/**
 * Deteksi orang YOLOv8 (Human-Detector) pada panel CCTV.
 *
 * MODE KONTINU (AUTO)
 * -------------------
 * Selama sebuah kamera aktif dan CCTV menyala, deteksi berjalan TERUS di
 * latar belakang: tiap siklus meminta /api/cctv/detect/:id, menggambar kotak
 * di atas pratinjau panel DAN di atas video layar penuh (bila terbuka),
 * memperbarui gambar hasil teranotasi dan chip jumlah orang. Tombol AUTO
 * mematikan/menyalakan loop; bawaannya MENYALA — deteksi mengikuti video.
 *
 * Inferensi berjalan di CPU (~2-4 detik per bingkai), jadi overlay ini
 * berkedip lambat by design: video tetap 20 fps, kotak menyegarkan tiap
 * siklus loop.
 */

import { attachLivePersonDetect } from './cctvLiveDetect.js';

/** Selang loop deteksi kontinu (ms) — antara MULAI satu deteksi ke berikutnya. */
const AUTO_INTERVAL_MS = 8_000;

/**
 * Pasang deteksi LANGSUNG (in-browser) pada video panel.
 *
 * Selama aktif, chip diperbarui ~10x/detik dari model peramban dan loop
 * server TIDAK menyentuh chip/overlay (hanya gambar hasil), supaya tidak
 * saling menimpa. Kotak real-time = dari model peramban.
 */
export function _attachCctvLiveDetect(video, cameraId) {
  if (this.destroyed || !video || !this._cctvDetectOverlay) return;
  this._detachCctvLiveDetect();
  this._cctvLiveDetect = {
    cameraId,
    handle: attachLivePersonDetect(video, this._cctvDetectOverlay, {
      cameraId,
      onCount: (count) => {
        if (this.destroyed) return;
        if (this._activeCctvCameraId() !== cameraId) return;
        this._setCctvDetectChip(`ORANG · ${count} · LANGSUNG`, 'ok');
      },
    }),
  };
}

/** Lepaskan deteksi langsung panel (jika ada). */
export function _detachCctvLiveDetect() {
  this._cctvLiveDetect?.handle?.detach();
  this._cctvLiveDetect = null;
}

/** Apakah deteksi in-browser sedang aktif untuk kamera aktif. */
export function _cctvLiveDetectActive() {
  return !!this._cctvLiveDetect;
}

/** Ganti teks chip status deteksi. */
export function _setCctvDetectChip(text, state) {
  if (!this._cctvDetectChip) return;
  this._cctvDetectChip.textContent = text;
  this._cctvDetectChip.dataset.detectState = state || '';
}

/** Sembunyikan overlay dan hapus semua kotak deteksi. */
export function _clearCctvDetectOverlay() {
  const canvas = this._cctvDetectOverlay;
  if (!canvas) return;
  canvas.hidden = true;
  const context = canvas.getContext('2d');
  context?.clearRect(0, 0, canvas.width, canvas.height);
}

/** Sembunyikan gambar hasil anotasi deteksi. */
export function _clearCctvDetectResult() {
  if (this._cctvDetectResultBlock) this._cctvDetectResultBlock.hidden = true;
  if (this._cctvDetectResult) this._cctvDetectResult.removeAttribute('src');
}

/** Gambar kotak berlabel hasil deteksi pada satu kanvas (ruang kanvas px). */
function paintDetectionBoxes(canvas, result) {
  const frameWidth = Number(result?.width);
  const frameHeight = Number(result?.height);
  const persons = Array.isArray(result?.persons) ? result.persons : [];
  if (!canvas || !frameWidth || !frameHeight) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;
  canvas.width = canvas.clientWidth || canvas.width;
  canvas.height = canvas.clientHeight || canvas.height;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!persons.length) return false;
  const scaleX = canvas.width / frameWidth;
  const scaleY = canvas.height / frameHeight;
  // Warna kotak sama dengan app.py repo Human-Detector: rgb(37, 99, 235).
  context.strokeStyle = 'rgba(37, 99, 235, 0.95)';
  context.lineWidth = 2;
  context.font = '11px monospace';
  persons.forEach((person, index) => {
    const [x1, y1, x2, y2] = person.box;
    const left = x1 * scaleX;
    const top = y1 * scaleY;
    const boxWidth = (x2 - x1) * scaleX;
    const boxHeight = (y2 - y1) * scaleY;
    context.strokeRect(left, top, boxWidth, boxHeight);
    const label = `P${index + 1} ${Math.round(person.conf * 100)}%`;
    const textWidth = context.measureText(label).width;
    context.fillStyle = 'rgba(37, 99, 235, 0.95)';
    context.fillRect(left, Math.max(0, top - 14), textWidth + 8, 14);
    context.fillStyle = '#ffffff';
    context.fillText(label, left + 4, Math.max(10, top - 3));
  });
  return true;
}

