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
import { fixture, until } from './fixture.js';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'quick-discovery-'));
  let now = Date.now(),
    revision = '1',
    calls = 0,
    scans = 0,
    fail = false;
  const delivered = new Map<string, any>(),
    prompts: string[] = [];
  const sessions: any[] = [];
  const agent = {
    sessionId: 'worker',
    snapshot: async () => ({ agent: { status: 'idle' } }),
    followup: async (text: string) => {
      calls++;
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
    bindingReady: Promise.resolve(),
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
      resume: async () => agent,
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
    advance: (ms: number) => {
      now += ms;
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
    f.advance(15 * 60000);
    await f.run();
    const before = f.q.state();
    await f.q.close();
    recovered = new QuickDiscoveryController(f.ctx, f.q.parent, f.q.directory, f.q.now);
    recovered.start(60000);
    assert.equal(recovered.state().workerSession, before.workerSession);
    assert.equal(recovered.state().checkedThrough, before.checkedThrough);
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
