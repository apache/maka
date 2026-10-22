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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DISCOVERY_TASK } from '../../../../src/assistant/index-initiative/prompt.js';
import { fixture as unboundFixture, until } from './fixture.js';

// Configuration tools do not choose the conversation anymore. Resolve the
// native assistant explicitly, just as opening the assistant does in the UI.
async function fixture(options: any = {}) {
  const f = await unboundFixture(options);
  await f.remote('assistant.bind', { sessionId: 'owner' });
  const setRunner = f.setRunner;
  f.setRunner = (fn: any) =>
    setRunner(async (call: any) => {
      if (call.prompt.includes('报告文件：')) return; // Controlled judgement elects silence.
      await fn(call);
      await call.invoke('DiscoveryCandidates', { text: 'Controlled discovery evidence' });
    });
  return f;
}

test('heartbeat uses an independent exploration Session and exits normally without checkpoint or notebook', async () => {
  const f = await fixture();
  let checks = 0;
  try {
    f.setRunner(async ({ id, prompt, finish, invoke }: any) => {
      assert.notEqual(id, 'owner');
      assert.match(prompt, /Runtime heartbeat/);
      assert.ok(prompt.includes(DISCOVERY_TASK), 'default instructions reach the actual heartbeat');
      assert.equal((await finish()).allow, false);
      await invoke('DiscoveryCandidates', { text: 'Controlled discovery evidence' });
      assert.equal((await finish()).allow, true);
      checks++;
    });
    await f.invoke('InitiativeConfigure', { intervalMinutes: 1 });
    await f.invoke('InitiativeEnable', {});
    assert.equal(checks, 0); // enabling is not another unsolicited turn
    const names = f.tools.resolve('owner', []).tools.map((t: any) => t.name);
    assert.ok(!names.includes('InitiativeCheckpoint'));
    assert.ok(!names.includes('InitiativeRead'));
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => checks === 1 && !(await f.invoke('InitiativeStatus')).active);
    assert.equal(f.workers.size, 3);
    assert.equal((await f.invoke('InitiativeStatus')).lastError, null);
    assert.ok((await f.invoke('InitiativeStatus')).nextAt > Date.now());
    await assert.rejects(
      f.invokeAs('other', 'InitiativeControl', { action: 'check' }),
      /unavailable in this session/,
    );
  } finally {
    await f.close();
  }
});
test('busy conversation does not block independent exploration; pause never cancels the user turn', async () => {
  const f = await fixture();
  let checks = 0;
  try {
    f.setRunner(async () => {
      checks++;
    });
    await f.invoke('InitiativeEnable', {});
    f.workers.get('owner').status = 'running';
    await f.invoke('InitiativeControl', { action: 'check' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(checks, 1);
    await f.invoke('InitiativeControl', { action: 'pause' });
    assert.equal(f.cancels(), 0);
    f.workers.get('owner').status = 'idle';
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(checks, 1);
  } finally {
    await f.close();
  }
});
test('queued wake cannot finish before it actually appears in Session history', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let checks = 0;
  try {
    f.setGate(() => gate, true);
    f.setRunner(async () => {
      checks++;
    });
    await f.invoke('InitiativeEnable', {});
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).active);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(checks, 0);
    assert.equal((await f.invoke('InitiativeStatus')).lastCheckedAt, null);
    release();
    await until(async () => checks === 1 && !(await f.invoke('InitiativeStatus')).active);
  } finally {
    release();
    await f.close();
  }
});
test('native heartbeat uses ordinary finish; failures retain cadence without cancelling chat', async () => {
  const f = await fixture({});
  try {
    f.setRunner(async () => {
      throw Error('provider unavailable');
    });
    await f.invoke('InitiativeEnable', {});
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).lastError);
    assert.equal((await f.invoke('InitiativeStatus')).enabled, true);
    assert.equal(f.cancels(), 0);
  } finally {
    await f.close();
  }
});

