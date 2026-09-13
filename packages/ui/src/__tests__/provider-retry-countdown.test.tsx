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
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ProviderRetryScheduledEvent } from '@maka/core/events';
import type { LiveProviderRetry } from '../live-turn-projection.js';
import { ModelProviderRetryIndicator } from '../chat-turn.js';
import { LocaleProvider } from '../locale-context.js';

const originalGlobals = {
  document: globalThis.document,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;

const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  // Unmount before restoring globals: React's cleanup reads `document`.
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function domRoot() {
  const { document, window } = parseHTML('<div id="root"></div>');
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // linkedom's window.setInterval resolves to globalThis.setInterval at call
  // time, so `t.mock.timers` (which patches the global) drives the banner's
  // one-second interval too — no adapter needed here.
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  return { container, root };
}

function scheduledRetry(
  overrides: Partial<ProviderRetryScheduledEvent> = {},
): ProviderRetryScheduledEvent {
  return {
    type: 'provider_retry',
    id: 'retry-1',
    turnId: 'turn-1',
    ts: 1,
    phase: 'scheduled',
    attempt: 2,
    maxAttempts: 10,
    delayMs: 10_000,
    reason: 'rate_limit',
    ...overrides,
  };
}

async function renderRetry(root: ReturnType<typeof createRoot>, retry: LiveProviderRetry) {
  await act(() =>
    root.render(
      <LocaleProvider locale="en">
        <ModelProviderRetryIndicator retry={retry} />
      </LocaleProvider>,
    ),
  );
}

/**
 * #3393: a subscription quota window can hand the runtime an hours-long
 * Retry-After. The banner counts down against the CLIENT-local receipt time —
 * a single clock domain, immune to skew between the client and a possibly
 * remote Runtime Host clock.
 */
test('provider retry banner subtracts the time already waited since receipt', async (t) => {
  const now = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const { container, root } = domRoot();

  await renderRetry(root, { event: scheduledRetry(), receivedAtMs: now });
  assert.match(container.textContent ?? '', /Retrying in 10s \(2\/10\)/);

  // Four seconds into the wait the same event renders the remaining six.
  await renderRetry(root, { event: scheduledRetry(), receivedAtMs: now - 4_000 });
  assert.match(container.textContent ?? '', /Retrying in 6s \(2\/10\)/);
});

test('provider retry banner never shows a negative countdown', async (t) => {
  const now = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const { container, root } = domRoot();

  await renderRetry(root, { event: scheduledRetry(), receivedAtMs: now - 60_000 });
  // Floors at 1s (formatRetryDelay uses Math.max(1, …)) until the `started`
  // event replaces it.
  assert.match(container.textContent ?? '', /Retrying in 1s \(2\/10\)/);
});

test('reduced motion keeps a correct static value at mount without ticking', async (t) => {
  const now = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const { container, root } = domRoot();
  // The reduced-motion preference freezes the per-second tick, but the
  // initial measurement still lands: four seconds into the wait the banner
  // reads 6s from the start instead of pinning the full delay.
  document.documentElement.dataset.makaReducedMotion = 'true';

  await renderRetry(root, { event: scheduledRetry(), receivedAtMs: now - 4_000 });
  assert.match(container.textContent ?? '', /Retrying in 6s \(2\/10\)/);

  await act(() => t.mock.timers.tick(2_000));
  assert.match(container.textContent ?? '', /Retrying in 6s \(2\/10\)/);
});

test('provider retry banner counts down from remainingMs when the host provides it', async (t) => {
  const now = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const { container, root } = domRoot();

  // A mid-wait host re-projection (reconnect) recomputes the remaining
  // duration; the banner counts THAT down instead of restarting at delayMs.
  await renderRetry(root, {
    event: scheduledRetry({ delayMs: 3_600_000, remainingMs: 300_000 }),
    receivedAtMs: now,
  });
  assert.match(container.textContent ?? '', /Retrying in 5m \(2\/10\)/);
});

test('a mounted provider retry banner actually ticks once per second', async (t) => {
  const now = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const { container, root } = domRoot();

  await renderRetry(root, { event: scheduledRetry(), receivedAtMs: now });
  assert.match(container.textContent ?? '', /Retrying in 10s \(2\/10\)/);

  await act(() => t.mock.timers.tick(1_000));
  assert.match(container.textContent ?? '', /Retrying in 9s \(2\/10\)/);

  await act(() => t.mock.timers.tick(2_000));
  assert.match(container.textContent ?? '', /Retrying in 7s \(2\/10\)/);
});

test('the ticking countdown stays hidden from the live region, which keeps a stable label', async (t) => {
  const now = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now });
  const { container, root } = domRoot();

  await renderRetry(root, { event: scheduledRetry(), receivedAtMs: now });
  const banner = container.querySelector('.maka-turn-provider-retry');
  assert.ok(banner);
  assert.equal(banner.getAttribute('role'), 'status');
  // The stable accessible name carries reason + attempt — no countdown.
  assert.equal(banner.getAttribute('aria-label'), 'Model rate limit reached · Waiting to retry (2/10)');
  // The visible countdown lives inside an aria-hidden subtree (the banner's
  // status icon is aria-hidden too, so find the node carrying the text).
  const tickingText = () =>
    [...banner.querySelectorAll('[aria-hidden="true"]')]
      .map((node) => node.textContent ?? '')
      .find((text) => /Retrying in/.test(text));
  assert.match(tickingText() ?? '', /Retrying in 10s/);

  // One second later the visual text ticks, the accessible name does not.
  await act(() => t.mock.timers.tick(1_000));
  assert.equal(banner.getAttribute('aria-label'), 'Model rate limit reached · Waiting to retry (2/10)');
  assert.match(tickingText() ?? '', /Retrying in 9s/);
});
