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
import { fixture, until } from './fixture.js';

test('first open binds one ordinary chat without import, indexing, model calls or heartbeat', async () => {
  const f = await fixture();
  let calls = 0;
  f.setRunner(async () => {
    calls++;
  });
  try {
    await assert.rejects(f.remote('assistant.bind', { sessionId: 'missing' }), /Host/);
    const results = await Promise.all([
      f.remote('assistant.bind', { sessionId: 'owner' }),
      f.remote('assistant.bind', { sessionId: 'owner' }),
    ]);
    assert.ok(results.every((s) => s.sessionId === 'owner' && !s.enabled));
    const s = await f.remote('assistant.status');
    assert.equal(s.state.lastCheckedAt, null);
    assert.equal(s.memory.installed, true);
    assert.ok(s.memory.sources.some((source: any) => source.id === "maka"));
    assert.equal(s.memory.indexes.length, 0);
    assert.equal(s.tasks.installed, false);
    assert.equal(f.workers.size, 1);
    assert.equal(calls, 0);
    f.workers.set('other', { status: 'idle' });
    assert.equal((await f.remote('assistant.bind', { sessionId: 'other' })).sessionId, 'owner');
    assert.equal((await f.remote('assistant.binding')).state.sessionId, 'owner');
    const prompt = await f.prompts.assemble({ sessionId: 'owner', turnId: 'first-chat', cwd: f.root }, undefined);
    assert.match(prompt.text, /正常回应用户/);
    assert.match(prompt.text, /没有索引也正常交流/);
  } finally {
    await f.close();
  }
});

test('UI enable checks immediately, status exposes failure, recovery requires explicit action', async () => {
  const f = await fixture();
  let checks = 0;
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async () => {
      checks++;
      throw Error('test provider unavailable');
    });
    await f.remote('assistant.control', { action: 'enable', intervalMinutes: 60 });
    await until(async () => (await f.remote('assistant.status')).state.lastError);
    let s = (await f.remote('assistant.status')).state;
    assert.equal(checks, 1);
    assert.equal(s.enabled, false);
    assert.equal(s.intervalMs, 3600000);
    assert.match(s.lastError, /provider unavailable/);
    f.setRunner(async () => {
      checks++;
    });
    await f.remote('assistant.control', { action: 'enable', intervalMinutes: 30 });
    await until(async () => (await f.remote('assistant.status')).state.lastCheckedAt);
    s = (await f.remote('assistant.status')).state;
    assert.equal(checks, 2);
    assert.equal(s.lastError, null);
    await f.remote('assistant.control', { action: 'pause' });
    assert.equal((await f.remote('assistant.status')).state.enabled, false);
    assert.equal(f.cancels(), 0);
  } finally {
    await f.close();
  }
});
