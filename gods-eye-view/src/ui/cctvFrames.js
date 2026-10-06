import {
  fetchStreamInfo,
  isVideoFeed,
  mountCameraMedia,
} from './cctvMedia.js';

export function _clearCctvFrame() {
  this._cctvFrameRequestToken += 1;
  // Kotak deteksi & gambar hasil milik bingkai kamera sebelumnya — jangan
  // biarkan menempel pada kamera berikutnya.
  this._clearCctvDetectOverlay?.();
  this._clearCctvDetectResult?.();
  this._setCctvDetectChip?.('ORANG · --', 'idle');
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  if (this._cctvFrame) {
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrame.dataset.cameraId = '';
    this._cctvFrame.dataset.currentSrc = '';
    this._cctvFrame.dataset.loading = '';
    this._cctvFrame.dataset.error = '';
  }
  this._cctvFrameWrap?.classList.remove('loading', 'has-frame');
}

export function _queueCctvFrame(src, cameraId, cameraChanged) {
  if (this.destroyed || !this._cctvFrame || !src) return;

  if (cameraChanged) {
    // A different camera gets an honest acquisition state. Never retain
    // the prior camera's pixels under the newly selected metadata.
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrameWrap?.classList.remove('has-frame');
  }

  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  const token = ++this._cctvFrameRequestToken;
  this._cctvFrame.dataset.cameraId = cameraId;
  this._cctvFrame.dataset.currentSrc = src;
  this._cctvFrame.dataset.loading = 'true';
  this._cctvFrame.dataset.error = '';
  this._cctvFrameWrap?.classList.toggle(
    'loading',
    !this._cctvFrameWrap?.classList.contains('has-frame'),
  );

  const preloader = new Image();
  this._cctvFramePreloader = preloader;
  preloader.onload = () => this._settleCctvFrame(token, src, true);
  preloader.onerror = () => this._settleCctvFrame(token, src, false);
  preloader.src = src;
}

export function _settleCctvFrame(token, src, ok) {
  if (
    this.destroyed ||
    !this._cctvFrame ||
    token !== this._cctvFrameRequestToken
  )
    return;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  this._cctvFrame.dataset.loading = '';
  this._cctvFrameWrap?.classList.remove('loading');

  const syncBadge = () =>
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );

  if (!ok) {
    // Leave the element untouched — a settled frame stays on screen.
    this._cctvFrame.dataset.error = 'true';
    syncBadge();
    return;
  }

  this._cctvFrame.dataset.error = '';
  this._cctvFrame.src = src;
  this._cctvFrame.classList.add('active');
  this._cctvFrameWrap?.classList.add('has-frame');
  syncBadge();
}

/**
 * Lepaskan video langsung yang terpasang di pratinjau panel dan kembalikan
 * jalur gambar (img) seperti semula.
 */
export function _detachCctvLiveVideo() {
  this._detachCctvLiveDetect?.();
  if (this._cctvLiveMedia) {
    try {
      this._cctvLiveMedia.detach();
    } catch {
      /* pembongkaran tidak boleh melempar */
    }
    this._cctvLiveMedia.element?.remove();
    this._cctvLiveMedia = null;
    this._cctvLiveMediaCameraId = '';
  }
  if (this._cctvFrame?.style) this._cctvFrame.style.display = '';
  // Pemasangan video memakai replaceChildren — pastikan img & kanvas overlay
  // kembali menjadi anak wrap sebelum dipakai lagi.
  const wrap = this._cctvFrameWrap;
  if (typeof wrap?.appendChild === 'function') {
    if (this._cctvFrame && this._cctvFrame.parentElement !== wrap) {
      wrap.appendChild(this._cctvFrame);
    }
    if (this._cctvDetectOverlay && this._cctvDetectOverlay.parentElement !== wrap) {
      wrap.appendChild(this._cctvDetectOverlay);
    }
  }
}

