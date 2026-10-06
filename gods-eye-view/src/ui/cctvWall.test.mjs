import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WALL_CELLS,
  WALL_SIZE,
  createCctvWall,
  selectWallCameras,
} from './cctvWall.js';

/** A camera row shaped like the catalog's. */
const cam = (id, lat, lon, over = {}) => ({
  id,
  name: `Camera ${id}`,
  city: 'Yogyakarta',
  lat,
  lon,
  feedType: 'hls',
  ...over,
});

/* --------------------------------------------------------------------------
 * Selection
 * ----------------------------------------------------------------------- */

test('the wall is three by three', () => {
  assert.equal(WALL_SIZE, 3);
  assert.equal(WALL_CELLS, 9);
});

test('selectWallCameras puts the anchor first, then its nearest neighbours', () => {
  const anchor = cam('a', 0, 0);
  const cameras = [
    cam('far', 0, 5),
    cam('near', 0, 0.01),
    anchor,
    cam('mid', 0, 1),
  ];
  const picked = selectWallCameras(cameras, anchor);
  assert.deepEqual(
    picked.map((c) => c.id),
    ['a', 'near', 'mid', 'far'],
  );
});

test('selectWallCameras caps at nine', () => {
  const anchor = cam('a', 0, 0);
  const cameras = [anchor, ...Array.from({ length: 40 }, (_, i) => cam(`c${i}`, 0, i / 100))];
  assert.equal(selectWallCameras(cameras, anchor).length, WALL_CELLS);
});

test('selectWallCameras without an anchor takes the first cameras in order', () => {
  const cameras = Array.from({ length: 12 }, (_, i) => cam(`c${i}`, 0, i));
  const picked = selectWallCameras(cameras, null);
  assert.equal(picked.length, WALL_CELLS);
  assert.equal(picked[0].id, 'c0');
});

test('selectWallCameras ignores an anchor with no usable coordinates', () => {
  const cameras = [cam('a', 1, 1), cam('b', 2, 2)];
  const picked = selectWallCameras(cameras, { id: 'x', lat: NaN, lon: NaN });
  assert.deepEqual(
    picked.map((c) => c.id),
    ['a', 'b'],
  );
});

test('a camera with broken coordinates sorts last rather than breaking the wall', () => {
  const anchor = cam('a', 0, 0);
  const cameras = [anchor, cam('broken', null, null), cam('near', 0, 0.01)];
  const picked = selectWallCameras(cameras, anchor);
  assert.deepEqual(
    picked.map((c) => c.id),
    ['a', 'near', 'broken'],
  );
});

test('an anchor missing from the catalog does not get injected', () => {
  // Otherwise the wall would show a tile for a camera the layer no longer has.
  const cameras = [cam('a', 0, 0), cam('b', 0, 1)];
  const picked = selectWallCameras(cameras, cam('ghost', 0, 0));
  assert.deepEqual(
    picked.map((c) => c.id),
    ['a', 'b'],
  );
});

test('selectWallCameras is safe on empty and junk input', () => {
  assert.deepEqual(selectWallCameras([], null), []);
  assert.deepEqual(selectWallCameras(null, null), []);
  assert.deepEqual(selectWallCameras([cam('a', 0, 0)], null, 0), []);
});

/* --------------------------------------------------------------------------
 * Lifecycle
 * ----------------------------------------------------------------------- */

function stubDom({ withMarkup = true } = {}) {
  const docListeners = new Map();
  const makeEl = (tag = 'div') => {
    const el = {
      tagName: tag,
      hidden: false,
      textContent: '',
      className: '',
      children: [],
      dataset: {},
      _listeners: new Map(),
      classList: {
        _set: new Set(),
        add(c) {
          this._set.add(c);
        },
        remove(c) {
          this._set.delete(c);
        },
        contains(c) {
          return this._set.has(c);
        },
      },
      addEventListener(type, fn) {
        el._listeners.set(type, fn);
      },
      removeEventListener(type) {
        el._listeners.delete(type);
      },
      replaceChildren(...kids) {
        el.children = kids;
      },
      removeAttribute(name) {
        delete el[name];
      },
      setAttribute(name, value) {
        el[name] = value;
      },
      focus() {},
      pause() {},
      play: () => Promise.resolve(),
      load() {},
    };
    return el;
  };

  const ids = withMarkup
    ? {
        'cctv-wall': makeEl(),
        'cctv-wall-grid': makeEl(),
        'cctv-wall-title': makeEl(),
        'cctv-wall-close': makeEl('button'),
      }
    : {};

  const body = makeEl('body');
  const documentRef = {
    body,
    getElementById: (id) => ids[id] || null,
    createElement: (tag) => makeEl(tag),
    addEventListener: (type, fn) => docListeners.set(type, fn),
    removeEventListener: (type) => docListeners.delete(type),
  };
  return { documentRef, ids, body, docListeners };
}

/** Let the staggered mounts run. */
const settle = (ms = 2600) => new Promise((r) => setTimeout(r, ms));

