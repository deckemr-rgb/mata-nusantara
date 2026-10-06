import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCctvMaximizeViewer } from './cctvMaximize.js';

/**
 * A DOM small enough to exercise the viewer's lifecycle without a browser.
 *
 * Only the surface the module actually touches is modelled; anything it calls
 * that is missing here would surface as a failure, which is the point.
 */
function stubDom({ withMarkup = true } = {}) {
  const listeners = new Map();
  const made = [];

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
      play: () => Promise.resolve(),
      load() {},
    };
    made.push(el);
    return el;
  };

  const ids = withMarkup
    ? {
        'cctv-maximize': makeEl(),
        'cctv-maximize-stage': makeEl(),
        'cctv-maximize-title': makeEl(),
        'cctv-maximize-meta': makeEl(),
        'cctv-maximize-status': makeEl(),
        'cctv-maximize-close': makeEl('button'),
      }
    : {};

  const body = makeEl('body');
  const documentRef = {
    body,
    getElementById: (id) => ids[id] || null,
    createElement: (tag) => makeEl(tag),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  return { documentRef, ids, body, listeners, made };
}

/** Install a fetch stub that answers the stream-info endpoint. */
function stubFetch(payload, { ok = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok,
      json: async () => payload,
    };
  };
  return calls;
}

test('a viewer with no DOM at all is inert but still honours its contract', async () => {
  // The CCTV panel is constructed in tests that have no document; a bare
  // `document` reference here would throw during panel construction.
  const viewer = createCctvMaximizeViewer({ documentRef: undefined });
  assert.equal(viewer.isOpen(), false);
  assert.equal(await viewer.open('cam-1', {}), false);
  assert.doesNotThrow(() => viewer.close());
  assert.doesNotThrow(() => viewer.destroy());
  assert.doesNotThrow(() => viewer.destroy(), 'destroy is idempotent');
});

test('a document without the markup is inert too', async () => {
  const { documentRef } = stubDom({ withMarkup: false });
  const viewer = createCctvMaximizeViewer({ documentRef });
  assert.equal(await viewer.open('cam-1', {}), false);
  viewer.destroy();
});

test('an HLS camera mounts a video element', async (t) => {
  const { documentRef, ids } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  stubFetch({
    id: 'jogja-1',
    feedType: 'hls',
    mediaUrl: '/api/cctv/media/jogja-1',
    frameUrl: '/api/cctv/frame/jogja-1',
  });

  const viewer = createCctvMaximizeViewer({ documentRef });
  const opened = await viewer.open('jogja-1', {
    name: 'Simpang APMD',
    city: 'Yogyakarta',
  });
  assert.equal(opened, true);
  assert.equal(viewer.isOpen(), true);
  assert.equal(ids['cctv-maximize'].hidden, false);
  assert.equal(ids['cctv-maximize-title'].textContent, 'Simpang APMD');
  assert.equal(ids['cctv-maximize-stage'].children.length, 1);
  assert.equal(ids['cctv-maximize-stage'].children[0].tagName, 'video');
  viewer.destroy();
});

test('an image camera mounts an img element and refreshes it', async (t) => {
  const { documentRef, ids } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  stubFetch({
    id: 'tln-103',
    feedType: 'image',
    mediaUrl: null,
    frameUrl: '/api/cctv/frame/tln-103',
  });

  const viewer = createCctvMaximizeViewer({ documentRef });
  assert.equal(await viewer.open('tln-103', { name: 'Viru' }), true);
  const stage = ids['cctv-maximize-stage'];
  assert.equal(stage.children.length, 1);
  assert.equal(stage.children[0].tagName, 'img');
  // A cache-busting parameter is what keeps a still feed from looking frozen.
  assert.match(String(stage.children[0].src), /[?&]t=\d+/);
  viewer.destroy();
});

