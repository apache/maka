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
import { readFile, stat } from 'node:fs/promises';
import { fixture, until } from './fixture.js';
import { InitiativeStore } from '../../../../src/assistant/index-initiative/store.js';

test('two persistent workers hand off a file without leaking candidates to Bot or judge prompt', async () => {
  const f = await fixture();
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    const discoveries: string[] = [],
      judgements: string[] = [],
      paths: string[] = [];
    const text = 'Private candidate evidence: investigate the new exhibition.';
    f.setRunner(async ({ id, prompt, invoke }: any) => {
      if (!prompt.includes('报告文件：')) {
        discoveries.push(id);
        await assert.rejects(invoke('DiscoveryReport', { text }), /active/);
        const report = await invoke('DiscoveryCandidates', { text });
        paths.push(report.path);
        assert.equal(await readFile(report.path, 'utf8'), text);
        assert.equal((await stat(report.path)).mode & 0o777, 0o600);
        assert.deepEqual(await invoke('DiscoveryCandidates', { text }), report);
        await assert.rejects(
          invoke('DiscoveryCandidates', { text: 'different' }),
          /already submitted/,
        );
      } else {
        judgements.push(id);
        assert.equal(discoveries.length, judgements.length);
        assert.ok(prompt.includes(paths.at(-1)));
        assert.ok(!prompt.includes(text));
        await assert.rejects(invoke('DiscoveryCandidates', { text }), /active/);
        await invoke('DiscoveryContext', {});
        // Nothing merits a user message; ordinary completion is valid for judgement.
      }
    });
    for (let i = 0; i < 2; i++) {
      await f.invoke('InitiativeControl', { action: 'check' });
      await until(
        async () => judgements.length === i + 1 && !(await f.invoke('InitiativeStatus')).active,
      );
      assert.equal((await f.invoke('InitiativeStatus')).lastError, null);
    }
    assert.equal(new Set(discoveries).size, 1);
    assert.equal(new Set(judgements).size, 1);
    assert.notEqual(discoveries[0], judgements[0]);
    assert.equal(new Set(paths).size, 2);
    const configured = await f.invoke('InitiativeConfigure', { intervalMinutes: 90 });
    assert.equal(configured.judgementSession, judgements[0]);
    assert.equal(configured.discoverySession, discoveries[0]);
    assert.equal(configured.candidateReport, undefined);
    assert.deepEqual(f.workers.get('owner').transcript, []);
  } finally {
    await f.close();
  }
});

test('judgement failure resumes saved report, without rerunning discovery', async () => {
  const f = await fixture();
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    let discovered = 0,
      judged = 0,
      path = '';
    f.setRunner(async ({ prompt, invoke }: any) => {
      if (!prompt.includes('报告文件：')) {
        discovered++;
        path = (await invoke('DiscoveryCandidates', { text: 'Unresolved candidate' })).path;
      } else {
        judged++;
        assert.ok(prompt.includes(path));
        if (judged === 1) throw Error('provider unavailable');
      }
    });
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).lastError);
    assert.equal((await f.invoke('InitiativeStatus')).candidateReport.path, path);
    await f.invoke('InitiativeConfigure', { intervalMinutes: 90 });
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => judged === 2 && !(await f.invoke('InitiativeStatus')).active);
    assert.equal(discovered, 1);
    assert.equal((await f.invoke('InitiativeStatus')).lastError, null);
    assert.equal((await f.invoke('InitiativeStatus')).candidateReport, undefined);
  } finally {
    await f.close();
  }
});

test('missing report is a visible failure and never starts judgement', async () => {
  const f = await fixture();
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async () => {});
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).lastError);
    const state = await f.invoke('InitiativeStatus');
    assert.match(state.lastError, /without a report/);
    assert.equal(state.judgementSession, undefined);
  } finally {
    await f.close();
  }
});

test('restart preserves report and both worker bindings without clearing indexes or changing cadence', async () => {
  const f = await fixture();
  try {
    const s = new InitiativeStore(f.root + '/restart-state', 'test-owner');
    assert.ok(s.lease());
    s.bind({ sessionId: 'owner', cwd: f.root });
    s.configure({ sessionId: 'owner', cwd: f.root }, 5400000);
    s.update((v) => {
      v.discoverySession = 'discovery';
      v.judgementSession = 'judge';
    });
    s.control('check');
    s.claim();
    const report = s.saveCandidates('discovery', 'Saved report');
    s.release();
    s.close();
    const resumed = new InitiativeStore(f.root + '/restart-state', 'new-owner');
    assert.ok(resumed.lease());
    resumed.recover();
    assert.equal(resumed.get().intervalMs, 5400000);
    assert.equal(resumed.get().judgementSession, 'judge');
    assert.deepEqual(resumed.get().candidateReport, report);
    resumed.control('check');
    assert.equal(resumed.claim().active.phase, 'judgement');
    assert.equal(await readFile(report.path, 'utf8'), 'Saved report');
    resumed.release();
    resumed.close();
  } finally {
    await f.close();
  }
});
