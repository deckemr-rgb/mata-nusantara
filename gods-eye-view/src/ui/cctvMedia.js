import { attachVideoSource } from '../layers/cctv/hlsPlayback.js';

/**
 * Pemasangan media satu kamera, dipakai bersama oleh penampil layar penuh dan
 * dinding 3x3.
 *
 * KENAPA DIPUSATKAN
 * -----------------
 * Kedua permukaan menjawab pertanyaan yang sama — "umpan ini video atau
 * gambar, dan bagaimana memasangnya" — dan jawabannya punya jebakan yang tidak
 * kentara: umpan HLS harus lewat hls.js pada peramban tanpa dukungan bawaan,
 * dan umpan gambar diam butuh parameter anti-cache atau tampak beku. Dua
 * salinan logika ini akan menyimpang pada perbaikan berikutnya.
 *
 * KENAPA KAMERA HLS TIDAK PERNAH MEMAKAI JALUR GAMBAR
 * ---------------------------------------------------
 * Untuk umpan HLS, `/api/cctv/frame/:id` tidak mengembalikan foto kamera; ia
 * mengembalikan SVG sintetis buatan proxy (~2 KB) karena tidak ada pendekode
 * video di sisi server. Memakai jalur gambar untuk kamera HLS berarti sembilan
 * kotak berisi gambar pengganti kosong, bukan Indonesia yang hidup.
 */

/** Jenis umpan yang harus dipasang sebagai video. */
const VIDEO_FEEDS = new Set(['hls', 'mp4', 'webm']);

/** Batas waktu permintaan info aliran. */
export const STREAM_INFO_TIMEOUT_MS = 8000;

/**
 * Tentukan apakah sebuah jenis umpan adalah video.
 *
 * @param {string} feedType
 * @returns {boolean}
 */
export function isVideoFeed(feedType) {
  return VIDEO_FEEDS.has(String(feedType || '').toLowerCase());
}

/**
 * Bangun URL bingkai dengan parameter anti-cache.
 *
 * Tanpa ini peramban menyajikan bingkai yang sama dari cache dan umpan diam
 * tampak membeku.
 *
 * @param {string} frameUrl
 * @returns {string}
 */
export function cacheBustedFrameUrl(frameUrl) {
  const url = String(frameUrl || '');
  if (!url) return '';
  return `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
}

/**
 * Ambil info aliran satu kamera.
 *
 * @param {string} cameraId
 * @param {{signal?: AbortSignal, fetchImpl?: Function}} [opts]
 * @returns {Promise<?object>} Info aliran, atau null bila tidak terjangkau.
 */
export async function fetchStreamInfo(cameraId, { signal, fetchImpl } = {}) {
  const id = String(cameraId || '').trim();
  if (!id) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  try {
    const resp = await doFetch(
      `/api/cctv/stream/${encodeURIComponent(id)}`,
      signal ? { signal } : undefined,
    );
    if (!resp?.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Pasang media satu kamera ke dalam sebuah wadah.
 *
 * @param {object} options
 * @param {Document} options.documentRef Dokumen pemilik elemen.
 * @param {HTMLElement} options.container Wadah; isinya diganti.
 * @param {object} options.info Info aliran dari {@link fetchStreamInfo}.
 * @param {string} [options.className] Kelas untuk elemen media.
 * @param {number} [options.refreshMs] Selang penyegaran umpan gambar; 0 mematikannya.
 * @param {(state: string) => void} [options.onState] Dipanggil dengan
 *   'ready' atau 'error' saat media menyelesaikan usahanya.
 * @returns {?{element: HTMLElement, detach: () => void}} null bila tidak ada
 *   yang bisa dipasang.
 */
export function mountCameraMedia({
  documentRef,
  container,
  info,
  className = 'cctv-media',
  refreshMs = 10000,
  onState = null,
}) {
  if (!documentRef || !container || !info) return null;
  const feedType = String(info.feedType || 'image');

  if (isVideoFeed(feedType) && info.mediaUrl) {
    const video = documentRef.createElement('video');
    video.className = className;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('canplay', () => {
      onState?.('ready');
      video.play?.().catch(() => {});
    });
    video.addEventListener('error', () => onState?.('error'));
    container.replaceChildren(video);
    // hls.js untuk HLS pada peramban tanpa dukungan bawaan, penetapan src
    // langsung untuk mp4/webm dan untuk Safari — lihat hlsPlayback.js.
    const detachVideo = attachVideoSource(video, info.mediaUrl, feedType);
    return {
      element: video,
      detach() {
        try {
          video.pause?.();
        } catch {
          /* pembongkaran tidak boleh melempar */
        }
        detachVideo?.();
      },
    };
  }

  if (info.frameUrl) {
    const img = documentRef.createElement('img');
    img.className = className;
    img.alt = 'Bingkai umpan CCTV';
    img.decoding = 'async';
    img.addEventListener('load', () => onState?.('ready'));
    img.addEventListener('error', () => onState?.('error'));
    const paint = () => {
      img.src = cacheBustedFrameUrl(info.frameUrl);
    };
    paint();
    container.replaceChildren(img);
    const timer =
      refreshMs > 0 && typeof setInterval === 'function'
        ? setInterval(paint, refreshMs)
        : 0;
    return {
      element: img,
      detach() {
        if (timer) clearInterval(timer);
        img.removeAttribute('src');
      },
    };
  }

  return null;
}
