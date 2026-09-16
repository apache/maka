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

/**
 * What one read across preload/IPC brings over: a Session under the history
 * budget arrives whole, with nothing left to ask the Host for.
 *
 * What the window then does with it — mounted rows, traversal, the reader's
 * displacement per frame — is renderer-owned and lives in the browser stories
 * over real layout (`UpwardTraversalHoldsTurnGeometry`,
 * `PrependedHistoryKeepsMeasuredHeights`).
 */

import { PROMPT_RAIL_PROMPT_COUNT } from '../src/main/e2e-fixture/seed-helpers';
import { expect, test } from './fixtures';

test('a Session under the history budget arrives whole in one read', async ({
  promptRailWindow: page,
}) => {
  await page.setViewportSize({ width: 1_000, height: 700 });
  await expect(page.locator(`[data-turn-id="turn-prompt-rail-${PROMPT_RAIL_PROMPT_COUNT}"]`)).toHaveCount(1);
  // The rail ticks every resident Turn, up to its own cap: the whole Session
  // crossed, not the tail the renderer happens to have mounted.
  await expect(page.locator('.maka-prompt-rail-tick')).toHaveCount(Math.min(PROMPT_RAIL_PROMPT_COUNT, 64));
  await expect(page.getByRole('button', { name: '载入更早的记录' })).toHaveCount(0);
});
