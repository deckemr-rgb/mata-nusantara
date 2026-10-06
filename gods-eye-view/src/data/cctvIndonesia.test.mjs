import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bandungCameraToSource,
  indonesianCameraHeading,
  jogjaCameraToSource,
  loadBandungSourcesFromAtcs,
  loadIndonesiaCuratedSources,
  loadJogjaSourcesFromAtcs,
  mapWithConcurrency,
  normalizeIndonesianStreamUrl,
  parseBandungCameraList,
  parseJakartaPortalCards,
  jakartaEmbedToPlaylistUrl,
  jakartaCameraToSource,
  loadJakartaSourcesFromPortal,
  normalizeMultiOriginStreamUrl,
} from '../../server/providers/cctv/sources.indonesia.js';
import {
  BANDUNG_STREAM_ORIGIN,
  JOGJA_STREAM_ORIGIN,
  INDONESIA_CAMERA_DEFAULTS,
} from '../../server/providers/cctv/constants.js';
import {
  isLikelyBandungCoordinate,
  isLikelyIndonesiaCoordinate,
  isLikelyJogjaCoordinate,
  isLikelyJakartaCoordinate,
} from '../../server/providers/cctv/normalize.js';
import { indonesianDirectionToHeading } from './directionTextIndonesian.js';

/** One row shaped like a live `cctv.jogjakota.go.id/home/getdata` record. */
const jogjaRow = (over = {}) => ({
  cctv_id: '12',
  cctv_title: 'Simpang Gondomanan (PTZ)',
  cctv_link: 'https://cctvjss.jogjakota.go.id/atcs/ATCS_gondomanan.stream/playlist.m3u8',
  cctv_latitude: '-7.8016',
  cctv_longitude: '110.3671',
  kecamatan_nama: 'GONDOMANAN',
  ...over,
});

/**
 * A response whose body is a live stream, plus a flag that flips when the
 * stream is cancelled. A rejection path that returns without cancelling holds
 * the transport open, so the flag is what the refusal tests actually assert.
 */
const streamingResponse = (init = {}) => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('['));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};

/* --------------------------------------------------------------------------
 * Direction text
 * ----------------------------------------------------------------------- */

test('indonesianDirectionToHeading reads explicit "arah" phrases', () => {
  assert.equal(indonesianDirectionToHeading('VID GEDEBAGE (Dari Arah Barat)'), 270);
  assert.equal(indonesianDirectionToHeading('Simpang Tugu - Arah Selatan'), 180);
  assert.equal(indonesianDirectionToHeading('Ke Arah Utara'), 0);
  assert.equal(indonesianDirectionToHeading('Menuju Arah Timur'), 90);
});

test('indonesianDirectionToHeading resolves compound points before cardinals', () => {
  // "BARAT DAYA" contains "BARAT" and "TIMUR LAUT" contains "TIMUR"; a naive
  // cardinal test would shadow both and return the wrong quadrant.
  assert.equal(indonesianDirectionToHeading('Arah Barat Daya'), 225);
  assert.equal(indonesianDirectionToHeading('Arah Timur Laut'), 45);
  assert.equal(indonesianDirectionToHeading('Arah Barat Laut'), 315);
  assert.equal(indonesianDirectionToHeading('Arah Tenggara'), 135);
});

test('indonesianDirectionToHeading never reads a bare cardinal as a facing', () => {
  // These are Indonesian PLACE names. Reading the cardinal in them as a
  // camera bearing would mis-orient a large share of the catalog with
  // confidence — the Austin/Calgary trap, in Indonesian.
  for (const placeName of [
    'Jakarta Selatan',
    'Jakarta Utara',
    'Bandung Barat',
    'Cibaduyut Barat',
    'Kebon Jeruk Timur',
    'Aceh Barat Daya',
  ]) {
    assert.ok(
      Number.isNaN(indonesianDirectionToHeading(placeName)),
      `${placeName} must not yield a heading`,
    );
  }
});

