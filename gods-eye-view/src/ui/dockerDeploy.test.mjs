import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/*
 * The container has a handful of properties that are easy to break and silent
 * when broken: the failure shows up as a container that is up, reports itself
 * healthy, and serves nobody. These pin them.
 */

const read = (name) =>
  fs.readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');

/**
 * Strip comments before matching.
 *
 * Both files explain at length what must NOT appear in them -- the Dockerfile
 * spells out why `npm ci --omit=dev` would break the server, and compose
 * explains why the API keys do not belong under `environment:`. Searching the
 * raw text finds those explanations and reports the very mistake they exist to
 * prevent.
 *
 * @param {string} text
 * @returns {string} The same text with comment lines and trailing comments gone.
 */
function withoutComments(text) {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');
}

const dockerfile = withoutComments(read('Dockerfile'));
const compose = withoutComments(read('docker-compose.yml'));
const dockerignore = read('.dockerignore');
const pkg = JSON.parse(read('package.json'));

/* --------------------------------------------------------------------------
 * The runtime needs the build toolchain
 * ----------------------------------------------------------------------- */

test('the image never prunes dev dependencies', () => {
  // `vite preview` IS the server -- the CCTV proxy is a Vite plugin registered
  // on it -- and `vite` lives in devDependencies. An --omit=dev anywhere here
  // produces an image that builds cleanly and then cannot start.
  assert.ok(
    !/--omit[= ]dev|--production|NODE_ENV=production\s+npm\s+ci/.test(dockerfile),
    'pruning dev dependencies removes vite, which is the server',
  );
  assert.ok(pkg.devDependencies?.vite, 'vite is a dev dependency; this test exists because of that');
});

/* --------------------------------------------------------------------------
 * Node version
 * ----------------------------------------------------------------------- */

test('the Dockerfile version guard matches the engines field', () => {
  // The `node:24` tag moves. When it moves out of range the build must fail
  // with a sentence, not with something strange halfway through.
  const engines = pkg.engines?.node || '';
  assert.match(engines, /24\.14/, 'engines pins a 24.14 floor');
  const guard = /a===24&&b>=14/.test(dockerfile);
  assert.ok(guard, 'the Dockerfile guard should encode the same 24.14 floor');
  const majors = [...engines.matchAll(/>=(\d+)/g)].map((m) => Number(m[1]));
  for (const major of majors) {
    assert.ok(
      new RegExp(`a===${major}`).test(dockerfile),
      `engines allows Node ${major}, so the Dockerfile guard must accept it too`,
    );
  }
});

/* --------------------------------------------------------------------------
 * Reachability: the mistake that looks like success
 * ----------------------------------------------------------------------- */

test('compose forces HOST=0.0.0.0 rather than trusting .env', () => {
  // HOST=127.0.0.1 is correct in the non-Docker guide and catastrophic here:
  // the server binds inside the container's own network namespace, passes its
  // own health check, and is reachable from nowhere. `environment:` outranks
  // `env_file:`, so copying that line into .env cannot cause this.
  const environment = compose.split('environment:')[1]?.split('ports:')[0] || '';
  assert.match(environment, /HOST:\s*"?0\.0\.0\.0"?/, 'HOST must be pinned to 0.0.0.0 in compose');
  assert.ok(
    compose.includes('env_file:'),
    'the rest of the configuration still comes from .env',
  );
  assert.ok(
    compose.indexOf('env_file:') < compose.indexOf('environment:'),
    'environment must come after env_file so it wins',
  );
});

test('the published port stays on the host loopback', () => {
  // Anything else exposes the app to the internet without HTTPS, bypassing the
  // Nginx the guide puts in front of it.
  assert.match(
    compose,
    /- "127\.0\.0\.1:\$\{HOST_PORT:-8080\}:8080"/,
    'the port must publish to 127.0.0.1 only',
  );
});

/* --------------------------------------------------------------------------
 * Build-time secrets
 * ----------------------------------------------------------------------- */

