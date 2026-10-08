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
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import type { OnboardingState } from '@maka/core/onboarding';
import {
  applyOnboardingSessionUpdate,
  createOnboardingAuthority,
  createOnboardingSnapshotPoller,
  getOnboardingActivationCandidate,
  OnboardingAuthorityProvider,
  OnboardingConnectionSeed,
  type OnboardingAuthority,
  type OnboardingProjection,
  OnboardingProjectionRoot,
  onboardingSnapshotProjectionEqual,
  type OnboardingShellProjection,
  type OnboardingSource,
} from '../../renderer/application/contracts/onboarding/onboarding-authority.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { createDesktopOnboardingSource } from '../../renderer/platform/desktop/create-onboarding-source.js';
import type { OnboardingSnapshot } from '../../preload/bridge-contract.js';

describe('createOnboardingAuthority', () => {
  afterEach(cleanupFakeDom);

  function source(overrides: Partial<OnboardingSource> = {}) {
    const calls: string[] = [];
    let invalidate: ((sessionId?: string) => void) | undefined;
    const snapshots = [READY_SNAPSHOT, NEEDS_CONNECTION_SNAPSHOT];
    const value: OnboardingSource = {
      getSnapshot: async () => { calls.push('snapshot'); return snapshots.shift() ?? NEEDS_CONNECTION_SNAPSHOT; },
      getSessionUpdate: async (sessionId) => {
        calls.push(`session:${sessionId}`);
        return { kind: 'delta', sessionId, outcome: { kind: 'blocked', reason: 'connection_missing', connectionLocked: false } };
      },
      subscribeInvalidations(handler) {
        calls.push('subscribe');
        invalidate = handler;
        return () => { calls.push('unsubscribe'); invalidate = undefined; };
      },
      skipInitialOnboarding: async () => { calls.push('skip'); },
      ...overrides,
    };
    return { value, calls, invalidate: (sessionId?: string) => invalidate?.(sessionId) };
  }

  it('reads only while subscribed and keeps the snapshot for the next reader', async () => {
    const fake = source();
    const authority = createOnboardingAuthority(fake.value);
    authority.refresh();
    await flushMicrotasks();
    assert.deepEqual(fake.calls, [], 'no reader, no read');
    let notified = 0;
    const unsubscribe = authority.subscribe(() => { notified += 1; });
    await flushMicrotasks();
    assert.equal(authority.getProjection().snapshot, READY_SNAPSHOT);
    fake.invalidate('one');
    await flushMicrotasks();
    assert.deepEqual(authority.getProjection().snapshot?.sessionSendOutcomes, {
      one: { kind: 'blocked', reason: 'connection_missing', connectionLocked: false },
    });
    assert.equal(notified, 2);
    unsubscribe();
    assert.deepEqual(fake.calls, ['snapshot', 'subscribe', 'session:one', 'unsubscribe']);
    assert.notEqual(authority.getProjection().snapshot, null, 'the accepted snapshot survives the last reader');
  });

  it('flags a failed read without dropping the snapshot, and clears it on the next success', async () => {
    let fail = false;
    const fake = source({
      getSnapshot: async () => {
        if (fail) throw new Error('Authorization: Bearer sk-live-secret-token-value');
        return READY_SNAPSHOT;
      },
    });
    const authority = createOnboardingAuthority(fake.value);
    const unsubscribe = authority.subscribe(() => {});
    await flushMicrotasks();
    fail = true;
    fake.invalidate();
    await flushMicrotasks();
    assert.deepEqual(authority.getProjection(), { snapshot: READY_SNAPSHOT, failed: true });
    fail = false;
    authority.refresh();
    await flushMicrotasks();
    assert.deepEqual(authority.getProjection(), { snapshot: READY_SNAPSHOT, failed: false });
    unsubscribe();
  });

  it('hands the shell the live projection and the authority commands through its root', async () => {
    const fake = source();
    const authority = createOnboardingAuthority(fake.value);
    const seen: OnboardingShellProjection[] = [];
    const { root } = installReactRenderer();
    await act(async () => root.render(createElement(OnboardingAuthorityProvider, { value: authority },
      createElement(OnboardingProjectionRoot, {
        children: (onboarding: OnboardingShellProjection) => {
          seen.push(onboarding);
          return null;
        },
      }))));
    await act(async () => flushMicrotasks());
    assert.equal(seen.at(-1)?.snapshot, READY_SNAPSHOT);
    assert.equal(seen.at(-1)?.refresh, authority.refresh);
    await act(async () => { fake.invalidate(); await flushMicrotasks(); });
    assert.equal(seen.at(-1)?.snapshot, NEEDS_CONNECTION_SNAPSHOT);
    await act(async () => root.unmount());
    assert.equal(fake.calls.at(-1), 'unsubscribe', 'the root is the subscriber that keeps the reads alive');
  });

  it('seeds the default Host connections from each new snapshot, and refreshes them when reads fail', async () => {
    let projection: OnboardingProjection = { snapshot: null, failed: false };
    const listeners = new Set<() => void>();
    const authority: OnboardingAuthority = {
      getProjection: () => projection,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      refresh: () => {},
      skipInitialOnboarding: async () => {},
    };
    const publish = (next: OnboardingProjection) => act(() => { projection = next; listeners.forEach((listener) => listener()); });
    const calls: unknown[] = [];
    const { root } = installReactRenderer();
    await act(async () => root.render(createElement(OnboardingAuthorityProvider, { value: authority,
      children: createElement(OnboardingConnectionSeed, {
        seed: (snapshot) => calls.push(snapshot),
        refresh: () => calls.push('refresh'),
      }) })));
    assert.deepEqual(calls, [], 'nothing to seed before the first read');
    const withConnections = { ...READY_SNAPSHOT, defaultSlug: 'openai' };
    publish({ snapshot: withConnections, failed: false });
    publish({ snapshot: withConnections, failed: false });
    assert.deepEqual(calls.splice(0), [{ connections: [], defaultConnection: 'openai', chatModelChoices: [] }]);
    publish({ snapshot: null, failed: true });
    assert.deepEqual(calls.splice(0), ['refresh']);
    await act(async () => root.unmount());
  });

  it('fails without its provider instead of holding the first-run gate closed', () => {
    const { root } = installReactRenderer();
    assert.throws(() => act(() => root.render(createElement(OnboardingProjectionRoot, { children: () => null }))),
      /OnboardingAuthorityProvider is missing/);
  });

  it('re-pulls after a skip lands, and not after a skip fails', async () => {
    let skipFails = false;
    const fake = source({
      skipInitialOnboarding: async () => {
        fake.calls.push('skip');
        if (skipFails) throw new Error('Host unavailable');
      },
    });
    const authority = createOnboardingAuthority(fake.value);
    const unsubscribe = authority.subscribe(() => {});
    await flushMicrotasks();
    fake.calls.length = 0;
    await authority.skipInitialOnboarding();
    await flushMicrotasks();
    assert.deepEqual(fake.calls, ['skip', 'snapshot']);
    fake.calls.length = 0;
    skipFails = true;
    await assert.rejects(authority.skipInitialOnboarding(), /Host unavailable/);
    await flushMicrotasks();
    assert.deepEqual(fake.calls, ['skip']);
    unsubscribe();
  });

  it('Desktop invalidates on named Session, connection and owner-profile events; AppShell no longer writes the milestone', async () => {
    const handlers: Record<string, (event?: unknown) => void> = {};
    const invalidations: Array<string | undefined> = [];
    const listen = (name: string) => (handler: (event?: unknown) => void) => { handlers[name] = handler; return () => {}; };
    const desktop = createDesktopOnboardingSource({
      sessions: { subscribeChanges: listen('sessions') },
      connections: { subscribeEvents: listen('connections') },
      runtimeHostProfiles: { subscribeChanges: listen('profiles') },
    } as unknown as Parameters<typeof createDesktopOnboardingSource>[0]);
    desktop.subscribeInvalidations((sessionId) => invalidations.push(sessionId));
    handlers.sessions?.({ sessionId: 'one' });
    handlers.connections?.();
    handlers.profiles?.({ profileAccess: 'guest', isDefault: false });
    handlers.profiles?.({ profileAccess: 'owner', isDefault: false });
    assert.deepEqual(invalidations, ['one', undefined, undefined]);
    const shell = readFileSync(fileURLToPath(new URL('../../../src/renderer/app-shell.tsx', import.meta.url)), 'utf8');
    assert.deepEqual(shell.split('\n').filter((line) => /\bonboarding\s*\.\s*setMilestone\b|\buseOnboardingSnapshot\b/.test(line)), []);
  });
});

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
      onError: () => assert.fail('unexpected onboarding read failure'),
    });
    await poller.pull();
    await poller.pullSession('one');
    assert.equal(fullReads, 1);
    assert.deepEqual(updates, ['one']);
    assert.equal(emitted.length, 2);
  });

  it('keeps the accepted snapshot on a targeted failure until a complete resync succeeds', async () => {
    const snapshots: OnboardingSnapshot[] = [];
    let failures = 0;
    let fullReads = 0;
    const poller = createOnboardingSnapshotPoller({
      getSnapshot: async () => ++fullReads === 1 ? READY_SNAPSHOT : NEEDS_CONNECTION_SNAPSHOT,
      getSessionUpdate: async () => { throw new Error('Host disconnected'); },
    }, {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onError: () => { failures += 1; },
    });
    await poller.pull();
    await poller.pullSession('one');
    assert.deepEqual(snapshots, [READY_SNAPSHOT, NEEDS_CONNECTION_SNAPSHOT]);
    assert.equal(fullReads, 2, 'the failed delta needs an authoritative resync');
    assert.equal(failures, 1);
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
      onError: () => assert.fail('unexpected onboarding read failure'),
    });
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
      onError: () => assert.fail('unexpected onboarding read failure'),
    });
    await poller.pull();
    const first = poller.pullSession('active');
    for (let index = 0; index < 65; index++) void poller.pullSession(`pending-${index}`);
    release({ kind: 'delta', sessionId: 'active', outcome: { kind: 'ready' } });
    await first;
    assert.equal(targetedReads, 1);
    assert.equal(fullReads, 2);
  });

  it('reports a getSnapshot rejection without carrying its text', async () => {
    const events: Array<{ type: 'snap' | 'err'; payload: unknown }> = [];
    const poller = createOnboardingSnapshotPoller(
      {
        getSnapshot: async () => {
          throw new Error('IPC failed for /Users/demo/.maka/settings.json Authorization: Bearer sk-live-secret-token-value');
        },
      },
      {
        onSnapshot: (s) => events.push({ type: 'snap', payload: s }),
        onError: () => events.push({ type: 'err', payload: undefined }),
      },
    );
    await poller.pull();
    // Nothing renders the failure's text, so none of it (paths, tokens) is kept.
    assert.deepEqual(events, [{ type: 'err', payload: undefined }]);
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
        onError: () => events.push({ type: 'err', payload: undefined }),
      },
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
        onError: () => events.push({ type: 'err', payload: undefined }),
      },
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
        onError: () => events.push({ type: 'err', payload: undefined }),
      },
    );

    poller.dispose();
    await poller.pull();
    assert.deepEqual(events, [], 'disposed poller must ignore pulls');

    poller.activate();
    await poller.pull();
    assert.deepEqual(events, [{ type: 'snap', payload: READY_SNAPSHOT }]);
  });
});