test('indonesianDirectionToHeading returns NaN for unlabelled cameras', () => {
  assert.ok(Number.isNaN(indonesianDirectionToHeading('Simpang APMD (PTZ)')));
  assert.ok(Number.isNaN(indonesianDirectionToHeading('')));
  assert.ok(Number.isNaN(indonesianDirectionToHeading(null)));
});

test('indonesianCameraHeading always reports low confidence', () => {
  // Even a parsed "Arah" phrase is a convention, not a measurement, and many
  // of these cameras are PTZ domes whose facing an operator changes at will.
  const parsed = indonesianCameraHeading('Simpang X (Dari Arah Barat)', 'jogja-1');
  assert.equal(parsed.headingDeg, 270);
  assert.equal(parsed.headingConfidence, 'low');

  const fallback = indonesianCameraHeading('Simpang APMD (PTZ)', 'jogja-1');
  assert.ok(Number.isFinite(fallback.headingDeg));
  assert.equal(fallback.headingConfidence, 'low');
});

test('indonesianCameraHeading fallback is deterministic per id', () => {
  const a = indonesianCameraHeading('No direction here', 'jogja-77');
  const b = indonesianCameraHeading('No direction here', 'jogja-77');
  const c = indonesianCameraHeading('No direction here', 'jogja-78');
  assert.equal(a.headingDeg, b.headingDeg);
  assert.notEqual(a.headingDeg, c.headingDeg);
});

/* --------------------------------------------------------------------------
 * Stream URL pinning (SSRF surface)
 * ----------------------------------------------------------------------- */

test('normalizeIndonesianStreamUrl accepts only the expected origin', () => {
  assert.equal(
    normalizeIndonesianStreamUrl(
      'https://cctvjss.jogjakota.go.id/atcs/A.stream/playlist.m3u8',
      JOGJA_STREAM_ORIGIN,
    ),
    'https://cctvjss.jogjakota.go.id/atcs/A.stream/playlist.m3u8',
  );
  // http is upgraded, then pinned.
  assert.equal(
    normalizeIndonesianStreamUrl(
      'http://cctvjss.jogjakota.go.id/atcs/A.stream/playlist.m3u8',
      JOGJA_STREAM_ORIGIN,
    ),
    'https://cctvjss.jogjakota.go.id/atcs/A.stream/playlist.m3u8',
  );
});

test('normalizeIndonesianStreamUrl rejects hosts that merely look right', () => {
  for (const hostile of [
    'https://evil.example/x.m3u8',
    // Suffix attack: the allowed host is a PREFIX of this one.
    'https://cctvjss.jogjakota.go.id.evil.com/x.m3u8',
    'file:///etc/passwd',
    'gopher://cctvjss.jogjakota.go.id/x',
    'not a url',
    '',
    null,
  ]) {
    assert.equal(
      normalizeIndonesianStreamUrl(hostile, JOGJA_STREAM_ORIGIN),
      null,
      `${hostile} must be refused`,
    );
  }
});

test('normalizeIndonesianStreamUrl distinguishes ports', () => {
  // Bandung serves its catalog on :443 and its media on :1990. Treating them
  // as one host would let a catalog URL be fetched as media.
  assert.equal(
    normalizeIndonesianStreamUrl(
      'https://atcs-dishub.bandung.go.id/ajax/lokasi',
      BANDUNG_STREAM_ORIGIN,
    ),
    null,
  );
  assert.equal(
    normalizeIndonesianStreamUrl(
      'https://atcs-dishub.bandung.go.id:1990/Tamblong/index.m3u8',
      BANDUNG_STREAM_ORIGIN,
    ),
    'https://atcs-dishub.bandung.go.id:1990/Tamblong/index.m3u8',
  );
});

/* --------------------------------------------------------------------------
 * Coordinate gates
 * ----------------------------------------------------------------------- */

