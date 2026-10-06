import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';

import {
  MAP_VIEW_PRESETS,
  PITCH_ANGLED,
  PITCH_LOW,
  PITCH_TOP_DOWN,
  nearestPresetKey,
} from './mapViewPresets.js';

const deg = (radians) => Cesium.Math.toDegrees(radians);

test('the presets span straight-down to low, and never reach exactly -90', () => {
  assert.ok(deg(PITCH_TOP_DOWN) < -80, 'top-down looks nearly straight down');
  // At exactly -90 the heading is undefined and the camera can snap on the
  // operator's next drag, so the top-down preset stops just short of it.
  assert.ok(deg(PITCH_TOP_DOWN) > -90, 'but never exactly -90');
  assert.ok(deg(PITCH_ANGLED) > deg(PITCH_TOP_DOWN));
  assert.ok(deg(PITCH_LOW) > deg(PITCH_ANGLED));
});

test('every preset carries a pitch and a label', () => {
  for (const [key, preset] of Object.entries(MAP_VIEW_PRESETS)) {
    assert.ok(Number.isFinite(preset.pitch), `${key} needs a pitch`);
    assert.ok(preset.label, `${key} needs a label`);
  }
});

test('only STRAIGHTEN also commands a heading', () => {
  // A preset that silently rotated the map would be startling; straightening
  // is the one action that is explicitly about putting north back on top.
  assert.equal(MAP_VIEW_PRESETS.straighten.heading, 0);
  assert.equal(MAP_VIEW_PRESETS.top.heading, undefined);
  assert.equal(MAP_VIEW_PRESETS.angled.heading, undefined);
  assert.equal(MAP_VIEW_PRESETS.low.heading, undefined);
});

test('STRAIGHTEN looks straight down', () => {
  assert.equal(MAP_VIEW_PRESETS.straighten.pitch, PITCH_TOP_DOWN);
});

test('nearestPresetKey matches an exact preset pitch', () => {
  assert.equal(nearestPresetKey(PITCH_TOP_DOWN), 'top');
  assert.equal(nearestPresetKey(PITCH_ANGLED), 'angled');
  assert.equal(nearestPresetKey(PITCH_LOW), 'low');
});

test('nearestPresetKey tolerates small drift around a preset', () => {
  assert.equal(nearestPresetKey(Cesium.Math.toRadians(-42)), 'angled');
  assert.equal(nearestPresetKey(Cesium.Math.toRadians(-48)), 'angled');
  assert.equal(nearestPresetKey(Cesium.Math.toRadians(-24)), 'low');
});

test('nearestPresetKey reports no match for a freehand angle', () => {
  // Highlighting a button the camera is nowhere near tells the operator
  // something false about the view they are looking at.
  assert.equal(nearestPresetKey(Cesium.Math.toRadians(-65)), null);
  assert.equal(nearestPresetKey(Cesium.Math.toRadians(-5)), null);
});

test('nearestPresetKey never matches STRAIGHTEN, which is an action', () => {
  for (const pitch of [-89, -45, -20, -65, -5]) {
    assert.notEqual(nearestPresetKey(Cesium.Math.toRadians(pitch)), 'straighten');
  }
});

test('nearestPresetKey is safe on junk input', () => {
  assert.equal(nearestPresetKey(Number.NaN), null);
  assert.equal(nearestPresetKey(undefined), null);
  assert.equal(nearestPresetKey('-45'), null);
});