/**
 * Gambar kotak-kotak hasil deteksi di atas pratinjau panel.
 *
 * Koordinat kotak berada di ruang bingkai asli (result.width ×
 * result.height); kanvas diskalakan ke ukuran tampil pratinjau.
 */
export function _drawCctvDetectOverlay(result) {
  const canvas = this._cctvDetectOverlay;
  const wrap = this._cctvFrameWrap;
  if (!canvas || !wrap) return;
  const wrapWidth = wrap.clientWidth;
  const wrapHeight = wrap.clientHeight;
  if (!wrapWidth || !wrapHeight) {
    this._clearCctvDetectOverlay();
    return;
  }
  canvas.width = wrapWidth;
  canvas.height = wrapHeight;
  const painted = paintDetectionBoxes(canvas, result);
  canvas.hidden = !painted;
}

/** Gambar kotak di atas video layar penuh (bila penampilnya terbuka). */
export function _drawCctvMaximizeOverlay(result) {
  const canvas = this._maximizeViewer?.detectOverlay?.();
  if (!canvas) return;
  const stage = canvas.parentElement;
  const video = stage?.querySelector('video');
  const width = video?.clientWidth || stage?.clientWidth;
  const height = video?.clientHeight || stage?.clientHeight;
  if (!width || !height) return;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = width;
  canvas.height = height;
  const painted = paintDetectionBoxes(canvas, result);
  canvas.hidden = !painted;
}

/**
 * Tampilkan gambar hasil anotasi dari layanan deteksi.
 *
 * Layanan YOLOv8 menggambar kotak, label, dan banner jumlah orang langsung
 * pada bingkai (persis demo repo Human-Detector) dan mengirimnya sebagai
 * JPEG base64 — tampil untuk SEMUA jenis kamera, termasuk HLS yang
 * pratinjau panelnya SVG sintetis.
 */
export function _showCctvDetectResult(result) {
  if (!this._cctvDetectResultBlock || !this._cctvDetectResult) return;
  const image = String(result?.annotated || '');
  if (!image) {
    this._clearCctvDetectResult();
    return;
  }
  this._cctvDetectResult.src = `data:image/jpeg;base64,${image}`;
  this._cctvDetectResultBlock.hidden = false;
}

/** Sinkronkan label tombol AUTO dengan keadaan loop. */
export function _syncCctvDetectAutoButton() {
  const button = this._cctvDetectAutoBtn;
  if (!button) return;
  button.classList.toggle('active', this._cctvDetectAuto);
  button.setAttribute('aria-pressed', String(this._cctvDetectAuto));
  button.textContent = this._cctvDetectAuto ? 'AUTO AKTIF' : 'AUTO MATI';
}

/**
 * Jalankan SATU siklus deteksi untuk kamera aktif: permintaan → gambar ke
 * panel + layar penuh → perbarui chip & gambar hasil. Aman dipanggil
 * berulang dari loop.
 */