test('Indonesian coordinate gates accept real cities and reject null island', () => {
  assert.ok(isLikelyIndonesiaCoordinate(-6.2, 106.8)); // Jakarta
  assert.ok(isLikelyIndonesiaCoordinate(-8.65, 115.22)); // Denpasar
  assert.ok(isLikelyIndonesiaCoordinate(5.55, 95.32)); // Banda Aceh
  assert.ok(isLikelyIndonesiaCoordinate(-2.53, 140.7)); // Jayapura
  assert.ok(!isLikelyIndonesiaCoordinate(0, 0));
  assert.ok(!isLikelyIndonesiaCoordinate(51.5, -0.12)); // London
  assert.ok(!isLikelyIndonesiaCoordinate(NaN, NaN));
});

test('city gates are narrower than the national box', () => {
  assert.ok(isLikelyJogjaCoordinate(-7.7828, 110.3671));
  assert.ok(!isLikelyJogjaCoordinate(-6.2, 106.8)); // Jakarta is not Jogja
  assert.ok(isLikelyBandungCoordinate(-6.9218, 107.6071));
  assert.ok(!isLikelyBandungCoordinate(-7.7828, 110.3671));
});

/* --------------------------------------------------------------------------
 * Yogyakarta
 * ----------------------------------------------------------------------- */

test('jogjaCameraToSource maps a live row', () => {
  const camera = jogjaCameraToSource(jogjaRow());
  assert.equal(camera.id, 'jogja-12');
  assert.equal(camera.name, 'Simpang Gondomanan (PTZ)');
  assert.equal(camera.cityId, 'yogyakarta');
  assert.equal(camera.feedType, 'hls');
  assert.equal(camera.sourceKind, 'jogja-atcs');
  assert.equal(camera.region, 'GONDOMANAN');
  assert.equal(camera.headingConfidence, 'low');
  assert.equal(camera.pitchDeg, INDONESIA_CAMERA_DEFAULTS.pitchDeg);
  assert.ok(camera.url.startsWith(JOGJA_STREAM_ORIGIN));
});

test('jogjaCameraToSource drops rows it cannot trust', () => {
  assert.equal(jogjaCameraToSource(null), null);
  assert.equal(jogjaCameraToSource({}), null);
  // Coordinates outside Jogja — a portal that starts publishing another city's
  // cameras must not silently land them under this pack.
  assert.equal(
    jogjaCameraToSource(jogjaRow({ cctv_latitude: '-6.2', cctv_longitude: '106.8' })),
    null,
  );
  // Stream URL moved off the known origin.
  assert.equal(
    jogjaCameraToSource(jogjaRow({ cctv_link: 'https://evil.example/a.m3u8' })),
    null,
  );
  assert.equal(jogjaCameraToSource(jogjaRow({ cctv_id: '  ' })), null);
});

test('loadJogjaSourcesFromAtcs maps and caps a payload', async (t) => {
  t.mock.method(console, 'log', () => {});
  const rows = Array.from({ length: 5 }, (_, i) =>
    jogjaRow({
      cctv_id: String(i + 1),
      cctv_title: `Simpang ${i + 1}`,
      cctv_link: `https://cctvjss.jogjakota.go.id/atcs/S${i + 1}.stream/playlist.m3u8`,
    }),
  );
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(rows)));
  process.env.CCTV_JOGJA_MAX_SOURCES = '8';
  try {
    const cameras = await loadJogjaSourcesFromAtcs();
    assert.equal(cameras.length, 5);
    assert.ok(cameras.every((c) => c.id.startsWith('jogja-')));
  } finally {
    delete process.env.CCTV_JOGJA_MAX_SOURCES;
  }
});

test('loadJogjaSourcesFromAtcs refuses a redirect and releases the body', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { response, state } = streamingResponse({
    status: 302,
    headers: { location: 'https://elsewhere.example/' },
  });
  t.mock.method(globalThis, 'fetch', async () => response);
  assert.deepEqual(await loadJogjaSourcesFromAtcs(), []);
  assert.equal(state.cancelled, true);
});

test('loadJogjaSourcesFromAtcs survives an upstream error', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNRESET');
  });
  assert.deepEqual(await loadJogjaSourcesFromAtcs(), []);
});

