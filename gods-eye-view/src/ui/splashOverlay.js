import * as Cesium from 'cesium';

/**
 * Layar pembuka yang menempel pada globe.
 *
 * KENAPA SEBAGAI LAPISAN CITRA, BUKAN HAMPARAN HTML
 * -------------------------------------------------
 * Hamparan HTML mengambang DI DEPAN layar: ia tidak ikut berputar, tidak ikut
 * miring, dan tidak melengkung mengikuti bola bumi. Yang diminta di sini adalah
 * peta Nusantara merah putih yang terasa MENEMPEL pada Nusantara yang
 * sesungguhnya, lalu memudar sampai menyingkap garis pantai di bawahnya.
 *
 * Satu-satunya cara itu benar adalah menjadikannya lapisan citra pada globe
 * Cesium, dipasang pada kotak bujur/lintang yang sama persis dengan bingkai
 * gambarnya. Dengan begitu gambar itu melengkung bersama bola, bergeser
 * bersama kamera, dan memudar tepat di tempat semestinya.
 *
 * KENAPA BINGKAINYA DIBACA DARI BERKAS, BUKAN DITULIS DI SINI
 * ----------------------------------------------------------
 * Bingkai itu milik gambarnya, bukan milik kode ini. `build-splash-map.mjs`
 * menuliskannya ke config/splash-bounds.json setiap kali petanya dibangun
 * ulang, sehingga keduanya tidak bisa lepas sinkron ketika seseorang mengubah
 * daftar pulau atau padding.
 *
 * KENAPA MEMUDARNYA DIJALANKAN rAF, BUKAN CSS
 * -------------------------------------------
 * Yang memudar di sini adalah `alpha` sebuah lapisan citra WebGL, bukan
 * properti CSS sebuah elemen. CSS tidak menjangkaunya. Pemudaran dijalankan per
 * frame animasi dengan kurva yang sama halusnya, dan setiap frame meminta
 * render ulang supaya globe yang sedang diam tetap ikut memperbarui.
 */

/** Lama memudar, milidetik. */
export const SPLASH_FADE_MS = 5000;

/** Batas menunggu globe selesai memuat sebelum pemudaran dimulai tetap jalan. */
export const GLOBE_READY_TIMEOUT_MS = 20000;

/**
 * Kurva pemudaran — sepadan dengan cubic-bezier(0.37, 0, 0.28, 1) yang dipakai
 * versi CSS-nya: turun mantap sejak awal, lalu melandai di ujung, sehingga
 * tidak ada momen "putus" yang kasat mata.
 *
 * @param {number} t Kemajuan 0..1.
 * @returns {number} Kemajuan yang sudah dilandaikan, 0..1.
 */
