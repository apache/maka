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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { OnboardingState } from '@maka/core/onboarding';
import {
  applyOnboardingSessionUpdate,
  createOnboardingSnapshotPoller,
  getOnboardingActivationCandidate,
  onboardingSnapshotProjectionEqual,
} from '../../renderer/use-onboarding-snapshot.js';
import type { OnboardingSnapshot } from '../../preload/bridge-contract.js';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const READY_SNAPSHOT: OnboardingSnapshot = {
  state: {
    kind: 'ready_empty',
    connectionSlug: 'a',
    model: 'm',
  } as OnboardingState,
  milestones: [],
  sessions: [],
  connections: [],
  defaultSlug: null,
  chatModelChoices: [],
  sessionSendOutcomes: {},
};

const NEEDS_CONNECTION_SNAPSHOT: OnboardingSnapshot = {
  state: { kind: 'needs_connection' } as OnboardingState,
  milestones: [],
  sessions: [],
  connections: [],
  defaultSlug: null,
  chatModelChoices: [],
  sessionSendOutcomes: {},
};

describe('getOnboardingActivationCandidate', () => {
  it('exposes the readiness-checked pair during an unsettled first activation', () => {
    assert.deepEqual(getOnboardingActivationCandidate(READY_SNAPSHOT, false), {
      llmConnectionSlug: 'a',
      model: 'm',
    });
  });

  it('does not influence ordinary new tasks after workspace history exists', () => {
    assert.equal(
      getOnboardingActivationCandidate(
        {
          ...READY_SNAPSHOT,
          state: { kind: 'ready_with_history', connectionSlug: 'a', model: 'm' },
        },
        false,
      ),
      undefined,
    );
  });

  it('does not influence the composer after onboarding is settled', () => {
    assert.equal(
      getOnboardingActivationCandidate(
        {
          ...READY_SNAPSHOT,
          milestones: [{ id: 'initial_onboarding', skippedAt: 1 }],
        },
        false,
      ),
      undefined,
    );
  });

  it('does not trust a stale ready-empty snapshot after local history appears', () => {
    assert.equal(getOnboardingActivationCandidate(READY_SNAPSHOT, true), undefined);
  });
});

describe('onboardingSnapshotProjectionEqual', () => {
  it('ignores sessions churn — the catalog owns live session rows', () => {
    assert.equal(
      onboardingSnapshotProjectionEqual(READY_SNAPSHOT, {
        ...READY_SNAPSHOT,
        sessions: [{} as OnboardingSnapshot['sessions'][number]],
      }),
      true,
    );
  });

  it('detects changes in the render-relevant fields', () => {
    assert.equal(
      onboardingSnapshotProjectionEqual(READY_SNAPSHOT, NEEDS_CONNECTION_SNAPSHOT),
      false,
    );
    assert.equal(
      onboardingSnapshotProjectionEqual(READY_SNAPSHOT, {
        ...READY_SNAPSHOT,
        sessionSendOutcomes: { s1: { kind: 'ready' } },
      }),
      false,
    );
    assert.equal(
      onboardingSnapshotProjectionEqual(READY_SNAPSHOT, {
        ...READY_SNAPSHOT,
        defaultSlug: 'other',
      }),
      false,
    );
  });
});

it('one outcome delta leaves unrelated outcomes and default state in place', () => {
  const initial = {
    ...READY_SNAPSHOT,
    sessionSendOutcomes: { first: { kind: 'ready' } as const, second: { kind: 'ready' } as const },
  };
  const changed = applyOnboardingSessionUpdate(initial, {
    kind: 'delta', sessionId: 'second',
    outcome: { kind: 'blocked', reason: 'fake_backend', connectionLocked: false },
  });
  assert.deepEqual(changed.sessionSendOutcomes.first, { kind: 'ready' });
  assert.equal(changed.state, initial.state);
  assert.equal(initial.sessionSendOutcomes.second.kind, 'ready');
  assert.equal(applyOnboardingSessionUpdate(changed, {
    kind: 'delta', sessionId: 'second', outcome: changed.sessionSendOutcomes.second,
  }), changed, 'an unchanged high-frequency outcome does not copy the entire record');
  const removed = applyOnboardingSessionUpdate(changed, {
    kind: 'delta', sessionId: 'second', outcome: null,
  });
  assert.equal(removed.sessionSendOutcomes.second, undefined);
  assert.deepEqual(removed.sessionSendOutcomes.first, { kind: 'ready' });
});