test('loadJogjaSourcesFromAtcs survives an HTML error page', async (t) => {
  // Observed live: the portal answers with an HTML error page under load.
  t.mock.method(console, 'warn', () => {});
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('<html><head><title>502</title></head></html>'),
  );
  assert.deepEqual(await loadJogjaSourcesFromAtcs(), []);
});

/* --------------------------------------------------------------------------
 * Bandung
 * ----------------------------------------------------------------------- */

const BANDUNG_FRAGMENT = `
<div id="box-list"><div class="row">
  <div class="col-sm-6"><div class="alert alert-secondary">
    <a href="#" class="list-group-item" data-bs-dismiss="modal" onclick="showStreamingModal(76);">
      <p class="text-center"><img src="/assets/img/video-play.png" width="50" alt=""></p>
      <p class="text-center">VID GEDEBAGE (Dari Arah Barat)   </p>
      <footer class="blockquote-footer"></footer>
    </a>
  </div></div>
  <div class="col-sm-6"><div class="alert alert-secondary">
    <a href="#" class="list-group-item" onclick="showStreamingModal(77);">
      <p class="text-center"><img src="/assets/img/video-play.png" alt=""></p>
      <p class="text-center">VID GEDEBAGE (Dari Arah Selatan)</p>
    </a>
  </div></div>
</div></div>`;

test('parseBandungCameraList extracts ids and labels from the fragment', () => {
  const list = parseBandungCameraList(BANDUNG_FRAGMENT);
  assert.deepEqual(list, [
    { id: '76', name: 'VID GEDEBAGE (Dari Arah Barat)' },
    { id: '77', name: 'VID GEDEBAGE (Dari Arah Selatan)' },
  ]);
});

test('parseBandungCameraList is defensive about junk input', () => {
  assert.deepEqual(parseBandungCameraList(''), []);
  assert.deepEqual(parseBandungCameraList(null), []);
  assert.deepEqual(parseBandungCameraList('<div>no cameras here</div>'), []);
  // A repeated id is one camera, not two.
  assert.equal(
    parseBandungCameraList(BANDUNG_FRAGMENT + BANDUNG_FRAGMENT).length,
    2,
  );
});

test('bandungCameraToSource maps a resolved camera', () => {
  const camera = bandungCameraToSource({
    id: '76',
    name: 'VID GEDEBAGE (Dari Arah Barat)',
    streamUrl: 'https://atcs-dishub.bandung.go.id:1990/GedeBar/index.m3u8',
    lat: -6.93703,
    lon: 107.692679,
    locationName: 'Soekarno Hatta - Gedebage',
  });
  assert.equal(camera.id, 'bandung-76');
  assert.equal(camera.cityId, 'bandung');
  assert.equal(camera.feedType, 'hls');
  assert.equal(camera.headingDeg, 270); // "Dari Arah Barat"
  assert.equal(camera.headingConfidence, 'low');
  assert.equal(camera.region, 'Soekarno Hatta - Gedebage');
});

test('bandungCameraToSource refuses off-origin and out-of-city input', () => {
  const base = {
    id: '76',
    name: 'X',
    streamUrl: 'https://atcs-dishub.bandung.go.id:1990/GedeBar/index.m3u8',
    lat: -6.93703,
    lon: 107.692679,
  };
  assert.equal(bandungCameraToSource({ ...base, id: '' }), null);
  assert.equal(
    bandungCameraToSource({ ...base, streamUrl: 'https://evil.example/a.m3u8' }),
    null,
  );
  assert.equal(bandungCameraToSource({ ...base, lat: -7.78, lon: 110.36 }), null);
});

