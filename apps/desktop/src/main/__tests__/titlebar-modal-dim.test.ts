/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
