import { normalizeFeedType, isVideoFeedType } from './normalize.js';
import { fetchCctvImageFromUpstream, fetchTxdotSnapshot } from './media.js';

/** Dasar URL layanan deteksi (Human-Detector, YOLOv8) di mesin lokal. */
const DETECTOR_BASE_DEFAULT = 'http://127.0.0.1:5101';
/** Membuka HLS + mengambil bingkai + inferensi bisa melampaui 10 detik. */
const DETECTOR_TIMEOUT_MS = 25_000;

/**
 * Kirim satu permintaan deteksi ke layanan Human-Detector.
 *
 * @param {string} path Jalur layanan ('/detect' untuk bytes gambar,
 *   '/detect-url' untuk URL stream yang dibuka lewat FFmpeg).
 * @param {Buffer|string} body Isi permintaan.
 * @param {string} contentType Jenis isi yang dilaporkan ke layanan.
 * @returns {Promise<{ok: boolean, status: number, payload: object}>}
 */
async function postToDetector(path, body, contentType) {
  const base = process.env.HUMAN_DETECTOR_URL || DETECTOR_BASE_DEFAULT;
  try {
    const response = await fetch(new URL(path, base).toString(), {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      signal: AbortSignal.timeout(DETECTOR_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload };
  } catch {
    // Layanan mati, timeout, atau tidak terjangkau — laporkan dengan jujur.
    return { ok: false, status: 0, payload: {} };
  }
}

/**
 * Deteksi orang pada satu kamera CCTV terdaftar.
 *
 * Kamera bingkai diam diambil gambarnya di sisi server (jalur sama dengan
 * /api/cctv/frame), lalu bytes-nya dikirim ke layanan deteksi. Kamera video
 * (HLS dkk.) tidak punya pendekode di proxy — URL hulu yang SUDAH TERDAFTAR
 * diteruskan ke layanan, yang membukanya lewat OpenCV/FFmpeg. URL tidak pernah
 * diterima dari klien peramban, jadi permukaan SSRF tetap tertutup.
 *
 * @param {{url?: string, snapshotUrl?: string, feedType?: string, sourceKind?: string}} source
 *   Entri registri sumber kamera dari katalog CCTV.
 * @returns {Promise<{ok: boolean, status: number, payload: object, frameSource: string}>}
 */
export async function detectPersonsOnSource({ source }) {
  const feedType = normalizeFeedType(source?.feedType || 'image');
  const isVideo = isVideoFeedType(feedType);
  const upstreamCandidate =
    source?.snapshotUrl ||
    (!isVideo && source?.url ? source.url : '');

  if (upstreamCandidate) {
    // Kamera bingkai diam (bisa juga kamera video yang menyediakan snapshot).
    const upstreamImage =
      source?.sourceKind === 'txdot-its'
        ? await fetchTxdotSnapshot(upstreamCandidate)
        : await fetchCctvImageFromUpstream(upstreamCandidate);
    if (upstreamImage?.ok) {
      const outcome = await postToDetector(
        '/detect',
        upstreamImage.body,
        upstreamImage.contentType || 'image/jpeg',
      );
      return { ...outcome, frameSource: 'upstream-image' };
    }
    if (!isVideo) {
      return {
        ok: false,
        status: 502,
        payload: { error: 'frame unavailable from upstream' },
        frameSource: 'upstream-image',
      };
    }
  }

  if (isVideo && source?.url) {
    const outcome = await postToDetector(
      '/detect-url',
      JSON.stringify({ url: source.url }),
      'application/json',
    );
    return { ...outcome, frameSource: 'upstream-stream' };
  }

  return {
    ok: false,
    status: 502,
    payload: { error: 'no frame source registered for this camera' },
    frameSource: 'none',
  };
}
