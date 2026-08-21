import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ProviderRetryScheduledEvent } from '@maka/core/events';
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
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  return { container, root };
}

function scheduledRetry(ts: number): ProviderRetryScheduledEvent {
  return {
    type: 'provider_retry',
    id: 'retry-1',
    turnId: 'turn-1',
    ts,
    phase: 'scheduled',
    attempt: 2,
    maxAttempts: 10,
    delayMs: 10_000,
    reason: 'rate_limit',
  };
}

async function renderRetry(root: ReturnType<typeof createRoot>, retry: ProviderRetryScheduledEvent) {
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
 * Retry-After. The banner must count down from the event's timestamp — a
 * frozen number reads as a hung process.
 */
test('provider retry banner subtracts the time already waited', async (t) => {
  const now = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const { container, root } = domRoot();

  await renderRetry(root, scheduledRetry(now));
  assert.match(container.textContent ?? '', /Retrying in 10s \(2\/10\)/);

  // Four seconds into the wait the same event renders the remaining six.
  await renderRetry(root, scheduledRetry(now - 4_000));
  assert.match(container.textContent ?? '', /Retrying in 6s \(2\/10\)/);
});

test('provider retry banner never shows a negative countdown', async (t) => {
  const now = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const { container, root } = domRoot();

  await renderRetry(root, scheduledRetry(now - 60_000));
  assert.match(container.textContent ?? '', /Retrying in 1s \(2\/10\)/);
});
