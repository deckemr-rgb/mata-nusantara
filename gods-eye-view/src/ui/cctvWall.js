import { fetchStreamInfo, mountCameraMedia } from './cctvMedia.js';

/**
 * Dinding CCTV 3x3.
 *
 * KENAPA ADA MODUL INI
 * --------------------
 * Peta menampilkan di mana kamera berada; penampil layar penuh menampilkan
 * satu kamera. Yang hilang di antaranya adalah melihat sebuah kawasan
 * sekaligus — sembilan persimpangan berdampingan, cara ruang kendali lalu
 * lintas sebenarnya dipakai.
 *
 * SEMBILAN ALIRAN LANGSUNG ITU MAHAL, DAN ITU MEMBENTUK DESAINNYA
 * ---------------------------------------------------------------
 * Untuk kamera Indonesia tidak ada jalan pintas berupa gambar diam: proxy
 * mengembalikan SVG pengganti untuk umpan HLS, bukan foto. Jadi dinding ini
 * memang membuka sembilan pemutar video sungguhan, dan konsekuensinya diurus
 * secara eksplisit:
 *
 *   - Kotak dipasang BERTAHAP, bukan serentak. Sembilan manifest HLS yang
 *     berangkat pada frame yang sama membuat jaringan tersendat dan sebagian
 *     gagal; jeda kecil di antaranya membuat kesembilannya sampai.
 *   - Menutup dinding membongkar kesembilan pemutar. Tanpa itu, membuka dan
 *     menutup beberapa kali meninggalkan pemutar hls.js yang masih mengunduh
 *     segmen di latar belakang.
 *   - Membuka dinding baru membatalkan pemasangan yang belum selesai lewat
 *     nomor generasi, sehingga jawaban yang terlambat dari dinding sebelumnya
 *     tidak menempel ke kotak milik dinding yang baru.
 */

/** Sisi kisi. Tiga baris kali tiga kolom. */
export const WALL_SIZE = 3;
/** Jumlah kotak pada dinding. */
export const WALL_CELLS = WALL_SIZE * WALL_SIZE;
/** Jeda antar pemasangan kotak, milidetik. */
const MOUNT_STAGGER_MS = 220;
/** Umpan gambar pada dinding disegarkan lebih jarang daripada di layar penuh:
 * sembilan kotak yang menyegar tiap 10 detik adalah sembilan kali beban. */
const WALL_IMAGE_REFRESH_MS = 20000;

/**
 * Apakah sebuah nilai benar-benar koordinat yang dapat dipakai.
 *
 * `Number.isFinite(Number(value))` saja tidak cukup: `Number(null)` dan
 * `Number('')` keduanya bernilai 0, yang lolos pemeriksaan itu dan membuat
 * kamera berkoordinat kosong diperlakukan sebagai titik (0, 0). Pada dinding
 * yang acuannya kebetulan dekat nol, kamera rusak itu justru menempati kotak
 * terdepan.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isUsableCoordinate(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

/**
 * Jarak lingkaran besar dalam kilometer.
 *
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Pilih sembilan kamera untuk dinding.
 *
 * Sebuah kamera acuan (biasanya yang sedang aktif) menetapkan pusatnya, dan
 * sisanya adalah tetangga terdekat — itulah yang membuat dinding terbaca
 * sebagai satu kawasan alih-alih sembilan tempat yang tak berhubungan. Acuan
 * selalu menempati kotak pertama.
 *
 * @param {Array<object>} cameras Katalog kamera.
 * @param {?object} anchor Kamera acuan, atau null.
 * @param {number} [limit=WALL_CELLS] Jumlah kotak.
 * @returns {Array<object>} Kamera terpilih, terurut.
 */
