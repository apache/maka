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

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cursorOverlayWindowOptions } from '../computer-use/cursor-overlay-window.js';

test('persistent cursor overlay keeps animation frames unthrottled in the background', () => {
  const options = cursorOverlayWindowOptions(
    { x: 0, y: 0, width: 1920, height: 1080 },
    '/tmp/cursor-overlay-preload.cjs',
  );

  assert.equal(options.webPreferences?.backgroundThrottling, false);
});