test('a camera with neither media nor frame reports instead of mounting', async (t) => {
  const { documentRef, ids } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  stubFetch({ id: 'x', feedType: 'image', mediaUrl: null, frameUrl: null });

  const viewer = createCctvMaximizeViewer({ documentRef });
  assert.equal(await viewer.open('x', {}), false);
  assert.equal(ids['cctv-maximize-stage'].children.length, 0);
  assert.equal(ids['cctv-maximize-status'].hidden, false);
  viewer.destroy();
});

test('an unreachable stream endpoint surfaces a status, not a crash', async (t) => {
  const { documentRef, ids } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    throw new Error('ECONNRESET');
  };

  const viewer = createCctvMaximizeViewer({ documentRef });
  assert.equal(await viewer.open('cam-1', {}), false);
  assert.equal(ids['cctv-maximize-status'].hidden, false);
  viewer.destroy();
});

test('switching cameras replaces the stage instead of stacking players', async (t) => {
  const { documentRef, ids } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  stubFetch({ feedType: 'hls', mediaUrl: '/api/cctv/media/a', frameUrl: '/f' });

  const viewer = createCctvMaximizeViewer({ documentRef });
  await viewer.open('a', { name: 'A' });
  await viewer.open('b', { name: 'B' });
  // Without teardown between opens, hls.js players and refresh timers would
  // accumulate every time the operator moved to another camera.
  assert.equal(ids['cctv-maximize-stage'].children.length, 1);
  assert.equal(ids['cctv-maximize-title'].textContent, 'B');
  assert.equal(viewer.currentCameraId(), 'b');
  viewer.destroy();
});

test('close clears the stage and the open flag', async (t) => {
  const { documentRef, ids, body } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  stubFetch({ feedType: 'hls', mediaUrl: '/m', frameUrl: '/f' });

  const viewer = createCctvMaximizeViewer({ documentRef });
  await viewer.open('a', {});
  assert.equal(body.classList.contains('cctv-maximize-open'), true);
  viewer.close();
  assert.equal(viewer.isOpen(), false);
  assert.equal(ids['cctv-maximize'].hidden, true);
  assert.equal(ids['cctv-maximize-stage'].children.length, 0);
  assert.equal(body.classList.contains('cctv-maximize-open'), false);
  viewer.destroy();
});

test('an empty camera id is refused', async () => {
  const { documentRef } = stubDom();
  const viewer = createCctvMaximizeViewer({ documentRef });
  assert.equal(await viewer.open('', {}), false);
  assert.equal(await viewer.open(null, {}), false);
  assert.equal(await viewer.open('   ', {}), false);
  viewer.destroy();
});

test('Escape closes the viewer and stops the event reaching other handlers', async (t) => {
  const { documentRef, listeners } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  stubFetch({ feedType: 'hls', mediaUrl: '/m', frameUrl: '/f' });

  const viewer = createCctvMaximizeViewer({ documentRef });
  await viewer.open('a', {});
  let stopped = false;
  let prevented = false;
  listeners.get('keydown')?.({
    key: 'Escape',
    stopPropagation: () => {
      stopped = true;
    },
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(viewer.isOpen(), false);
  // Otherwise the same Escape would also dismiss search or exit the cockpit.
  assert.ok(stopped && prevented);
  viewer.destroy();
});

test('Escape is ignored while the viewer is closed', () => {
  const { documentRef, listeners } = stubDom();
  const viewer = createCctvMaximizeViewer({ documentRef });
  let stopped = false;
  listeners.get('keydown')?.({
    key: 'Escape',
    stopPropagation: () => {
      stopped = true;
    },
    preventDefault: () => {},
  });
  assert.equal(stopped, false, 'a closed viewer must not swallow Escape');
  viewer.destroy();
});

test('destroy releases document listeners', async (t) => {
  const { documentRef, listeners } = stubDom();
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  stubFetch({ feedType: 'hls', mediaUrl: '/m', frameUrl: '/f' });

  const viewer = createCctvMaximizeViewer({ documentRef });
  await viewer.open('a', {});
  viewer.destroy();
  assert.equal(listeners.has('keydown'), false);
});
