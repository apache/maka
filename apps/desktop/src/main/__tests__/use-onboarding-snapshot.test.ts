/**
 * Tests for the onboarding snapshot poller + isSetupRequired helper
 * (PR110c).
 *
 * The React hook (`useOnboardingSnapshotImpl`) is a thin shell over
 * `createOnboardingSnapshotPoller`. We test the pure poller here —
 * stale-response defense, lifecycle gating, error handling — and
 * verify the helper predicate `isSetupRequired`. The React wiring is
 * covered by Playwright E2E + manual UI testing in PR110d.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { OnboardingState } from '@maka/core';
import {
  advanceOnboardingSnapshotState,
  createOnboardingSnapshotPoller,
  createOnboardingSnapshotState,
  isSetupRequired,
  onboardingSnapshotErrorMessage,
} from '../../renderer/use-onboarding-snapshot.js';
import type { OnboardingSnapshot } from '../../preload/bridge-contract.js';

const READY_SNAPSHOT: OnboardingSnapshot = {
  state: {
    kind: 'ready_empty',
    defaultConnectionSlug: 'a',
    defaultModel: 'm',
  } as OnboardingState,
  milestones: [],
  sessions: [],
  connections: [],
  defaultSlug: null,
};

const NEEDS_CONNECTION_SNAPSHOT: OnboardingSnapshot = {
  state: { kind: 'needs_connection' } as OnboardingState,
  milestones: [],
  sessions: [],
  connections: [],
  defaultSlug: null,
};

describe('createOnboardingSnapshotPoller', () => {
  it('routes a successful getSnapshot to onSnapshot', async () => {
    const events: Array<{ type: 'snap' | 'err'; payload: unknown }> = [];
    const poller = createOnboardingSnapshotPoller(
      { getSnapshot: async () => READY_SNAPSHOT },
      {
        onSnapshot: (s) => events.push({ type: 'snap', payload: s }),
        onError: (m) => events.push({ type: 'err', payload: m }),
      },
      () => 'zh',
    );
    await poller.pull();
    assert.deepEqual(events, [{ type: 'snap', payload: READY_SNAPSHOT }]);
  });

  it('scrubs getSnapshot rejections before routing them to onError', async () => {
    const events: Array<{ type: 'snap' | 'err'; payload: unknown }> = [];
    const poller = createOnboardingSnapshotPoller(
      {
        getSnapshot: async () => {
          throw new Error('IPC failed for /Users/demo/.maka/settings.json Authorization: Bearer sk-live-secret-token-value');
        },
      },
      {
        onSnapshot: (s) => events.push({ type: 'snap', payload: s }),
        onError: (m) => events.push({ type: 'err', payload: m }),
      },
      () => 'zh',
    );
    await poller.pull();
    assert.deepEqual(events, [{ type: 'err', payload: '鉴权失败' }]);
    assert.notEqual(String(events[0]?.payload).includes('/Users/demo'), true);
    assert.notEqual(String(events[0]?.payload).includes('sk-live-secret'), true);
  });

  it('older inflight response cannot overwrite newer state (ticket guard)', async () => {
    let resolveFirst!: (snap: OnboardingSnapshot) => void;
    let resolveSecond!: (snap: OnboardingSnapshot) => void;
    let call = 0;
    const events: Array<{ type: 'snap'; payload: OnboardingSnapshot }> = [];
    const poller = createOnboardingSnapshotPoller(
      {
        getSnapshot: () =>
          new Promise<OnboardingSnapshot>((resolve) => {
            call += 1;
            if (call === 1) resolveFirst = resolve;
            else resolveSecond = resolve;
          }),
      },
      {
        onSnapshot: (s) => events.push({ type: 'snap', payload: s }),
        onError: () => {
          /* not expected */
        },
      },
      () => 'zh',
    );
    // Fire two overlapping pulls.
    const pull1 = poller.pull();
    const pull2 = poller.pull();
    // Resolve the newer pull (#2) first.
    resolveSecond(READY_SNAPSHOT);
    await pull2;
    assert.deepEqual(events, [{ type: 'snap', payload: READY_SNAPSHOT }]);
    // Now resolve the stale pull (#1) — it must be ignored.
    resolveFirst(NEEDS_CONNECTION_SNAPSHOT);
    await pull1;
    assert.deepEqual(
      events,
      [{ type: 'snap', payload: READY_SNAPSHOT }],
      'stale response from earlier pull must not emit',
    );
  });

  it('older inflight error cannot overwrite newer state', async () => {
    let rejectFirst!: (err: Error) => void;
    let resolveSecond!: (snap: OnboardingSnapshot) => void;
    let call = 0;
    const snaps: OnboardingSnapshot[] = [];
    const errs: string[] = [];
    const poller = createOnboardingSnapshotPoller(
      {
        getSnapshot: () =>
          new Promise<OnboardingSnapshot>((resolve, reject) => {
            call += 1;
            if (call === 1) rejectFirst = reject;
            else resolveSecond = resolve;
          }),
      },
      {
        onSnapshot: (s) => snaps.push(s),
        onError: (m) => errs.push(m),
      },
      () => 'zh',
    );
    const pull1 = poller.pull();
    const pull2 = poller.pull();
    resolveSecond(READY_SNAPSHOT);
    await pull2;
    rejectFirst(new Error('stale failure'));
    await pull1;
    assert.equal(snaps.length, 1);
    assert.equal(errs.length, 0, 'stale error from older pull must NOT emit');
  });

  it('dispose() prevents pending getSnapshot callbacks after unmount', async () => {
    let resolveSnapshot!: (snap: OnboardingSnapshot) => void;
    const events: Array<{ type: 'snap' | 'err'; payload: unknown }> = [];
    const poller = createOnboardingSnapshotPoller(
      {
        getSnapshot: () =>
          new Promise<OnboardingSnapshot>((resolve) => {
            resolveSnapshot = resolve;
          }),
      },
      {
        onSnapshot: (s) => events.push({ type: 'snap', payload: s }),
        onError: (m) => events.push({ type: 'err', payload: m }),
      },
      () => 'zh',
    );

    const pull = poller.pull();
    poller.dispose();
    resolveSnapshot(READY_SNAPSHOT);
    await pull;

    assert.deepEqual(events, [], 'pending snapshot callbacks must not fire after dispose');
  });

  it('dispose() prevents pending error callbacks after unmount', async () => {
    let rejectSnapshot!: (error: Error) => void;
    const events: Array<{ type: 'snap' | 'err'; payload: unknown }> = [];
    const poller = createOnboardingSnapshotPoller(
      {
        getSnapshot: () =>
          new Promise<OnboardingSnapshot>((_resolve, reject) => {
            rejectSnapshot = reject;
          }),
      },
      {
        onSnapshot: (s) => events.push({ type: 'snap', payload: s }),
        onError: (m) => events.push({ type: 'err', payload: m }),
      },
      () => 'zh',
    );

    const pull = poller.pull();
    poller.dispose();
    rejectSnapshot(new Error('late failure'));
    await pull;

    assert.deepEqual(events, [], 'pending error callbacks must not fire after dispose');
  });

  it('activate() restores callbacks after StrictMode cleanup replay', async () => {
    const events: Array<{ type: 'snap' | 'err'; payload: unknown }> = [];
    const poller = createOnboardingSnapshotPoller(
      { getSnapshot: async () => READY_SNAPSHOT },
      {
        onSnapshot: (s) => events.push({ type: 'snap', payload: s }),
        onError: (m) => events.push({ type: 'err', payload: m }),
      },
      () => 'zh',
    );

    poller.dispose();
    await poller.pull();
    assert.deepEqual(events, [], 'disposed poller must ignore pulls');

    poller.activate();
    await poller.pull();
    assert.deepEqual(events, [{ type: 'snap', payload: READY_SNAPSHOT }]);
  });
});

