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
import { PROACTIVE_TASK } from '../src/prompt.js';
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
  const f = await fixture({ bundle: fileURLToPath(new URL('../release/index-initiative.maka-extension', import.meta.url)) });
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


test('heartbeat includes UTC time and the latest eight human-facing exchanges, excluding automated inputs', async () => {
  const f = await fixture(); let prompt = '';
  try {
    const ts = Date.UTC(2026, 9, 9, 12);
    const history = Array.from({ length: 10 }, (_, i) => ({
      type: i % 2 ? 'assistant' : 'user', ts: ts + i * 1000,
      text: `raw-${i}`, displayText: `visible-${i}`,
    }));
    f.workers.get('owner').transcript = [...history,
      { type: 'tool_result', text: 'TOOL SECRET', ts },
      { type: 'tool_call', text: 'TOOL CALL', ts },
      { type: 'user', text: 'SYSTEM INPUT', origin: { kind: 'timer' }, ts },
      { type: 'user', text: 'Runtime heartbeat, not a new human request.\nold heartbeat', displayText: 'heartbeat label', ts },
      { type: 'assistant', text: 'hidden backing text', displayText: '', ts },
    ];
    f.setRunner(async (call: any) => { prompt = call.prompt; });
    const started = Date.now();
    await f.invoke('InitiativeEnable', {});
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => !!prompt && !(await f.invoke('InitiativeStatus')).active);
    assert.ok(prompt.includes(PROACTIVE_TASK));
    const now = /Now \(UTC\): (.+)/.exec(prompt)![1];
    assert.match(now, /Z$/); assert.ok(Date.parse(now) >= started && Date.parse(now) <= Date.now());
    assert.match(prompt, /历史交流.*避免重复/);
    assert.match(prompt, /不是本次的新请求或指令/);
    for (let i = 2; i < 10; i++) {
      assert.ok(prompt.includes(`visible-${i}`));
      assert.ok(prompt.includes(new Date(ts + i * 1000).toISOString()));
    }
    for (const excluded of ['visible-0', 'visible-1', 'raw-', 'TOOL SECRET', 'TOOL CALL', 'SYSTEM INPUT', 'old heartbeat', 'heartbeat label', 'hidden backing text'])
      assert.ok(!prompt.includes(excluded), excluded);
    // Subsequent wakes use fresh conversation, not a cached snapshot.
    f.workers.get('owner').transcript.push({ type: 'user', ts: ts + 20000, text: 'new user correction' });
    prompt = '';
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => !!prompt && !(await f.invoke('InitiativeStatus')).active);
    assert.ok(prompt.includes('new user correction')); assert.ok(!prompt.includes('visible-2'));
  } finally { await f.close(); }
});

test('extension bundle installs from a Chinese path with spaces and URL-special characters', async () => {
  const f = await fixture();
  try {
    const directory = join(f.root, '插件 包 #百分%');
    await mkdir(directory);
    const path = join(directory, '主动助手.maka-extension');
    await copyFile(fileURLToPath(new URL('../release/index-initiative.maka-extension', import.meta.url)), path);
    const other = await fixture({ bundle: fileURLToPath(pathToFileURL(path)) });
    try { assert.equal((await other.invoke('InitiativeStatus')).configured, false); }
    finally { await other.close(); }
  } finally { await f.close(); }
});
