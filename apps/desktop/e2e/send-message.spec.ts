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

import { test, expect, COMPOSER_INPUT } from './fixtures';

/**
 * Enter commits a candidate in a CJK IME; nothing else may act on it. Both the
 * composer's send and ChatComposerInput's trigger menu read Enter, and the
 * component runs its menu handling before the `onKeyDown` we pass it — so the
 * guard is a native capture on the composer root that takes the key away from
 * React entirely.
 */
/**
 * Core chat loop: type a message, send it, see the deterministic fake backend
 * stream a reply back into the transcript. Depends on the E2E seam: the
 * fixture's MAKA_E2E=1 forces sessions:create onto the fake backend, and the
 * seeded 'e2e' connection clears onboarding so the composer is usable.
 */
test('Enter mid-IME commits the candidate, then an ordinary send streams a reply', async ({
  window: page,
}) => {
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('中文草稿');
  await composer.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    // `isComposing: false` on purpose: only the composition we track ourselves
    // can stop this one, so a passing test can't be crediting the component's
    // own `nativeEvent.isComposing` check.
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });

  // A leaked send is asynchronous, so `toHaveCount(0)` can pass before it
  // lands, and a second send of the same text would hide it. Send something
  // different and pin the total instead.
  await composer.fill('中文草稿 已提交');
  await composer.press('Enter');
  await expect(page.getByRole('log').getByText(/Fake backend received: 中文草稿 已提交/)).toBeVisible();
  await expect(page.getByLabel('你发送的消息')).toHaveCount(1);

  // Settle before the ordinary send: an Enter during a streaming turn would
  // become steering instead of a second message.
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, { timeout: 20_000 });

  // #1433: the deleted first-run panel had its own input, and the spec that
  // covered the handoff between the two asserted this accessible name. With
  // one composer left, the name is what a screen-reader user has to find the
  // send target by — assert it on the path that exercises it.
  await expect(composer).toHaveAttribute('aria-label', '消息输入框');
  await composer.fill('hello e2e');
  await composer.press('Enter');

  await expect(page.getByRole('log').getByText(/Fake backend received: hello e2e/)).toBeVisible();
});
