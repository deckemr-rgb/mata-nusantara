import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isHlsPlaylistResponse,
  mediaOriginFor,
  resolveHlsSegmentUrl,
  rewriteHlsPlaylist,
} from '../../server/providers/cctv/hls.js';

const ORIGIN = 'https://atcs-dishub.bandung.go.id:1990';
const MASTER_URL = `${ORIGIN}/GedeBar/index.m3u8`;
const VARIANT_URL = `${ORIGIN}/GedeBar/main_stream.m3u8`;

const rewrite = (playlist, baseUrl = VARIANT_URL) =>
  rewriteHlsPlaylist(playlist, {
    cameraId: 'bandung-76',
    baseUrl,
    allowedOrigin: ORIGIN,
  });

/** Decode the `u=` parameter out of a rewritten proxy URL. */
const upstreamOf = (line) =>
  decodeURIComponent(String(line).split('?u=')[1] || '');

test('isHlsPlaylistResponse recognises declared playlist types', () => {
  assert.ok(isHlsPlaylistResponse('application/vnd.apple.mpegurl', MASTER_URL));
  assert.ok(isHlsPlaylistResponse('application/x-mpegURL', MASTER_URL));
  assert.ok(
    isHlsPlaylistResponse('application/vnd.apple.mpegurl; charset=utf-8', MASTER_URL),
  );
});

test('isHlsPlaylistResponse falls back to the .m3u8 extension', () => {
  // Municipal media servers routinely mislabel playlists.
  assert.ok(isHlsPlaylistResponse('text/plain', MASTER_URL));
  assert.ok(isHlsPlaylistResponse('application/octet-stream', MASTER_URL));
  assert.ok(isHlsPlaylistResponse('', MASTER_URL));
});

test('isHlsPlaylistResponse leaves real media alone', () => {
  assert.ok(!isHlsPlaylistResponse('video/mp2t', `${ORIGIN}/GedeBar/seg1.ts`));
  assert.ok(!isHlsPlaylistResponse('image/jpeg', 'https://x.example/a.jpg'));
  assert.ok(!isHlsPlaylistResponse('video/mp4', 'https://x.example/a.mp4'));
});

test('mediaOriginFor keeps the port', () => {
  assert.equal(mediaOriginFor(MASTER_URL), ORIGIN);
  // Same host, different port is a DIFFERENT origin.
  assert.notEqual(
    mediaOriginFor('https://atcs-dishub.bandung.go.id/ajax/lokasi'),
    ORIGIN,
  );
  assert.equal(mediaOriginFor('nonsense'), null);
  assert.equal(mediaOriginFor(''), null);
});

test('resolveHlsSegmentUrl resolves relative names against the playlist', () => {
  assert.equal(
    resolveHlsSegmentUrl('seg1.ts', VARIANT_URL, ORIGIN),
    `${ORIGIN}/GedeBar/seg1.ts`,
  );
  assert.equal(
    resolveHlsSegmentUrl('../Other/seg1.ts', VARIANT_URL, ORIGIN),
    `${ORIGIN}/Other/seg1.ts`,
  );
  assert.equal(
    resolveHlsSegmentUrl('/abs/seg1.ts', VARIANT_URL, ORIGIN),
    `${ORIGIN}/abs/seg1.ts`,
  );
});

test('resolveHlsSegmentUrl refuses anything off-origin', () => {
  // This is the SSRF boundary: the proxy accepts a URL from a query parameter,
  // so everything not on the camera's own media origin has to be refused.
  for (const hostile of [
    'https://evil.example/steal.ts',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    // Same host, catalog port rather than media port.
    'https://atcs-dishub.bandung.go.id/ajax/lokasi',
    'http://localhost:4173/api/cctv/sources',
  ]) {
    assert.equal(
      resolveHlsSegmentUrl(hostile, VARIANT_URL, ORIGIN),
      null,
      `${hostile} must be refused`,
    );
  }
});

test('resolveHlsSegmentUrl refuses when no origin is known', () => {
  assert.equal(resolveHlsSegmentUrl('seg1.ts', VARIANT_URL, null), null);
  assert.equal(resolveHlsSegmentUrl('', VARIANT_URL, ORIGIN), null);
});

test('rewriteHlsPlaylist routes a master playlist variant through the proxy', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '',
    '#EXT-X-STREAM-INF:BANDWIDTH=107536,RESOLUTION=640x480',
    'main_stream.m3u8',
  ].join('\n');

  const { body, rewritten, dropped } = rewrite(master, MASTER_URL);
  assert.equal(rewritten, 1);
  assert.equal(dropped, 0);
  // The tag itself is untouched; only the URI line becomes a proxy URL.
  assert.ok(body.includes('#EXT-X-STREAM-INF:BANDWIDTH=107536,RESOLUTION=640x480'));
  const variantLine = body
    .split('\n')
    .find((line) => line.startsWith('/api/cctv/media/'));
  assert.equal(upstreamOf(variantLine), VARIANT_URL);
});

