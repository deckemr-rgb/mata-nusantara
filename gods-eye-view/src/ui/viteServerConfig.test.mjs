import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBrowserViteConfig } from '../../build/vite.js';

test('the preview server exists and mirrors the dev server', () => {
  // `vite preview` does NOT inherit `server`. Without its own block a
  // deployment silently ignores HOST and PORT and binds to localhost, which is
  // reachable from inside the machine and from nowhere else.
  const config = createBrowserViteConfig({ host: '0.0.0.0', port: '8080' });
  assert.ok(config.preview, 'a preview block is required for deployment');
  assert.equal(config.preview.host, '0.0.0.0');
  assert.equal(config.preview.port, 8080);
  assert.equal(config.server.host, config.preview.host);
  assert.equal(config.server.port, config.preview.port);
});

test('the port is coerced to a number, as Vite requires', () => {
  // Environment variables arrive as strings; Vite wants a number.
  const config = createBrowserViteConfig({ port: '9000' });
  assert.strictEqual(config.preview.port, 9000);
  assert.strictEqual(config.server.port, 9000);
});

test('an unusable port falls back rather than binding to NaN', () => {
  for (const port of ['', 'abc', undefined, null]) {
    const config = createBrowserViteConfig({ port });
    assert.strictEqual(config.preview.port, 4173, `port ${port}`);
  }
});

test('a public bind accepts any Host by default', () => {
  // Bound to 0.0.0.0 the operator has already chosen to be reachable; the
  // rebinding guard would otherwise reject the server's own IP address.
  const config = createBrowserViteConfig({ host: '0.0.0.0' });
  assert.equal(config.preview.allowedHosts, true);
  assert.equal(createBrowserViteConfig({ host: '::' }).preview.allowedHosts, true);
});

test('a local bind keeps the narrow default allow list', () => {
  const config = createBrowserViteConfig({});
  assert.deepEqual(config.preview.allowedHosts, [
    'localhost',
    '127.0.0.1',
    '.local',
  ]);
});

test('ALLOWED_HOSTS names the domains a deployment answers to', () => {
  // This is the setting a domain deployment hits first: without it, Vite
  // answers "Blocked request. This host is not allowed" and nothing else.
  const config = createBrowserViteConfig({
    host: '127.0.0.1',
    allowedHosts: 'mata.contoh.id,www.mata.contoh.id',
  });
  assert.deepEqual(config.preview.allowedHosts, [
    'mata.contoh.id',
    'www.mata.contoh.id',
  ]);
});

test('ALLOWED_HOSTS tolerates the spacing people actually type', () => {
  const config = createBrowserViteConfig({
    allowedHosts: '  a.contoh.id ,, b.contoh.id ,  ',
  });
  assert.deepEqual(config.preview.allowedHosts, ['a.contoh.id', 'b.contoh.id']);
});

test('an empty ALLOWED_HOSTS falls back instead of allowing nothing', () => {
  // An empty list would reject every request, including localhost.
  const publicBind = createBrowserViteConfig({
    host: '0.0.0.0',
    allowedHosts: '   ',
  });
  assert.equal(publicBind.preview.allowedHosts, true);
  const localBind = createBrowserViteConfig({ allowedHosts: ',,' });
  assert.ok(Array.isArray(localBind.preview.allowedHosts));
  assert.ok(localBind.preview.allowedHosts.includes('localhost'));
});

test('the framing protections apply to the built server too', () => {
  // Provider Settings lives in this document; it must not be frameable in
  // production any more than in development.
  const config = createBrowserViteConfig({ host: '0.0.0.0' });
  assert.equal(config.preview.headers['X-Frame-Options'], 'DENY');
  assert.match(
    config.preview.headers['Content-Security-Policy'],
    /frame-ancestors 'none'/,
  );
});

test('dotfiles stay denied on the dev server', () => {
  const config = createBrowserViteConfig({});
  assert.ok(config.server.fs.deny.includes('.env'));
});
