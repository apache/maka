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
import { test } from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import {
  HostHandoffCancelledError,
  HostHandoffRequiredError,
  runHostHandoff,
  type HostHandoffAction,
  type HostHandoffBlocker,
  type HostHandoffView,
  type OpenHostHandoffSurface,
} from '../client/host-handoff.js';
import { decodeClientFrame, decodeHostFrame } from '../protocol/index.js';
import { decodeHostActivitySnapshot, isHostActivityIdle } from '../protocol/host-status.js';
import { formatHostHandoff } from '../client/host-handoff-copy.js';

const idle = { connections: 0, activeOperations: 0, processUptimeSeconds: 1, residencies: [] };
const target = {
  name: 'Local workspace',
  location: 'local' as const,
  rootId: 'root',
  hostEpoch: 'a',
};
const resource = <T>(value: T) => ({ value, async close() {} });
const blocked = (blocker: HostHandoffBlocker) => ({ kind: 'blocked' as const, blocker });
const base: HostHandoffBlocker = {
  identity: 'root/owner/a',
  target,
  reason: 'upgrade',
  mayExitNaturally: false,
};

function surfaceHarness() {
  let submit: (revision: string, action: HostHandoffAction) => void;
  let latest: HostHandoffView | undefined;
  let closed = false;
  const waiters = new Set<{
    predicate(view: HostHandoffView): boolean;
    resolve(view: HostHandoffView): void;
  }>();
  const openSurface: OpenHostHandoffSurface = (callback) => {
    submit = callback;
    return {
      update(view) {
        latest = view;
        for (const waiter of waiters)
          if (waiter.predicate(view)) {
            waiters.delete(waiter);
            waiter.resolve(view);
          }
      },
      close() {
        closed = true;
      },
    };
  };
  return {
    openSurface,
    get closed() {
      return closed;
    },
    choose(view: HostHandoffView, action: HostHandoffAction) {
      submit(view.revision, action);
    },
    view(predicate: (view: HostHandoffView) => boolean = () => true): Promise<HostHandoffView> {
      if (latest && predicate(latest)) return Promise.resolve(latest);
      return new Promise((resolve) => waiters.add({ predicate, resolve }));
    },
  };
}

test('compatible connection needs no handoff surface', async () => {
  assert.equal(
    (await runHostHandoff({ observe: async () => ({ kind: 'ready', value: resource(42) }) })).value,
    42,
  );
});

test('handoff copy exposes background work even with zero operations and keeps legacy counts unknown', () => {
  const view: HostHandoffView = {
    revision: 'test',
    target,
    state: 'attention',
    reason: 'busy',
    mayExitNaturally: false,
    actions: ['cancel', 'interrupt'],
    defaultAction: 'cancel',
    activity: {
      ...idle,
      residencies: [{ label: 'memory-extraction', count: 2 }],
      drainResidencies: 2,
    },
  };
  for (const [locale, known, unknown] of [
    ['en', '2 background activities', 'Background activity count unknown'],
    ['zh-CN', '2 个后台工作', '后台工作数量未知'],
    ['zh-TW', '2 個背景工作', '背景工作數量未知'],
  ] as const) {
    assert.ok(formatHostHandoff(view, locale).detail.includes(known));
    assert.ok(formatHostHandoff({ ...view, activity: idle }, locale).detail.includes(unknown));
  }
});

test('managed handoff copy gives the user an executable Desktop recovery path', () => {
  const view: HostHandoffView = {
    revision: 'managed',
    target,
    state: 'attention',
    reason: 'operator_required',
    mayExitNaturally: false,
    actions: ['cancel', 'retry'],
    defaultAction: 'cancel',
    recoveryBlocker: 'managed',
  };
  for (const [locale, expected] of [
    [
      'en',
      'Desktop installed it, open this workspace there and choose Stop old service and continue',
    ],
    ['zh-CN', '在该 Desktop 中打开此工作区，然后选择“停止旧服务并继续”'],
    ['zh-TW', '在該 Desktop 中開啟此工作區，然後選擇「停止舊服務並繼續」'],
  ] as const) {
    assert.match(formatHostHandoff(view, locale).description, new RegExp(expected, 'u'));
  }
});

