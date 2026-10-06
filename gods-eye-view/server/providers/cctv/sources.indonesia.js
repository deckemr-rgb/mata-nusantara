/**
 * Indonesian ATCS camera loaders.
 *
 * Each Indonesian city runs its own Area Traffic Control System portal, built
 * by its own Dinas Perhubungan on its own stack, so there is no national
 * endpoint to point at — every city needs its own adapter. This module holds
 * them, and `catalog.js` registers each as an independently-gated live pack.
 *
 * SCOPE: these are cameras the cities themselves publish for road users, read
 * through the same keyless endpoints the portals' own public maps call. This
 * module never probes for unlisted cameras and never touches a device behind
 * authentication. A city that takes its portal down simply drops out of the
 * catalog.
 *
 * HEADINGS ARE LOW CONFIDENCE EVERYWHERE HERE. No Indonesian portal publishes
 * a bearing field. The best available signal is an "Arah <cardinal>" phrase in
 * the camera label, which is a convention rather than a measurement, and many
 * of these are PTZ domes whose true facing changes as an operator drives them.
 * See directionTextIndonesian.js for why bare cardinals are never read.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_JOGJA_CCTV_URL,
  JOGJA_STREAM_ORIGIN,
  DEFAULT_JOGJA_MAX_SOURCES,
  JOGJA_CENTER,
  BANDUNG_LOCATIONS_URL,
  BANDUNG_CAMERA_LIST_URL,
  BANDUNG_CAMERA_INFO_URL,
  BANDUNG_STREAM_ORIGIN,
  DEFAULT_BANDUNG_MAX_SOURCES,
  BANDUNG_CENTER,
  BANDUNG_RESOLVE_CONCURRENCY,
  DEFAULT_JAKARTA_PORTAL_URL,
  JAKARTA_STREAM_ORIGINS,
  DEFAULT_JAKARTA_LOCATIONS_FILE,
  DEFAULT_JAKARTA_MAX_SOURCES,
  JAKARTA_CENTER,
  JAKARTA_GROUND_ELEVATION_M,
  DEFAULT_INDONESIA_SOURCE_FILE,
  INDONESIA_MAX_CATALOG_BYTES,
  INDONESIA_CAMERA_DEFAULTS,
} from './constants.js';
import { fetchCctvCatalog } from './connect.js';
import {
  toFiniteNumber,
  isLikelyJogjaCoordinate,
  isLikelyBandungCoordinate,
  isLikelyIndonesiaCoordinate,
  isLikelyJakartaCoordinate,
  fallbackHeadingFromId,
  cameraDisplayCode,
  prioritizeSources,
} from './normalize.js';
import { indonesianDirectionToHeading } from '../../../src/data/directionTextIndonesian.js';
import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../common/http.js';

/** Jogja sits on the Merapi apron; Bandung in a highland basin. Priors only —
 * the client's one-shot ground snap corrects them wherever tiles are loaded. */
const JOGJA_GROUND_ELEVATION_M = 113;
const BANDUNG_GROUND_ELEVATION_M = 750;

const UA = { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' };
/** These portals answer their own map's XHR; the header keeps that shape. */
const XHR = { ...UA, 'X-Requested-With': 'XMLHttpRequest' };

/**
 * Validate a portal-supplied stream URL and pin it to the origin that city is
 * known to stream from.
 *
 * The URL arrives inside a JSON/HTML payload from a city server, so it is
 * attacker-controlled in the threat model that matters here: a compromised or
 * spoofed portal response must not be able to aim the media proxy at an
 * arbitrary host (SSRF) or at a `file:`/`gopher:` scheme. Anything not on the
 * expected https origin is dropped rather than rewritten.
 *
 * @param {string} raw - URL as published by the portal.
 * @param {string} origin - Expected stream origin, with trailing slash.
 * @returns {?string} The URL, or null when it is not on that origin.
 */
export function normalizeIndonesianStreamUrl(raw, origin) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // Portals publish a mix of http/https for the same host; the stream serves
  // https, and the browser tab is https, so upgrade before pinning.
  parsed.protocol = 'https:';
  const url = parsed.toString();
  return url.startsWith(origin) ? url : null;
}

