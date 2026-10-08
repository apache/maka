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

test('heartbeat uses the human Session and exits normally without checkpoint or notebook', async () => {
  const f = await fixture(); let checks = 0;
  try {
    f.setRunner(async ({ id, prompt, finish }: any) => {
      assert.equal(id, 'owner'); assert.match(prompt, /Runtime heartbeat/);
      assert.equal((await finish()).allow, true); checks++;
    });
    await f.invoke('InitiativeEnable', { intervalMinutes: 1 });
    assert.equal(checks, 0); // enabling is not another unsolicited turn
    const names = f.tools.resolve('owner', []).tools.map((t: any) => t.name);
    assert.ok(!names.includes('InitiativeCheckpoint')); assert.ok(!names.includes('InitiativeRead'));
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => checks === 1 && !(await f.invoke('InitiativeStatus')).active);
    assert.equal(f.workers.size, 1); assert.equal((await f.invoke('InitiativeStatus')).lastError, null);
    assert.ok((await f.invoke('InitiativeStatus')).nextAt > Date.now());
    await assert.rejects(f.invokeAs('other', 'InitiativeControl', { action: 'check' }), /conversation/);
  } finally { await f.close(); }
});
test('busy conversation defers heartbeat; pause never cancels the user turn', async () => {
  const f = await fixture(); let checks = 0;
  try {
    f.setRunner(async () => { checks++; });
    await f.invoke('InitiativeEnable', {}); f.workers.get('owner').status = 'running';
    await f.invoke('InitiativeControl', { action: 'check' });
    await new Promise(r => setTimeout(r, 50)); assert.equal(checks, 0);
    await f.invoke('InitiativeControl', { action: 'pause' });
    assert.equal(f.cancels(), 0); f.workers.get('owner').status = 'idle';
    await new Promise(r => setTimeout(r, 30)); assert.equal(checks, 0);
  } finally { await f.close(); }
});
test('queued wake cannot finish before it actually appears in Session history', async () => {
  const f = await fixture(); let release!: () => void; const gate = new Promise<void>(r => release = r); let checks = 0;
  try {
    f.setGate(() => gate, true); f.setRunner(async () => { checks++; });
    await f.invoke('InitiativeEnable', {}); await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).active);
    await new Promise(r => setTimeout(r, 40)); assert.equal(checks, 0);
    assert.equal((await f.invoke('InitiativeStatus')).lastCheckedAt, null);
    release(); await until(async () => checks === 1 && !(await f.invoke('InitiativeStatus')).active);
  } finally { release(); await f.close(); }
});
test('packaged extension uses ordinary finish; failures stop heartbeats without cancelling chat', async () => {
  const f = await fixture({ bundle: new URL('../release/index-initiative.maka-extension', import.meta.url).pathname });
  try {
    f.setRunner(async () => { throw Error('provider unavailable'); });
    await f.invoke('InitiativeEnable', {}); await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).lastError);
    assert.equal((await f.invoke('InitiativeStatus')).enabled, false); assert.equal(f.cancels(), 0);
  } finally { await f.close(); }
});


test('aborted runtime completion stops future heartbeats without a model checkpoint', async () => {
  const f = await fixture();
  try {
    f.workers.get('owner').endStatus = 'aborted'; f.setRunner(async () => {});
    await f.invoke('InitiativeEnable', {}); await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).lastError);
    assert.equal((await f.invoke('InitiativeStatus')).enabled, false);
    assert.match((await f.invoke('InitiativeStatus')).lastError, /aborted/);
    assert.equal(f.cancels(), 0);
  } finally { await f.close(); }
});