test('aborted runtime completion retains cadence without cancelling a concurrent user turn', async () => {
  const f = await fixture();
  try {
    f.setRunner(async ({ id }: any) => {
      f.workers.get(id).endStatus = 'aborted';
    });
    await f.invoke('InitiativeEnable', {});
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).lastError);
    assert.equal((await f.invoke('InitiativeStatus')).enabled, true);
    assert.match((await f.invoke('InitiativeStatus')).lastError, /aborted/);
    assert.equal(f.cancels(), 0);
  } finally {
    await f.close();
  }
});

test('heartbeat carries UTC time and instructions without copying native conversation history', async () => {
  const f = await fixture();
  let prompt = '';
  try {
    const history = Array.from({ length: 10 }, (_, i) => ({
      type: i % 2 ? 'assistant' : 'user',
      ts: Date.UTC(2026, 9, 9, 12) + i * 1000,
      text: `previous-message-${i}`,
      displayText: `visible-message-${i}`,
    }));
    f.workers.get('owner').transcript = [...history];
    f.setRunner(async (call: any) => {
      assert.notEqual(call.id, 'owner');
      prompt = call.prompt;
    });
    await f.invoke('InitiativeEnable', {});
    for (let round = 0; round < 2; round++) {
      prompt = '';
      const started = Date.now();
      await f.invoke('InitiativeControl', { action: 'check' });
      await until(async () => !!prompt && !(await f.invoke('InitiativeStatus')).active);
      assert.ok(prompt.includes(DISCOVERY_TASK));
      assert.match(prompt, /Heartbeat ID:/);
      const now = /Now \(UTC\): (.+)/.exec(prompt)![1];
      assert.match(now, /Z$/);
      assert.ok(Date.parse(now) >= started && Date.parse(now) <= Date.now());
      assert.doesNotMatch(prompt, /最近的历史交流|previous-message-|visible-message-/);
      const transcript = f.workers.get('owner').transcript;
      assert.deepEqual(transcript.slice(0, history.length), history);
      assert.equal(transcript.length, history.length);
      const discovery = (await f.invoke('InitiativeStatus')).discoverySession;
      assert.equal(f.workers.get(discovery).transcript.length, round + 1);
    }
  } finally {
    await f.close();
  }
});

test('temporary model failure keeps scheduled discovery enabled; permission failures remain visible without losing the configured cadence', async () => {
  const f = await fixture();
  try {
    f.setRunner(async () => {
      throw Error('HTTP 503 temporarily unavailable');
    });
    await f.invoke('InitiativeEnable', {});
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).lastError);
    let s = await f.invoke('InitiativeStatus');
    assert.equal(s.enabled, true);
    assert.equal(s.failures, 1);
    f.setRunner(async () => {
      throw Error('permission denied');
    });
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).lastError);
    s = await f.invoke('InitiativeStatus');
    assert.equal(s.enabled, true);
    assert.equal(f.cancels(), 0);
  } finally {
    await f.close();
  }
});

test('assistant status remains a strict JSON value at the real Host RPC boundary', async () => {
  const f = await fixture();
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    for (const includeMemory of [true, false]) {
      const result = await f.remote('assistant.status', { includeMemory });
      assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
      assert.equal(result.readiness.sessionError, null);
    }
  } finally {
    await f.close();
  }
});

test('failed blocked Session can check again, but actual pending user input defers', async () => {
  const f = await fixture();
  try {
    let checks = 0;
    f.setRunner(async () => {
      checks++;
    });
    await f.invoke('InitiativeEnable', {});
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => checks === 1 && !(await f.invoke('InitiativeStatus')).active);
    checks = 0;
    const worker = f.workers.get((await f.invoke('InitiativeStatus')).discoverySession);
    worker.status = 'blocked';
    worker.pendingInteractions = 1;
    await f.invoke('InitiativeControl', { action: 'check' });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(checks, 0);
    worker.pendingInteractions = 0;
    await until(() => checks === 1);
    await until(async () => !(await f.invoke('InitiativeStatus')).active);
    assert.equal((await f.invoke('InitiativeStatus')).enabled, true);
  } finally {
    await f.close();
  }
});