/**
 * Heading for an Indonesian camera label, and how much to trust it.
 *
 * Returns the id-hash fallback when the label carries no "Arah" phrase, which
 * is the same contract TfL, Fintraffic and Calgary cameras use. The confidence
 * is 'low' either way — see the module header.
 *
 * @param {string} label - Camera title as published.
 * @param {string} cameraId - Stable id, used for the deterministic fallback.
 * @returns {{headingDeg:number, headingConfidence:string}}
 */
export function indonesianCameraHeading(label, cameraId) {
  const parsed = indonesianDirectionToHeading(label);
  return {
    headingDeg: Number.isFinite(parsed)
      ? parsed
      : fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
  };
}

/**
 * One Yogyakarta portal record -> one catalog source, or null.
 *
 * @param {object} record - Raw row from /home/getdata.
 * @returns {?object}
 */
export function jogjaCameraToSource(record) {
  if (!record || typeof record !== 'object') return null;
  const lat = toFiniteNumber(record.cctv_latitude);
  const lon = toFiniteNumber(record.cctv_longitude);
  if (!isLikelyJogjaCoordinate(lat, lon)) return null;

  const streamUrl = normalizeIndonesianStreamUrl(
    record.cctv_link,
    JOGJA_STREAM_ORIGIN,
  );
  if (!streamUrl) return null;

  const rawId = String(record.cctv_id ?? '').trim();
  if (!rawId) return null;
  const cameraId = `jogja-${rawId}`;
  const name = String(record.cctv_title ?? '').trim() || `CCTV Jogja ${rawId}`;
  const district = String(record.kecamatan_nama ?? '').trim();

  return {
    id: cameraId,
    name,
    city: 'Yogyakarta',
    cityId: 'yogyakarta',
    provider: 'Pemerintah Kota Yogyakarta (Dinas Perhubungan)',
    lat,
    lon,
    ...indonesianCameraHeading(name, cameraId),
    ...INDONESIA_CAMERA_DEFAULTS,
    groundElevationM: JOGJA_GROUND_ELEVATION_M,
    feedType: 'hls',
    url: streamUrl,
    sourceKind: 'jogja-atcs',
    // Kecamatan (district) is the locally meaningful second line; it is the
    // unit a resident places an intersection by.
    region: district,
    license:
      'Public traffic camera feed published by Pemerintah Kota Yogyakarta',
    code: cameraDisplayCode(name.toUpperCase()),
  };
}

