import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/*
 * Things that only break on the OTHER machine.
 *
 * Every check here passes silently on Windows and fails on macOS or Linux, or
 * the reverse. That asymmetry is the whole point: a contributor cannot notice
 * these by working normally, because their own machine is the one that agrees
 * with them.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (name) => fs.readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

/** Ask Git for the recorded mode of every tracked path matching a glob. */
function trackedModes(glob) {
  const out = execFileSync('git', ['ls-files', '-s', '--', glob], {
    cwd: root,
    encoding: 'utf8',
  });
  const modes = new Map();
  for (const line of out.split('\n')) {
    const match = /^(\d{6})\s+[0-9a-f]+\s+\d+\t(.+)$/.exec(line);
    if (match) modes.set(match[2], match[1]);
  }
  return modes;
}

test('shell scripts npm invokes directly are executable in the index', () => {
  /*
   * package.json runs these as `./scripts/x.sh`, which asks the kernel to
   * execute the file. Git stores the executable bit, but Windows sets
   * core.filemode=false and never records it -- so a script added from Windows
   * lands in the repository as 100644 and the Windows author sees nothing
   * wrong. The first person to clone on macOS or Linux gets "permission
   * denied" from a script that works fine for everyone else.
   *
   * The fix, when this fails: git update-index --chmod=+x <path>
   */
  const invoked = Object.values(pkg.scripts || {})
    .flatMap((command) => [...command.matchAll(/\.\/([\w./-]+\.sh)/g)].map((m) => m[1]));
  assert.ok(invoked.length, 'expected package.json to invoke at least one shell script');

  const modes = trackedModes('*.sh');
  for (const script of invoked) {
    const mode = modes.get(script);
    assert.ok(mode, `${script} is invoked by package.json but not tracked by Git`);
    assert.equal(
      mode,
      '100755',
      `${script} is run as ./${script} and must carry the executable bit`,
    );
  }
});

test('every tracked shell script is executable, not just the ones npm names', () => {
  // The others are run by hand from the guides; "permission denied" is no
  // friendlier there.
  for (const [path, mode] of trackedModes('*.sh')) {
    assert.equal(mode, '100755', `${path} should be executable`);
  }
});

test('text files are normalised to LF for every platform', () => {
  // Dozens of tests read repository source and match it against multi-line
  // regexes anchored on \n. Under Git's default core.autocrlf=true on Windows
  // those sources check out with CRLF and the patterns all miss, so a clean
  // clone fails its own test suite.
  const attributes = read('.gitattributes');
  assert.match(attributes, /^\*\s+text=auto\s+eol=lf$/m, 'all text should check out LF');
  assert.match(attributes, /^\*\.sh\s+text\s+eol=lf$/m, 'a CRLF shell script will not run at all');
});

test('binary assets are marked binary so Git never rewrites them', () => {
  const attributes = read('.gitattributes');
  for (const extension of ['gif', 'png']) {
    assert.match(
      attributes,
      new RegExp(`^\\*\\.${extension}\\s+binary$`, 'm'),
      `*.${extension} must be binary, or eol normalisation will corrupt it`,
    );
  }
});

test('no tracked source file is secretly binary', () => {
  /*
   * A NUL byte inside a .js or .json file has two consequences, both quiet.
   * Git's `text=auto` classifies the file as binary and stops applying the
   * eol=lf normalisation the rest of the tree depends on, and an editor on
   * another machine may strip or mangle the byte on save without saying so.
   *
   * build/i18n-html.js genuinely needs NUL as a masking sentinel -- nothing in
   * HTML can collide with it -- so it writes the escape \u0000 instead of the
   * raw byte. The escape produces the same character at runtime and leaves the
   * file as ordinary text.
   */
  const tracked = execFileSync('git', ['ls-files', '--', '*.js', '*.mjs', '*.json'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  assert.ok(tracked.length > 100, 'expected the repository to track many sources');

  const offenders = tracked.filter((file) =>
    fs.readFileSync(new URL(`../../${file}`, import.meta.url)).includes(0),
  );
  assert.deepEqual(
    offenders,
    [],
    'these files contain a raw NUL byte; write \\u0000 instead',
  );
});

test('secrets and machine-local state are never committed', () => {
  // A collaborator cloning this repository must not receive anyone's keys, and
  // must not inherit a cache or a node_modules built for another operating
  // system -- sharp and puppeteer ship platform-specific binaries.
  const ignore = read('.gitignore');
  for (const entry of ['.env', 'node_modules', 'dist']) {
    assert.ok(
      ignore.split('\n').some((line) => line.trim().replace(/\/$/, '') === entry),
      `.gitignore should exclude ${entry}`,
    );
  }
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  for (const forbidden of ['.env\n', 'node_modules/', '.gev-cache/']) {
    assert.ok(
      !tracked.includes(forbidden),
      `${forbidden.replace(/\n$/, '')} must not be tracked`,
    );
  }
});

test('the Node requirement is stated where another machine will look for it', () => {
  // A collaborator on a different machine needs to know this before `npm ci`
  // fails in a way that does not mention versions.
  assert.ok(pkg.engines?.node, 'engines.node is how nvm and npm learn the requirement');
  assert.match(pkg.engines.node, /24\.14/);
});
