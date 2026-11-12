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

import { readFileSync } from 'node:fs';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until, sleep, AgentDriver } from './platform-helper.js';
async function settle(f: any, view: any, turn = 'turn-initial', complete = false) {
  return f.invoke(
    'MatterSettle',
    {
      note: '当前事实：已检查。退出：等待变化或完成。',
      disposition: complete ? 'complete' : 'wait',
      waitingFor: complete ? undefined : '等待外部检查结果',
      wakes: complete ? [] : [{ kind: 'at', at: Date.now() + 250 }],
      summary: '检查后保存当前事实',
      reason: complete ? '目标已满足' : '等待下次复查',
      next: complete ? undefined : '重新判断',
      update: complete ? '已完成' : '开始跟进',
    },
    turn,
  );
}
test('native Host starts without plugins; same session wakes, refreshes files, completes and stops', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const first = await f.invoke('MatterStart', {
    title: '跟进交付',
    request: '文件通过检查后完成',
  });
  assert.ok(first.activationId);
  const finishContext = {
    sessionId: 'session-1',
    turnId: 'turn-initial',
    signal: new AbortController().signal,
  };
  assert.equal((await f.turns.evaluate(finishContext)).allow, false);
  assert.deepEqual(await f.turns.evaluate({ ...finishContext, sessionId: 'ordinary-session' }), {
    allow: true,
  });
  assert.equal((await f.platform.clientSnapshot()).entries.length, 0);
  const prompt = await f.systemPrompt.assemble(
    { sessionId: 'session-1', turnId: 'turn-initial', cwd: f.root },
    'base',
  );
  assert.match(prompt.text, /ordinary agent loop/);
  assert.ok(prompt.contexts.some((c: any) => c.text.includes('Runtime clock')));
  const m = await settle(f, first);
  assert.equal(m.status, 'waiting');
  assert.deepEqual(await f.turns.evaluate(finishContext), { allow: true });
  f.driver.end();
  await until(async () => !(await f.remote('matters.list')).matters[0].activation);
  let wakeError: any;
  f.driver.onFollowup = async (id: string, prompt: string, turn: string) => {
    try {
      assert.match(prompt, /woken for a new activation/);
      assert.match(prompt, /scheduled time reached/);
      assert.equal(id, 'session-1');
      const view = await f.invoke('MatterRead', {}, turn);
      for (const path of [view.files.request, view.files.state, view.files.inbox])
        await f.invoke('MatterReadFile', { path }, turn);
      await assert.rejects(
        () =>
          f.invoke(
            'MatterWriteFile',
            { path: first.files.draft, content: 'stale' },
            'turn-initial',
          ),
        /does not own/,
      );
      await settle(f, view, turn, true);
      f.driver.end();
    } catch (e) {
      wakeError = e;
      f.driver.end();
    }
  };
  await until(async () => (await f.remote('matters.list')).matters[0].status === 'completed');
  if (wakeError) throw wakeError;
  await until(async () => !(await f.remote('matters.list')).matters[0].activation);
  const report = await f.remote('matters.list');
  assert.equal(report.matters[0].runs.length, 2);
  assert.equal(report.matters[0].updates.length, 2);
  assert.deepEqual(report.matters[0].wakes, []);
  const count = f.driver.calls.filter((c: any) => c.op === 'followup').length;
  await sleep(320);
  assert.equal(f.driver.calls.filter((c: any) => c.op === 'followup').length, count);
  const tool = f.tools.resolve('session-1', []).tools.find((t: any) => t.name === 'MatterRead');
  await f.close();
  await assert.rejects(() => tool.impl({}, {}), /shutting down/);
});
test('waiting state and authorized session binding recover through native Host restart', async (t) => {
  let f = await fixture();
  const root = f.root;
  t.after(async () => {
    await f.close();
    await rm(root, { recursive: true, force: true });
  });
  const view = await f.invoke('MatterStart', {
    title: '重启恢复',
    request: '下次检查再完成',
  });
  await settle(f, view);
  f.driver.end();
  await until(async () => !(await f.remote('matters.list')).matters[0].activation);
  await f.close();
  await sleep(280);
  const driver = new AgentDriver();
  driver.add('session-1', false);
  f = await fixture({ root, reopen: true, driver });
  await until(() => driver.calls.some((c: any) => c.op === 'followup'));
  assert.ok(driver.calls.every((c: any) => !c.inv || c.inv.sessionId === 'session-1'));
  const active = (await f.remote('matters.list')).matters[0];
  assert.equal(active.sessionId, 'session-1');
  assert.equal(active.runCount, 2);
  const current = await f.invoke('MatterRead', {}, driver.sessions.get('session-1').turnId);
  await settle(f, current, driver.sessions.get('session-1').turnId, true);
  driver.end();
  await until(async () => !(await f.remote('matters.list')).matters[0].activation);
});
test('no settle faults durably; user amendment and pause invalidate stale writers', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const view = await f.invoke('MatterStart', {
    title: '校验',
    request: '保持跟进',
  });
  f.driver.end();
  await until(async () => (await f.remote('matters.list')).matters[0].status === 'paused');
  const m = (await f.remote('matters.list')).matters[0];
  assert.match(m.lastError, /未提交等待或完成/);
  await assert.rejects(() => f.invoke('MatterMessage', { text: '' }));
  // A direct human follow-up adopts the task in the current conversation turn.
  const turn = 'human-amendment';
  f.driver.sessions.get('session-1').running = true;
  f.driver.sessions.get('session-1').turnId = turn;
  const next = await f.invoke('MatterMessage', { text: '只使用最新版' }, turn);
  const request = await f.invoke('MatterReadFile', { path: next.files.request }, turn);
  assert.match(request.content, /只使用最新版/);
  await f.invoke('MatterControl', { action: 'pause' }, turn);
  await assert.rejects(
    () => f.invoke('MatterWriteFile', { path: next.files.draft, content: 'late' }, turn),
    /does not own/,
  );
  assert.equal((await f.remote('matters.list')).matters[0].status, 'paused');
});
test('a queued Host wake waits for its exact activation claim instead of mistaking temporary idle for completion', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const first = await f.invoke('MatterStart', {
    title: '队列竞争',
    request: '复查后完成',
  });
  await settle(f, first);
  f.driver.end();
  await until(async () => !(await f.remote('matters.list')).matters[0].activation);
  let wakeError: any;
  let started = false;
  f.driver.runtime.followup = async (id: string, prompt: string) => {
    const meta = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    setTimeout(async () => {
      try {
        started = true;
        const s = f.driver.sessions.get(id);
        s.running = true;
        s.turnId = 'queued-real-turn';
        const view = await f.invoke('MatterRead', { activationId: meta.activationId }, s.turnId);
        await settle(f, view, s.turnId, true);
        f.driver.end();
      } catch (e) {
        wakeError = e;
        f.driver.end();
      }
    }, 100);
    return { disposition: 'followup' };
  };
  await until(async () => (await f.remote('matters.list')).matters[0].status === 'completed');
  assert.equal(wakeError, undefined);
  assert.equal(started, true);
  await until(async () => !(await f.remote('matters.list')).matters[0].activation);
});