test('obsolete timeout config cannot expire an active heartbeat; pause still wins', async () => {
  const f = await fixture({ runTimeoutMs: 10 });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.setRunner(async () => {
      await hold;
    });
    await f.invoke('InitiativeEnable', {});
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).active);
    await new Promise((r) => setTimeout(r, 60));
    const active = await f.invoke('InitiativeStatus');
    assert.ok(active.active);
    assert.equal(active.lastError, null);
    await f.invoke('InitiativeControl', { action: 'pause' });
    release();
    await until(async () => !(await f.invoke('InitiativeStatus')).active);
    assert.equal((await f.invoke('InitiativeStatus')).enabled, false);
    assert.equal(f.cancels(), 0);
  } finally {
    release();
    await f.close();
  }
});

test('master disable stops an active heartbeat and removes tools until explicitly enabled again', async () => {
  const f = await fixture();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async () => hold);
    await f.remote('assistant.control', { action: 'enable', intervalMinutes: 30 });
    await until(
      async () =>
        f.workers.get((await f.invoke('InitiativeStatus')).discoverySession)?.status === 'running',
    );
    await f.remote('assistant.set-enabled', { enabled: false });
    assert.ok(f.cancels() >= 1, 'the runtime heartbeat is cancelled, not merely its observer');
    assert.equal(f.workers.get('owner').status, 'idle');
    assert.deepEqual(f.tools.resolve('owner', []).tools, []);
    await assert.rejects(f.remote('assistant.control', { action: 'check' }), /disabled/);
    release();
    await f.remote('assistant.set-enabled', { enabled: true });
    assert.equal((await f.remote('assistant.binding')).state.sessionId, 'owner');
  } finally {
    release();
    await f.close();
  }
});

test('discovery enabling preserves cadence; explicit configuration preserves paused state and reports scope', async () => {
  const f = await fixture();
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    const configured = await f.invoke('InitiativeConfigure', { intervalMinutes: 360 });
    assert.equal(configured.enabled, false);
    assert.equal(configured.intervalMs, 21600000);
    assert.equal(configured.nextAt, null);
    assert.equal(configured.effect.target, 'assistant_proactive_discovery');
    assert.equal(configured.effect.taskCreated, false);
    const enabled = await f.invoke('InitiativeEnable', {});
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.intervalMs, 21600000);
    const again = await f.invoke('InitiativeEnable', {});
    assert.equal(again.nextAt, enabled.nextAt, 'repeated enable must not postpone the next round');
    assert.equal(again.revision, enabled.revision);
    await assert.rejects(f.invoke('InitiativeEnable', { intervalMinutes: 30 }));
    assert.equal((await f.invoke('InitiativeStatus')).intervalMs, 21600000);
    await f.invoke('InitiativeControl', { action: 'pause' });
    const changed = await f.invoke('InitiativeConfigure', { intervalMinutes: 30 });
    assert.equal(changed.enabled, false);
    assert.equal(changed.effect.before.intervalMs, 21600000);
    assert.equal(changed.effect.after.intervalMs, 1800000);
    assert.equal(changed.nextAt, null);
    await assert.rejects(
      f.invokeAs('unrelated-session', 'InitiativeConfigure', { intervalMinutes: 1 }),
    );
    const resumed = await f.invoke('InitiativeControl', { action: 'resume' });
    assert.equal(resumed.intervalMs, 1800000);
    assert.equal(resumed.enabled, true);
    assert.equal(f.workers.size, 1, 'schedule operations do not start a task or exploration');
    await assert.rejects(f.invoke('InitiativeConfigure', {}));
    await assert.rejects(f.invoke('InitiativeConfigure', { intervalMinutes: 0 }));
  } finally {
    await f.close();
  }
});
