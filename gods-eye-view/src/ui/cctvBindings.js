import { selectWallCameras } from './cctvWall.js';
export function _initCctvPanel() {
  if (!this._cctvPanel) return;

  this._initCctvMaximizeControls();

  this.listen(this._cctvEnableBtn, 'click', async () => {
    this._actionGeneration++;
    await this.actions.toggleEnabled();
  });

  this.listen(this._cctvNearestBtn, 'click', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    this.actions.runExplicitFocus(
      () => this.cctv.focusNearest({ focus: false }),
      (cameraId) => this.cctv.focusCamera(cameraId, 1.8),
    );
  });

  this.listen(this._cctvPrevBtn, 'click', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    this.actions.runExplicitFocus(
      () => this.cctv.cycleCamera(-1),
      (cameraId) => this.cctv.focusCamera(cameraId, 1.4),
    );
  });

  this.listen(this._cctvNextBtn, 'click', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    this.actions.runExplicitFocus(
      () => this.cctv.cycleCamera(1),
      (cameraId) => this.cctv.focusCamera(cameraId, 1.4),
    );
  });

  this.listen(this._cctvSelect, 'change', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    const cameraId = this._cctvSelect.value;
    if (!cameraId) return;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    // Picking a camera from the dropdown flies to it. The catalog spans
    // three metros, so a bare selection used to leave the view in the old
    // city with a camera active thousands of km away.
    this.actions.runExplicitFocus(
      () => (this.cctv.selectCamera(cameraId) ? cameraId : null),
      (selectedId) => this.cctv.focusCamera(selectedId, 2.2),
    );
    this.actions.setParams({ selectedCameraId: cameraId }, { origin: 'user' });
  });

  this.listen(this._cctvFocusBtn, 'click', async () => {
    const generation = ++this._actionGeneration;
    const activeId = this._cctvState?.activeCameraId;
    const selected = this._cctvState?.activeCameraId || this._cctvSelect?.value;
    if (!selected) return;
    if (!(await this.actions.toggleEnabled(true))) return;
    if (
      this.destroyed ||
      generation !== this._actionGeneration ||
      !this.actions.isEnabled() ||
      (activeId && activeId !== this._cctvState?.activeCameraId)
    )
      return;
    this.actions.runExplicitFocus(
      () => selected,
      (cameraId) => this.cctv.focusCamera(cameraId, 1.9),
    );
    this.actions.setParams({ selectedCameraId: selected }, { origin: 'user' });
  });

  this.listen(this._cctvCoverageBtn, 'click', () => {
    const current =
      this._cctvState?.coverageMode ||
      (this._cctvState?.showCoverage ? 'on' : 'off');
    const next =
      current === 'off' ? 'on' : current === 'on' ? 'viewshed' : 'off';
    this.actions.setParams({ coverageMode: next }, { origin: 'user' });
  });

  this.listen(this._cctvAutoHopBtn, 'click', () => {
    const current = !!this._cctvState?.autoHop;
    this.actions.setParams({ autoHop: !current }, { origin: 'user' });
  });

  this.listen(this._cctvProjectionBtn, 'click', () => {
    const current = this._cctvState?.showProjection !== false;
    this.actions.setParams({ showProjection: !current }, { origin: 'user' });
  });

  this.listen(this._cctvAdjustBtn, 'click', () => {
    const current = !!this._cctvState?.calibrationMode;
    this.actions.setParams({ calibrationMode: !current }, { origin: 'user' });
  });

  // Click-to-edit pose readout: each chip swaps to a number input; Enter or
  // blur commits (converted to a calibration offset against basePose),
  // Escape cancels. Delegated so re-renders never re-bind.
  this.listen(this._cctvCalReadout, 'click', (event) => {
    const chip = event.target.closest?.('.cctv-cal-value');
    if (!chip || chip.disabled || chip.querySelector('input')) return;
    this._beginCctvCalValueEdit(chip);
  });

  this.listen(this._cctvCalibSaveBtn, 'click', () => {
    const cameraId = this._activeCctvCameraId();
    if (!cameraId || !this.actions.setParams) return;
    this.actions.setParams(
      {
        selectedCameraId: cameraId,
        calibration: { cameraId, save: true },
      },
      { origin: 'user' },
    );
    this.actions.showToast('CCTV calibration saved');
  });

  this.listen(this._cctvCalibResetBtn, 'click', () => {
    this._resetCctvCalibration();
  });

  this._renderCctvState(null);
  this.actions.syncViewport();
}

/**
 * Pasang kontrol layar penuh: tombol FULL SCREEN, pengalih AUTO FULL, dan
 * klik pada pratinjau di panel.
 *
 * Dipanggil dari `_initCctvPanel`. Dipisah agar jalur layar penuh dapat dibaca
 * sebagai satu kesatuan, bukan tersebar di antara kontrol panel lainnya.
 */
export function _initCctvMaximizeControls() {
  /** Buka penampil untuk kamera yang sedang aktif, bila ada. */
  const openActive = () => {
    const state = this._cctvState;
    const id = state?.activeCameraId;
    if (!id) {
      // Tanpa kamera aktif tidak ada yang bisa diperbesar; diam lebih baik
      // daripada membuka panggung kosong.
      return;
    }
    const camera =
      state.activeCamera ||
      (state.cameras || []).find((entry) => entry.id === id) ||
      null;
    this._maximizeViewer?.open(id, {
      name: camera?.name || id,
      city: camera?.city || '',
      provider: camera?.provider || '',
    });
  };

  this.listen(this._cctvMaximizeBtn, 'click', openActive);
  this.listen(this._cctvFrameWrap, 'click', openActive);

  this.listen(this._cctvAutoMaximizeBtn, 'click', () => {
    this._autoMaximize = !this._autoMaximize;
    this._syncAutoMaximizeButton();
    // Menyalakannya selagi sebuah kamera sudah aktif membuka kamera itu
    // sekarang juga, supaya pengalihnya terasa langsung bekerja.
    if (this._autoMaximize && this._cctvState?.activeCameraId) openActive();
  });

  this._initCctvWallControls();
  this._syncAutoMaximizeButton();
}

/** Tulis label dan status tertekan pengalih AUTO FULL. */
export function _syncAutoMaximizeButton() {
  const button = this._cctvAutoMaximizeBtn;
  if (!button) return;
  const on = !!this._autoMaximize;
  button.classList.toggle('active', on);
  button.setAttribute('aria-pressed', String(on));
  button.textContent = on ? 'AUTO PENUH AKTIF' : 'AUTO PENUH MATI';
}

/**
 * Pasang tombol dinding 3x3.
 *
 * Dipanggil dari `_initCctvMaximizeControls`, karena dinding dan layar penuh
 * adalah dua sisi permukaan yang sama: dinding untuk memindai kawasan, layar
 * penuh untuk memeriksa satu kamera.
 */
export function _initCctvWallControls() {
  this.listen(this._cctvWallBtn, 'click', () => {
    const state = this._cctvState;
    const cameras = state?.cameras || [];
    if (!cameras.length) return;
    // Kamera aktif menjadi acuan sehingga dinding terbaca sebagai satu
    // kawasan; tanpa kamera aktif, sembilan pertama sudah cukup.
    const anchor =
      state.activeCamera ||
      cameras.find((entry) => entry.id === state?.activeCameraId) ||
      null;
    const selected = selectWallCameras(cameras, anchor);
    if (!selected.length) return;
    this._wall?.open(selected, {
      title: anchor?.city
        ? `DINDING CCTV 3×3 · ${String(anchor.city).toUpperCase()}`
        : 'DINDING CCTV 3×3',
    });
  });
}