test('ordinary Plan mode excludes every mutating Matter tool, including activation reads', async (t) => {
  const { selectCollaborationTools } = await import('../.artifacts/main-api.mjs');
  const f = await fixture();
  t.after(async () => {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });
  const tools = f.tools
    .resolve('session-1', [])
    .tools.filter((t: any) => t.name.startsWith('Matter'));
  const writes = [
    'MatterStart',
    'MatterMessage',
    'MatterControl',
    'MatterRead',
    'MatterCheckpoint',
    'MatterConditionTest',
    'MatterSettle',
    'MatterWriteFile',
    'MatterDelegate',
    'MatterDelegationRecover',
    'MatterFeedbackRetry',
    'MatterAdopt',
    'MatterAskBot',
    'MatterReply',
    'MatterTaskMessage',
    'MatterTaskControl',
  ];
  assert.deepEqual(
    tools
      .filter((tool) => tool.categoryHint === 'file_write')
      .map((tool) => tool.name)
      .sort(),
    writes.sort(),
  );
  const selected = selectCollaborationTools({ mode: 'plan', tools, hasActiveExecution: false });
  assert.deepEqual(selected.map((tool) => tool.name).sort(), [
    'MatterOverview',
    'MatterReadFile',
    'MatterTasks',
  ]);
  assert.equal(
    selectCollaborationTools({ mode: 'agent', tools, hasActiveExecution: false }).length,
    tools.length,
  );
  assert.deepEqual((await f.remote('matters.list')).matters, []);
});

test('failed enrollment binding rolls back matter, event and history; restart can retry', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  let f = await fixture();
  const root = f.root;
  const db = new DatabaseSync(join(root, 'data', 'matters.sqlite'));
  t.after(async () => {
    db.close();
    await f.close();
    await rm(root, { recursive: true, force: true });
  });
  db.exec(
    "CREATE TRIGGER fail_binding AFTER INSERT ON plugin_bindings BEGIN SELECT RAISE(ABORT, 'injected binding failure'); END",
  );
  await assert.rejects(
    () =>
      f.invoke('MatterStart', { title: 'atomic enrollment', request: 'follow up after restart' }),
    /injected binding failure/,
  );
  for (const table of [
    'matters',
    'plugin_bindings',
    'matter_events',
    'matter_history',
    'matter_revisions',
    'matter_runs',
  ]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(f.driver.calls.length, 0, 'failed registration cannot reach the agent');
  db.exec('DROP TRIGGER fail_binding');
  await f.close();
  f = await fixture({ root, reopen: true });
  const view = await f.invoke('MatterStart', {
    title: 'atomic enrollment',
    request: 'follow up after restart',
  });
  assert.ok(view.activationId);
  assert.equal(
    db.prepare('SELECT cwd FROM plugin_bindings WHERE session_id=?').get('session-1').cwd,
    root,
  );
  assert.equal((await f.remote('matters.list')).matters.length, 1);
  await f.invoke('MatterControl', { action: 'cancel' });
});