describe('onboarding mounted snapshot handoff', () => {
  it('latches B when B and a later C are reduced before React commits', () => {
    const snapshotA = READY_SNAPSHOT;
    const snapshotB = { ...READY_SNAPSHOT, defaultSlug: 'b' };
    const snapshotC = { ...READY_SNAPSHOT, defaultSlug: 'c' };

    const afterB = advanceOnboardingSnapshotState(createOnboardingSnapshotState(snapshotA), snapshotB);
    const afterC = advanceOnboardingSnapshotState(afterB, snapshotC);

    assert.equal(afterC.snapshot, snapshotC);
    assert.equal(afterC.firstMountedSnapshot, snapshotB);
  });
});

describe('first-run error boundaries', () => {
  it('keeps onboarding probe errors localized and scrubbed', async () => {
    const onboarding = await readFile(join(process.cwd(), 'src/renderer/use-onboarding-snapshot.ts'), 'utf8');

    assert.match(onboarding, /function onboardingSnapshotErrorMessage\(error: unknown, locale: UiLocale\): string \{[\s\S]*locale === 'zh' \? generalizedErrorMessageChinese\(error, fallback\) : generalizedErrorMessage\(error, fallback\)/);
    assert.match(onboarding, /emitError\(onboardingSnapshotErrorMessage\(err, getLocale\(\)\)\)/);
    assert.doesNotMatch(onboarding, /callbacks\.onError\(err instanceof Error \? err\.message : String\(err\)\)/);
    assert.match(onboarding, /export interface OnboardingSnapshotPoller \{[\s\S]*activate\(\): void;[\s\S]*pull\(\): Promise<void>;[\s\S]*dispose\(\): void;/);
    assert.match(onboarding, /poller\.activate\(\);[\s\S]*void poller\.pull\(\);[\s\S]*unsubscribe\(\);[\s\S]*poller\.dispose\(\);/);
    assert.match(onboarding, /let active = true;/);
    assert.match(onboarding, /if \(!active \|\| ticket !== inflightTicket\) return/);
    assert.match(onboarding, /dispose\(\): void \{[\s\S]*active = false;[\s\S]*inflightTicket \+= 1;/);

    assert.doesNotMatch(onboardingSnapshotErrorMessage(new Error('IPC failed'), 'en'), /[\u3400-\u9fff]/);
  });
});

describe('isSetupRequired', () => {
  it('returns true for the four needs_* variants', () => {
    for (const kind of [
      'needs_connection',
      'needs_default_connection',
      'needs_connection_credentials',
      'needs_default_model',
    ] as const) {
      const state =
        kind === 'needs_connection_credentials' || kind === 'needs_default_model'
          ? ({ kind, connectionSlug: 'a' } as OnboardingState)
          : ({ kind } as OnboardingState);
      assert.equal(isSetupRequired(state), true, `${kind} should be setup-required`);
    }
  });

  it('returns false for ready_empty / ready_with_history / blocked / undefined', () => {
    const ready: OnboardingState = {
      kind: 'ready_empty',
      defaultConnectionSlug: 'a',
      defaultModel: 'm',
    };
    const withHistory: OnboardingState = {
      kind: 'ready_with_history',
      defaultConnectionSlug: 'a',
      defaultModel: 'm',
    };
    const blocked: OnboardingState = { kind: 'blocked', reason: 'all_connections_unhealthy' };
    assert.equal(isSetupRequired(ready), false);
    assert.equal(isSetupRequired(withHistory), false);
    assert.equal(isSetupRequired(blocked), false);
    assert.equal(isSetupRequired(undefined), false);
  });
});
