/**
 * HLS playlist proxying for CCTV feeds.
 *
 * WHY THIS EXISTS
 * ---------------
 * The image and MP4 feeds this proxy already handled are single requests: one
 * URL in, one body out. HLS is not. A playlist is an index that names more
 * URLs — variant playlists, media segments, encryption keys — and those names
 * are usually RELATIVE:
 *
 *     #EXT-X-STREAM-INF:BANDWIDTH=107536,RESOLUTION=640x480
 *     main_stream.m3u8
 *
 * Piped through `/api/cctv/media/<id>` untouched, the player resolves
 * `main_stream.m3u8` against THIS server's path and asks for
 * `/api/cctv/media/main_stream.m3u8`, which is not a camera id. The stream
 * dies on the first hop, every time.
 *
 * Indonesian ATCS portals also serve their media hosts with no CORS headers at
 * all, so the browser cannot fetch even an absolute segment URL directly. Both
 * problems have the same fix: rewrite every URI in the playlist to point back
 * at this proxy, and let the proxy fetch the segments.
 *
 * SSRF IS THE WHOLE RISK HERE
 * ---------------------------
 * Rewriting means the proxy now accepts a URL as a query parameter, which is
 * the classic SSRF shape. The rule enforced in `resolveHlsSegmentUrl` is that
 * a requested URL must live on the SAME ORIGIN as the camera's own registered
 * stream URL — not merely a matching hostname, and never a caller-supplied
 * origin. A playlist that names another host simply loses that entry.
 */

/** Playlist media types, plus the extension for hosts that mislabel them. */
const HLS_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
];

/**
 * Whether an upstream response is an HLS playlist that needs rewriting.
 *
 * Checks the declared type first, then falls back to the URL extension:
 * several municipal media servers return `text/plain` or
 * `application/octet-stream` for `.m3u8`.
 *
 * @param {string} contentType - Upstream Content-Type header.
 * @param {string} url - The URL that was fetched.
 * @returns {boolean}
 */
export function isHlsPlaylistResponse(contentType, url) {
  const type = String(contentType || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (HLS_CONTENT_TYPES.includes(type)) return true;
  try {
    return new URL(String(url || '')).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

/**
 * The origin a camera's media is allowed to come from, including its port.
 *
 * Port matters: Bandung serves its catalog from `atcs-dishub.bandung.go.id`
 * and its media from `atcs-dishub.bandung.go.id:1990`. A hostname-only check
 * would conflate the two.
 *
 * @param {string} streamUrl - The camera's registered stream URL.
 * @returns {?string} Origin string, or null when unparseable.
 */
export function mediaOriginFor(streamUrl) {
  try {
    return new URL(String(streamUrl || '')).origin;
  } catch {
    return null;
  }
}

/**
 * Resolve one playlist URI against the playlist's own URL and confirm it stays
 * on the camera's media origin.
 *
 * @param {string} raw - URI exactly as it appears in the playlist.
 * @param {string} baseUrl - Absolute URL of the playlist that named it.
 * @param {string} allowedOrigin - Origin the camera is registered to stream from.
 * @returns {?string} Absolute URL, or null when it escapes the origin.
 */
export function resolveHlsSegmentUrl(raw, baseUrl, allowedOrigin) {
  const text = String(raw || '').trim();
  if (!text || !allowedOrigin) return null;
  let resolved;
  try {
    resolved = new URL(text, baseUrl);
  } catch {
    return null;
  }
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') {
    return null;
  }
  return resolved.origin === allowedOrigin ? resolved.toString() : null;
}

/** Proxy URL for one absolute upstream media URL. */
function proxyUrlFor(cameraId, absoluteUrl) {
  return `/api/cctv/media/${encodeURIComponent(cameraId)}?u=${encodeURIComponent(absoluteUrl)}`;
}

/** Tags whose URI="..." attribute is a fetchable resource. */
const URI_ATTR_TAGS =
  /^#EXT-X-(?:KEY|MAP|MEDIA|I-FRAME-STREAM-INF|PART|PRELOAD-HINT|RENDITION-REPORT|SESSION-KEY)\b/i;

/**
 * Rewrite every URI in an HLS playlist to route through this proxy.
 *
 * Handles both forms a playlist uses: bare URI lines (segments and variant
 * playlists) and `URI="..."` attributes on tags (keys, init segments,
 * alternate renditions). Entries that resolve off-origin are dropped — for a
 * bare line the line is removed, for an attribute the tag is left out — so a
 * tampered playlist degrades to a shorter stream instead of turning the proxy
 * into an open relay.
 *
 * @param {string} playlist - Playlist body.
 * @param {object} opts
 * @param {string} opts.cameraId - Camera the playlist belongs to.
 * @param {string} opts.baseUrl - Absolute URL the playlist was fetched from.
 * @param {string} opts.allowedOrigin - Origin the camera may stream from.
 * @returns {{body:string, rewritten:number, dropped:number}}
 */
export function rewriteHlsPlaylist(
  playlist,
  { cameraId, baseUrl, allowedOrigin },
) {
  const lines = String(playlist || '').split(/\r?\n/);
  const out = [];
  let rewritten = 0;
  let dropped = 0;
  // Output index of an #EXTINF still waiting for its segment line. Dropping a
  // segment has to take its duration tag with it, or the playlist is left
  // declaring a segment it never names.
  let pendingExtinf = -1;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      out.push(line);
      continue;
    }

    if (/^#EXTINF\b/i.test(trimmed)) {
      pendingExtinf = out.length;
      out.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (!URI_ATTR_TAGS.test(trimmed) || !/URI\s*=\s*"/i.test(trimmed)) {
        out.push(line);
        continue;
      }
      let attrDropped = false;
      const replaced = trimmed.replace(
        /URI\s*=\s*"([^"]*)"/gi,
        (whole, uri) => {
          const absolute = resolveHlsSegmentUrl(uri, baseUrl, allowedOrigin);
          if (!absolute) {
            attrDropped = true;
            return whole;
          }
          rewritten += 1;
          return `URI="${proxyUrlFor(cameraId, absolute)}"`;
        },
      );
      if (attrDropped) {
        dropped += 1;
        continue;
      }
      out.push(replaced);
      continue;
    }

    // A bare, non-comment line is a segment or a variant playlist.
    const absolute = resolveHlsSegmentUrl(trimmed, baseUrl, allowedOrigin);
    if (!absolute) {
      dropped += 1;
      if (pendingExtinf >= 0) {
        out.splice(pendingExtinf, 1);
        pendingExtinf = -1;
      }
      continue;
    }
    rewritten += 1;
    out.push(proxyUrlFor(cameraId, absolute));
    pendingExtinf = -1;
  }

  return { body: out.join('\n'), rewritten, dropped };
}
