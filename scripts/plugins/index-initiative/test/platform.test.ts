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
import { fixture, until, checkpoint } from './fixture.js';

test('two real index instances + incremental originals drive action, unchanged evidence stays quiet', async () => {
  const f = await fixture();
  try {
    // Installing the second extension reloads the first; its existing lease refresh is 10 s.
    await new Promise(r => setTimeout(r, 10100));
    const range = await f.invoke('MemoryRange');
    const indexes = [];
    for (const name of ['Project context', 'Supplier commitments']) indexes.push(await f.invoke('MemoryIndexCreate', { name, instructions: 'Organize relevant evidence with original references.', cursor: range.to }));
    const before = await Promise.all(indexes.map(i => f.invoke('MemoryIndexRead', { indexId: i.index.id })));
    let checks = 0; const drafts: string[] = []; let stale: any;
    f.setRunner(async ({ prompt, invoke, finish }: any) => {
      const activationId = /Activation: ([^\n]+)/.exec(prompt)![1];
      assert.equal((await finish()).allow, false);
      const s = await invoke('InitiativeRead', { activationId });
      const list = await invoke('MemoryIndexList', {}); assert.equal(list.length, 2);
      let evidence = ''; const refs: string[] = [];
      for (const index of list) {
        const doc = await invoke('MemoryIndexContent', { indexId: index.id, key: 'evidence' });
        evidence += doc.text;
        for (const ref of [...doc.text.matchAll(/memory-original:([^\s)]+)/g)].map((m: any) => m[1])) {
          const original = await invoke('MemoryOriginal', { ref }); assert.ok(original); refs.push(ref);
        }
        const delta = await invoke('MemoryRange', { indexId: index.id });
        const page = await invoke('MemoryHistory', { from: delta.from, to: delta.to, mode: 'messages' });
        evidence += page.items.map((m: any) => m.message.text).join(' ');
      }
      const prior = await invoke('InitiativeHistory', { key: 'demo-backup' });
      const act = evidence.includes('Friday') && evidence.includes('delayed to Monday') && prior.items.length === 0;
      // Controlled external action adapter; this is not a real LLM decision-quality test.
      if (act) drafts.push('Prepare a backup demo checklist');
      const input = checkpoint(s, { summary: act ? 'Cross-index conflict confirmed by newer original' : 'No new action needed', update: act ? 'Prepared backup checklist after verifying the delivery delay.' : '',
        records: act ? [{ key: 'demo-backup', summary: 'Backup checklist created', evidence: refs }] : [], bookmarks: { observed: 'Own observation, not index coverage' } });
      stale ??= input;
      await invoke('InitiativeCheckpoint', input);
      await invoke('InitiativeCheckpoint', input); // exact replay is idempotent
      assert.equal((await finish()).allow, true); checks++;
    });
    await f.invoke('InitiativeEnable', { instructions: 'Check multiple indexes. You may prepare a local backup checklist if delivery slips. Do not contact anyone.' });
    await until(async () => checks === 1 && !(await f.invoke('InitiativeStatus')).active);
    assert.deepEqual(drafts, []);
    f.sessions.get('supplier')!.push({ id: 'delay', type: 'user', text: 'Delivery is now delayed to Monday.' });
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => checks === 2 && !(await f.invoke('InitiativeStatus')).active);
    assert.equal(drafts.length, 1);
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => checks === 3 && !(await f.invoke('InitiativeStatus')).active);
    assert.equal(drafts.length, 1);
    const after = await Promise.all(indexes.map(i => f.invoke('MemoryIndexRead', { indexId: i.index.id })));
    assert.deepEqual(after.map(i => i.coverage.cursor), before.map(i => i.coverage.cursor));
    assert.deepEqual(after.map(i => i.index.revision), before.map(i => i.index.revision));
    assert.equal((await f.invoke('InitiativeHistory', { key: 'demo-backup' })).items.length, 1);
    await assert.rejects(f.invokeAs('intruder', 'InitiativeStatus', {}), /outside/);
    await assert.rejects(f.invokeAs((await f.invoke('InitiativeStatus')).worker, 'InitiativeCheckpoint', stale), /matching active/);
    assert.equal((await f.turns.evaluate({ sessionId: 'ordinary-chat', turnId: 'x', signal: new AbortController().signal })).allow, true);
  } finally { await f.close(); }
});

test('absolute timer wakes same worker; queued wake is claimed before idle means completion', async () => {
  const f = await fixture(); let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  let checks = 0; const ids: string[] = [];
  try {
    f.setGate(() => gate, true);
    f.setRunner(async ({ id, prompt, invoke }: any) => {
      ids.push(id); const s = await invoke('InitiativeRead', { activationId: /Activation: ([^\n]+)/.exec(prompt)![1] });
      await invoke('InitiativeCheckpoint', checkpoint(s, { nextCheckAt: new Date(Date.now() + (checks === 0 ? 100 : 3600000)).toISOString() })); checks++;
    });
    await f.invoke('InitiativeEnable', { instructions: 'Inspect evidence, stay quiet without changes.' });
    await until(async () => (await f.invoke('InitiativeStatus')).active);
    await new Promise(r => setTimeout(r, 30)); assert.equal(checks, 0); assert.equal((await f.invoke('InitiativeStatus')).enabled, true);
    release(); await until(() => checks === 2); assert.equal(new Set(ids).size, 1);
    await until(async () => !(await f.invoke('InitiativeStatus')).active);
    await f.invoke('InitiativeControl', { action: 'pause' });
    assert.equal((await f.invoke('InitiativeStatus')).enabled, false);
  } finally { release(); await f.close(); }
});

test('past wake rejected and premature exit is held; unfinished runtime exit preserves a fault', async () => {
  const f = await fixture();
  try {
    f.setRunner(async ({ prompt, invoke, finish }: any) => {
      const s = await invoke('InitiativeRead', { activationId: /Activation: ([^\n]+)/.exec(prompt)![1] });
      await assert.rejects(invoke('InitiativeCheckpoint', checkpoint(s, { nextCheckAt: '2000-01-01T00:00:00Z' })), /future/);
      assert.equal((await finish()).allow, false);
      // Simulate a forced runtime exit, bypassing its natural-finish hook.
    });
    await f.invoke('InitiativeEnable', { instructions: 'Inspect evidence.' });
    await until(async () => (await f.invoke('InitiativeStatus')).lastError);
    assert.equal((await f.invoke('InitiativeStatus')).enabled, false);
  } finally { await f.close(); }
});

test('exported extension installs and executes a quiet checkpoint', async () => {
  const f = await fixture({ bundle: new URL('../release/index-initiative.maka-extension', import.meta.url).pathname });
  let checked = false;
  try {
    f.setRunner(async ({ prompt, invoke }: any) => {
      const s = await invoke('InitiativeRead', { activationId: /Activation: ([^\n]+)/.exec(prompt)![1] });
      await invoke('InitiativeCheckpoint', checkpoint(s)); checked = true;
    });
    await f.invoke('InitiativeEnable', { instructions: 'Inspect relevant indexes. Stay quiet when nothing useful changed.' });
    await until(async () => checked && !(await f.invoke('InitiativeStatus')).active);
    assert.equal((await f.invoke('InitiativeStatus')).lastUpdate, '');
  } finally { await f.close(); }
});