export function selectWallCameras(cameras, anchor, limit = WALL_CELLS) {
  const list = Array.isArray(cameras) ? cameras.filter(Boolean) : [];
  if (!list.length) return [];
  const cap = Math.max(0, Math.floor(limit));
  if (!cap) return [];

  const hasAnchor =
    Boolean(anchor) &&
    isUsableCoordinate(anchor?.lat) &&
    isUsableCoordinate(anchor?.lon);
  const anchorLat = Number(anchor?.lat);
  const anchorLon = Number(anchor?.lon);
  if (!hasAnchor) return list.slice(0, cap);

  const rest = list
    .filter((camera) => camera.id !== anchor.id)
    .map((camera) => ({
      camera,
      distanceKm:
        isUsableCoordinate(camera.lat) && isUsableCoordinate(camera.lon)
          ? haversineKm(
              anchorLat,
              anchorLon,
              Number(camera.lat),
              Number(camera.lon),
            )
          : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .map((entry) => entry.camera);

  const anchorInList = list.some((camera) => camera.id === anchor.id);
  return (anchorInList ? [anchor, ...rest] : rest).slice(0, cap);
}

/**
 * Pasang dinding CCTV 3x3.
 *
 * @param {object} options
 * @param {Document} [options.documentRef]
 * @param {(cameraId: string, meta: object) => void} [options.onCellActivate]
 *   Dipanggil saat sebuah kotak diklik — dipakai untuk membuka layar penuh.
 * @returns {{open: Function, close: Function, isOpen: Function, destroy: Function}}
 */
export function createCctvWall({
  documentRef = globalThis.document,
  onCellActivate = null,
} = {}) {
  const root = documentRef?.getElementById?.('cctv-wall') || null;
  const grid = documentRef?.getElementById?.('cctv-wall-grid') || null;
  const titleEl = documentRef?.getElementById?.('cctv-wall-title') || null;
  const closeBtn = documentRef?.getElementById?.('cctv-wall-close') || null;

  const inert = !documentRef || !root || !grid;

  let open = false;
  let destroyed = false;
  /** Naik pada setiap buka dan tutup; pemasangan yang tertinggal memeriksanya. */
  let generation = 0;
  /** Pembongkar media per kotak. */
  let mounted = [];
  let timers = [];
  let controllers = [];
  const removers = [];

  /** Bongkar seluruh media, batalkan permintaan, dan kosongkan kisi. */
  function teardown() {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    for (const controller of controllers) {
      try {
        controller.abort();
      } catch {
        /* sudah selesai */
      }
    }
    controllers = [];
    for (const entry of mounted) {
      try {
        entry?.detach?.();
      } catch {
        /* pembongkaran tidak boleh melempar */
      }
    }
    mounted = [];
    if (grid) grid.replaceChildren();
  }

  /**
   * Bangun satu kotak: bingkai, label, dan penanganan klik.
   *
   * @param {object} camera
   * @returns {{cell: HTMLElement, stage: HTMLElement, status: HTMLElement}}
   */
  function buildCell(camera) {
    const cell = documentRef.createElement('div');
    cell.className = 'cctv-wall-cell';
    cell.dataset.cameraId = camera.id;

    const stage = documentRef.createElement('div');
    stage.className = 'cctv-wall-stage';

    const status = documentRef.createElement('div');
    status.className = 'cctv-wall-cell-status';
    status.textContent = 'Menghubungkan…';

    const label = documentRef.createElement('div');
    label.className = 'cctv-wall-cell-label';
    label.textContent = camera.name || camera.id;

    cell.replaceChildren(stage, status, label);

    // Mengklik sebuah kotak menaikkannya ke layar penuh — dinding untuk
    // memindai, layar penuh untuk memeriksa.
    const onClick = () => {
      onCellActivate?.(camera.id, {
        name: camera.name || camera.id,
        city: camera.city || '',
        provider: camera.provider || '',
      });
    };
    cell.addEventListener('click', onClick);
    removers.push(() => cell.removeEventListener('click', onClick));

    return { cell, stage, status };
  }

  /**
   * Buka dinding untuk sekumpulan kamera.
   *
   * @param {Array<object>} cameras Kamera yang sudah dipilih dan terurut.
   * @param {{title?: string}} [meta]
   * @returns {boolean} true bila kisi dibangun.
   */
  function openWall(cameras, meta = {}) {
    if (inert || destroyed) return false;
    const list = (Array.isArray(cameras) ? cameras : []).slice(0, WALL_CELLS);
    if (!list.length) return false;

    teardown();
    const mine = ++generation;
    open = true;
    root.hidden = false;
    root.classList.add('active');
    documentRef.body?.classList.add('cctv-wall-open');
    if (titleEl) {
      titleEl.textContent = meta.title || `DINDING CCTV ${WALL_SIZE}×${WALL_SIZE}`;
    }
    closeBtn?.focus?.({ preventScroll: true });

    const cells = list.map((camera) => buildCell(camera));
    grid.replaceChildren(...cells.map((entry) => entry.cell));

    list.forEach((camera, index) => {
      // Bertahap: sembilan manifest HLS yang berangkat bersamaan membuat
      // sebagian gagal sebelum sempat dimulai.
      const timer = setTimeout(async () => {
        if (destroyed || generation !== mine) return;
        const controller = new AbortController();
        controllers.push(controller);
        const info = await fetchStreamInfo(camera.id, {
          signal: controller.signal,
        });
        if (destroyed || generation !== mine) return;
        const { stage, status } = cells[index];
        if (!info) {
          status.textContent = 'Tidak tersedia';
          return;
        }
        const entry = mountCameraMedia({
          documentRef,
          container: stage,
          info,
          className: 'cctv-wall-media',
          refreshMs: WALL_IMAGE_REFRESH_MS,
          onState: (state) => {
            if (destroyed || generation !== mine) return;
            status.textContent = state === 'ready' ? '' : 'Umpan bermasalah';
            status.hidden = state === 'ready';
          },
        });
        if (!entry) {
          status.textContent = 'Tanpa umpan';
          return;
        }
        if (destroyed || generation !== mine) {
          entry.detach();
          return;
        }
        mounted.push(entry);
      }, index * MOUNT_STAGGER_MS);
      timers.push(timer);
    });

    return true;
  }

  /** Tutup dinding dan lepaskan kesembilan pemutar. */
  function close() {
    if (inert) return;
    generation += 1;
    teardown();
    open = false;
    root.classList.remove('active');
    root.hidden = true;
    documentRef.body?.classList.remove('cctv-wall-open');
  }

  const listen = (element, type, handler) => {
    if (!element) return;
    element.addEventListener(type, handler);
    removers.push(() => element.removeEventListener(type, handler));
  };

  if (!inert) {
    listen(closeBtn, 'click', close);
    listen(root, 'click', (event) => {
      if (event.target === root) close();
    });
    listen(documentRef, 'keydown', (event) => {
      if (!open) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        close();
      }
    });
  }

  return {
    open: openWall,
    close,
    isOpen: () => open,
    cellCount: () => mounted.length,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      close();
      for (const remove of removers) remove();
      removers.length = 0;
    },
  };
}
