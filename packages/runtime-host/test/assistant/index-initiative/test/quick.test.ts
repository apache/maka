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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuickDiscoveryController } from '../../../../src/assistant/index-initiative/quick.js';
import { InitiativeController } from '../../../../src/assistant/index-initiative/controller.js';
import { fixture, until } from './fixture.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'quick-discovery-'));
  let now = Date.now(),
    revision = '1',
    calls = 0,
    scans = 0,
    resumes = 0,
    fail = false,
    notebookRefreshes = 0;
  const delivered = new Map<string, any>(),
    prompts: string[] = [];
  const sessions: any[] = [];
  const agent = {
    sessionId: 'worker',
    snapshot: async () => ({ agent: { status: 'idle' } }),
    followup: async (text: string) => {
      calls++;
      assert.equal(notebookRefreshes, calls, 'refresh receipts before every quick wake');
      prompts.push(text);
      return { disposition: 'turn_started' };
    },
    messageExecution: async () => ({ state: 'owned' }),
    whenIdle: async () => {
      if (fail) throw Error('network failure');
    },
    cancel: async () => {},
  };
  const parent = {
    abort: new AbortController(),
    bindingReady: Promise.resolve(),
    refreshNotebook: () => {
      notebookRefreshes++;
    },
    store: { get: () => ({ sessionId: 'owner', cwd: root }) },
    asOwner: (_: any, fn: any) => fn(),
  };
  const ctx = {
    sessionQuery: {
      list: async () => sessions,
      historyList: async () => [{ id: 'source-session', historyRevision: revision }],
    },
    sources: {
      list: () => [{ id: 'mail', scope: {} }],
      activityToken: async () => {
        scans++;
        return revision;
      },
    },
    agents: {
      create: async (input: any) => {
        sessions.push({ id: 'worker', ...input });
        return agent;
      },
      resume: async () => {
        resumes++;
        return agent;
      },
    },
    bot: {
      post: (_: string, message: any) => {
        delivered.set(message.id, message);
        return true;
      },
    },
  };
  const q = new QuickDiscoveryController(ctx, parent, root, () => now);
  q.start(60000);
  await q.control({ action: 'enable' });
  return {
    q,
    agent,
    ctx,
    delivered,
    prompts,
    calls: () => calls,
    scans: () => scans,
    resumes: () => resumes,
    advance: (ms: number) => {
      now += ms;
    },
    setTime: (time: string) => {
      now = Date.parse(time);
    },
    change: () => {
      revision += 'x';
    },
    fail: (v: boolean) => {
      fail = v;
    },
    run: async () => {
      await q.tick();
      await q.running;
    },
    close: async () => {
      await q.close();
      q.store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('quick schedule batches activity at 15 minutes and uses a 60 minute quiet fallback', async () => {
  const f = await setup();
  try {
    await f.run();
    assert.equal(f.calls(), 0);
    f.advance(15 * 60000);
    await f.run();
    assert.equal(f.calls(), 1);
    f.advance(15 * 60000);
    await f.run();
    assert.equal(f.calls(), 1);
    const scans = f.scans();
    await f.run();
    assert.equal(f.scans(), scans);
    f.advance(45 * 60000);
    await f.run();
    assert.equal(f.calls(), 2);
    assert.equal(f.q.state().workerSession, 'worker');
    assert.match(f.prompts[0], /不必等用户明确求助/);
    assert.doesNotMatch(f.prompts[1], /不必等用户明确求助/);
    f.change();
    f.advance(15 * 60000);
    await f.run();
    assert.equal(f.calls(), 3);
  } finally {
    await f.close();
  }
});
test('changes arriving during execution remain for the next wake; concurrent ticks never overlap', async () => {
  const f = await setup();
  try {
    let release!: () => void;
    f.agent.whenIdle = () =>
      new Promise<void>((r) => {
        release = r;
      });
    f.advance(15 * 60000);
    await f.q.tick();
    await until(() => !!release);
    const before = f.q.state().active.tokens;
    f.change();
    await Promise.all([f.q.tick(), f.q.tick()]);
    assert.equal(f.calls(), 1);
    release();
    await f.q.running;
    assert.deepEqual(f.q.state().checkedTokens, before);
    f.agent.whenIdle = async () => {};
    f.advance(15 * 60000);
    await f.run();
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});
test('failed execution preserves the range and reusable Session; pause creates no further calls', async () => {
  const f = await setup();
  try {
    f.fail(true);
    f.advance(15 * 60000);
    await f.run();
    assert.equal(f.q.state().checkedThrough, undefined);
    const pending = f.q.state().pending;
    assert.match(f.q.state().lastError, /network/);
    f.change();
    f.fail(false);
    f.advance(15 * 60000);
    await f.run();
    assert.equal(f.q.state().checkedThrough, pending.to);
    assert.equal(f.q.state().workerSession, 'worker');
    await f.q.control({ action: 'pause' });
    f.advance(120 * 60000);
    await f.run();
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});
test('a wake ending in an interaction pause completes cleanly instead of scheduling an unreachable retry', async () => {
  for (const shape of [
    { agent: { status: 'waiting_for_user' } },
    { agent: { status: 'blocked' }, pendingInteractions: 1 },
  ]) {
    const f = await setup();
    try {
      // The hidden worker answers its wake by asking the user a question and stays
      // there: nobody can ever answer a background session, so a retry cannot succeed.
      f.agent.snapshot = async () => (f.calls() > 0 ? shape : { agent: { status: 'idle' } });
      f.advance(15 * 60000);
      await f.run();
      assert.equal(f.calls(), 1);
      const s = f.q.state();
      assert.equal(s.pending, null, 'an interaction pause is not a retryable failure');
      assert.equal(s.retryAt, null, 'an interaction pause arms no retry deadline');
      assert.equal(s.lastError, null, 'an interaction pause is not an error');
      assert.equal(s.checkedThrough, s.observation.at, 'the pause consumes the wake bounds');
      assert.deepEqual(s.checkedTokens, s.observation.tokens, 'the pause consumes the wake tokens');
      assert.ok(s.pausedAt, 'the pause is surfaced');
    } finally {
      await f.close();
    }
  }
});
test('after an interaction pause the tick loop idles on the normal cadence', async () => {
  const f = await setup();
  try {
    f.agent.snapshot = async () =>
      f.calls() > 0 ? { agent: { status: 'waiting_for_user' } } : { agent: { status: 'idle' } };
    f.advance(15 * 60000);
    await f.run();
    assert.equal(f.calls(), 1);
    const scans = f.scans(),
      resumes = f.resumes();
    for (const step of [15 * 60000, 5000, 5000]) {
      f.advance(step);
      await f.run();
    }
    assert.equal(f.calls(), 1, 'no wake is admitted while the worker session is paused');
    assert.equal(f.resumes(), resumes, 'the paused worker is not re-admitted on cadence ticks');
    assert.equal(f.scans(), scans + 1, 'idle cadence keeps one observation per window');
  } finally {
    await f.close();
  }
});
test('failed and interaction-free blocked terminals keep the pending retry', async () => {
  for (const shape of [
    { shape: { agent: { status: 'failed' } }, label: 'failed' },
    { shape: { agent: { status: 'aborted' } }, label: 'aborted' },
    { shape: { agent: { status: 'blocked' }, pendingInteractions: 0 }, label: 'blocked' },
  ]) {
    const f = await setup();
    try {
      f.agent.snapshot = async () => (f.calls() > 0 ? shape.shape : { agent: { status: 'idle' } });
      f.advance(15 * 60000);
      await f.run();
      const pending = f.q.state().pending;
      assert.ok(pending, `${shape.label}: a failed wake stays retryable`);
      assert.match(f.q.state().lastError, /Quick discovery ended with/);
      assert.equal(f.q.state().checkedThrough, undefined);
      f.agent.snapshot = async () => ({ agent: { status: 'idle' } });
      f.advance(15 * 60000);
      await f.run();
      assert.equal(f.q.state().checkedThrough, pending.to, 'the retry consumes its captured range');
      assert.equal(f.q.state().pending, null);
    } finally {
      await f.close();
    }
  }
});
test('reports are idempotent Bot handoffs, not notebook edits or delegated tasks', async () => {
  const f = await setup();
  try {
    let release!: () => void;
    f.agent.whenIdle = () =>
      new Promise<void>((r) => {
        release = r;
      });
    await f.q.control({ action: 'check' });
    await f.q.tick();
    await until(() => !!release);
    const report = { key: 'expense', messages: ['这笔材料已经交了，要不要我帮你盯回复？'] };
    f.q.report(report, 'worker');
    f.q.report(report, 'worker');
    assert.equal(f.delivered.size, 1);
    assert.throws(() => f.q.report({ ...report, messages: ['different'] }, 'worker'), /different/);
    assert.throws(() => f.q.report(report, 'owner'), /active/);
    release();
    await f.q.running;
  } finally {
    await f.close();
  }
});
test('unknown or failed source observation is explicit; it does not enumerate or read sources', async () => {
  const f = await setup();
  try {
    f.ctx.sources.activityToken = async () => {
      throw Error('permission denied');
    };
    f.advance(15 * 60000);
    await f.run();
    assert.match(f.q.state().observation.unavailable.mail, /permission denied/);
  } finally {
    await f.close();
  }
});
test('native quick worker can read context and report offers, without starting the two-stage flow', async () => {
  const f = await fixture();
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    const workers: string[] = [];
    f.setRunner(async ({ id, prompt, invoke }: any) => {
      if (prompt.startsWith('Inbox 有新消息')) {
        await invoke('InboxCheck', {});
        await invoke('Sleep', {});
        return;
      }
      workers.push(id);
      await invoke('DiscoveryContext', {});
      await invoke('QuickDiscoveryNotebook', {});
      await invoke('QuickDiscoveryReport', {
        key: 'help',
        messages: ['你在整理候选方案，我可以帮你对比这两项。'],
      });
    });
    for (let i = 0; i < 2; i++) {
      await f.remote('assistant.quick-discovery', { action: 'check' });
      await until(
        async () =>
          workers.length === i + 1 &&
          !(await f.remote('assistant.quick-discovery-status', {})).active,
      );
    }
    assert.equal(new Set(workers).size, 1);
    const state = (await f.remote('assistant.binding', {})).state;
    assert.equal(state.discoverySession, undefined);
    assert.equal(state.judgementSession, undefined);
  } finally {
    await f.close();
  }
});

test('native API admits quick controls and status', async () => {
  const { PERSONAL_ASSISTANT_OPERATION_SPECS } = await import(
    '../../../../src/protocol/personal-assistant.js'
  );
  for (const method of ['assistant.quick-discovery', 'assistant.quick-discovery-status']) {
    const value = PERSONAL_ASSISTANT_OPERATION_SPECS['personal-assistant.call'].decodeInput({
      method,
      input: {},
    });
    assert.equal(value.method, method);
  }
});

test('restart retains the worker, watermark and cadence without another initial prompt', async () => {
  const f = await setup();
  let recovered: QuickDiscoveryController | undefined;
  try {
    await f.q.control({
      action: 'configure',
      quietHours: { start: '01:00', end: '08:30', timeZone: 'Asia/Shanghai' },
    });
    f.advance(15 * 60000);
    await f.run();
    const before = f.q.state();
    await f.q.close();
    recovered = new QuickDiscoveryController(f.ctx, f.q.parent, f.q.directory, f.q.now);
    recovered.start(60000);
    assert.equal(recovered.state().workerSession, before.workerSession);
    assert.equal(recovered.state().checkedThrough, before.checkedThrough);
    assert.deepEqual(recovered.state().quietHours, before.quietHours);
    f.change();
    f.advance(15 * 60000);
    await recovered.tick();
    await recovered.running;
    assert.equal(f.calls(), 2);
    assert.doesNotMatch(f.prompts[1], /不必等用户明确求助/);
  } finally {
    if (recovered) {
      await recovered.close();
      recovered.store.close();
    }
    await f.close();
  }
});

test('idle quiet hours use the configured timezone, preserve progress and resume at the end', async () => {
  const f = await setup();
  try {
    await f.q.control({
      action: 'configure',
      quietHours: { start: '01:00', end: '08:30', timeZone: 'Asia/Shanghai' },
    });
    f.setTime('2026-11-01T00:00:00+08:00');
    await f.q.control({ action: 'check' });
    await f.run();
    const through = f.q.state().checkedThrough;
    f.setTime('2026-11-01T01:00:00+08:00');
    await f.run();
    assert.equal(f.calls(), 1);
    const scans = f.scans();
    f.advance(1000);
    await f.run();
    assert.equal(f.scans(), scans, 'idle deadline must not cause a scan on every timer tick');
    f.setTime('2026-11-01T08:15:00+08:00');
    await f.run();
    assert.equal(f.calls(), 1);
    assert.equal(f.q.state().checkedThrough, through);
    f.setTime('2026-11-01T08:30:00+08:00');
    await f.run();
    assert.equal(f.calls(), 2);
    assert.notEqual(f.q.state().checkedThrough, through);
  } finally {
    await f.close();
  }
});

for (const freshObservation of [false, true]) {
  test(`failed work retries during quiet hours with a ${freshObservation ? 'fresh' : 'stale'} observation, without bypassing admission guards`, async () => {
    const f = await setup();
    try {
      await f.q.control({
        action: 'configure',
        quietHours: { start: '01:00', end: '08:30', timeZone: 'Asia/Shanghai' },
      });
      f.setTime('2026-11-01T00:00:00+08:00');
      await f.q.control({ action: 'check' });
      await f.run();
      const through = f.q.state().checkedThrough;
      f.setTime('2026-11-01T00:50:00+08:00');
      f.fail(true);
      await f.q.control({ action: 'check' });
      await f.run();
      const pending = f.q.state().pending;
      assert.ok(pending);
      const retryAt = Date.parse('2026-11-01T01:05:00+08:00');
      assert.equal(f.q.state().retryAt, retryAt);
      assert.equal(f.q.state().checkedThrough, through);
      // A cadence change can leave the failed run's observation fresh at its original deadline.
      if (freshObservation) await f.q.control({ action: 'configure', intervalMinutes: 30 });
      f.fail(false);
      f.setTime('2026-11-01T01:04:59+08:00');
      await f.run();
      assert.equal(f.calls(), 2, 'quiet-hours bypass must not run before retryAt');
      f.setTime('2026-11-01T01:05:00+08:00');
      await f.q.control({ action: 'pause' });
      await f.run();
      assert.equal(f.calls(), 2, 'pending work must respect pause');
      await f.q.control({ action: 'enable' });
      for (const status of ['running', 'waiting_for_user']) {
        f.agent.snapshot = async () => ({ agent: { status } });
        await f.run();
        assert.equal(f.calls(), 2, `pending work must respect ${status}`);
        assert.equal(f.q.state().pending.id, pending.id);
      }
      f.agent.snapshot = async () => ({ agent: { status: 'idle' } });
      await f.run();
      assert.equal(f.calls(), 3, 'due retry must not wait until quiet hours end');
      assert.equal(f.q.state().checkedThrough, pending.to, 'retry preserves its captured range');
      assert.deepEqual(f.q.state().checkedTokens, pending.tokens);
      assert.equal(f.q.state().pending, null);
      assert.equal(f.q.state().retryAt, null);
      assert.equal(f.q.state().workerSession, 'worker');
      f.setTime('2026-11-01T02:05:00+08:00');
      await f.run();
      assert.equal(f.calls(), 3, 'ordinary idle fallback must still respect quiet hours');
      assert.equal(f.q.state().checkedThrough, pending.to);
      f.setTime('2026-11-01T08:30:00+08:00');
      await f.run();
      assert.equal(f.calls(), 4, 'idle fallback resumes at the exclusive quiet-hours end');
    } finally {
      await f.close();
    }
  });
}

test('new activity and explicit checks bypass quiet hours; changing cadence preserves the window', async () => {
  const f = await setup();
  try {
    const hours = { start: '01:00', end: '08:30', timeZone: 'Asia/Shanghai' };
    await f.q.control({ action: 'configure', quietHours: hours });
    f.setTime('2026-11-01T02:00:00+08:00');
    await f.q.control({ action: 'check' });
    await f.run();
    f.change();
    f.advance(15 * 60000);
    await f.run();
    assert.equal(f.calls(), 2);
    await f.q.control({ action: 'check' });
    await f.run();
    assert.equal(f.calls(), 3);
    await f.q.control({ action: 'configure', intervalMinutes: 20, idleMinutes: 90 });
    assert.deepEqual(f.q.state().quietHours, hours);
    f.advance(90 * 60000);
    await f.run();
    assert.equal(f.calls(), 3);
    await f.q.control({ action: 'configure', quietHours: null });
    f.advance(20 * 60000);
    await f.run();
    assert.equal(f.calls(), 4);
  } finally {
    await f.close();
  }
});

test('cross-midnight windows suppress idle fallback for unobservable sources too', async () => {
  const f = await setup();
  try {
    await f.q.control({
      action: 'configure',
      quietHours: { start: '23:00', end: '08:30', timeZone: 'Asia/Shanghai' },
    });
    f.ctx.sources.activityToken = async () => null as any;
    f.setTime('2026-11-01T22:00:00+08:00');
    await f.q.control({ action: 'check' });
    await f.run();
    for (const time of ['2026-11-01T23:00:00+08:00', '2026-11-02T02:00:00+08:00']) {
      f.setTime(time);
      await f.run();
      assert.equal(f.calls(), 1);
    }
    assert.match(f.q.state().observation.unavailable.mail, /quiet hours/);
    f.setTime('2026-11-02T08:30:00+08:00');
    await f.run();
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});

test('quiet window validation rejects ambiguous times and invalid zones without changing settings', async () => {
  const f = await fixture();
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    const quietHours = { start: '01:00', end: '08:30', timeZone: 'Asia/Shanghai' };
    await f.remote('assistant.quick-discovery', { action: 'configure', quietHours });
    for (const invalid of [
      { ...quietHours, start: '25:00' },
      { ...quietHours, start: '1:00' },
      { ...quietHours, end: '01:00' },
      { ...quietHours, timeZone: 'Invalid/Zone' },
    ]) {
      await assert.rejects(
        f.remote('assistant.quick-discovery', { action: 'configure', quietHours: invalid }),
      );
    }
    assert.deepEqual(
      (await f.remote('assistant.quick-discovery-status', {})).quietHours,
      quietHours,
    );
  } finally {
    await f.close();
  }
});

test('a failed source observation preserves the last token, rather than inventing a change', async () => {
  const f = await setup();
  try {
    f.advance(15 * 60000);
    await f.run();
    const before = f.q.state().checkedTokens.mail;
    f.ctx.sources.activityToken = async () => {
      throw Error('temporarily unavailable');
    };
    f.advance(15 * 60000);
    await f.run();
    assert.equal(f.calls(), 1);
    assert.equal(f.q.state().observation.tokens.mail, before);
    assert.match(f.q.state().observation.unavailable.mail, /temporarily unavailable/);
    f.advance(45 * 60000);
    await f.run();
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});

test('parallel source completion order is not an activity change', async () => {
  const f = await setup();
  try {
    f.advance(15 * 60000);
    await f.run();
    f.q.store.update((s) => {
      s.checkedTokens = Object.fromEntries(Object.entries(s.checkedTokens).reverse());
    });
    f.advance(15 * 60000);
    await f.run();
    assert.equal(f.calls(), 1);
  } finally {
    await f.close();
  }
});

test('disabling the native assistant cancels concurrent pending quick activity probes', async () => {
  const f = await fixture();
  const signals: AbortSignal[] = [];
  const releases: (() => void)[] = [];
  let disable: Promise<any> | undefined;
  const source = f.ctx.extend({
    maka: {
      rootId: 'profile',
      packageId: 'cancel-probes',
      entryId: 'cancel-probes',
      generation: 1,
    },
  }).sources;
  for (const id of ['cancel.one', 'cancel.two'])
    source.register({
      id,
      description: 'cancellable probe',
      queryHelp: '',
      scope: {},
      enumerate: async () => ({ items: [] }),
      query: async () => ({ items: [] }),
      authorize: async () => [],
      read: async () => {
        throw Error('no body reads');
      },
      activityToken: async (caller: any) => {
        const signal = caller.invocation.abortSignal;
        signals.push(signal);
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          releases.push(() => {
            signal.removeEventListener('abort', abort);
            resolve();
          });
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        return 'unchanged';
      },
    });
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    await f.remote('assistant.quick-discovery', { action: 'check' });
    await until(() => signals.length === 2);
    disable = f.remote('assistant.set-enabled', { enabled: false });
    await until(() => signals.every((signal) => signal.aborted), 1000);
    await disable;
    assert.equal(signals.length, 2, 'shutdown must not start another observation');
    assert.ok([...f.workers.values()].every((worker: any) => worker.status !== 'running'));
  } finally {
    for (const release of releases) release();
    await disable;
    await f.close();
  }
});

for (const phase of ['list', 'historyList', 'activityToken']) {
  for (const cancel of ['parent', 'quick']) {
    test(`${cancel} cancellation reaches a pending quick ${phase} without cancelling the other owner`, async () => {
      const f = await setup();
      const parentAbort = new AbortController();
      const parent = f.q.parent as any;
      parent.abort = parentAbort;
      parent.ctx = f.ctx;
      parent.asOwner = InitiativeController.prototype.asOwner;
      let invocation: any;
      (f.ctx.agents as any).withInvocation = (call: any, fn: any) => {
        invocation = call;
        return fn();
      };
      let observed: AbortSignal | undefined;
      let release!: () => void;
      const blocked = async () => {
        observed = invocation.abortSignal;
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(observed!.reason);
          release = () => {
            observed!.removeEventListener('abort', abort);
            resolve();
          };
          observed!.addEventListener('abort', abort, { once: true });
          if (observed!.aborted) abort();
        });
        return phase === 'activityToken' ? 'unchanged' : [];
      };
      if (phase === 'activityToken') f.ctx.sources.activityToken = blocked as any;
      else (f.ctx.sessionQuery as any)[phase] = blocked;
      let closing: Promise<void> | undefined;
      try {
        f.advance(15 * 60000);
        const tick = f.q.tick();
        await until(() => !!observed);
        const reason = Error(`${cancel} stopped`);
        if (cancel === 'quick') closing = f.q.close();
        else parentAbort.abort(reason);
        assert.equal(observed!.aborted, true);
        if (cancel === 'parent') {
          assert.equal(observed!.reason, reason);
          assert.equal(f.q.abort.signal.aborted, false);
        } else assert.equal(parentAbort.signal.aborted, false);
        await tick;
        await closing;
        assert.equal(f.calls(), 0, 'cancelled observation cannot admit a worker');
      } finally {
        release?.();
        await closing;
        await f.close();
      }
    });
  }
}