export function splashEase(t) {
  // Nilai bukan-angka diperlakukan sebagai awal, bukan diteruskan: `Math.max`
  // meneruskan NaN apa adanya, dan NaN yang lolos ke sini akan menjadi
  // `layer.alpha = NaN`, yang membuat lapisannya menghilang begitu saja.
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  // Kubik masuk-keluar, condong ke depan.
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/**
 * Pasang layar pembuka pada globe, lalu pudarkan.
 *
 * @param {object} options
 * @param {object} options.viewer Cesium Viewer.
 * @param {string} options.imageUrl Berkas gambar splash.
 * @param {{west: number, south: number, east: number, north: number}} options.bounds
 *   Bingkai geografis gambar, dalam derajat.
 * @param {number} [options.durationMs] Lama memudar.
 * @param {boolean} [options.reducedMotion] Bila benar, memudar seketika.
 * @returns {{destroy: Function, isActive: Function}}
 */
export function installSplashOverlay({
  viewer,
  imageUrl = '/splash.svg',
  bounds,
  durationMs = SPLASH_FADE_MS,
  reducedMotion = false,
}) {
  const layers = viewer?.imageryLayers;
  const valid =
    bounds &&
    [bounds.west, bounds.south, bounds.east, bounds.north].every((v) =>
      Number.isFinite(v),
    );
  if (!layers || !valid) {
    return { destroy() {}, isActive: () => false };
  }

  let layer = null;
  let frame = 0;
  let destroyed = false;
  let started = false;

  /** Lepaskan lapisan; aman dipanggil lebih dari sekali. */
  const removeLayer = () => {
    if (!layer) return;
    try {
      // Cesium melempar bila lapisannya sudah dilepas di tempat lain.
      if (!viewer.isDestroyed?.()) layers.remove(layer, true);
    } catch {
      /* sudah tidak ada */
    }
    layer = null;
  };

  const stop = () => {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  // Menghormati pilihan sistem: tanpa gerakan, lapisan cukup ditampilkan
  // sekejap lalu dilepas.
  const total = reducedMotion ? 600 : Math.max(1, durationMs);

  /**
   * Tunggu globe benar-benar menggambar sesuatu, lalu jalankan pemudaran.
   *
   * Ini yang membuat efeknya terbaca. Ubin peta bisa perlu belasan detik pada
   * sambungan lambat; memulai hitungan lima detik saat viewer dibuat berarti
   * peta merah putihnya sudah habis memudar di atas layar kosong sebelum garis
   * pantai di bawahnya sempat muncul — persis kebalikan dari yang diinginkan.
   *
   * Batas waktu tetap dipasang: sebuah globe yang tidak pernah selesai memuat
   * tidak boleh membuat layar pembuka menetap selamanya.
   *
   * @param {() => void} run Dijalankan begitu globe siap, atau saat batas waktu.
   */
  const whenGlobeReady = (run) => {
    const globe = viewer.scene?.globe;
    if (!globe?.tileLoadProgressEvent) {
      run();
      return;
    }
    let done = false;
    // Antrean nol juga benar SEBELUM ubin pertama diminta — globe yang masih
    // kosong melaporkan "tidak ada yang ditunggu" persis seperti globe yang
    // sudah selesai. Menganggapnya siap membuat pemudaran mulai di atas layar
    // hitam; itu yang terjadi pada percobaan pertama. Jadi yang ditunggu adalah
    // satu siklus penuh: ada ubin yang dimuat, LALU antreannya habis.
    let sawLoading = false;
    const finish = () => {
      if (done) return;
      done = true;
      remove?.();
      clearTimeout(timeout);
      run();
    };
    const remove = globe.tileLoadProgressEvent.addEventListener((queued) => {
      if (queued > 0) {
        sawLoading = true;
        return;
      }
      if (sawLoading) finish();
    });
    const timeout = setTimeout(finish, GLOBE_READY_TIMEOUT_MS);
  };

  /** Jalankan pemudaran setelah lapisannya benar-benar terpasang. */
  const startFade = () => {
    if (destroyed || started || !layer) return;
    started = true;
    const start = performance.now();
    const step = (now) => {
      frame = 0;
      if (destroyed || !layer || viewer.isDestroyed?.()) return;
      const progress = Math.min(1, (now - start) / total);
      layer.alpha = 1 - splashEase(progress);
      // Globe yang sedang diam tidak menggambar ulang dengan sendirinya di
      // bawah pengatur render; tanpa permintaan ini pemudarannya tersendat.
      viewer.scene?.requestRender?.();
      if (progress >= 1) {
        removeLayer();
        viewer.scene?.requestRender?.();
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  // `SingleTileImageryProvider.fromUrl` adalah jalur yang benar sejak Cesium
  // 1.104: konstruktornya sendiri kini menuntut tileWidth/tileHeight, yang baru
  // diketahui setelah gambarnya dimuat. Memanggil konstruktor langsung melempar
  // "Expected options.tileWidth to be typeof number" dan layar pembuka tidak
  // pernah muncul.
  Cesium.SingleTileImageryProvider.fromUrl(imageUrl, {
    rectangle: Cesium.Rectangle.fromDegrees(
      bounds.west,
      bounds.south,
      bounds.east,
      bounds.north,
    ),
  })
    .then((provider) => {
      // Aplikasi dapat ditutup selagi gambarnya masih dimuat.
      if (destroyed || viewer.isDestroyed?.()) return;
      layer = layers.addImageryProvider(provider);
      layer.alpha = 1;
      viewer.scene?.requestRender?.();
      whenGlobeReady(startFade);
    })
    .catch((error) => {
      // Gambar yang gagal dimuat tidak boleh menahan aplikasi — globe tetap
      // tampil, hanya tanpa layar pembuka. Tetap dicatat: kegagalan yang
      // sepenuhnya senyap di sini persis yang membuat bug konstruktor di atas
      // sulit ditemukan.
      console.warn('[Splash] layar pembuka tidak dapat dipasang:', error?.message || error);
    });

  return {
    isActive: () => Boolean(layer),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      removeLayer();
    },
  };
}