test('Client bridge rejects removed mutation RPCs with valid generation and payloads', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });
  await f.invoke('MatterStart', { title: 'read-only bridge', request: 'retain state' });
  const before = await f.remote('matters.list');
  const matter = before.matters[0];

  for (const [method, input] of [
    ['matters.control', { id: matter.id, action: 'cancel' }],
    ['matters.message', { id: matter.id, text: 'change the objective' }],
    ['matters.edit', { id: matter.id, revision: matter.revision, text: 'replace state' }],
  ]) {
    await assert.rejects(
      () => f.remote(method as string, input),
      /Unknown personal assistant operation/,
    );
  }
  assert.deepEqual(await f.remote('matters.list'), before);
  // The session's authorized agent tools remain the only interactive write surface.
  await f.invoke('MatterControl', { action: 'cancel' });
});

test('native condition tools test real source, wait without a model, then resume the same task', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });
  let ready = false,
    reads = 0,
    wakeError: unknown;
  f.ctx
    .extend({
      maka: {
        rootId: 'profile',
        packageId: 'test-shipment',
        entryId: 'test-shipment',
        generation: 1,
      },
    })
    .sources.register({
      id: 'shipment',
      description: 'Test supplier updates',
      queryHelp: 'query returns current shipment metadata',
      scope: { account: 'test' },
      enumerate: async () => ({ items: [] }),
      query: async () => {
        reads++;
        return {
          items: ready
            ? [{ id: 'parcel', revision: 'shipped', kind: 'shipment', locator: { id: 'parcel' } }]
            : [],
        };
      },
      authorize: async (items: any[]) => items.map((x) => x.id),
      read: async (object: any) => ({ status: 'ok', object, content: 'Shipment confirmed' }),
    });
  const first = await f.invoke('MatterStart', {
    title: 'Shipment',
    request: 'Inspect shipment after supplier confirms it',
  });
  const checked = await f.invoke('MatterConditionTest', {
    code: 'const page=await tools.SourceQuery({source:"shipment",query:{}}); return {status:page.items.length ? "triggered":"pending",reason:page.items.length ? "Shipment confirmed":"No confirmation"};',
    input: {},
  });
  assert.equal(checked.result.status, 'pending');
  assert.equal(reads, 1);
  await f.invoke('MatterWriteFile', {
    path: first.files.draft,
    content: 'Supplier has not confirmed shipment yet.',
  });
  await f.invoke('MatterSettle', {
    note: readFileSync(first.files.draft, 'utf8'),
    disposition: 'wait',
    wakes: [{ kind: 'at', at: Date.now() + 60000 }],
    condition: { checkerId: checked.checkerId, intervalMs: 1000 },
    waitingFor: 'Supplier confirms shipment',
    reason: 'Cannot inspect an unavailable shipment',
    summary: 'Queried shipment source',
  });
  f.driver.onFollowup = async (id: string, prompt: string, turn: string) => {
    try {
      assert.equal(id, 'session-1');
      assert.match(prompt, /condition observation/);
      const view = await f.invoke('MatterRead', {}, turn);
      const inbox = await f.invoke('MatterReadFile', { path: view.files.inbox }, turn);
      assert.match(inbox.content, /Shipment confirmed/);
      await settle(f, view, turn, true);
    } catch (error) {
      wakeError = error;
    } finally {
      f.driver.end();
    }
  };
  ready = true;
  f.driver.end();
  await until(
    async () => wakeError || (await f.remote('matters.list')).matters[0].status === 'completed',
    10000,
  );
  if (wakeError) throw wakeError;
  assert.equal(f.driver.calls.filter((x: any) => x.op === 'followup').length, 1);
  assert.equal(
    f.reviewCalls.length,
    2,
    'model called only for wait and complete review, not condition observations',
  );
});

test('checkpoint and settlement require an AI-authored preview of at most 30 characters', async (t) => {
  const f = await fixture();
  t.after(async () => {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });
  for (const name of ['MatterSettle', 'MatterCheckpoint']) {
    const tool = f.tools.resolve('session-1', []).tools.find((tool: any) => tool.name === name);
    const input =
      name === 'MatterSettle'
        ? { disposition: 'complete', summary: 'full handoff' }
        : { expectedRevision: 1, stateFile: '/draft.md' };
    assert.equal(tool.parameters.safeParse(input).success, false);
    assert.equal(
      tool.parameters.safeParse({ ...input, progressSummary: '字'.repeat(31) }).success,
      false,
    );
    assert.equal(
      tool.parameters.safeParse({ ...input, progressSummary: '😀'.repeat(30) }).success,
      true,
    );
  }
});
