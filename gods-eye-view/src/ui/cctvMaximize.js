import {
  fetchStreamInfo,
  mountCameraMedia,
  STREAM_INFO_TIMEOUT_MS,
} from './cctvMedia.js';
import { attachLivePersonDetect } from './cctvLiveDetect.js';

/**
 * Penampil CCTV layar penuh.
 *
 * KENAPA ADA MODUL INI
 * --------------------
 * Pratinjau di panel kanan berukuran beberapa ratus piksel dan hanya berupa
 * gambar diam yang disegarkan berkala. Untuk benar-benar MELIHAT sebuah
 * persimpangan — membaca antrean kendaraan, melihat apakah lampu menyala —
 * operator butuh bingkainya besar, dan untuk kamera Indonesia yang semuanya
 * HLS, butuh videonya yang hidup, bukan potongan gambar.
 *
 * Penampil ini dibuka dari dua tempat: mengklik pratinjau di panel, dan
 * mengklik ikon kamera di peta. Keduanya memanggil `open(cameraId, meta)`.
 *
 * SATU SUMBER KEBENARAN UNTUK JENIS UMPAN
 * ---------------------------------------
 * Jenis umpan tidak ditebak dari katalog di sisi klien, melainkan dibaca dari
 * `/api/cctv/stream/:id`, yang sudah menjadi jawaban resmi proxy: umpan video
 * (hls/mp4/webm) mendapat elemen <video>, selain itu <img> yang disegarkan.
 * Menebaknya di dua tempat berarti dua tempat yang bisa salah.
 *
 * SIKLUS HIDUP ADALAH BAGIAN YANG RAWAN
 * -------------------------------------
 * Membuka kamera lain selagi satu sedang diputar harus membongkar pemutar
 * sebelumnya, membatalkan permintaan yang masih berjalan, dan menghentikan
 * timer penyegar — kalau tidak, pemutar hls.js dan interval akan menumpuk
 * setiap kali operator berpindah kamera. `teardownMedia()` adalah satu-satunya
 * jalan keluar, dan setiap jalur (tutup, ganti kamera, hancurkan) melewatinya.
 */

/** Selang penyegaran bingkai untuk umpan gambar diam di layar penuh. */
const IMAGE_REFRESH_MS = 10000;

/**
 * Pasang penampil CCTV layar penuh.
 *
 * @param {object} options
 * @param {Document} [options.documentRef] Dokumen tempat elemen berada.
 * @param {(message: string) => void} [options.showToast] Penampil pesan singkat.
 * @returns {{open: Function, close: Function, isOpen: Function, destroy: Function}}
 */