test('rewriteHlsPlaylist routes segments and key URIs', () => {
  const media = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:2.00000,',
    'seg1.ts',
  ].join('\n');

  const { body, rewritten } = rewrite(media);
  assert.equal(rewritten, 3);
  assert.ok(body.includes('#EXT-X-KEY:METHOD=AES-128,URI="/api/cctv/media/'));
  assert.ok(body.includes('#EXT-X-MAP:URI="/api/cctv/media/'));
  assert.ok(
    body
      .split('\n')
      .some(
        (line) =>
          line.startsWith('/api/cctv/media/') &&
          upstreamOf(line) === `${ORIGIN}/GedeBar/seg1.ts`,
      ),
  );
});

test('rewriteHlsPlaylist drops an off-origin segment with its EXTINF', () => {
  const media = [
    '#EXTM3U',
    '#EXTINF:2.0,',
    'seg1.ts',
    '#EXTINF:2.0,',
    'https://evil.example/steal.ts',
    '#EXTINF:2.0,',
    'seg3.ts',
  ].join('\n');

  const { body, rewritten, dropped } = rewrite(media);
  assert.equal(rewritten, 2);
  assert.equal(dropped, 1);
  assert.ok(!body.includes('evil.example'));
  // A dangling #EXTINF would declare a segment the playlist never names, so
  // the duration tag has to go with the dropped URI.
  const extinf = (body.match(/#EXTINF/g) || []).length;
  const uris = body
    .split('\n')
    .filter((line) => line.startsWith('/api/cctv/media/')).length;
  assert.equal(extinf, uris);
  assert.equal(extinf, 2);
});

test('rewriteHlsPlaylist drops a tag whose URI attribute is off-origin', () => {
  const media = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/key.bin"',
    '#EXTINF:2.0,',
    'seg1.ts',
  ].join('\n');

  const { body, dropped } = rewrite(media);
  assert.equal(dropped, 1);
  assert.ok(!body.includes('evil.example'));
  assert.ok(!body.includes('EXT-X-KEY'));
});

test('rewriteHlsPlaylist preserves comments, tags and blank lines', () => {
  const media = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA-SEQUENCE:6113',
    '#EXT-X-PROGRAM-DATE-TIME:2026-09-15T10:25:14.96Z',
    '',
    '#EXTINF:2.00000,',
    'seg6113.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');

  const { body } = rewrite(media);
  for (const keep of [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA-SEQUENCE:6113',
    '#EXT-X-PROGRAM-DATE-TIME:2026-09-15T10:25:14.96Z',
    '#EXT-X-ENDLIST',
  ]) {
    assert.ok(body.includes(keep), `${keep} must survive rewriting`);
  }
});

test('rewriteHlsPlaylist handles CRLF playlists', () => {
  const media = '#EXTM3U\r\n#EXTINF:2.0,\r\nseg1.ts\r\n';
  const { body, rewritten } = rewrite(media);
  assert.equal(rewritten, 1);
  assert.ok(!body.includes('\r'));
});

test('rewriteHlsPlaylist is safe on empty and junk input', () => {
  assert.deepEqual(rewrite(''), { body: '', rewritten: 0, dropped: 0 });
  assert.equal(rewrite(null).rewritten, 0);

  // A bare non-comment line is treated as a URI, so junk text resolves as a
  // relative path on the camera's own origin. That is harmless — it 404s
  // upstream — and the property that actually matters is that it can never
  // leave the origin, which is what is asserted here.
  const junk = rewrite('not a playlist at all');
  const line = junk.body
    .split('\n')
    .find((l) => l.startsWith('/api/cctv/media/'));
  assert.ok(upstreamOf(line).startsWith(`${ORIGIN}/`));
});

test('rewritten URIs encode the upstream so query strings survive', () => {
  const media = ['#EXTM3U', '#EXTINF:2.0,', 'seg1.ts?token=abc&x=1'].join('\n');
  const { body } = rewrite(media);
  const line = body.split('\n').find((l) => l.startsWith('/api/cctv/media/'));
  // The upstream query must not leak into the proxy URL's own parameters.
  assert.equal(line.split('?').length, 2);
  assert.equal(upstreamOf(line), `${ORIGIN}/GedeBar/seg1.ts?token=abc&x=1`);
});
