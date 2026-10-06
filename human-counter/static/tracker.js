/* Human Counter — pelacak orang dengan deduplikasi berbasis IoU.
 *
 * Satu kamera = satu PelacakKamera:
 *  - deteksi COCO-SSD per ~150ms di atas video yang berputar;
 *  - deteksi dicocokkan ke jejak hidup lewat IoU (>= 0.3) → orang yang SAMA;
 *  - jejak baru = orang BARU melewati kamera → kirim event sekali
 *    (eventKey unik; pengiriman ulang tidak menduplikasi — backend juga);
 *  - jejak yang tak terlihat > JEDA_HIDUP_MS dianggap sudah keluar pandangan.
 */
"use strict";

const JEDA_HIDUP_MS = 4000; // jejak mati bila tak terlihat selama ini
const AMBANG_IOU = 0.3;
const SELANG_DETEKSI_MS = 150;

function iouBox(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

class PelacakKamera {
  /**
   * @param {object} opts
   * @param {string} opts.cameraId
   * @param {HTMLVideoElement} opts.video
   * @param {HTMLCanvasElement} opts.canvas
   * @param {object} opts.model model COCO-SSD yang sudah dimuat
   * @param {(event: object) => void} opts.onNewPerson dipanggil saat orang baru tercatat
   * @param {(cameraId: string, count: number) => void} opts.onLiveCount
   */
  constructor(opts) {
    this.cameraId = opts.cameraId;
    this.video = opts.video;
    this.canvas = opts.canvas;
    this.model = opts.model;
    this.onNewPerson = opts.onNewPerson;
    this.onLiveCount = opts.onLiveCount;
    this.tracks = [];
    this.serial = 0;
    this.epoch = Date.now();
    this.stopped = false;
    this.timer = setTimeout(() => this.tick(), 400);
    this.timer?.unref?.();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  tick = async () => {
    if (this.stopped) return;
    try {
      const video = this.video;
      if (video.readyState >= 2 && !video.paused && video.videoWidth) {
        if (video.paused) video.play?.().catch(() => {});
        const predictions = await this.model.detect(video, 20, 0.3);
        if (!this.stopped) this.update(predictions);
      }
      // panggilan lintas-reload: jejak lama yang mati dibersihkan
      const now = performance.now();
      this.tracks = this.tracks.filter((t) => now - t.lastSeenMs <= JEDA_HIDUP_MS + 60000);
    } catch {
      /* satu frame gagal bukan alasan berhenti */
    }
    if (!this.stopped) this.timer = setTimeout(() => this.tick(), SELANG_DETEKSI_MS);
  };

  update(predictions) {
    const persons = predictions.filter((p) => p.class === "person");
    const now = performance.now();
    const live = this.tracks.filter((t) => now - t.lastSeenMs <= JEDA_HIDUP_MS);
    const matchedTracks = new Set();
    const context = this.canvas.getContext("2d");
    const showW = this.video.clientWidth || this.canvas.width;
    const showH = this.video.clientHeight || this.canvas.height;
    if (this.canvas.width !== showW || this.canvas.height !== showH) {
      this.canvas.width = showW;
      this.canvas.height = showH;
    }
    this.canvas.hidden = false;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const scaleX = this.canvas.width / (this.video.videoWidth || this.canvas.width);
    const scaleY = this.canvas.height / (this.video.videoHeight || this.canvas.height);

    let liveCount = 0;
    for (const det of persons) {
      const box = det.bbox; // [x, y, w, h] px video asli
      const boxXY = [box[0], box[1], box[0] + box[2], box[1] + box[3]];
      let best = null;
      let bestIou = AMBANG_IOU;
      for (const track of live) {
        if (matchedTracks.has(track)) continue;
        const score = iouBox(boxXY, track.boxXY);
        if (score > bestIou) {
          bestIou = score;
          best = track;
        }
      }
      if (best) {
        // ORANG YANG SAMA — cukup perpanjang jejaknya.
        best.boxXY = boxXY;
        best.box = box;
        best.lastSeenMs = now;
        best.frames += 1;
        best.maxConf = Math.max(best.maxConf, det.score);
        matchedTracks.add(best);
      } else {
        // ORANG BARU melewati kamera → daftarkan.
        this.serial += 1;
        const track = {
          id: this.serial,
          key: `${this.cameraId}:${this.serial}:${this.epoch}`,
          boxXY,
          box,
          firstSeenMs: now,
          lastSeenMs: now,
          frames: 1,
          maxConf: det.score,
        };
        this.tracks.push(track);
        this.onNewPerson?.({
          eventKey: track.key,
          cameraId: this.cameraId,
          firstSeen: new Date().toISOString(),
          frames: 1,
          conf: det.score,
          bbox: boxXY,
        });
      }
      liveCount += 1;
      // gambar kotak
      const x = box[0] * scaleX;
      const y = box[1] * scaleY;
      const w = box[2] * scaleX;
      const h = box[3] * scaleY;
      context.strokeStyle = "#00e5ff";
      context.lineWidth = 2;
      context.strokeRect(x, y, w, h);
      const label = `${Math.round(det.score * 100)}%`;
      context.fillStyle = "rgba(0, 229, 255, 0.85)";
      context.fillRect(x, Math.max(0, y - 13), context.measureText(label).width + 6, 13);
      context.fillStyle = "#04070b";
      context.fillText(label, x + 3, Math.max(10, y - 3));
    }
    this.onLiveCount?.(this.cameraId, liveCount);
  }
}

window.PelacakKamera = PelacakKamera;