test('a wall with no DOM is inert but honours its contract', () => {
  const wall = createCctvWall({ documentRef: undefined });
  assert.equal(wall.isOpen(), false);
  assert.equal(wall.open([cam('a', 0, 0)]), false);
  assert.doesNotThrow(() => wall.close());
  assert.doesNotThrow(() => wall.destroy());
  assert.doesNotThrow(() => wall.destroy());
});

test('opening builds one tile per camera', async (t) => {
  const { documentRef, ids, body } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ feedType: 'hls', mediaUrl: '/m', frameUrl: '/f' }),
  });

  const wall = createCctvWall({ documentRef });
  const cameras = Array.from({ length: 9 }, (_, i) => cam(`c${i}`, 0, i / 100));
  assert.equal(wall.open(cameras, { title: 'TEST' }), true);
  assert.equal(wall.isOpen(), true);
  assert.equal(ids['cctv-wall'].hidden, false);
  assert.equal(ids['cctv-wall-grid'].children.length, 9);
  assert.equal(ids['cctv-wall-title'].textContent, 'TEST');
  assert.equal(body.classList.contains('cctv-wall-open'), true);
  await settle();
  wall.destroy();
});

test('opening with no cameras does nothing', () => {
  const { documentRef, ids } = stubDom();
  const wall = createCctvWall({ documentRef });
  assert.equal(wall.open([]), false);
  assert.equal(wall.isOpen(), false);
  assert.equal(ids['cctv-wall'].hidden, false || ids['cctv-wall'].hidden);
  wall.destroy();
});

test('close tears down every mounted player', async (t) => {
  const { documentRef, ids, body } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ feedType: 'hls', mediaUrl: '/m', frameUrl: '/f' }),
  });

  const wall = createCctvWall({ documentRef });
  wall.open(Array.from({ length: 9 }, (_, i) => cam(`c${i}`, 0, i / 100)));
  await settle();
  assert.ok(wall.cellCount() > 0, 'players mounted');
  wall.close();
  // Nine HLS players left running in the background is exactly the leak this
  // guards against.
  assert.equal(wall.cellCount(), 0);
  assert.equal(wall.isOpen(), false);
  assert.equal(ids['cctv-wall-grid'].children.length, 0);
  assert.equal(body.classList.contains('cctv-wall-open'), false);
  wall.destroy();
});

test('reopening cancels the previous wall pending mounts', async (t) => {
  const { documentRef, ids } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ feedType: 'hls', mediaUrl: '/m', frameUrl: '/f' }),
  });

  const wall = createCctvWall({ documentRef });
  wall.open(Array.from({ length: 9 }, (_, i) => cam(`a${i}`, 0, i / 100)));
  // Reopen immediately, while the first wall's staggered mounts are still due.
  wall.open(Array.from({ length: 4 }, (_, i) => cam(`b${i}`, 0, i / 100)));
  await settle();
  assert.equal(ids['cctv-wall-grid'].children.length, 4);
  // A late answer from the first wall must not attach to the second's tiles.
  assert.ok(wall.cellCount() <= 4, `stale mounts leaked: ${wall.cellCount()}`);
  wall.destroy();
});

test('an unreachable stream leaves the tile labelled, not crashed', async (t) => {
  const { documentRef, ids } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    throw new Error('ECONNRESET');
  };

  const wall = createCctvWall({ documentRef });
  wall.open([cam('a', 0, 0)]);
  await settle(800);
  const tile = ids['cctv-wall-grid'].children[0];
  const status = tile.children.find((c) =>
    String(c.className).includes('status'),
  );
  assert.equal(status.textContent, 'Tidak tersedia');
  wall.destroy();
});

test('clicking a tile reports the camera for full screen', async (t) => {
  const { documentRef, ids } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ feedType: 'hls', mediaUrl: '/m', frameUrl: '/f' }),
  });

  const seen = [];
  const wall = createCctvWall({
    documentRef,
    onCellActivate: (id, meta) => seen.push([id, meta.name]),
  });
  wall.open([cam('a', 0, 0), cam('b', 0, 1)]);
  ids['cctv-wall-grid'].children[1]._listeners.get('click')?.();
  assert.deepEqual(seen, [['b', 'Camera b']]);
  await settle(800);
  wall.destroy();
});

test('Escape closes the wall and stops the event reaching other handlers', async (t) => {
  const { documentRef, docListeners } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ feedType: 'hls', mediaUrl: '/m', frameUrl: '/f' }),
  });

  const wall = createCctvWall({ documentRef });
  wall.open([cam('a', 0, 0)]);
  let stopped = false;
  docListeners.get('keydown')?.({
    key: 'Escape',
    stopPropagation: () => {
      stopped = true;
    },
    preventDefault: () => {},
  });
  assert.equal(wall.isOpen(), false);
  assert.ok(stopped);
  await settle(800);
  wall.destroy();
});

test('Escape is ignored while the wall is closed', () => {
  const { documentRef, docListeners } = stubDom();
  const wall = createCctvWall({ documentRef });
  let stopped = false;
  docListeners.get('keydown')?.({
    key: 'Escape',
    stopPropagation: () => {
      stopped = true;
    },
    preventDefault: () => {},
  });
  assert.equal(stopped, false);
  wall.destroy();
});