test('API keys are build arguments, because Vite inlines them at build time', () => {
  // These go through Vite's `define`, which substitutes the text inside the
  // bundle. Supplying them as runtime environment variables does nothing at
  // all -- the bundle is already written -- and the failure is silent.
  for (const key of ['GOOGLE_MAPS_API_KEY', 'CESIUM_ION_TOKEN']) {
    assert.ok(
      new RegExp(`ARG ${key}`).test(dockerfile),
      `${key} must be an ARG in the builder stage`,
    );
    const args = compose.split('args:')[1]?.split('image:')[0] || '';
    assert.ok(args.includes(key), `${key} must be passed as a build arg in compose`);
  }
});

/* --------------------------------------------------------------------------
 * Writable state
 * ----------------------------------------------------------------------- */

test('the provider cache directory is created and owned before dropping root', () => {
  // Providers write to ./.gev-cache at runtime. The unprivileged user cannot
  // create it inside /app on its own.
  assert.match(dockerfile, /mkdir -p \/app\/\.gev-cache/);
  assert.match(dockerfile, /chown node:node \/app\/\.gev-cache/);
  assert.ok(
    dockerfile.indexOf('chown node:node /app/.gev-cache') < dockerfile.indexOf('USER node'),
    'the directory must be prepared while still root',
  );
  assert.match(compose, /- cache:\/app\/\.gev-cache/, 'the cache should survive a recreate');
});

test('the container does not run as root', () => {
  assert.match(dockerfile, /^USER node$/m);
});

/* --------------------------------------------------------------------------
 * Health check
 * ----------------------------------------------------------------------- */

test('the health check uses tools the image actually has', () => {
  const health = dockerfile.split('HEALTHCHECK')[1] || '';
  assert.ok(health, 'a health check is what makes `docker compose ps` meaningful');
  assert.ok(!/curl|wget/.test(health), 'neither curl nor wget is installed in node:slim');
  assert.match(health, /node -e/, 'node is always present');
  // Vite always admits a literal IPv4 Host, so the check cannot start failing
  // just because ALLOWED_HOSTS changed.
  assert.match(health, /127\.0\.0\.1/, 'an IPv4 literal sidesteps the host allow list');
});

/* --------------------------------------------------------------------------
 * Build context
 * ----------------------------------------------------------------------- */

test('secrets and rebuilt directories stay out of the image', () => {
  for (const pattern of ['.env', 'node_modules', 'dist', '.gev-cache']) {
    assert.ok(
      dockerignore.split('\n').some((line) => line.trim() === pattern),
      `.dockerignore should exclude ${pattern}`,
    );
  }
  assert.ok(
    dockerignore.includes('!.env.example'),
    '.env.example documents the settings and should survive the .env.* rule',
  );
});

test('nothing the running server reads is excluded from the build context', () => {
  // The catalogs, ground heights and brand files are read from disk at runtime.
  // An over-eager ignore rule here produces a container that starts and then
  // serves an empty globe.
  const required = [
    'config/cctv_sources.indonesia.json',
    'config/brand.json',
    'config/splash-bounds.json',
    'src/data/local_data/cctv_ground_heights/cctv_ground_heights.json',
    'vite.config.js',
    'server/providers/local.js',
  ];
  const rules = dockerignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'));
  for (const file of required) {
    assert.ok(
      fs.existsSync(new URL(`../../${file}`, import.meta.url)),
      `${file} should exist in the repository`,
    );
    for (const rule of rules) {
      const directory = rule.endsWith('/') ? rule : `${rule}/`;
      assert.ok(
        file !== rule && !file.startsWith(directory),
        `${file} is needed at runtime but "${rule}" would drop it`,
      );
    }
  }
});

/* --------------------------------------------------------------------------
 * Naming
 * ----------------------------------------------------------------------- */

test('the stack is named pri-nusantara throughout', () => {
  assert.match(compose, /^name:\s*pri-nusantara$/m);
  assert.match(compose, /container_name:\s*pri-nusantara/);
  assert.match(compose, /image:\s*pri-nusantara:latest/);
});