/**
 * Fetch the Yogyakarta ATCS catalog. One keyless JSON call returns every
 * camera with coordinates and a direct HLS URL.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadJogjaSourcesFromAtcs() {
  try {
    const endpoint = process.env.CCTV_JOGJA_URL || DEFAULT_JOGJA_CCTV_URL;
    const resp = await fetchCctvCatalog(endpoint, {
      headers: { ...XHR, Accept: 'application/json' },
      redirect: 'manual',
    });
    // A response this loader will not read still owns its transport until the
    // body is released, so every rejection path cancels before returning.
    const discard = async () => {
      try {
        await resp.body?.cancel();
      } catch {
        /* no-op */
      }
      return [];
    };
    if (resp.status >= 300 && resp.status < 400) {
      console.warn(
        '[CCTV] Yogyakarta catalog redirected; redirects are not followed',
      );
      return discard();
    }
    if (!resp.ok) {
      console.warn('[CCTV] Yogyakarta camera download failed:', resp.status);
      return discard();
    }
    // The portal serves this JSON as text/html; parse on structure, not on
    // the declared content type.
    const rows = await readResponseJsonCapped(
      resp,
      INDONESIA_MAX_CATALOG_BYTES,
    );
    if (!Array.isArray(rows)) return [];

    const cameras = [];
    const seen = new Set();
    for (const record of rows) {
      const camera = jogjaCameraToSource(record);
      if (!camera || seen.has(camera.id)) continue;
      seen.add(camera.id);
      cameras.push(camera);
    }
    const maxRaw = Number(
      process.env.CCTV_JOGJA_MAX_SOURCES || DEFAULT_JOGJA_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(400, Math.floor(maxRaw)))
      : DEFAULT_JOGJA_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, [JOGJA_CENTER]);
    console.log(
      `[CCTV] Loaded Yogyakarta camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Yogyakarta camera download error:',
      error?.message || error,
    );
    return [];
  }
}

/**
 * Extract camera ids and labels from one Bandung `/ajax/cctv-list` fragment.
 *
 * The endpoint returns an HTML fragment, not JSON: each camera is an anchor
 * whose `onclick` carries the camera id and whose inner text is the label.
 * Parsed with a bounded regex rather than a DOM — this runs server-side in a
 * Vite plugin with no DOM available, and the fragment shape is fixed.
 *
 * @param {string} html - Fragment body.
 * @returns {Array<{id:string, name:string}>}
 */
export function parseBandungCameraList(html) {
  const text = String(html ?? '');
  if (!text) return [];
  const out = [];
  const seen = new Set();
  // Anchor open tag carrying showStreamingModal(<id>), then everything up to
  // the closing tag, which holds the label alongside a play-icon <img>.
  const anchor =
    /showStreamingModal\((\d+)\)\s*;?\s*"[^>]*>([\s\S]{0,2000}?)<\/a>/g;
  let match;
  while ((match = anchor.exec(text)) !== null) {
    const id = match[1];
    if (seen.has(id)) continue;
    const label = match[2]
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!label) continue;
    seen.add(id);
    out.push({ id, name: label });
  }
  return out;
}

/**
 * Run an async mapper over a list with a fixed number of workers.
 *
 * Bandung resolves one camera per request, so a catalog refresh is inherently
 * fan-out. Bounding it keeps a refresh from opening dozens of sockets at once
 * against a municipal server.
 *
 * @template T,R
 * @param {Array<T>} items
 * @param {number} limit - Maximum in-flight operations.
 * @param {(item:T)=>Promise<R>} mapper
 * @returns {Promise<Array<R>>} Results in input order.
 */
export async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length));
  const results = new Array(list.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor++;
      try {
        results[index] = await mapper(list[index]);
      } catch {
        results[index] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** POST a form body to a Bandung ATCS ajax endpoint and read it as text. */
async function postBandungAjax(endpoint, body) {
  const resp = await fetchCctvCatalog(
    endpoint,
    {
      method: 'POST',
      headers: {
        ...XHR,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'manual',
    },
    {
      // A reconnection is refused for POST by default, because a repeated POST
      // is normally a second act. Not here: all three of these endpoints are
      // queries -- the location list, one site's camera list, one camera's
      // details -- and POST is merely the shape this portal's ajax API takes.
      // Nothing on the server changes, and the body is a string, so the second
      // attempt is the same request byte for byte rather than an empty one.
      replayable: true,
    },
  );
  if (!resp.ok || (resp.status >= 300 && resp.status < 400)) {
    try {
      await resp.body?.cancel();
    } catch {
      /* no-op */
    }
    return null;
  }
  return readResponseTextCapped(resp, INDONESIA_MAX_CATALOG_BYTES);
}

/**
 * One resolved Bandung camera -> one catalog source, or null.
 *
 * @param {object} input
 * @param {string} input.id - Portal camera id.
 * @param {string} input.name - Camera label.
 * @param {string} input.streamUrl - Resolved HLS URL.
 * @param {number} input.lat - Intersection latitude.
 * @param {number} input.lon - Intersection longitude.
 * @param {string} [input.locationName] - Intersection label.
 * @returns {?object}
 */
export function bandungCameraToSource({
  id,
  name,
  streamUrl,
  lat,
  lon,
  locationName = '',
}) {
  const rawId = String(id ?? '').trim();
  if (!rawId) return null;
  if (!isLikelyBandungCoordinate(lat, lon)) return null;
  const url = normalizeIndonesianStreamUrl(streamUrl, BANDUNG_STREAM_ORIGIN);
  if (!url) return null;

  const cameraId = `bandung-${rawId}`;
  const label = String(name ?? '').trim() || `CCTV Bandung ${rawId}`;

  return {
    id: cameraId,
    name: label,
    city: 'Bandung',
    cityId: 'bandung',
    provider: 'Pemerintah Kota Bandung (Dinas Perhubungan)',
    // The portal geocodes the INTERSECTION, not each camera on it: several
    // cameras at one junction share these coordinates and are separated only
    // by their headings. Placing them exactly is what the calibration gizmo is
    // for; the shared point is honest about what the portal actually knows.
    lat,
    lon,
    ...indonesianCameraHeading(label, cameraId),
    ...INDONESIA_CAMERA_DEFAULTS,
    groundElevationM: BANDUNG_GROUND_ELEVATION_M,
    feedType: 'hls',
    url,
    sourceKind: 'bandung-atcs',
    region: String(locationName ?? '').trim(),
    license: 'Public traffic camera feed published by Pemerintah Kota Bandung',
    code: cameraDisplayCode(label.toUpperCase()),
  };
}

/**
 * Fetch the Bandung ATCS catalog.
 *
 * Three hops: intersections with coordinates, then the cameras at each
 * intersection, then one stream-URL resolve per camera. Bounded by
 * BANDUNG_RESOLVE_CONCURRENCY and by the location cap.
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadBandungSourcesFromAtcs() {
  try {
    const locationsRaw = await postBandungAjax(
      process.env.CCTV_BANDUNG_LOCATIONS_URL || BANDUNG_LOCATIONS_URL,
      '',
    );
    if (!locationsRaw) {
      console.warn('[CCTV] Bandung location list unavailable');
      return [];
    }
    let locations;
    try {
      locations = JSON.parse(locationsRaw);
    } catch {
      console.warn('[CCTV] Bandung location list was not JSON');
      return [];
    }
    if (!Array.isArray(locations)) return [];

    const sites = locations
      .map((row) => ({
        id: String(row?.id_lokasi ?? '').trim(),
        name: String(row?.nama_lokasi ?? '').trim(),
        lat: toFiniteNumber(row?.lat_lokasi),
        lon: toFiniteNumber(row?.lon_lokasi),
      }))
      .filter(
        (site) => site.id && isLikelyBandungCoordinate(site.lat, site.lon),
      );

    // Visit the intersections nearest the anchor first, so a cap trims the
    // far edge of the city rather than a random slice of it.
    const orderedSites = prioritizeSources(sites, sites.length, [
      BANDUNG_CENTER,
    ]);

    const perSite = await mapWithConcurrency(
      orderedSites,
      BANDUNG_RESOLVE_CONCURRENCY,
      async (site) => {
        const fragment = await postBandungAjax(
          process.env.CCTV_BANDUNG_LIST_URL || BANDUNG_CAMERA_LIST_URL,
          `id=${encodeURIComponent(site.id)}`,
        );
        if (!fragment) return [];
        return parseBandungCameraList(fragment).map((camera) => ({
          ...camera,
          site,
        }));
      },
    );

    const pending = perSite.filter(Array.isArray).flat();
    const resolved = await mapWithConcurrency(
      pending,
      BANDUNG_RESOLVE_CONCURRENCY,
      async (entry) => {
        const infoRaw = await postBandungAjax(
          process.env.CCTV_BANDUNG_INFO_URL || BANDUNG_CAMERA_INFO_URL,
          `id=${encodeURIComponent(entry.id)}`,
        );
        if (!infoRaw) return null;
        let info;
        try {
          info = JSON.parse(infoRaw);
        } catch {
          return null;
        }
        return bandungCameraToSource({
          id: entry.id,
          name: String(info?.name ?? '').trim() || entry.name,
          streamUrl: info?.src,
          lat: entry.site.lat,
          lon: entry.site.lon,
          locationName: entry.site.name,
        });
      },
    );

    const cameras = [];
    const seen = new Set();
    for (const camera of resolved) {
      if (!camera || seen.has(camera.id)) continue;
      seen.add(camera.id);
      cameras.push(camera);
    }

    const maxRaw = Number(
      process.env.CCTV_BANDUNG_MAX_SOURCES || DEFAULT_BANDUNG_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(400, Math.floor(maxRaw)))
      : DEFAULT_BANDUNG_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, [BANDUNG_CENTER]);
    console.log(
      `[CCTV] Loaded Bandung camera sources: ${cameras.length} (using nearest ${prioritized.length})`,
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Bandung camera download error:',
      error?.message || error,
    );
    return [];
  }
}

/**
 * Load curated Indonesian cameras from a local JSON file.
 *
 * Indonesia has hundreds of ATCS portals — one per city and regency — and most
 * are small bespoke sites with no machine-readable endpoint at all. Writing an
 * adapter for each would be unmaintainable, and several would break on their
 * next redesign. This file is the other half of the strategy: anyone can add a
 * camera from any Indonesian city by appending an entry, with no code change
 * and no new failure mode for the live packs.
 *
 * Entries are validated the same way a live pack's are — an Indonesian
 * coordinate, an http(s) URL, a stable id — so a malformed contribution drops
 * out instead of corrupting the catalog.
 *
 * @param {{sourceRoot?: string}} [opts]
 * @returns {Array<object>} Normalized camera source objects.
 */
export function loadIndonesiaCuratedSources({
  sourceRoot = process.cwd(),
} = {}) {
  const sourceFile =
    process.env.CCTV_INDONESIA_SOURCES_FILE || DEFAULT_INDONESIA_SOURCE_FILE;
  const resolved = path.isAbsolute(sourceFile)
    ? sourceFile
    : path.resolve(sourceRoot, sourceFile);
  let rows = [];
  try {
    if (!fs.existsSync(resolved)) return [];
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    rows = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn(
      '[CCTV] Indonesia curated source file read error:',
      error?.message || error,
    );
    return [];
  }

  const cameras = [];
  const seen = new Set();
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? '').trim();
    const url = String(item.url ?? item.snapshotUrl ?? '').trim();
    if (!id || seen.has(id)) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    const lat = toFiniteNumber(item.lat);
    const lon = toFiniteNumber(item.lon);
    if (!isLikelyIndonesiaCoordinate(lat, lon)) continue;

    const name = String(item.name ?? '').trim() || id;
    seen.add(id);
    cameras.push({
      ...INDONESIA_CAMERA_DEFAULTS,
      ...item,
      id,
      name,
      url,
      lat,
      lon,
      city: String(item.city ?? '').trim() || 'Indonesia',
      cityId: String(item.cityId ?? '').trim() || 'indonesia',
      provider: String(item.provider ?? '').trim() || 'Curated public camera',
      feedType: String(item.feedType ?? '').trim() || 'hls',
      sourceKind: String(item.sourceKind ?? '').trim() || 'indonesia-curated',
      // A curated pose is only as good as whoever entered it; default to the
      // same low confidence the live packs use unless the contributor has
      // explicitly claimed better.
      headingConfidence: String(item.headingConfidence ?? '').trim() || 'low',
      code: cameraDisplayCode(name.toUpperCase()),
    });
  }
  if (cameras.length) {
    console.log('[CCTV] Loaded curated Indonesia camera sources:', cameras.length);
  }
  return cameras;
}

/* ---------------------------------------------------------------------------
 * Jakarta — DKI provincial public CCTV wall
 * ------------------------------------------------------------------------- */

/**
 * Validate a stream URL against the several origins one city may stream from.
 *
 * Same contract as normalizeIndonesianStreamUrl, but Jakarta's portal embeds
 * two Flussonic hosts rather than one.
 *
 * @param {string} raw - URL as published by the portal.
 * @param {ReadonlyArray<string>} origins - Allowed origins, without a trailing slash.
 * @returns {?string} The URL, or null when it is on none of them.
 */
export function normalizeMultiOriginStreamUrl(raw, origins) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  parsed.protocol = 'https:';
  // Compare on the parsed origin rather than a string prefix, so a host that
  // merely STARTS with an allowed one ("...balitower.co.id.evil.com") cannot
  // slip through.
  const list = Array.isArray(origins) ? origins : [];
  return list.includes(parsed.origin) ? parsed.toString() : null;
}

/**
 * Extract cameras from the DKI Jakarta public CCTV wall.
 *
 * The page is static HTML: one `.card` per camera, whose `<iframe>` points at
 * a Flussonic `embed.html` and whose footer carries the human location name
 * and the camera designator ("CCTV-01"). Parsed with a bounded regex — this
 * runs server-side with no DOM, and the page shape is fixed.
 *
 * @param {string} html - Portal page body.
 * @returns {Array<{streamUrl:string, title:string, badge:string}>}
 */
export function parseJakartaPortalCards(html) {
  const text = String(html ?? '');
  if (!text) return [];
  const card =
    /<iframe\s+src="([^"]+)"[\s\S]{0,400}?<div class="title">([\s\S]{0,200}?)<\/div>\s*<span class="badge">([\s\S]{0,40}?)<\/span>/g;
  const out = [];
  const seen = new Set();
  let match;
  while ((match = card.exec(text)) !== null) {
    const embedUrl = match[1].trim();
    const title = match[2].replace(/\s+/g, ' ').trim();
    const badge = match[3].replace(/\s+/g, ' ').trim();
    if (!embedUrl || seen.has(embedUrl)) continue;
    seen.add(embedUrl);
    out.push({ embedUrl, title, badge });
  }
  return out;
}

/**
 * Turn a Flussonic embed URL into its HLS playlist URL.
 *
 * Flussonic serves `<origin>/<stream>/embed.html` for the player and
 * `<origin>/<stream>/index.m3u8` for the stream itself.
 *
 * @param {string} embedUrl - The iframe src from the portal.
 * @returns {?string} Playlist URL on an allowed origin, or null.
 */
export function jakartaEmbedToPlaylistUrl(embedUrl) {
  const pinned = normalizeMultiOriginStreamUrl(embedUrl, JAKARTA_STREAM_ORIGINS);
  if (!pinned) return null;
  let parsed;
  try {
    parsed = new URL(pinned);
  } catch {
    return null;
  }
  if (!/\/embed\.html$/i.test(parsed.pathname)) return null;
  parsed.pathname = parsed.pathname.replace(/\/embed\.html$/i, '/index.m3u8');
  return parsed.toString();
}

/**
 * Stable camera id from a Flussonic stream path.
 *
 * The stream name carries the provincial asset code and camera designator
 * ("502045_JKP_POLDA_JPO-JL.-GATOT-SUBROTO-7_CCTV-01"), which is the only
 * stable per-camera token the portal exposes.
 *
 * @param {string} playlistUrl - Normalized playlist URL.
 * @returns {?string}
 */
export function jakartaCameraId(playlistUrl) {
  let parsed;
  try {
    parsed = new URL(String(playlistUrl || ''));
  } catch {
    return null;
  }
  const stream = parsed.pathname.split('/').filter(Boolean)[0] || '';
  if (!stream) return null;
  const slug = decodeURIComponent(stream)
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug ? `jakarta-${slug}` : null;
}

/**
 * Load the geocoded Jakarta location table.
 *
 * @param {string} sourceRoot - Repository root.
 * @returns {Map<string,{lat:number, lon:number}>} Keyed by portal title.
 */
export function loadJakartaLocations(sourceRoot = process.cwd()) {
  const file =
    process.env.CCTV_JAKARTA_LOCATIONS_FILE || DEFAULT_JAKARTA_LOCATIONS_FILE;
  const resolved = path.isAbsolute(file)
    ? file
    : path.resolve(sourceRoot, file);
  try {
    if (!fs.existsSync(resolved)) return new Map();
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const rows = parsed?.locations && typeof parsed.locations === 'object'
      ? parsed.locations
      : {};
    const map = new Map();
    for (const [title, point] of Object.entries(rows)) {
      const lat = toFiniteNumber(point?.lat);
      const lon = toFiniteNumber(point?.lon);
      if (isLikelyJakartaCoordinate(lat, lon)) map.set(title, { lat, lon });
    }
    return map;
  } catch (error) {
    console.warn(
      '[CCTV] Jakarta location table read error:',
      error?.message || error,
    );
    return new Map();
  }
}

/**
 * One portal card plus its geocoded point -> one catalog source, or null.
 *
 * @param {object} input
 * @param {string} input.embedUrl - iframe src from the portal.
 * @param {string} input.title - Location label.
 * @param {string} input.badge - Camera designator ("CCTV-01").
 * @param {{lat:number, lon:number}} input.point - Geocoded location.
 * @returns {?object}
 */
export function jakartaCameraToSource({ embedUrl, title, badge, point }) {
  const url = jakartaEmbedToPlaylistUrl(embedUrl);
  if (!url) return null;
  const cameraId = jakartaCameraId(url);
  if (!cameraId) return null;
  const lat = toFiniteNumber(point?.lat);
  const lon = toFiniteNumber(point?.lon);
  if (!isLikelyJakartaCoordinate(lat, lon)) return null;

  const label = String(title ?? '').trim() || cameraId;
  const designator = String(badge ?? '').trim();
  const name = designator ? `${label} (${designator})` : label;

  return {
    id: cameraId,
    name,
    city: 'Jakarta',
    cityId: 'jakarta',
    provider: 'Pemerintah Provinsi DKI Jakarta',
    lat,
    lon,
    ...indonesianCameraHeading(name, cameraId),
    ...INDONESIA_CAMERA_DEFAULTS,
    groundElevationM: JAKARTA_GROUND_ELEVATION_M,
    feedType: 'hls',
    url,
    sourceKind: 'jakarta-jakcctv',
    region: label,
    // UNLIKE every other pack in this catalog, the POSITION here is an
    // estimate too: the portal publishes no coordinates, so these points are
    // geocoded from the street name and are accurate to the road, not to the
    // pole. Flagged so the UI and any downstream consumer can say so.
    positionConfidence: 'approximate',
    license:
      'Public traffic camera feed published by Pemerintah Provinsi DKI Jakarta; positions geocoded via OpenStreetMap (ODbL)',
    code: cameraDisplayCode(label.toUpperCase()),
  };
}

/**
 * Fetch the DKI Jakarta public CCTV wall and join it to the geocoded
 * location table.
 *
 * A camera whose location has no geocoded point is DROPPED rather than placed
 * at a guess: an unplaceable camera on a globe is worse than an absent one.
 *
 * @param {{sourceRoot?: string}} [opts]
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadJakartaSourcesFromPortal({
  sourceRoot = process.cwd(),
} = {}) {
  try {
    const endpoint =
      process.env.CCTV_JAKARTA_PORTAL_URL || DEFAULT_JAKARTA_PORTAL_URL;
    const resp = await fetchCctvCatalog(endpoint, {
      headers: { ...UA, Accept: 'text/html' },
      redirect: 'manual',
    });
    const discard = async () => {
      try {
        await resp.body?.cancel();
      } catch {
        /* no-op */
      }
      return [];
    };
    if (resp.status >= 300 && resp.status < 400) {
      console.warn(
        '[CCTV] Jakarta portal redirected; redirects are not followed',
      );
      return discard();
    }
    if (!resp.ok) {
      console.warn('[CCTV] Jakarta portal download failed:', resp.status);
      return discard();
    }
    const html = await readResponseTextCapped(resp, INDONESIA_MAX_CATALOG_BYTES);
    const cards = parseJakartaPortalCards(html);
    if (!cards.length) return [];

    const locations = loadJakartaLocations(sourceRoot);
    const cameras = [];
    const seen = new Set();
    let unplaced = 0;
    for (const card of cards) {
      const point = locations.get(card.title);
      if (!point) {
        unplaced += 1;
        continue;
      }
      const camera = jakartaCameraToSource({ ...card, point });
      if (!camera || seen.has(camera.id)) continue;
      seen.add(camera.id);
      cameras.push(camera);
    }

    const maxRaw = Number(
      process.env.CCTV_JAKARTA_MAX_SOURCES || DEFAULT_JAKARTA_MAX_SOURCES,
    );
    const maxCount = Number.isFinite(maxRaw)
      ? Math.max(8, Math.min(400, Math.floor(maxRaw)))
      : DEFAULT_JAKARTA_MAX_SOURCES;
    const prioritized = prioritizeSources(cameras, maxCount, [JAKARTA_CENTER]);
    console.log(
      `[CCTV] Loaded Jakarta camera sources: ${cameras.length} (using nearest ${prioritized.length}` +
        (unplaced ? `, ${unplaced} without a geocoded location` : '') +
        ')',
    );
    return prioritized;
  } catch (error) {
    console.warn(
      '[CCTV] Jakarta camera download error:',
      error?.message || error,
    );
    return [];
  }
}