test('maintenance evidence distinguishes idle retention without guessing for legacy activity', () => {
  const retention = { ...idle, residencies: [{ label: 'process-retention', count: 1 }] };
  assert.equal(isHostActivityIdle(decodeHostActivitySnapshot(retention)), false);
  assert.equal(
    isHostActivityIdle(decodeHostActivitySnapshot({ ...retention, drainResidencies: 0 })),
    true,
  );
  assert.equal(isHostActivityIdle({ ...retention, drainResidencies: 1 }), false);
  assert.throws(() => decodeHostActivitySnapshot({ ...retention, drainResidencies: -1 }));
  assert.throws(() => decodeHostActivitySnapshot({ ...retention, drainResidencies: '0' }));
});

test('activity extension is opt-in and old handshake activity remains decodable', () => {
  const hello = {
    kind: 'hello',
    clientInstanceId: 'client',
    protocolMin: 0,
    protocolMax: 0,
    compatibilityEpoch: 119,
    compositionId: 'interactive',
  };
  assert.deepEqual(decodeClientFrame(hello), hello);
  assert.deepEqual(decodeClientFrame({ ...hello, activitySnapshotVersion: 2 }), {
    ...hello,
    activitySnapshotVersion: 2,
  });
  const legacy = {
    kind: 'incompatible',
    hostEpoch: 'host',
    protocolMin: 0,
    protocolMax: 0,
    compatibilityEpoch: 50,
    compositionId: 'interactive',
    compositionRevision: 'legacy',
    state: 'ready',
    replacement: 'blocked_by_residency',
    activity: idle,
  };
  assert.deepEqual(decodeHostFrame(legacy), legacy);
});

test('verified idle replacement is automatic but readiness must be reobserved', async () => {
  let ready = false;
  assert.equal(
    (
      await runHostHandoff({
        observe: async () =>
          ready
            ? { kind: 'ready', value: resource('successor') }
            : blocked({
                ...base,
                activity: idle,
                replacement: {
                  kind: 'replace',
                  canReplaceIdle: true,
                  canInterrupt: true,
                  async execute(policy) {
                    assert.equal(policy, 'refuse_active_work');
                    ready = true;
                    return { kind: 'completed' };
                  },
                },
              }),
      })
    ).value,
    'successor',
  );
});

test('negotiated cooperative work can continue automatically without interruption consent', async () => {
  let ready = false;
  const result = await runHostHandoff({
    observe: async () =>
      ready
        ? { kind: 'ready', value: resource('continued') }
        : blocked({
            ...base,
            activity: {
              ...idle,
              cooperativeHandoff: true,
              drainResidencies: 1,
              residencies: [{ label: 'hosted-execution', count: 1 }],
            },
            replacement: {
              kind: 'replace',
              canReplaceIdle: true,
              canInterrupt: false,
              async execute(policy, _progress, consent) {
                assert.equal(policy, 'refuse_active_work');
                assert.equal(consent, 'automatic');
                ready = true;
                return { kind: 'completed' };
              },
            },
          }),
  });
  assert.equal(result.value, 'continued');
});

test('progress Cancel aborts cooperative convergence but awaits safe transaction settlement', async () => {
  const ui = surfaceHarness();
  const aborted = deferred<void>();
  const release = deferred<void>();
  let finished = false;
  const running = runHostHandoff({
    openSurface: ui.openSurface,
    observe: async () =>
      blocked({
        ...base,
        activity: {
          ...idle,
          cooperativeHandoff: true,
          drainResidencies: 1,
          residencies: [{ label: 'hosted-execution', count: 1 }],
        },
        replacement: {
          kind: 'replace',
          canReplaceIdle: true,
          canInterrupt: false,
          async execute(_policy, _progress, _consent, signal) {
            assert.ok(signal);
            signal.addEventListener('abort', () => aborted.resolve(), { once: true });
            await release.promise;
            return { kind: 'active_work' };
          },
        },
      }),
  });
  const rejection = assert.rejects(running, HostHandoffCancelledError).then(() => {
    finished = true;
  });
  const view = await ui.view((candidate) => candidate.state === 'progress');
  assert.equal(view.phase, 'pausing');
  assert.deepEqual(view.actions, ['cancel']);
  ui.choose(view, 'cancel');
  await aborted.promise;
  assert.equal(finished, false);
  assert.equal(ui.closed, false);
  release.resolve();
  await rejection;
  assert.equal(ui.closed, true);
});

