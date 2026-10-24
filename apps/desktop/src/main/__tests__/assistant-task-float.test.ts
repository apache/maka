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
import { visibleFloatTasks, projectTasks, readFloatTasks, watchFloatTasks } from '../../renderer/features/personal-assistant/testing.js';

test('task list distinguishes execution, business waiting, queued and user input', () => {
  const items = [
    { id: 'running', status: 'active', runtimeStatus: 'running' },
    { id: 'waiting', status: 'waiting', runtimeStatus: 'idle', summary: '等待回复', waitingFor: '不应显示的等待条件', state: '不应显示的长报告' },
    { id: 'queued', status: 'active', runtimeStatus: 'idle' },
    { id: 'attention', status: 'active', runtimeStatus: 'waiting_for_user' },
    { id: 'completed', status: 'completed', runtimeStatus: 'running' },
    { id: 'retry', status: 'active', runtimeStatus: 'running', retryAt: 200 },
    { id: 'unavailable', status: 'active', runtimeError: 'offline' },
  ];
  const result = projectTasks({ items }, 100);
  const phase = (id: string) => result.find(x => x.id === id)?.phase;
  for (const id of ['running', 'waiting', 'queued', 'attention', 'completed']) assert.equal(phase(id), id);
  assert.equal(phase('retry'), 'queued');
  assert.equal(phase('unavailable'), 'attention');
  assert.equal(result.find(x => x.id === 'waiting')?.progress, '等待回复');
});

test('orders by durable update time and pending creation without reading report history', () => {
  const input = { items: [{ id: 'old', updatedAt: 100 }, { id: 'new', updatedAt: 300 }, { id: 'fallback', updatedAt: 200, summary: '最新结果', updates: [{ createdAt: 400, text: '不应显示' }] }], pending: [{ taskKey: 'pending', title: '创建中', status: 'creating' }] };
  const result = projectTasks(input);
  assert.deepEqual(result.map(x => x.id), ['new', 'fallback', 'old', 'pending:pending']);
  assert.deepEqual(projectTasks(input, Date.now() + 10000), result);
  assert.equal(result[1]?.progress, '最新结果');
});

test('reads only the displayed assistant host and rejects changed binding or failed task overview', async () => {
  let result: any = { state: { sessionId: 'assistant' }, tasks: { installed: true, items: [] } };
  const services = {
    hostSnapshot: async () => ({ entries: [{ hostId: 'owner', enabled: true, profile: { id: 'profile' } }] }),
    call: async (method: string, input: unknown, host: unknown) => {
      assert.equal(method, 'assistant.status');
      assert.deepEqual(input, { includeMemory: false });
      assert.deepEqual(host, { hostId: 'owner', profileId: 'profile' });
      return result;
    },
  };
  assert.deepEqual(await readFloatTasks(services, '["owner","assistant"]'), []);
  result = { ...result, state: { sessionId: 'another' } };
  await assert.rejects(readFloatTasks(services, '["owner","assistant"]'), /binding/);
  result = { state: { sessionId: 'assistant' }, tasks: { installed: true, error: 'unavailable' } };
  await assert.rejects(readFloatTasks(services, '["owner","assistant"]'), /unavailable/);
  await assert.rejects(readFloatTasks(services, '["missing","assistant"]'));
});

test('polling never delivers in-flight results after disposal', async () => {
  let finish!: (value: []) => void;
  let reads = 0;
  const received: unknown[] = [];
  const stop = watchFloatTasks(() => { reads++; return new Promise<[]>((resolve) => { finish = resolve; }); }, value => received.push(value), 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(reads, 1);
  stop();
  finish([]);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(received, []);
  assert.equal(reads, 1);
});


test('default list excludes archived tasks, including paused tasks with stale runtime errors', () => {
  const tasks = projectTasks({ items: [
    { id: 'running', status: 'active', runtimeStatus: 'running' },
    { id: 'waiting', status: 'waiting' },
    { id: 'queued', status: 'active' },
    { id: 'attention', status: 'active', runtimeStatus: 'waiting_for_user' },
    { id: 'paused', status: 'paused', lastError: 'failed', runtimeError: 'offline', runtimeStatus: 'running' },
    { id: 'completed', status: 'completed' },
    { id: 'cancelled', status: 'cancelled' },
  ] });
  assert.equal(tasks.find(task => task.id === 'paused')?.phase, 'paused');
  assert.deepEqual(visibleFloatTasks(tasks, false).map(task => task.id), ['attention', 'queued', 'running', 'waiting']);
  assert.deepEqual(visibleFloatTasks(tasks, true), tasks);
});

 test('legacy tasks without AI previews do not expose or truncate detailed content', () => {
  const [task] = projectTasks({ items: [{ id: 'old', status: 'completed', state: '完整报告', waitingFor: '完整条件', updates: [{ text: '完整进展' }] }] });
  assert.equal(task.progress, '');
});
