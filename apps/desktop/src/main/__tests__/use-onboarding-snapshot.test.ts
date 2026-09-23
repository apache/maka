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

describe('createOnboardingSnapshotPoller', () => {
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
    assert.deepEqual(events, [NEEDS_CONNECTION_SNAPSHOT, READY_SNAPSHOT]);
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