export async function _runCctvPersonDetection() {
  if (this.destroyed || !this._cctvDetectBtn) return null;
  const cameraId = this._activeCctvCameraId();
  if (!cameraId) {
    this._setCctvDetectChip('PILIH KAMERA DULU', 'idle');
    return null;
  }
  if (this._cctvDetectBusy) return null; // siklus sebelumnya belum selesai
  const button = this._cctvDetectBtn;
  button.disabled = true;
  this._cctvDetectBusy = true;
  // Saat deteksi in-browser aktif, chip milik model peramban (~10x/detik) —
  // jangan ditimpa fase "MEMUAT" milik siklus server.
  if (!this._cctvLiveDetectActive()) {
    this._setCctvDetectChip('DETEKSI · MEMUAT', 'loading');
  }
  try {
    const response = await fetch(
      `/api/cctv/detect/${encodeURIComponent(cameraId)}`,
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      const reason = String(payload.error || `HTTP ${response.status}`);
      const offline = response.status === 0 || reason.includes('fetch failed');
      // Dalam mode kontinu, satu siklus gagal TIDAK membuang kotak terakhir
      // yang sudah tampil di video — upstream CCTV memang kadang gagal buka
      // lalu berhasil pada percobaan berikutnya. Tampilkan status mengulang.
      const lastGood = this._cctvDetectLastPayload?.[cameraId];
      if (this._cctvLiveDetectActive()) {
        // Model peramban memegang chip — jangan ditimpa status server.
      } else if (lastGood) {
        const keep = payload.count ?? lastGood.count;
        this._setCctvDetectChip(`ORANG · ${keep} · MENUNGGU UMPAN`, 'loading');
      } else {
        this._setCctvDetectChip(
          offline ? 'LAYANAN DETEKSI MATI' : `DETEKSI GAGAL · ${reason}`,
          'error',
        );
        this._clearCctvDetectOverlay();
        this._clearCctvDetectResult();
      }
      return null;
    }
    if (!this._cctvDetectLastPayload) this._cctvDetectLastPayload = {};
    this._cctvDetectLastPayload[cameraId] = payload;
    // Saat deteksi in-browser aktif, kotak real-time milik model peramban —
    // jangan timpa dengan potongan server yang lebih tua; cukup gambar hasil.
    if (!this._cctvLiveDetectActive()) {
      this._drawCctvDetectOverlay(payload);
      this._drawCctvMaximizeOverlay(payload);
      const streamNote = payload.frameSource === 'upstream-stream' ? ' · LIVE' : '';
      this._setCctvDetectChip(`ORANG · ${payload.count}${streamNote}`, 'ok');
    }
    this._showCctvDetectResult(payload);
    return payload;
  } catch {
    const cameraId2 = this._activeCctvCameraId();
    const lastGood = cameraId2 ? this._cctvDetectLastPayload?.[cameraId2] : null;
    if (lastGood) {
      this._setCctvDetectChip(`ORANG · ${lastGood.count} · MENUNGGU UMPAN`, 'loading');
    } else {
      this._setCctvDetectChip('LAYANAN DETEKSI MATI', 'error');
      this._clearCctvDetectOverlay();
      this._clearCctvDetectResult();
    }
    return null;
  } finally {
    this._cctvDetectBusy = false;
    if (!this.destroyed) button.disabled = false;
  }
}

/**
 * Satu ketukan loop kontinu. Guard ringan: tanpa kamera aktif atau CCTV
 * mati, siklus dilewati tanpa permintaan jaringan.
 */
function runAutoTick(controls) {
  if (controls.destroyed || !controls._cctvDetectAuto) return;
  if (!controls._activeCctvCameraId()) return;
  if (!controls.actions?.isEnabled?.()) return;
  controls._runCctvPersonDetection();
}

/** Nyalakan loop deteksi kontinu. */
export function _startCctvDetectLoop() {
  if (this._cctvDetectAutoTimer || this.destroyed) return;
  this._cctvDetectAutoTimer = setInterval(() => runAutoTick(this), AUTO_INTERVAL_MS);
  // Node (unit test): jangan biarkan timer menggantung event loop.
  this._cctvDetectAutoTimer?.unref?.();
  // Siklus pertama tanpa menunggu selang penuh.
  runAutoTick(this);
}

/** Matikan loop deteksi kontinu. */
export function _stopCctvDetectLoop() {
  if (this._cctvDetectAutoTimer) {
    clearInterval(this._cctvDetectAutoTimer);
    this._cctvDetectAutoTimer = null;
  }
}

/**
 * Sinkronkan loop dengan keadaan kamera: menyala otomatis saat kamera aktif
 * (video berjalan), berhenti saat tidak ada — selama operator tidak
 * mematikan AUTO secara eksplisit.
 */
export function _syncCctvDetectAutoRun(active) {
  if (this.destroyed) return;
  if (this._cctvDetectAuto && active) {
    this._startCctvDetectLoop();
  } else if (!active) {
    this._stopCctvDetectLoop();
  }
  this._syncCctvDetectAutoButton();
}

/** Alih mode AUTO dari tombol. */
export function _toggleCctvDetectAuto() {
  this._cctvDetectAuto = !this._cctvDetectAuto;
  this._syncCctvDetectAutoButton();
  if (this._cctvDetectAuto) {
    this._startCctvDetectLoop();
  } else {
    this._stopCctvDetectLoop();
  }
}

/** Ikat tombol DETECT dan AUTO; dipanggil dari CctvControls. */
export function _initCctvDetectionControls() {
  if (!this._cctvDetectBtn) return;
  this.listen(this._cctvDetectBtn, 'click', () => {
    this._runCctvPersonDetection();
  });
  this.listen(this._cctvDetectAutoBtn, 'click', () => {
    this._toggleCctvDetectAuto();
  });
  // Bawaan AUTO MENYALA — deteksi mengikuti video begitu kamera aktif.
  this._cctvDetectAuto = true;
  this._syncCctvDetectAutoButton();
}
