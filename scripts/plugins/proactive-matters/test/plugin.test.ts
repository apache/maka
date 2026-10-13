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
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, until, sleep, AgentDriver } from './platform-helper.js';
async function settle(f: any, view: any, turn = 'turn-initial', complete = false) {
  await f.invoke(
    'MatterWriteFile',
    {
      path: view.files.draft,
      content: '当前事实：已检查。\n计划：根据新情况复查。\n退出：等待变化。',
    },
    turn,
  );
  return f.invoke(
    'MatterSettle',
    {
      expectedRevision: view.revision,
      stateFile: view.files.draft,
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
test('latest main installs the real bundle; same session wakes, refreshes files, completes and stops', async (t) => {
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
  const finishContext = { sessionId: 'session-1', turnId: 'turn-initial', signal: new AbortController().signal };
  assert.equal((await f.turns.evaluate(finishContext)).allow, false);
  assert.deepEqual(await f.turns.evaluate({ ...finishContext, sessionId: 'ordinary-session' }), { allow: true });
  assert.equal((await f.platform.clientSnapshot()).entries.length, 1);
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
  await f.platform.apply({
    operations: [
      {
        type: 'update',
        entryId: 'proactive-matters-host',
        patch: { disabled: true },
      },
    ],
  });
  assert.equal(f.tools.resolve('session-1', []).tools.length, 0);
});
test('waiting state and authorized session binding recover through real platform restart', async (t) => {
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
  const tools = f.tools.resolve('session-1', []).tools;
  const writes = [
    'MatterStart',
    'MatterMessage',
    'MatterControl',
    'MatterRead',
    'MatterCheckpoint',
    'MatterSettle',
    'MatterWriteFile',
  ];
  assert.deepEqual(
    tools
      .filter((tool) => tool.categoryHint === 'file_write')
      .map((tool) => tool.name)
      .sort(),
    writes.sort(),
  );
  const selected = selectCollaborationTools({ mode: 'plan', tools, hasActiveExecution: false });
  assert.deepEqual(
    selected.map((tool) => tool.name),
    ['MatterReadFile'],
  );
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
  const snapshot = await f.platform.clientSnapshot();
  for (const [method, input] of [
    ['matters.control', { id: matter.id, action: 'cancel' }],
    ['matters.message', { id: matter.id, text: 'change the objective' }],
    ['matters.edit', { id: matter.id, revision: matter.revision, text: 'replace state' }],
  ]) {
    await assert.rejects(
      () =>
        f.platform.invokeClientRemote({
          ...snapshot.entries[0],
          authorityEpoch: snapshot.authorityEpoch,
          revision: snapshot.revision,
          method,
          input,
        }),
      (error: any) => error.code === 'not_found',
    );
  }
  assert.deepEqual(await f.remote('matters.list'), before);
  // The session's authorized agent tools remain the only interactive write surface.
  await f.invoke('MatterControl', { action: 'cancel' });
});
