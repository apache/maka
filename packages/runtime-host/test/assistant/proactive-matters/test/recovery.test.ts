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
import { rm } from 'node:fs/promises';
import { fixture, until, sleep, AgentDriver } from './platform-helper.js';
test('finished model failure with zero pending interactions releases activation and can resume same Session', async (t) => {
  const driver = new AgentDriver();
  driver.add();
  driver.runtime.snapshot = async (id: string) => ({
    agent: { status: driver.sessions.get(id).running ? 'running' : 'blocked' },
    pendingInteractions: 0,
  });
  const f = await fixture({ driver });
  t.after(async () => {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });
  await f.invoke('MatterStart', { title: '故障恢复', request: '读取证据后完成' });
  driver.end();
  await until(async () => {
    const m = (await f.remote('matters.list')).matters[0];
    return m.status === 'paused' && !m.activation;
  }, 1200);
  let failure: any;
  driver.onFollowup = async (id: string, _p: string, turn: string) => {
    try {
      const v = await f.invoke('MatterRead', {}, turn);
      await f.invoke(
        'MatterWriteFile',
        { path: v.files.draft, content: '已重新核验原文，任务完成。' },
        turn,
      );
      await f.invoke(
        'MatterSettle',
        {
          expectedRevision: v.revision,
          stateFile: v.files.draft,
          disposition: 'complete',
          summary: '重新核验完成',
          reason: '证据满足目标',
        },
        turn,
      );
    } catch (e) {
      failure = e;
    } finally {
      driver.end(id);
    }
  };
  await f.invoke('MatterControl', { action: 'resume' });
  await until(async () => (await f.remote('matters.list')).matters[0].status === 'completed', 1800);
  if (failure) throw failure;
  assert.equal(driver.sessions.size, 1);
});
test('actual pending interaction continues waiting and cancellation releases the running controller', async (t) => {
  const driver = new AgentDriver();
  driver.add();
  driver.runtime.snapshot = async (id: string) => ({
    agent: { status: driver.sessions.get(id).running ? 'running' : 'blocked' },
    pendingInteractions: 1,
  });
  const f = await fixture({ driver });
  t.after(async () => {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });
  await f.invoke('MatterStart', { title: '真实问题等待', request: '等待用户授权后工作' });
  driver.end();
  await sleep(200);
  const m = (await f.remote('matters.list')).matters[0];
  assert.equal(m.status, 'active');
  assert.ok(m.activation);
  await Promise.race([
    f.invoke('MatterControl', { action: 'cancel' }, 'other-user-turn'),
    sleep(1200).then(() => {
      throw Error('cancel hung behind obsolete blocked status');
    }),
  ]);
  assert.equal((await f.remote('matters.list')).matters[0].status, 'cancelled');
});

import { executionFailure } from '../../../../src/assistant/execution-outcome.js';
test('failure recovery uses the exact terminal turn and respects unsafe replay decisions', async () => {
  const rows: any[] = [
    { type: 'turn_state', turnId: 'old', errorClass: 'network', failureMessage: 'old reset' },
  ];
  const agent = { transcript: async () => rows };
  assert.equal(await executionFailure(agent, 'current'), undefined);
  rows.push({
    type: 'turn_state',
    turnId: 'current',
    errorClass: 'network',
    failureMessage: 'new reset',
  });
  assert.equal((await executionFailure(agent, 'current'))?.retryable, true);
  rows.push({
    type: 'turn_state',
    turnId: 'current',
    errorClass: 'network',
    retry: { because: 'side_effects' },
  });
  assert.equal((await executionFailure(agent, 'current'))?.retryable, false);
  rows.push({ type: 'turn_state', turnId: 'current', errorClass: 'unknown' });
  assert.equal((await executionFailure(agent, 'current'))?.retryable, false);
  rows.push({ type: 'turn_state', turnId: 'current', status: 'completed' });
  assert.equal(await executionFailure(agent, 'current'), undefined);
});

test('known transient terminal failure releases the task into durable backoff in the same Session', async (t) => {
  const driver = new AgentDriver();
  driver.add();
  driver.runtime.snapshot = async (id: string) => ({
    agent: { status: driver.sessions.get(id).running ? 'running' : 'blocked' },
    pendingInteractions: 0,
  });
  driver.runtime.transcript = async () => [
    {
      type: 'turn_state',
      turnId: 'turn-initial',
      errorClass: 'network',
      failureMessage: 'connection reset',
    },
  ];
  const f = await fixture({ driver });
  t.after(async () => {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });
  await f.invoke('MatterStart', { title: '网络恢复', request: '保留已执行记录继续' });
  driver.end();
  await until(async () => {
    const m = (await f.remote('matters.list')).matters[0];
    return !m.activation && m.retryAt;
  });
  const m = (await f.remote('matters.list')).matters[0];
  assert.equal(m.status, 'active');
  assert.equal(m.sessionId, 'session-1');
  assert.equal(m.lastFailure.kind, 'network');
  assert.ok(m.retryAt > Date.now());
  await f.invoke('MatterControl', { action: 'cancel' });
  assert.equal((await f.remote('matters.list')).matters[0].retryAt, null);
});

test('after backoff the controller resumes the original task and commits once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const driver = new AgentDriver();
  driver.add();
  let failed = true;
  driver.runtime.snapshot = async (id: string) => ({
    agent: { status: driver.sessions.get(id).running ? 'running' : failed ? 'blocked' : 'idle' },
    pendingInteractions: 0,
  });
  driver.runtime.transcript = async () => [
    {
      type: 'turn_state',
      turnId: 'turn-initial',
      errorClass: 'network',
      failureMessage: 'temporary transport failure',
    },
  ];
  const f = await fixture({ driver });
  t.after(async () => {
    await f.close();
    await rm(f.root, { recursive: true, force: true });
  });
  await f.invoke('MatterStart', { title: '自动续跑', request: '证据齐全后完成' });
  driver.end();
  await until(async () => (await f.remote('matters.list')).matters[0].retryAt);
  const before = (await f.remote('matters.list')).matters[0];
  let callbackError: unknown;
  driver.onFollowup = async (id: string, _prompt: string, turn: string) => {
    try {
      failed = false;
      const view = await f.invoke('MatterRead', {}, turn);
      await f.invoke(
        'MatterWriteFile',
        { path: view.files.draft, content: '已核对已有工具记录，未重复操作，验收完成。' },
        turn,
      );
      await f.invoke(
        'MatterSettle',
        {
          expectedRevision: view.revision,
          stateFile: view.files.draft,
          disposition: 'complete',
          summary: '从已有记录恢复完成',
          reason: '目标已满足',
        },
        turn,
      );
    } catch (e) {
      callbackError = e;
    } finally {
      driver.end(id);
    }
  };
  t.mock.timers.setTime(before.retryAt + 1);
  await until(async () => (await f.remote('matters.list')).matters[0].status === 'completed');
  if (callbackError) throw callbackError;
  const after = (await f.remote('matters.list')).matters[0];
  assert.equal(after.id, before.id);
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.runCount, 2);
  assert.equal(driver.calls.filter((c: any) => c.op === 'followup').length, 1);
  assert.equal(driver.sessions.size, 1);
});
