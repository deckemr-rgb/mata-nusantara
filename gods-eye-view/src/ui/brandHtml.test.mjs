import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { applyBrand, loadBrand } from '../../build/brand-html.js';
import { buildApplicationHtml } from '../../build/application-html.js';

const DEFAULTS = {
  name: "GOD'S EYE",
  nameAccent: 'VIEW',
  documentTitle: "God's Eye View",
  tagline: 'NO PLACE LEFT BEHIND',
  logo: '/logo.svg',
  splash: '/splash.svg',
};

const custom = (over = {}) => ({ ...DEFAULTS, ...over });

const MARKUP = [
  '<title>God&#39;s Eye View</title>',
  '<h1><span data-brand="name">GOD\'S EYE <span class="title-accent">VIEW</span></span></h1>',
  '<p class="subtitle" data-brand="tagline">NO PLACE LEFT BEHIND</p>',
  '<img src="/logo.svg" alt="" />',
].join('\n');

test('an unchanged brand leaves the markup completely alone', () => {
  // This is what keeps the build identical for anyone who has not touched the
  // brand file — and, critically, what stops the English default from
  // overwriting a tagline the dictionary just translated.
  const { html, applied } = applyBrand(MARKUP, custom());
  assert.equal(html, MARKUP);
  assert.equal(applied, 0);
});

test('changing the document title rewrites only the title', () => {
  const { html } = applyBrand(MARKUP, custom({ documentTitle: 'Mata Nusantara' }));
  assert.match(html, /<title>Mata Nusantara<\/title>/);
  assert.ok(html.includes("GOD'S EYE"), 'the on-screen name is untouched');
});

test('changing the name rewrites the on-screen title with its accent span', () => {
  const { html } = applyBrand(
    MARKUP,
    custom({ name: 'MATA', nameAccent: 'NUSANTARA' }),
  );
  assert.match(
    html,
    /data-brand="name">MATA <span class="title-accent">NUSANTARA<\/span>/,
  );
});

test('a one-word brand drops the accent span entirely', () => {
  // An empty span would still occupy a space in the rendered title.
  const { html } = applyBrand(MARKUP, custom({ name: 'PANTAU', nameAccent: '' }));
  assert.match(html, /data-brand="name">PANTAU<\/span>/);
  assert.ok(!/title-accent"><\/span>/.test(html));
});

test('an empty tagline hides its element instead of leaving a blank line', () => {
  const { html } = applyBrand(MARKUP, custom({ tagline: '' }));
  assert.match(html, /data-brand="tagline"[^>]*\shidden>/);
});

test('a replaced logo path updates every reference, including the favicon', () => {
  // Two references in this fixture: the favicon link and the on-screen <img>.
  const markup = `<link rel="icon" href="/logo.svg" />${MARKUP}`;
  const before = (markup.match(/\/logo\.svg/g) || []).length;
  const { html } = applyBrand(markup, custom({ logo: '/brand.svg' }));
  assert.ok(!html.includes('/logo.svg'), 'no stale reference may survive');
  assert.equal((html.match(/\/brand\.svg/g) || []).length, before);
});

test('brand text is escaped, so a stray angle bracket cannot inject markup', () => {
  const { html } = applyBrand(
    MARKUP,
    custom({ name: '<script>alert(1)</script>', nameAccent: '' }),
  );
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('a logo path with a quote cannot break out of its attribute', () => {
  const markup = '<img src="/logo.svg" />';
  const { html } = applyBrand(markup, custom({ logo: '/a" onerror="x' }));
  assert.ok(!html.includes('onerror="x"'));
  assert.ok(html.includes('&quot;'));
});

test('loadBrand falls back to the defaults when the file is missing', () => {
  const brand = loadBrand(new URL('./does-not-exist.json', import.meta.url));
  assert.deepEqual(brand, DEFAULTS);
});

test('loadBrand keeps a deliberately empty string rather than filling it in', () => {
  // An empty tagline is a real choice — "hide it" — not a missing value.
  const file = new URL('./brand-fixture.json', import.meta.url);
  fs.writeFileSync(file, JSON.stringify({ tagline: '', name: 'X' }));
  try {
    const brand = loadBrand(file);
    assert.equal(brand.tagline, '');
    assert.equal(brand.name, 'X');
    assert.equal(brand.documentTitle, DEFAULTS.documentTitle, 'missing keys fall back');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('the build renders whatever brand file is currently shipped', () => {
  // Asserted against the ACTIVE brand file rather than one fixed name: pinning
  // a name here would fail every time someone rebrands, which is the normal
  // use of this system, not a regression.
  const source = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const html = buildApplicationHtml(source);
  const brand = loadBrand();

  const rawTitle = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '';
  const title = rawTitle.replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.equal(title, brand.documentTitle, 'tab title follows the brand file');

  const onScreen =
    /data-brand="name"[^>]*>([\s\S]*?)<\/span><\/span>/.exec(html)?.[1] ?? '';
  assert.ok(
    onScreen.includes(brand.name),
    `on-screen title should carry ${brand.name}, got: ${onScreen}`,
  );
  if (brand.nameAccent) {
    assert.ok(
      onScreen.includes(brand.nameAccent),
      'the accent half of the name should render too',
    );
  }
});

test('the shipped brand file parses and carries every key', () => {
  const brand = loadBrand();
  for (const key of Object.keys(DEFAULTS)) {
    assert.equal(typeof brand[key], 'string', `${key} must be a string`);
  }
});
