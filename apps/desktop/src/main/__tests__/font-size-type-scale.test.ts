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
import { test } from 'node:test';
import { DEFAULT_UI_FONT_SIZE } from '@maka/core/settings';
import { TYPE_SCALE_BASE_PX } from '../../renderer/astryx-theme/type-scale.js';
import { makaTheme } from '../../renderer/astryx-theme/makaTheme.js';

// `DEFAULT_UI_FONT_SIZE` (in @maka/core, which cannot import renderer code)
// means "the type scale as designed, no root scaling" — it is only true while
// it equals the renderer's type-scale base that `applyUiFontSize` divides by.
// This test makes that cross-package coupling fail loudly instead of silently
// mis-scaling every size (see the Astro-Han review on PR #4024).
test('default UI font size equals the renderer type-scale base', () => {
  assert.equal(DEFAULT_UI_FONT_SIZE, TYPE_SCALE_BASE_PX);
});

test('makaTheme generates its type scale from the shared base constant', () => {
  // `--font-size-base` is step 0 of the expanded scale: base px over the 16px
  // browser root. If makaTheme's scale and TYPE_SCALE_BASE_PX ever diverge,
  // this stops holding.
  assert.equal(makaTheme.tokens['--font-size-base'], `${TYPE_SCALE_BASE_PX / 16}rem`);
});