export function createCctvMaximizeViewer({
  // Dibaca dari globalThis, bukan dari `document` telanjang: panel CCTV juga
  // dibangun di lingkungan uji tanpa DOM, dan sebuah referensi telanjang di
  // sini akan melempar ReferenceError saat konstruksi panel, bukan saat
  // penampil ini dipakai.
  documentRef = globalThis.document,
  showToast = null,
} = {}) {
  const root = documentRef?.getElementById?.('cctv-maximize') || null;
  const stage = documentRef?.getElementById?.('cctv-maximize-stage') || null;
  const titleEl = documentRef?.getElementById?.('cctv-maximize-title') || null;
  const metaEl = documentRef?.getElementById?.('cctv-maximize-meta') || null;
  const statusEl = documentRef?.getElementById?.('cctv-maximize-status') || null;
  const closeBtn = documentRef?.getElementById?.('cctv-maximize-close') || null;

  // Tanpa DOM atau tanpa markup-nya, modul ini tidak melakukan apa pun tetapi
  // tetap memenuhi kontraknya, sehingga pemanggil tidak perlu memeriksa null
  // di setiap pemakaian.
  const inert = !documentRef || !root || !stage;

  let open = false;
  let currentCameraId = null;
  /** Pembongkar media yang sedang aktif (video hls.js atau timer gambar). */
  let detachMedia = null;
  /** Pembongkar deteksi orang langsung (model peramban) di atas video. */
  let detachLiveDetect = null;
  let inFlight = null;
  let destroyed = false;
  /** Kanvas overlay deteksi orang di atas video (dibuat ulang per pemasangan). */
  let overlayCanvas = null;
  const removers = [];

  /** Hentikan media apa pun yang sedang berjalan dan kosongkan panggung. */
  const teardownMedia = () => {
    if (inFlight) {
      inFlight.abort();
      inFlight = null;
    }
    detachLiveDetect?.();
    detachLiveDetect = null;
    if (detachMedia) {
      try {
        detachMedia();
      } catch {
        /* pembongkaran tidak boleh melempar */
      }
      detachMedia = null;
    }
    overlayCanvas = null;
    if (stage) stage.replaceChildren();
  };

  /** Tulis baris status; string kosong menyembunyikannya. */
  const setStatus = (text) => {
    if (!statusEl) return;
    statusEl.textContent = String(text || '');
    statusEl.hidden = !text;
  };

  /**
   * Pasang media kamera ke panggung lewat pemasang bersama (cctvMedia.js),
   * sehingga layar penuh dan dinding 3x3 memutuskan video-atau-gambar dengan
   * aturan yang sama persis.
   *
   * @param {object} info Info aliran.
   * @returns {boolean} true bila ada yang terpasang.
   */
  const mountMedia = (info) => {
    const entry = mountCameraMedia({
      documentRef,
      container: stage,
      info,
      className: 'cctv-maximize-media',
      refreshMs: IMAGE_REFRESH_MS,
      onState: (state) =>
        setStatus(state === 'ready' ? '' : 'Umpan tidak tersedia'),
    });
    if (!entry) return false;
    detachMedia = entry.detach;
    // Kanvas overlay deteksi: kotak orang dari loop deteksi kontinu digambar
    // DI ATAS video yang berputar — dipasang ulang di sini karena
    // teardownMedia mengosongkan panggung. Panggung rintisan (uji) mungkin
    // tidak punya appendChild — tanpa kanvas pun penampil tetap sah.
    if (documentRef.createElement && typeof stage.appendChild === 'function') {
      overlayCanvas = documentRef.createElement('canvas');
      overlayCanvas.className = 'cctv-maximize-detect-overlay';
      overlayCanvas.hidden = true;
      stage.appendChild(overlayCanvas);
      // Video HLS di layar penuh mendapat deteksi LANGSUNG dari model
      // peramban — kotak ikut gerak real-time, bukan potongan berkala.
      if (entry.element?.tagName === 'VIDEO') {
        detachLiveDetect = attachLivePersonDetect(
          entry.element,
          overlayCanvas,
          { cameraId: id },
        );
      }
    }
    return true;
  };
  /**
   * Buka penampil untuk satu kamera.
   *
   * @param {string} cameraId Id kamera.
   * @param {{name?: string, city?: string, provider?: string}} [meta] Label.
   * @returns {Promise<boolean>} true bila panggung berhasil dipasang.
   */
  async function openCamera(cameraId, meta = {}) {
    if (inert || destroyed) return false;
    const id = String(cameraId || '').trim();
    if (!id) return false;

    // Berpindah kamera membongkar yang lama lebih dulu, jadi pemutar dan timer
    // tidak pernah menumpuk.
    teardownMedia();
    currentCameraId = id;
    open = true;
    root.hidden = false;
    root.classList.add('active');
    documentRef.body?.classList.add('cctv-maximize-open');

    if (titleEl) titleEl.textContent = meta.name || id;
    if (metaEl) {
      metaEl.textContent = [meta.city, meta.provider].filter(Boolean).join(' · ');
    }
    setStatus('Menghubungkan…');
    closeBtn?.focus?.({ preventScroll: true });

    const controller = new AbortController();
    inFlight = controller;
    const timeout = setTimeout(() => controller.abort(), STREAM_INFO_TIMEOUT_MS);
    let info = null;
    try {
      info = await fetchStreamInfo(id, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      if (inFlight === controller) inFlight = null;
    }

    // Operator bisa menutup atau berpindah kamera selagi permintaan berjalan;
    // jawaban yang datang untuk kamera yang bukan lagi yang aktif dibuang.
    if (destroyed || !open || currentCameraId !== id) return false;

    if (!info) {
      setStatus('Tidak dapat memuat info kamera');
      return false;
    }

    if (!mountMedia(info)) {
      setStatus('Kamera ini tidak menyediakan umpan');
      return false;
    }

    if (metaEl && info.provider && !meta.provider) {
      metaEl.textContent = [meta.city, info.provider]
        .filter(Boolean)
        .join(' · ');
    }
    return true;
  }

  /** Tutup penampil dan lepaskan seluruh media. */
  function close() {
    if (inert) return;
    teardownMedia();
    open = false;
    currentCameraId = null;
    root.classList.remove('active');
    root.hidden = true;
    documentRef.body?.classList.remove('cctv-maximize-open');
    setStatus('');
  }

  const listen = (element, type, handler, opts) => {
    if (!element) return;
    element.addEventListener(type, handler, opts);
    removers.push(() => element.removeEventListener(type, handler, opts));
  };

  if (!inert) {
    listen(closeBtn, 'click', close);
    // Mengklik latar menutup; mengklik panggung tidak, supaya operator bisa
    // berinteraksi dengan bingkainya tanpa penampil tertutup tak sengaja.
    listen(root, 'click', (event) => {
      if (event.target === root) close();
    });
    listen(documentRef, 'keydown', (event) => {
      if (!open) return;
      if (event.key === 'Escape') {
        // Escape di sini tidak boleh juga menutup pencarian atau keluar dari
        // kokpit di pendengar lain.
        event.stopPropagation();
        event.preventDefault();
        close();
      }
    });
  }

  return {
    open: openCamera,
    close,
    isOpen: () => open,
    currentCameraId: () => currentCameraId,
    /** Kanvas overlay deteksi kamera yang sedang terbuka, atau null. */
    detectOverlay: () => (open ? overlayCanvas : null),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      close();
      for (const remove of removers) remove();
      removers.length = 0;
      void showToast;
    },
  };
}
