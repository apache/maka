import assert from 'node:assert/strict';
import test from 'node:test';
import { compositeScrimOverBackground, parseCssRgbColor } from '../../renderer/titlebar-dim-color.js';

// The two scrim values the app theme pins (astryx-theme/maka.css:
// light-dark(#00000080, #000000CC)).
const LIGHT_SCRIM = { r: 0, g: 0, b: 0, a: 0.5 };
const DARK_SCRIM = { r: 0, g: 0, b: 0, a: 0.8 };

test('light-theme dim: black@50% scrim over a white titlebar', () => {
  assert.equal(compositeScrimOverBackground(LIGHT_SCRIM, '#ffffff'), '#808080');
});

test('dark-theme dim: black@80% scrim over the dark titlebar', () => {
  assert.equal(compositeScrimOverBackground(DARK_SCRIM, '#171719'), '#050505');
});

test('an opaque scrim wins outright', () => {
  assert.equal(
    compositeScrimOverBackground({ r: 16, g: 32, b: 48, a: 1 }, '#ffffff'),
    '#102030',
  );
});

test('an unparseable background comes back unchanged so the caller degrades', () => {
  assert.equal(compositeScrimOverBackground(LIGHT_SCRIM, 'not-a-color'), 'not-a-color');
});

test('parseCssRgbColor reads every rgb()/rgba() separator style', () => {
  assert.deepEqual(parseCssRgbColor('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseCssRgbColor('rgba(0,0,0,0.8)'), { r: 0, g: 0, b: 0, a: 0.8 });
  assert.deepEqual(parseCssRgbColor('rgb(255, 255, 255)'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseCssRgbColor('rgb(23 23 25 / 80%)'), { r: 23, g: 23, b: 25, a: 0.8 });
});

test('parseCssRgbColor refuses serializations it cannot trust', () => {
  assert.equal(parseCssRgbColor('oklch(0.2 0.01 250)'), null);
  assert.equal(parseCssRgbColor('color(srgb 0 0 0 / 0.5)'), null);
  assert.equal(parseCssRgbColor(''), null);
});