test('unknown work requires explicit non-default consent', async () => {
  const ui = surfaceHarness();
  let ready = false;
  const running = runHostHandoff({
    openSurface: ui.openSurface,
    pollIntervalMs: 1,
    observe: async () =>
      ready
        ? { kind: 'ready', value: resource('done') }
        : blocked({
            ...base,
            replacement: {
              kind: 'replace',
              canReplaceIdle: false,
              canInterrupt: true,
              async execute(policy) {
                assert.equal(policy, 'interrupt_active_work');
                ready = true;
                return { kind: 'completed' };
              },
            },
          }),
  });
  const view = await ui.view();
  assert.equal(view.reason, 'activity_unknown');
  assert.equal(view.defaultAction, 'cancel');
  ui.choose(view, 'interrupt');
  assert.equal((await running).value, 'done');
  assert.equal(ui.closed, true);
});

test('cancel during observation wins over a changed idle successor', async () => {
  const ui = surfaceHarness();
  let markObserving!: () => void;
  let releaseObservation!: () => void;
  const observing = new Promise<void>((resolve) => {
    markObserving = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseObservation = resolve;
  });
  let observations = 0;
  const running = runHostHandoff({
    openSurface: ui.openSurface,
    pollIntervalMs: 1,
    observe: async () => {
      if (observations++ === 0) return blocked(base);
      markObserving();
      await release;
      return blocked({
        ...base,
        identity: 'successor',
        activity: idle,
        replacement: {
          kind: 'replace',
          canReplaceIdle: true,
          canInterrupt: true,
          async execute() {
            assert.fail('Cancel must not start replacement');
          },
        },
      });
    },
  });
  const view = await ui.view();
  await observing;
  ui.choose(view, 'cancel');
  releaseObservation();
  await assert.rejects(running, HostHandoffCancelledError);
  assert.equal(ui.closed, true);
});

test('fresh observation invalidates consent when the Host changes before a click is applied', async () => {
  const ui = surfaceHarness();
  let epoch = 'a';
  const running = runHostHandoff({
    openSurface: ui.openSurface,
    pollIntervalMs: 1,
    observe: async () =>
      blocked({
        ...base,
        identity: epoch,
        target: { ...target, hostEpoch: epoch },
        replacement: {
          kind: 'replace',
          canReplaceIdle: false,
          canInterrupt: true,
          async execute() {
            assert.fail('Stale consent must never invoke replacement');
          },
        },
      }),
  });
  const old = await ui.view();
  epoch = 'b';
  ui.choose(old, 'interrupt');
  const current = await ui.view((view) => view.target.hostEpoch === 'b');
  assert.notEqual(current.revision, old.revision);
  ui.choose(old, 'interrupt');
  ui.choose(current, 'cancel');
  await assert.rejects(running, HostHandoffCancelledError);
});

test('a live blocking surface resolves automatically when work finishes', async () => {
  const ui = surfaceHarness();
  let active = true;
  let ready = false;
  const running = runHostHandoff({
    openSurface: ui.openSurface,
    pollIntervalMs: 1,
    observe: async () =>
      ready
        ? { kind: 'ready', value: resource('done') }
        : blocked({
            ...base,
            activity: { ...idle, activeOperations: active ? 1 : 0 },
            replacement: {
              kind: 'replace',
              canReplaceIdle: true,
              canInterrupt: true,
              async execute(policy) {
                assert.equal(policy, 'refuse_active_work');
                ready = true;
                return { kind: 'completed' };
              },
            },
          }),
  });
  assert.equal((await ui.view()).reason, 'busy');
  active = false;
  assert.equal((await running).value, 'done');
  assert.equal(ui.closed, true);
});

test('automatic replacement attempts are bounded even if every successor conflicts', async () => {
  let epoch = 0;
  await assert.rejects(
    runHostHandoff({
      observe: async () =>
        blocked({
          ...base,
          identity: String(epoch),
          activity: idle,
          replacement: {
            kind: 'replace',
            canReplaceIdle: true,
            canInterrupt: true,
            async execute() {
              epoch += 1;
              return { kind: 'completed' };
            },
          },
        }),
    }),
    HostHandoffRequiredError,
  );
  assert.equal(epoch, 3);
});