test('loadBandungSourcesFromAtcs walks all three hops', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = String(url);
    if (target.endsWith('/ajax/lokasi')) {
      return new Response(
        JSON.stringify([
          {
            id_lokasi: '1',
            nama_lokasi: 'Soekarno Hatta - Gedebage',
            lat_lokasi: '-6.93703',
            lon_lokasi: '107.692679',
          },
        ]),
      );
    }
    if (target.endsWith('/ajax/cctv-list')) return new Response(BANDUNG_FRAGMENT);
    if (target.endsWith('/ajax/cctv-info')) {
      return new Response(
        JSON.stringify({
          name: 'VID GEDEBAGE (Dari Arah Barat)',
          src: 'https://atcs-dishub.bandung.go.id:1990/GedeBar/index.m3u8',
        }),
      );
    }
    throw new Error(`unexpected fetch ${target}`);
  });

  const cameras = await loadBandungSourcesFromAtcs();
  assert.equal(cameras.length, 2);
  assert.deepEqual(
    cameras.map((c) => c.id).sort(),
    ['bandung-76', 'bandung-77'],
  );
  assert.ok(cameras.every((c) => c.url.startsWith(BANDUNG_STREAM_ORIGIN)));
});

test('loadBandungSourcesFromAtcs yields nothing when the portal is down', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  assert.deepEqual(await loadBandungSourcesFromAtcs(), []);
});

test('loadBandungSourcesFromAtcs tolerates a partial outage', async (t) => {
  // The location list answers but per-camera resolution fails: the pack must
  // degrade to empty rather than throwing and taking the catalog with it.
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = String(url);
    if (target.endsWith('/ajax/lokasi')) {
      return new Response(
        JSON.stringify([
          {
            id_lokasi: '1',
            nama_lokasi: 'X',
            lat_lokasi: '-6.93703',
            lon_lokasi: '107.692679',
          },
        ]),
      );
    }
    throw new Error('upstream gone');
  });
  assert.deepEqual(await loadBandungSourcesFromAtcs(), []);
});

/* --------------------------------------------------------------------------
 * Concurrency helper
 * ----------------------------------------------------------------------- */

test('mapWithConcurrency preserves order and bounds parallelism', async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  let inFlight = 0;
  let peak = 0;
  const result = await mapWithConcurrency(items, 3, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return n * 2;
  });
  assert.deepEqual(
    result,
    items.map((n) => n * 2),
  );
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit`);
});

test('mapWithConcurrency isolates a rejecting item', async () => {
  const result = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom');
    return n;
  });
  assert.deepEqual(result, [1, null, 3]);
});

/* --------------------------------------------------------------------------
 * Curated catalog
 * ----------------------------------------------------------------------- */

/** Write a curated catalog to a temp root and load it from there. */
const withCuratedFile = (rows, run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-id-'));
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'config', 'cctv_sources.indonesia.json'),
      JSON.stringify(rows),
    );
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test('loadIndonesiaCuratedSources accepts a well-formed entry', (t) => {
  t.mock.method(console, 'log', () => {});
  const cameras = withCuratedFile(
    [
      {
        id: 'semarang-simpang-lima',
        name: 'Simpang Lima',
        city: 'Semarang',
        cityId: 'semarang',
        lat: -6.9908,
        lon: 110.4229,
        url: 'https://example.go.id/live/simpanglima.m3u8',
        feedType: 'hls',
      },
    ],
    (sourceRoot) => loadIndonesiaCuratedSources({ sourceRoot }),
  );
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].cityId, 'semarang');
  assert.equal(cameras[0].sourceKind, 'indonesia-curated');
  assert.equal(cameras[0].headingConfidence, 'low');
  assert.equal(cameras[0].pitchDeg, INDONESIA_CAMERA_DEFAULTS.pitchDeg);
});

test('loadIndonesiaCuratedSources rejects malformed contributions', (t) => {
  t.mock.method(console, 'log', () => {});
  const cameras = withCuratedFile(
    [
      { id: '', lat: -6.99, lon: 110.42, url: 'https://x.go.id/a.m3u8' },
      { id: 'no-url', lat: -6.99, lon: 110.42 },
      { id: 'bad-scheme', lat: -6.99, lon: 110.42, url: 'file:///etc/passwd' },
      // London: outside Indonesia entirely.
      { id: 'wrong-country', lat: 51.5, lon: -0.12, url: 'https://x.go.id/a.m3u8' },
      { id: 'null-island', lat: 0, lon: 0, url: 'https://x.go.id/a.m3u8' },
      null,
      'not an object',
    ],
    (sourceRoot) => loadIndonesiaCuratedSources({ sourceRoot }),
  );
  assert.deepEqual(cameras, []);
});

test('loadIndonesiaCuratedSources deduplicates by id', (t) => {
  t.mock.method(console, 'log', () => {});
  const row = {
    id: 'dupe',
    lat: -6.99,
    lon: 110.42,
    url: 'https://x.go.id/a.m3u8',
  };
  const cameras = withCuratedFile([row, { ...row, name: 'Second' }], (sourceRoot) =>
    loadIndonesiaCuratedSources({ sourceRoot }),
  );
  assert.equal(cameras.length, 1);
});

test('loadIndonesiaCuratedSources returns [] when the file is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-id-none-'));
  try {
    assert.deepEqual(loadIndonesiaCuratedSources({ sourceRoot: root }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadIndonesiaCuratedSources survives malformed JSON', (t) => {
  t.mock.method(console, 'warn', () => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-id-bad-'));
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'config', 'cctv_sources.indonesia.json'),
      '{ not json',
    );
    assert.deepEqual(loadIndonesiaCuratedSources({ sourceRoot: root }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------------------
 * Jakarta
 * ----------------------------------------------------------------------- */

const JAKARTA_CARD = `
<div class="card" data-title="jkp polda jpo jl. gatot subroto 7 502045 cctv-01">
  <div class="card-body">
    <iframe src="https://dki-jkt.balitower.co.id:7028/502045_JKP_POLDA_JPO-JL.-GATOT-SUBROTO-7_CCTV-01/embed.html" loading="lazy"></iframe>
  </div>
  <div class="card-footer">
    <div class="title">JKP POLDA JPO JL. GATOT SUBROTO 7</div>
    <span class="badge">CCTV-01</span>
  </div>