describe('createOnboardingSnapshotPoller', () => {
  it('uses one targeted read for a named event after bootstrap', async () => {
    let fullReads = 0;
    const updates: string[] = [];
    const emitted: unknown[] = [];
    const poller = createOnboardingSnapshotPoller({
      getSnapshot: async () => { fullReads++; return READY_SNAPSHOT; },
      getSessionUpdate: async (id) => {
        updates.push(id);
        return { kind: 'delta', sessionId: id, outcome: { kind: 'ready' } };
      },
    }, {
      onSnapshot: (snapshot) => emitted.push(snapshot),
      onSessionUpdate: (update) => emitted.push(update),
      onError: (error) => assert.fail(error),
    }, () => 'zh-CN');
    await poller.pull();
    await poller.pullSession('one');
    assert.equal(fullReads, 1);
    assert.deepEqual(updates, ['one']);
    assert.equal(emitted.length, 2);
  });

  it('keeps the accepted snapshot on a targeted failure until a complete resync succeeds', async () => {
    const snapshots: OnboardingSnapshot[] = [];
    const errors: string[] = [];
    let fullReads = 0;
    const poller = createOnboardingSnapshotPoller({
      getSnapshot: async () => ++fullReads === 1 ? READY_SNAPSHOT : NEEDS_CONNECTION_SNAPSHOT,
      getSessionUpdate: async () => { throw new Error('Host disconnected'); },
    }, {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onError: (message) => errors.push(message),
    }, () => 'zh-CN');
    await poller.pull();
    await poller.pullSession('one');
    assert.deepEqual(snapshots, [READY_SNAPSHOT, NEEDS_CONNECTION_SNAPSHOT]);
    assert.equal(fullReads, 2, 'the failed delta needs an authoritative resync');
    assert.equal(errors.length, 1);
  });

  it('coalesces a repeat while a targeted read is in flight', async () => {
    let resolveFirst!: (value: { kind: 'delta'; sessionId: string; outcome: { kind: 'ready' } }) => void;
    let calls = 0;
    const emitted: string[] = [];
    const poller = createOnboardingSnapshotPoller({
      getSnapshot: async () => READY_SNAPSHOT,
      getSessionUpdate: (id) => {
        calls++;
        return calls === 1
          ? new Promise((resolve) => { resolveFirst = resolve; })
          : Promise.resolve({ kind: 'delta' as const, sessionId: id, outcome: { kind: 'ready' as const } });
      },
    }, {
      onSnapshot: () => {},
      onSessionUpdate: (update) => emitted.push(update.sessionId),
      onError: (error) => assert.fail(error),
    }, () => 'zh-CN');
    await poller.pull();
    const first = poller.pullSession('one');
    void poller.pullSession('one');
    resolveFirst({ kind: 'delta', sessionId: 'one', outcome: { kind: 'ready' } });
    await first;
    assert.equal(calls, 2);
    assert.deepEqual(emitted, ['one'], 'the older response stays unpublished');
  });

  it('bounds distinct pending IDs and falls back to one complete resync', async () => {
    let release!: (value: { kind: 'delta'; sessionId: string; outcome: { kind: 'ready' } }) => void;
    let fullReads = 0;
    let targetedReads = 0;
    const poller = createOnboardingSnapshotPoller({
      getSnapshot: async () => { fullReads++; return READY_SNAPSHOT; },
      getSessionUpdate: (id) => {
        targetedReads++;
        return new Promise((resolve) => { release = resolve; });
      },
    }, {
      onSnapshot: () => {},
      onSessionUpdate: () => assert.fail('superseded update must not publish'),
      onError: (error) => assert.fail(error),
    }, () => 'zh-CN');
    await poller.pull();
    const first = poller.pullSession('active');
    for (let index = 0; index < 65; index++) void poller.pullSession(`pending-${index}`);
    release({ kind: 'delta', sessionId: 'active', outcome: { kind: 'ready' } });
    await first;
    assert.equal(targetedReads, 1);
    assert.equal(fullReads, 2);
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
      () => 'zh-CN',
    );
    await poller.pull();
    assert.deepEqual(events, [{ type: 'err', payload: '鉴权失败' }]);
    assert.notEqual(String(events[0]?.payload).includes('/Users/demo'), true);
    assert.notEqual(String(events[0]?.payload).includes('sk-live-secret'), true);
  });

  it('a pull issued while another is in flight runs once after it settles', async () => {
    const resolvers: Array<(snap: OnboardingSnapshot) => void> = [];
    const events: OnboardingSnapshot[] = [];
    const poller = createOnboardingSnapshotPoller(
      {
        getSnapshot: () =>
          new Promise<OnboardingSnapshot>((resolve) => {
            resolvers.push(resolve);
          }),
      },
      {
        onSnapshot: (s) => events.push(s),
        onError: () => {
          /* not expected */
        },
      },
      () => 'zh-CN',
    );
    const pull1 = poller.pull();
    const pull2 = poller.pull();
    assert.equal(resolvers.length, 1, 'overlapping pull must not start a second getSnapshot');
    resolvers[0]!(NEEDS_CONNECTION_SNAPSHOT);
    await flushMicrotasks();
    assert.equal(resolvers.length, 2, 'the queued pull runs exactly one follow-up');
    resolvers[1]!(READY_SNAPSHOT);
    await pull1;
    await pull2;
    assert.deepEqual(events, [READY_SNAPSHOT], 'the superseded full response stays unpublished');
  });

  it('collapses repeated invalidations during one pull into a single follow-up', async () => {
    const resolvers: Array<(snap: OnboardingSnapshot) => void> = [];
    const poller = createOnboardingSnapshotPoller(
      {
        getSnapshot: () =>
          new Promise<OnboardingSnapshot>((resolve) => {
            resolvers.push(resolve);
          }),
      },
      {
        onSnapshot: () => {
          /* not asserted */
        },
        onError: () => {
          /* not expected */
        },
      },
      () => 'zh-CN',
    );
    void poller.pull();
    void poller.pull();
    void poller.pull();
    void poller.pull();
    assert.equal(resolvers.length, 1);
    resolvers[0]!(READY_SNAPSHOT);
    await flushMicrotasks();
    assert.equal(resolvers.length, 2, 'four queued invalidations produce one follow-up');
    resolvers[1]!(READY_SNAPSHOT);
    await flushMicrotasks();
    assert.equal(resolvers.length, 2);
  });

  it('a response in flight across dispose cannot write after re-activation', async () => {
    const resolvers: Array<(snap: OnboardingSnapshot) => void> = [];
    const events: OnboardingSnapshot[] = [];
    const poller = createOnboardingSnapshotPoller(
      {
        getSnapshot: () =>
          new Promise<OnboardingSnapshot>((resolve) => {
            resolvers.push(resolve);
          }),
      },
      {
        onSnapshot: (s) => events.push(s),
        onError: () => {
          /* not expected */
        },
      },
      () => 'zh-CN',
    );
    const pull = poller.pull();
    poller.dispose();
    poller.activate();
    resolvers[0]!(READY_SNAPSHOT);
    await pull;
    assert.deepEqual(events, [], 'pre-dispose response must stay dropped after re-activation');
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
      () => 'zh-CN',
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
      () => 'zh-CN',
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
      () => 'zh-CN',
    );

    poller.dispose();
    await poller.pull();
    assert.deepEqual(events, [], 'disposed poller must ignore pulls');

    poller.activate();
    await poller.pull();
    assert.deepEqual(events, [{ type: 'snap', payload: READY_SNAPSHOT }]);
  });
});
