import {
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

/**
 * Kontrol kamera lewat papan ketik — WASD untuk bergerak, G/F untuk memutar.
 *
 * KENAPA ADA MODUL INI
 * --------------------
 * Cesium sendiri hanya menyediakan navigasi lewat tetikus. Peta ini dipakai
 * seperti kokpit: operator ingin menggeser dan memutar pandangan tanpa
 * melepas tangan dari papan ketik.
 *
 *   W / S  — maju / mundur searah pandangan
 *   A / D  — geser kiri / kanan (menyamping, arah pandang tetap)
 *   G      — putar pandangan ke KANAN (3D)
 *   F      — putar pandangan ke KIRI (3D)
 *
 * KENAPA LAJUNYA IKUT KETINGGIAN
 * ------------------------------
 * Laju tetap tidak mungkin benar pada globe: 500 m/detik terasa merayap saat
 * melihat seluruh Bumi, dan melesat tak terkendali saat berada di ketinggian
 * tiang CCTV. Laju gerak di sini sebanding dengan ketinggian kamera di atas
 * permukaan, dengan batas bawah dan atas, sehingga satu ketukan terasa sama
 * proporsionalnya di orbit maupun di persimpangan jalan.
 *
 * KENAPA PAKAI LOOP rAF, BUKAN PER-KETUKAN
 * ----------------------------------------
 * Menggerakkan kamera pada tiap event `keydown` menyerahkan kecepatan kepada
 * laju pengulangan papan ketik sistem operasi — berbeda di tiap mesin, dan
 * ada jeda sebelum pengulangan dimulai. Modul ini mencatat tombol yang sedang
 * ditekan lalu memindahkan kamera sekali per frame berdasarkan waktu nyata
 * (delta time), sehingga gerakannya mulus dan konsisten.
 *
 * Loop hanya berjalan selagi ada tombol ditekan; saat semua dilepas, loop
 * berhenti dan render kontinu dilepaskan kembali ke governor.
 */

/** Pemilik hold pada render governor. */
const RENDER_OWNER = 'keyboard-flight';

/** Batas bawah laju gerak (m/detik) — dipakai saat kamera sangat rendah. */
const MIN_MOVE_RATE_MPS = 12;
/** Batas atas laju gerak (m/detik) — dipakai saat melihat seluruh globe. */
const MAX_MOVE_RATE_MPS = 900000;
/** Laju gerak sebagai pecahan dari ketinggian kamera per detik. */
const MOVE_RATE_PER_HEIGHT = 0.6;
/** Laju putar pandangan, radian per detik (±60°/detik). */
const TURN_RATE_RAD_PER_SEC = Math.PI / 3;
/**
 * Batas atas delta waktu per frame. Tab yang tersembunyi lalu dibuka kembali
 * menghasilkan satu delta raksasa; tanpa batas ini kamera akan melompat jauh
 * dalam satu frame.
 */
const MAX_FRAME_DELTA_SEC = 0.1;

/** Tombol yang ditangani modul ini, dipetakan ke perannya. */
const KEY_ROLES = Object.freeze({
  keyw: 'forward',
  keys: 'backward',
  keya: 'left',
  keyd: 'right',
  keyg: 'turnRight',
  keyf: 'turnLeft',
});

/**
 * Menentukan apakah event berasal dari kolom isian teks.
 *
 * Saat operator mengetik nama tempat di kotak pencarian, huruf "w" harus
 * menjadi huruf, bukan perintah terbang.
 *
 * @param {KeyboardEvent} event
 * @param {HTMLElement} [searchInput] Kolom pencarian aplikasi.
 * @returns {boolean}
 */
function isTypingTarget(event, searchInput) {
  const target = event?.target;
  if (!target) return false;
  if (target === searchInput) return true;
  if (target.isContentEditable) return true;
  return Boolean(target.matches?.('input, textarea, select, [contenteditable]'));
}

/**
 * Pasang kontrol kamera papan ketik.
 *
 * @param {object} options
 * @param {object} options.viewer Cesium Viewer.
 * @param {Document} [options.documentRef] Target event papan ketik.
 * @param {HTMLElement} [options.searchInput] Kolom pencarian yang harus diabaikan.
 * @param {() => boolean} [options.isEnabled] Gerbang tambahan; kembalikan false
 *   untuk menonaktifkan sementara (mis. saat mode kokpit mengemudikan kamera).
 * @returns {{destroy: Function}} Pembersihan yang sinkron dan idempoten.
 */
export function bindKeyboardFlight({
  viewer,
  documentRef = document,
  searchInput = null,
  isEnabled = () => true,
}) {
  /** @type {Set<string>} Peran yang sedang aktif ('forward', 'turnLeft', …). */
  const active = new Set();
  let rafId = 0;
  /**
   * Timestamp frame sebelumnya, atau null bila loop baru dimulai.
   *
   * Sengaja null dan bukan 0: rAF boleh saja memberikan timestamp 0 pada frame
   * pertama, dan sentinel bernilai 0 akan tertukar dengan timestamp itu pada
   * pemeriksaan kebenaran (falsy), sehingga delta frame berikutnya menjadi nol
   * dan kamera diam.
   */
  let lastFrameAt = null;
  let holding = false;

  /** Lepaskan render kontinu bila sedang dipegang. */
  const releaseHold = () => {
    if (!holding) return;
    holding = false;
    releaseContinuousRender(RENDER_OWNER);
  };

  /** Hentikan loop dan lepaskan hold. */
  const stopLoop = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    lastFrameAt = null;
    releaseHold();
  };

  /**
   * Laju gerak untuk frame ini, diturunkan dari ketinggian kamera.
   *
   * @param {object} camera Cesium Camera.
   * @returns {number} meter per detik.
   */
  const moveRateFor = (camera) => {
    const height = Number(camera?.positionCartographic?.height);
    if (!Number.isFinite(height)) return MIN_MOVE_RATE_MPS;
    const scaled = Math.abs(height) * MOVE_RATE_PER_HEIGHT;
    return Math.min(MAX_MOVE_RATE_MPS, Math.max(MIN_MOVE_RATE_MPS, scaled));
  };

  /** Satu langkah animasi: terapkan setiap peran aktif ke kamera. */
  const step = (timestamp) => {
    rafId = 0;
    if (!active.size) {
      stopLoop();
      return;
    }
    const camera = viewer?.camera;
    if (!camera || viewer?.isDestroyed?.()) {
      active.clear();
      stopLoop();
      return;
    }

    const previous = lastFrameAt === null ? timestamp : lastFrameAt;
    lastFrameAt = timestamp;
    const delta = Math.min(
      MAX_FRAME_DELTA_SEC,
      Math.max(0, (timestamp - previous) / 1000),
    );

    if (delta > 0) {
      const distance = moveRateFor(camera) * delta;
      const turn = TURN_RATE_RAD_PER_SEC * delta;

      // Gerak translasi relatif terhadap arah pandang kamera saat ini.
      if (active.has('forward')) camera.moveForward(distance);
      if (active.has('backward')) camera.moveBackward(distance);
      if (active.has('left')) camera.moveLeft(distance);
      if (active.has('right')) camera.moveRight(distance);

      // Putar arah pandang. lookLeft/lookRight memutar kamera di tempat,
      // sehingga pandangan 3D berputar tanpa memindahkan posisi kamera.
      if (active.has('turnRight')) camera.lookRight(turn);
      if (active.has('turnLeft')) camera.lookLeft(turn);
    }

    rafId = requestAnimationFrame(step);
  };

  /** Pastikan loop berjalan dan render kontinu dipegang. */
  const startLoop = () => {
    if (!holding) {
      holding = true;
      holdContinuousRender(RENDER_OWNER);
    }
    if (!rafId) {
      lastFrameAt = null;
      rafId = requestAnimationFrame(step);
    }
  };

  const onKeyDown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event, searchInput)) return;
    const role = KEY_ROLES[String(event.code || '').toLowerCase()];
    if (!role) return;
    if (!isEnabled()) return;
    // Cegah pengguliran halaman oleh tombol yang juga menggulir, dan cegah
    // pintasan huruf lain ikut menyala untuk ketukan yang sama.
    event.preventDefault();
    if (active.has(role)) return;
    active.add(role);
    startLoop();
  };

  const onKeyUp = (event) => {
    const role = KEY_ROLES[String(event.code || '').toLowerCase()];
    if (!role) return;
    active.delete(role);
    if (!active.size) stopLoop();
  };

  /**
   * Alt-Tab keluar dari jendela tidak memunculkan keyup, sehingga tombol akan
   * "tersangkut" menekan dan kamera terus melaju setelah operator kembali.
   */
  const onWindowBlur = () => {
    active.clear();
    stopLoop();
  };

  documentRef.addEventListener('keydown', onKeyDown);
  documentRef.addEventListener('keyup', onKeyUp);
  const view = documentRef.defaultView || globalThis;
  view.addEventListener?.('blur', onWindowBlur);

  return {
    destroy() {
      documentRef.removeEventListener('keydown', onKeyDown);
      documentRef.removeEventListener('keyup', onKeyUp);
      view.removeEventListener?.('blur', onWindowBlur);
      active.clear();
      stopLoop();
    },
  };
}
