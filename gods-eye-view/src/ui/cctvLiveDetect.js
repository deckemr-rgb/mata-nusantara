/**
 * Deteksi orang LANGSUNG di dalam peramban, di atas <video> yang berputar.
 *
 * KENAPA DI PERAMBAN
 * ------------------
 * Deteksi lewat layanan server membuka ulang stream HLS lewat FFmpeg
 * (2-5 detik) plus inferensi CPU (2-4 detik) per siklus — kotak selalu
 * telat belasan detik. Model di sini (COCO-SSD via TensorFlow.js, backend
 * WebGL) berjalan langsung di atas frame video yang SEDANG DIPUTAR: tanpa
 * jaringan, tanpa buka stream, kotak menyegarkan ~10x per detik dan ikut
 * mengikuti gerakan sesungguhnya.
 *
 * Kualitasnya sedikit di bawah YOLOv8s @1280 server (objek kecil/jauh lebih
 * mudah lolos) — karena itu YOLO server tetap dipakai untuk pelabelan
 * dataset dan gambar hasil; overlay ini adalah lapisan real-time-nya.
 *
 * Model bobotnya diunduh sekali dari CDN saat pertama dipakai lalu
 * tersimpan di cache peramban.
 */

import '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';

let modelPromise = null;
let model = null;

/** Muat model sekali; pemanggil berikutnya memakai janji yang sama. */
function loadModel() {
  if (!modelPromise) {
    modelPromise = cocoSsd
      .load({ base: 'lite_mobilenet_v2' })
      .then((loaded) => {
        model = loaded;
        return loaded;
      })
      .catch((error) => {
        // Gagal (mis. CDN tak terjangkau) — reset agar percobaan berikutnya
        // mencoba lagi, bukan menyimpan janji yang sudah ditolak.
        modelPromise = null;
        throw error;
      });
  }
  return modelPromise;
}

/**
 * Pasang deteksi langsung pada satu elemen video.
 *
 * @param {HTMLVideoElement} video Elemen video yang berputar.
 * @param {HTMLCanvasElement} canvas Kanvas overlay (dikosongkan pemasangnya).
 * @param {{cameraId: string, onCount?: (count: number) => void}} opts
 * @returns {{detach: () => void}} Pembongkar; aman dipanggil dua kali.
 */
export function attachLivePersonDetect(video, canvas, { cameraId, onCount } = {}) {
  let stopped = false;
  let timer = 0;
  const context = canvas.getContext('2d');

  const drawResults = (predictions) => {
    // Kanvas mengikuti kotak tampil video; prediksi memakai koordinat piksel
    // video asli — skala ke kotak tampil.
    const showWidth = video.clientWidth || canvas.clientWidth;
    const showHeight = video.clientHeight || canvas.clientHeight;
    if (!showWidth || !showHeight) return;
    if (canvas.width !== showWidth || canvas.height !== showHeight) {
      canvas.width = showWidth;
      canvas.height = showHeight;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = false;
    const scaleX = canvas.width / (video.videoWidth || canvas.width);
    const scaleY = canvas.height / (video.videoHeight || canvas.height);
    context.strokeStyle = '#00e5ff';
    context.lineWidth = 2;
    context.font = '11px monospace';
    let personCount = 0;
    for (const prediction of predictions) {
      if (prediction.class !== 'person') continue;
      personCount += 1;
      const [x, y, w, h] = prediction.bbox;
      context.strokeRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);
      const label = `${Math.round(prediction.score * 100)}%`;
      context.fillStyle = 'rgba(0, 229, 255, 0.85)';
      context.fillRect(x * scaleX, Math.max(0, y * scaleY - 13), context.measureText(label).width + 6, 13);
      context.fillStyle = '#04070b';
      context.fillText(label, x * scaleX + 3, Math.max(10, y * scaleY - 3));
    }
    onCount?.(personCount);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        // Kebijakan autoplay/reload bisa meninggalkan video pause — deteksi
        // langsung justru tempat yang tepat untuk membangunkannya lagi
        // (video selalu muted, jadi play() diizinkan tanpa gestur).
        if (video.paused) video.play?.().catch(() => {});
      }
      // Video belum siap (mendekode bingkai pertama) → tunggu siklus berikut.
      if (video.readyState >= 2 && !video.paused && video.videoWidth) {
        const detector = model || (await loadModel());
        const predictions = await detector.detect(video, 20, 0.3);
        if (!stopped) drawResults(predictions);
      }
    } catch {
      /* satu frame gagal deteksi bukan alasan mematikan overlay */
    }
    if (!stopped) timer = setTimeout(tick, 100);
  };

  timer = setTimeout(tick, 300);
  // Node (unit test): timer tidak boleh menggantung event loop.
  timer?.unref?.();

  return {
    detach() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = 0;
      context?.clearRect(0, 0, canvas.width, canvas.height);
    },
  };
}