/**
 * Pasang VIDEO LANGSUNG di pratinjau panel untuk kamera HLS/video.
 *
 * KENAPA: untuk umpan video, `/api/cctv/frame/:id` hanya mengembalikan SVG
 * sintetis (proxy tidak punya pendekode video), sehingga pratinjau panel
 * dulu tampak beku padahal umpannya hidup — operator menyimpulkan "CCTV
 * tidak jalan". Kini panel memutar stream yang sama dengan layar penuh
 * (lewat mountCameraMedia + hls.js), dan jalur img tetap dipakai untuk
 * kamera bingkai diam.
 */
export async function _syncCctvLiveVideo(camera, enabled) {
  if (this.destroyed) return;
  const wantsVideo = !!(enabled && camera && isVideoFeed(camera.feedType));
  if (!wantsVideo) {
    if (this._cctvLiveMedia) this._detachCctvLiveVideo();
    return;
  }
  const cameraId = camera.id;
  if (this._cctvLiveMediaCameraId === cameraId && this._cctvLiveMedia) {
    return; // sudah terpasang untuk kamera ini
  }
  this._detachCctvLiveVideo();
  this._cctvLiveMediaCameraId = cameraId;
  const info = await fetchStreamInfo(cameraId);
  if (this.destroyed || this._cctvLiveMediaCameraId !== cameraId) return;
  if (!info?.mediaUrl) return; // tak ada media — biarkan jalur gambar bekerja
  if (this._cctvFrame) this._cctvFrame.style.display = 'none';
  const mounted = mountCameraMedia({
    documentRef: document,
    container: this._cctvFrameWrap,
    info,
    className: 'cctv-media cctv-live-video',
    refreshMs: 0,
  });
  if (mounted) {
    this._cctvFrameWrap?.classList.add('has-frame');
    this._cctvFrameWrap?.classList.remove('loading');
    this._cctvLiveMedia = mounted;
    // mountCameraMedia memakai replaceChildren — img dan kanvas overlay
    // deteksi terbuang dari wrap. Kembalikan: img disembunyikan selagi video
    // berputar, kanvas tetap di atas video untuk kotak real-time.
    const wrap = this._cctvFrameWrap;
    const canAppend = typeof wrap?.appendChild === 'function';
    if (canAppend && this._cctvFrame && this._cctvFrame.parentElement !== wrap) {
      wrap.appendChild(this._cctvFrame);
    }
    if (canAppend && this._cctvDetectOverlay && this._cctvDetectOverlay.parentElement !== wrap) {
      wrap.appendChild(this._cctvDetectOverlay);
    }
    if (this._cctvFrame?.style) this._cctvFrame.style.display = 'none';
    // Deteksi LANGSUNG di peramban: kotak orang real-time di atas video
    // panel (loop server tetap jalan untuk gambar hasil & pelabelan).
    this._attachCctvLiveDetect?.(mounted.element, cameraId);
  }
}

export function _syncCctvSourceBadge(activeCamera, enabled) {  if (!this._cctvSourceBadge) return;
  if (!enabled || !activeCamera) {
    this._cctvSourceBadge.textContent = 'SUMBER · TIDAK DIKETAHUI';
    this._cctvSourceBadge.dataset.frameState = 'idle';
    return;
  }
  const hasDisplayedFrame =
    this._cctvFrameWrap?.classList.contains('has-frame');
  if (this._cctvFrame?.dataset.loading === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'BINGKAI · MEMUAT';
    this._cctvSourceBadge.dataset.frameState = 'loading';
    return;
  }
  if (this._cctvFrame?.dataset.error === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'BINGKAI · TIDAK TERSEDIA';
    this._cctvSourceBadge.dataset.frameState = 'error';
    return;
  }
  const kind = String(
    activeCamera.sourceKind || activeCamera.feedType || 'unknown',
  ).toUpperCase();
  const status = String(activeCamera.sourceStatus || 'unknown').toUpperCase();
  this._cctvSourceBadge.textContent = `${kind} · ${status}`;
  this._cctvSourceBadge.dataset.frameState = 'ready';
}