test('an admission refusal does not repeatedly retry the same idle observation', async () => {
  let replacements = 0;
  await assert.rejects(
    runHostHandoff({
      observe: async () =>
        blocked({
          ...base,
          activity: idle,
          replacement: {
            kind: 'replace',
            canReplaceIdle: true,
            canInterrupt: true,
            async execute() {
              replacements += 1;
              return { kind: 'active_work' };
            },
          },
        }),
    }),
    HostHandoffRequiredError,
  );
  assert.equal(replacements, 1);
});

test('remote operators get actionable retry without local interruption authority', async () => {
  await assert.rejects(
    runHostHandoff({
      observe: async () =>
        blocked({
          ...base,
          target: { ...target, location: 'remote' },
          operatorStep: 'Update Maka on office-mac, then retry.',
        }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof HostHandoffRequiredError);
      assert.deepEqual(error.view.actions, ['cancel', 'retry']);
      assert.equal(error.view.operatorStep, 'Update Maka on office-mac, then retry.');
      return true;
    },
  );
});

test('transaction failure remains a repair outcome instead of an automatic retry loop', async () => {
  await assert.rejects(
    runHostHandoff({
      observe: async () =>
        blocked({
          ...base,
          activity: idle,
          replacement: {
            kind: 'repair',
            canReplaceIdle: true,
            canInterrupt: true,
            async execute() {
              return { kind: 'recovery_required', diagnostic: 'Writer release was not verified' };
            },
          },
        }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof HostHandoffRequiredError);
      assert.equal(error.view.reason, 'repair_required');
      assert.equal(error.view.diagnostic, 'Writer release was not verified');
      assert.match(formatHostHandoff(error.view, 'zh-CN').description, /修复原因后再重试/u);
      assert.match(formatHostHandoff(error.view, 'en').description, /without a state change/u);
      return true;
    },
  );
});

test('cancellation does not abandon an in-flight deployment transaction', async () => {
  const abort = new AbortController();
  let markStarted!: () => void;
  let markFinished!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  let settled = false;
  const running = runHostHandoff({
    signal: abort.signal,
    observe: async () =>
      blocked({
        ...base,
        activity: idle,
        replacement: {
          kind: 'replace',
          canReplaceIdle: true,
          canInterrupt: true,
          async execute() {
            markStarted();
            await finish;
            settled = true;
            return { kind: 'completed' };
          },
        },
      }),
  });
  await started;
  abort.abort(new Error('cancelled'));
  assert.equal(settled, false);
  markFinished();
  await assert.rejects(running, /cancelled/);
  assert.equal(settled, true);
});

test('managed handoff rechecks without mutation and requests interruption only after safe admission refuses', async () => {
  const ui = surfaceHarness();
  const policies: string[] = [];
  let observations = 0;
  let ready = false;
  const running = runHostHandoff({
    openSurface: ui.openSurface,
    pollIntervalMs: 1,
    observe: async () => {
      observations += 1;
      if (ready) return { kind: 'ready', value: resource('connected') };
      return blocked({
        ...base,
        manualRecheck: true,
        activity: idle,
        packageChange: { current: '0.2.0', target: '0.3.0' },
        replacement: {
          kind: 'replace',
          canReplaceIdle: true,
          canInterrupt: true,
          requiresExplicitSelection: true,
          execute: async (policy, _progress, consent) => {
            assert.equal(consent, 'explicit');
            policies.push(policy);
            if (policy === 'refuse_active_work') return { kind: 'active_work' };
            ready = true;
            return { kind: 'completed' };
          },
        },
      });
    },
  });
  const initial = await ui.view();
  assert.equal(initial.reason, 'replacement_required');
  assert.match(formatHostHandoff(initial, 'zh-CN').detail, /0\.2\.0 → 0\.3\.0/u);
  assert.deepEqual(initial.actions, ['cancel', 'retry', 'replace']);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(observations, 1);
  ui.choose(initial, 'retry');
  const checked = await ui.view((view) => view.revision !== initial.revision);
  assert.deepEqual(policies, []);
  ui.choose(checked, 'replace');
  const busy = await ui.view((view) => view.state === 'attention' && view.reason === 'busy');
  assert.deepEqual(policies, ['refuse_active_work']);
  assert.ok(busy.actions.includes('interrupt'));
  ui.choose(busy, 'interrupt');
  assert.equal((await running).value, 'connected');
  assert.deepEqual(policies, ['refuse_active_work', 'interrupt_active_work']);
});
