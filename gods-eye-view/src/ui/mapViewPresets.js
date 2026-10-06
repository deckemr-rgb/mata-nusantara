import * as Cesium from 'cesium';
import {
  createCameraOrientationAnimator,
  readCameraTargetFrame,
} from './cameraOrientationControls.js';

/**
 * Prasetel sudut pandang peta.
 *
 * KENAPA ADA MODUL INI
 * --------------------
 * Globe ini adalah tampilan 3D, dan sudut serong yang membuatnya menarik juga
 * membuatnya sulit dibaca: pada kemiringan rendah, bangunan saling menutupi,
 * jalan memendek karena perspektif, dan ikon kamera bertumpuk di kejauhan.
 * Sudah ada pengalih miring/tegak di bilah atas, tetapi hanya dua keadaan
 * ekstrem (-35° dan -89°), berupa ikon kecil tanpa label, dan tidak menyentuh
 * heading — jadi peta yang terlanjur terputar tetap terputar.
 *
 * Modul ini memberi sudut yang diberi nama, plus satu tindakan "LURUSKAN" yang
 * mengembalikan peta ke keadaan yang paling mudah dibaca: tegak lurus dari
 * atas, utara di atas.
 *
 * KENAPA ROLL TIDAK PERLU DIURUS SENDIRI
 * --------------------------------------
 * `setCameraTargetFrame` menempatkan kamera lewat `camera.lookAt` dengan
 * HeadingPitchRange, yang menurunkan vektor `up` dari kerangka lokal sasaran.
 * Artinya roll selalu kembali nol sebagai akibat wajar — horizon yang miring
 * ikut lurus tanpa ada bidang roll yang perlu ditulis di sini.
 */

/** Sudut tegak lurus dari atas. Bukan -90 tepat: pada -90 heading menjadi tak
 * tentu dan kamera dapat melompat saat operator menggeser berikutnya. */
export const PITCH_TOP_DOWN = Cesium.Math.toRadians(-89);
/** Sudut serong sedang — kompromi antara keterbacaan dan kedalaman 3D. */
export const PITCH_ANGLED = Cesium.Math.toRadians(-45);
/** Sudut rendah, untuk melihat fasad bangunan dan arah pandang kamera CCTV. */
export const PITCH_LOW = Cesium.Math.toRadians(-20);

/** Prasetel yang tersedia, dipetakan dari atribut `data-map-view`. */
export const MAP_VIEW_PRESETS = Object.freeze({
  top: { pitch: PITCH_TOP_DOWN, label: 'Tampilan dari atas' },
  angled: { pitch: PITCH_ANGLED, label: 'Tampilan serong' },
  low: { pitch: PITCH_LOW, label: 'Tampilan rendah' },
  // Meluruskan keduanya sekaligus: tegak dari atas DAN utara di atas.
  straighten: { pitch: PITCH_TOP_DOWN, heading: 0, label: 'Peta diluruskan' },
});

/**
 * Tentukan prasetel mana yang paling cocok dengan kemiringan kamera saat ini,
 * supaya tombol yang sedang berlaku dapat ditandai.
 *
 * @param {number} pitch Kemiringan kamera dalam radian.
 * @returns {?string} Kunci prasetel, atau null bila tidak ada yang mendekati.
 */
export function nearestPresetKey(pitch) {
  if (!Number.isFinite(pitch)) return null;
  const candidates = [
    ['top', PITCH_TOP_DOWN],
    ['angled', PITCH_ANGLED],
    ['low', PITCH_LOW],
  ];
  let bestKey = null;
  let bestDelta = Infinity;
  for (const [key, value] of candidates) {
    const delta = Math.abs(pitch - value);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestKey = key;
    }
  }
  // Di luar 12° dari prasetel mana pun, operator sedang memakai sudut bebas
  // dan menyorot salah satu tombol justru menyesatkan.
  return bestDelta <= Cesium.Math.toRadians(12) ? bestKey : null;
}

/**
 * Pasang tombol prasetel sudut pandang peta.
 *
 * @param {object} options
 * @param {object} options.viewer Cesium Viewer.
 * @param {Array<HTMLElement>} options.buttons Tombol dengan atribut `data-map-view`.
 * @param {(noun: string, navigate: Function) => any} [options.runNavigation]
 *   Pembungkus navigasi milik aplikasi, supaya gerakan kamera ini mengikuti
 *   aturan kepemilikan kamera yang sama dengan kontrol orientasi lain.
 * @param {(message: string) => void} [options.showToast] Penampil pesan singkat.
 * @returns {{destroy: Function, sync: Function}}
 */
export function bindMapViewPresets({
  viewer,
  buttons = [],
  runNavigation = (_noun, navigate) => navigate(),
  showToast = null,
}) {
  const list = [...buttons].filter(Boolean);
  const animator = createCameraOrientationAnimator(viewer);
  const removers = [];
  let destroyed = false;

  /** Tandai tombol yang sudut pandangnya sedang berlaku. */
  function sync() {
    if (destroyed || !list.length) return;
    // Selagi animasi berjalan, kemiringan kamera masih berada di sudut LAMA:
    // membacanya di sini akan menyalakan tombol yang baru saja ditinggalkan
    // selama 650 ms berikutnya. Tujuan animasi adalah sudut yang sebenarnya
    // sedang berlaku — pola yang sama dipakai pengalih miring di bilah atas.
    const pending = animator.destination;
    const frame = pending ? null : readCameraTargetFrame(viewer);
    const pitch = Number.isFinite(pending?.pitch) ? pending.pitch : frame?.pitch;
    const active = Number.isFinite(pitch) ? nearestPresetKey(pitch) : null;
    for (const button of list) {
      const key = button.dataset?.mapView;
      // "LURUSKAN" adalah tindakan, bukan keadaan, jadi tidak pernah disorot.
      const on = key !== 'straighten' && key === active;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }

  /** Terapkan satu prasetel. */
  function apply(key) {
    if (destroyed) return false;
    const preset = MAP_VIEW_PRESETS[key];
    if (!preset) return false;
    const result = runNavigation('camera', () => {
      const frame = readCameraTargetFrame(viewer);
      if (!frame) return false;
      return animator.animate(frame, {
        // Sebuah prasetel hanya mengubah kemiringan kecuali ia menyebut
        // heading; memutar peta yang tidak diminta operator itu mengagetkan.
        heading: Number.isFinite(preset.heading)
          ? preset.heading
          : frame.heading,
        pitch: preset.pitch,
      })
        ? preset
        : false;
    });
    if (result) showToast?.(result.label);
    sync();
    return Boolean(result);
  }

  for (const button of list) {
    const handler = () => apply(button.dataset?.mapView);
    button.addEventListener('click', handler);
    removers.push(() => button.removeEventListener('click', handler));
  }

  sync();

  return {
    apply,
    sync,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      animator.cancel();
      for (const remove of removers) remove();
      removers.length = 0;
    },
  };
}