</div>`;

test('normalizeMultiOriginStreamUrl compares parsed origins, not prefixes', () => {
  const origins = ['https://dki-jkt.balitower.co.id:7028'];
  assert.equal(
    normalizeMultiOriginStreamUrl(
      'https://dki-jkt.balitower.co.id:7028/x/embed.html',
      origins,
    ),
    'https://dki-jkt.balitower.co.id:7028/x/embed.html',
  );
  // A host that merely STARTS with an allowed one must not pass.
  assert.equal(
    normalizeMultiOriginStreamUrl(
      'https://dki-jkt.balitower.co.id.evil.com:7028/x/embed.html',
      origins,
    ),
    null,
  );
  // Same host, different port is a different origin.
  assert.equal(
    normalizeMultiOriginStreamUrl(
      'https://dki-jkt.balitower.co.id:9999/x/embed.html',
      origins,
    ),
    null,
  );
  assert.equal(normalizeMultiOriginStreamUrl('file:///etc/passwd', origins), null);
});

test('parseJakartaPortalCards reads the portal wall', () => {
  const cards = parseJakartaPortalCards(JAKARTA_CARD);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'JKP POLDA JPO JL. GATOT SUBROTO 7');
  assert.equal(cards[0].badge, 'CCTV-01');
  assert.ok(cards[0].embedUrl.endsWith('/embed.html'));
});

test('parseJakartaPortalCards is defensive', () => {
  assert.deepEqual(parseJakartaPortalCards(''), []);
  assert.deepEqual(parseJakartaPortalCards(null), []);
  assert.deepEqual(parseJakartaPortalCards('<div>nothing here</div>'), []);
  // The same iframe twice is one camera.
  assert.equal(parseJakartaPortalCards(JAKARTA_CARD + JAKARTA_CARD).length, 1);
});

test('jakartaEmbedToPlaylistUrl swaps the player page for the playlist', () => {
  assert.equal(
    jakartaEmbedToPlaylistUrl(
      'https://dki-jkt.balitower.co.id:7028/STREAM_NAME/embed.html',
    ),
    'https://dki-jkt.balitower.co.id:7028/STREAM_NAME/index.m3u8',
  );
  // Off-origin, or not an embed page at all.
  assert.equal(
    jakartaEmbedToPlaylistUrl('https://evil.example/STREAM/embed.html'),
    null,
  );
  assert.equal(
    jakartaEmbedToPlaylistUrl(
      'https://dki-jkt.balitower.co.id:7028/STREAM/other.html',
    ),
    null,
  );
});

test('jakartaCameraToSource flags its position as approximate', () => {
  // Jakarta is the only pack whose POSITIONS are estimates: the portal
  // publishes no coordinates, so these are geocoded from the street name.
  const camera = jakartaCameraToSource({
    embedUrl:
      'https://dki-jkt.balitower.co.id:7028/502045_JKP_POLDA_JPO-JL.-GATOT-SUBROTO-7_CCTV-01/embed.html',
    title: 'JKP POLDA JPO JL. GATOT SUBROTO 7',
    badge: 'CCTV-01',
    point: { lat: -6.21929, lon: 106.81256 },
  });
  assert.equal(camera.cityId, 'jakarta');
  assert.equal(camera.feedType, 'hls');
  assert.equal(camera.positionConfidence, 'approximate');
  assert.equal(camera.headingConfidence, 'low');
  assert.ok(camera.url.endsWith('/index.m3u8'));
  assert.ok(camera.name.includes('CCTV-01'));
});

test('jakartaCameraToSource refuses a point outside Jakarta', () => {
  const base = {
    embedUrl: 'https://dki-jkt.balitower.co.id:7028/S/embed.html',
    title: 'X',
    badge: 'CCTV-01',
  };
  assert.equal(
    jakartaCameraToSource({ ...base, point: { lat: -7.78, lon: 110.36 } }),
    null,
    'a Yogyakarta coordinate must not register as a Jakarta camera',
  );
  assert.equal(jakartaCameraToSource({ ...base, point: { lat: 0, lon: 0 } }), null);
});

test('loadJakartaSourcesFromPortal drops cameras it cannot place', async (t) => {
  // An unplaceable camera on a globe is worse than an absent one.
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response(JAKARTA_CARD));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-jak-'));
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'config', 'cctv_jakarta_locations.json'),
      JSON.stringify({ locations: {} }),
    );
    assert.deepEqual(
      await loadJakartaSourcesFromPortal({ sourceRoot: root }),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadJakartaSourcesFromPortal joins the portal to the location table', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response(JAKARTA_CARD));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-jak2-'));
  try {
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'config', 'cctv_jakarta_locations.json'),
      JSON.stringify({
        locations: {
          'JKP POLDA JPO JL. GATOT SUBROTO 7': {
            lat: -6.21929,
            lon: 106.81256,
          },
        },
      }),
    );
    const cameras = await loadJakartaSourcesFromPortal({ sourceRoot: root });
    assert.equal(cameras.length, 1);
    assert.equal(cameras[0].cityId, 'jakarta');
    assert.equal(cameras[0].positionConfidence, 'approximate');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadJakartaSourcesFromPortal survives an unreachable portal', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNRESET');
  });
  assert.deepEqual(await loadJakartaSourcesFromPortal(), []);
});

test('the shipped Jakarta location table is inside Jakarta', () => {
  const parsed = JSON.parse(
    fs.readFileSync(
      new URL('../../config/cctv_jakarta_locations.json', import.meta.url),
      'utf8',
    ),
  );
  const entries = Object.entries(parsed.locations);
  assert.ok(entries.length >= 20, 'the table should cover the published wall');
  for (const [name, point] of entries) {
    assert.ok(
      isLikelyJakartaCoordinate(point.lat, point.lon),
      `${name} falls outside DKI Jakarta: ${point.lat},${point.lon}`,
    );
  }
});
