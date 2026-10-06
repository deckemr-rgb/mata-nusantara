/**
 * HLS playback attachment for CCTV monitor planes.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other CCTV feed type this layer handles can be assigned straight to a
 * video element: `video.src = url` works for MP4 and WebM in every browser.
 * HLS cannot. Safari plays `.m3u8` natively, but Chrome, Edge and Firefox do
 * not — assigning a playlist URL there fails silently, leaving a camera that
 * is online and correctly proxied looking permanently dead.
 *
 * Indonesian ATCS portals stream HLS almost exclusively, so without this the
 * whole Indonesia pack would render as placeholder frames.
 *
 * WHY hls.js IS LOADED LAZILY
 * ---------------------------
 * hls.js is ~200 KB and most cameras in the catalog are still-image feeds. A
 * dynamic import keeps it in its own chunk that is fetched the first time an
 * HLS camera is actually opened, rather than on every page load.
 */

/** Cached module promise, so N cameras share one fetch of the library. */
let hlsModulePromise = null;

/**
 * Whether the browser can play HLS by itself (Safari, iOS WebKit).
 *
 * @param {HTMLVideoElement} video - Element to probe.
 * @returns {boolean}
 */
export function supportsNativeHls(video) {
  if (!video || typeof video.canPlayType !== 'function') return false;
  return Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
}

/** Load hls.js on first use; resolves to null if it cannot be loaded. */
async function loadHlsModule() {
  if (!hlsModulePromise) {
    hlsModulePromise = import('hls.js')
      .then((mod) => mod?.default || mod || null)
      .catch(() => null);
  }
  return hlsModulePromise;
}

/**
 * Point a video element at a stream URL, choosing the mechanism the feed and
 * the browser require.
 *
 * Returns a detach function in every case — including the failure paths — so
 * the caller's teardown is unconditional and never has to ask what happened
 * here.
 *
 * @param {HTMLVideoElement} video - Target element.
 * @param {string} url - Media URL (proxied through /api/cctv/media/:id).
 * @param {string} feedType - Normalized feed type ('hls', 'mp4', 'webm').
 * @returns {() => void} Detach function; safe to call more than once.
 */
export function attachVideoSource(video, url, feedType) {
  if (!video || !url) return () => {};

  if (feedType !== 'hls') {
    video.src = url;
    return () => {
      video.removeAttribute('src');
      video.load();
    };
  }

  // Safari: the native player handles the playlist, and doing it natively also
  // keeps hardware decoding on iOS.
  if (supportsNativeHls(video)) {
    video.src = url;
    return () => {
      video.removeAttribute('src');
      video.load();
    };
  }

  // Everywhere else: hls.js drives the element through Media Source
  // Extensions. The import is async, so a camera closed before the library
  // arrives must not leave an orphaned player attached to a dead element.
  let detached = false;
  let instance = null;

  loadHlsModule().then((Hls) => {
    if (detached || !Hls?.isSupported?.()) {
      // No MSE and no native support: nothing can play this feed. The monitor
      // plane keeps its placeholder rather than showing a broken element.
      return;
    }
    instance = new Hls({
      // These are live municipal streams: recovering to the live edge matters
      // more than replaying what was missed while the tab was backgrounded.
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 2,
      fragLoadingMaxRetry: 2,
    });
    instance.on(Hls.Events.ERROR, (_event, data) => {
      if (!data?.fatal) return;
      // Fatal network/media errors are routine on public CCTV — a camera goes
      // down, a segment 404s. Try the documented recoveries once each, then
      // give up and leave the placeholder in place.
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        instance.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        instance.recoverMediaError();
      } else {
        instance.destroy();
        instance = null;
      }
    });
    instance.loadSource(url);
    instance.attachMedia(video);
  });

  return () => {
    detached = true;
    if (instance) {
      instance.destroy();
      instance = null;
    }
    video.removeAttribute('src');
    video.load();
  };
}
