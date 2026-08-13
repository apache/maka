import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { OnboardingState } from '@maka/core/onboarding';
import {
  advanceOnboardingSnapshotState,
  createOnboardingSnapshotPoller,
  createOnboardingSnapshotState,
  getOnboardingActivationCandidate,
} from '../../renderer/use-onboarding-snapshot.js';
import type { OnboardingSnapshot } from '../../preload/bridge-contract.js';

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
  it('keeps a session created while mounted snapshots wait for React to commit', () => {
    const snapshotA = READY_SNAPSHOT;
    const snapshotB = { ...READY_SNAPSHOT };
    const snapshotC: OnboardingSnapshot = {
      ...READY_SNAPSHOT,
      sessions: [
        {
          id: 'created-during-bootstrap',
          name: 'New session',
          isFlagged: false,
          isArchived: false,
          labels: [],
          hasUnread: false,
          status: 'active' as const,
          backend: 'fake',
          llmConnectionSlug: 'default',
          connectionLocked: false,
          model: 'fake-model',
          permissionMode: 'ask' as const,
          projectId: null,
        },
      ],
    };

    const afterB = advanceOnboardingSnapshotState(createOnboardingSnapshotState(snapshotA), snapshotB);
    const afterC = advanceOnboardingSnapshotState(afterB, snapshotC);

    assert.equal(afterC.snapshot, snapshotC);
    assert.deepEqual(
      afterC.mountedSnapshotHandoff?.sessions.map(({ id }) => id),
      ['created-during-bootstrap'],
    );
  });
});
