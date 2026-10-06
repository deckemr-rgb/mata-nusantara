import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { splashEase, SPLASH_FADE_MS } from './splashOverlay.js';

test('the fade curve runs the full range, in the right direction', () => {
  assert.equal(splashEase(0), 0);
  assert.equal(splashEase(1), 1);
  // Monotonic: a fade that ever goes back up would read as a flicker.
  let previous = -1;
  for (let i = 0; i <= 20; i += 1) {
    const value = splashEase(i / 20);
    assert.ok(value >= previous, `curve went backwards at ${i / 20}`);
    previous = value;
  }
});

test('the fade curve is eased at both ends, not linear', () => {
  // A linear fade reads as mechanical; the ends should move slower than the
  // middle. At 10% of the way through, a linear curve would already be at 0.1.
  assert.ok(splashEase(0.1) < 0.05, 'should start gently');
  assert.ok(splashEase(0.9) > 0.95, 'should settle gently');
  // And the middle should be near half.
  assert.ok(Math.abs(splashEase(0.5) - 0.5) < 0.01);
});

test('the fade curve clamps input outside 0..1', () => {
  assert.equal(splashEase(-3), 0);
  assert.equal(splashEase(42), 1);
  assert.equal(splashEase(Number.NaN), 0);
});

test('the shipped duration is the five seconds that was asked for', () => {
  assert.equal(SPLASH_FADE_MS, 5000);
});

/* --------------------------------------------------------------------------
 * The image and its geographic frame must agree
 * ----------------------------------------------------------------------- */

const bounds = JSON.parse(
  fs.readFileSync(new URL('../../config/splash-bounds.json', import.meta.url), 'utf8'),
);

test('the splash bounds cover Indonesia and nothing more', () => {
  // Sabang sits near 95°E and the Papua border is exactly 141°E; anything
  // wider would mean the generator picked up an island it should not have.
  assert.ok(bounds.west > 93 && bounds.west < 96, `west: ${bounds.west}`);
  assert.ok(bounds.east > 140 && bounds.east < 143, `east: ${bounds.east}`);
  assert.ok(bounds.south > -12 && bounds.south < -9, `south: ${bounds.south}`);
  assert.ok(bounds.north > 5 && bounds.north < 8, `north: ${bounds.north}`);
});

test('the bounds are a well-formed rectangle', () => {
  assert.ok(bounds.east > bounds.west);
  assert.ok(bounds.north > bounds.south);
});

test('the image aspect ratio matches its geographic frame', () => {
  // The overlay is pinned to the globe as a lon/lat rectangle, so the image
  // must be plain equirectangular. If the generator ever reintroduces a
  // cos(latitude) correction, the drawing slides off the coastline underneath
  // it — and this is the assertion that catches it.
  const svg = fs.readFileSync(new URL('../../public/splash.svg', import.meta.url), 'utf8');
  const size = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
  assert.ok(size, 'the splash SVG should declare a viewBox');
  const imageRatio = Number(size[1]) / Number(size[2]);
  const geoRatio =
    (bounds.east - bounds.west) / (bounds.north - bounds.south);
  assert.ok(
    Math.abs(imageRatio - geoRatio) / geoRatio < 0.01,
    `image ratio ${imageRatio.toFixed(3)} should match geography ${geoRatio.toFixed(3)}`,
  );
});

test('the SVG declares intrinsic pixel dimensions', () => {
  // Without width/height an SVG has no intrinsic size, and the browser falls
  // back to 300px — which is what a texture loader would then upload.
  const svg = fs.readFileSync(new URL('../../public/splash.svg', import.meta.url), 'utf8');
  assert.match(svg, /<svg[^>]*\swidth="\d+"/);
  assert.match(svg, /<svg[^>]*\sheight="\d+"/);
});

test('a PNG texture ships beside the SVG source', () => {
  // Cesium uploads imagery through createImageBitmap, which refuses SVG
  // ("The source image could not be decoded"), so the globe layer needs a
  // raster. The SVG stays as the editable source.
  const png = new URL('../../public/splash.png', import.meta.url);
  assert.ok(fs.existsSync(png), 'public/splash.png should be generated');
  const header = fs.readFileSync(png).subarray(0, 8);
  assert.deepEqual(
    [...header],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'should be a real PNG',
  );
});

test('the brand file points the splash at the raster, not the SVG', () => {
  const brand = JSON.parse(
    fs.readFileSync(new URL('../../config/brand.json', import.meta.url), 'utf8'),
  );
  assert.match(
    brand.splash,
    /\.(png|jpe?g|webp)$/i,
    'an SVG here would fail to decode as a WebGL texture',
  );
});
