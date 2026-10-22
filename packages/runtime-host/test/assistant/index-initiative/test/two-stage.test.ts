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
import { output, view, note } from './notebook-output.js';
import { InitiativeStore } from '../../../../src/assistant/index-initiative/store.js';
import { Notebook } from '../../../../src/assistant/index-initiative/notebook.js';

test('two persistent workers share append-only knowledge, not a fixed candidate report', async () => {
  const f = await fixture();
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    const discoveries: string[] = [],
      judgements: string[] = [],
      paths: string[] = [];
    f.setRunner(async ({ id, prompt, invoke, finish }: any) => {
      const path = view(prompt);
      paths.push(path);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await finish()).allow, true, 'ordinary agent finish, no content approval');
      if (prompt.includes('Phase: discovery')) {
        discoveries.push(id);
        assert.equal(prompt.includes('从生活和工作等多个方面出发'), discoveries.length === 1);
        assert.doesNotMatch(prompt, /10 个|六个|DiscoveryCandidates/);
        await output(prompt, { notes: discoveries.length === 1 ? [note] : [] });
      } else {
        judgements.push(id);
        assert.match(await readFile(path, 'utf8'), /用户曾关注摄影展/);
        assert.ok(!prompt.includes(note.text), 'the notebook is read from file');
        await invoke('DiscoveryContext', {});
        await output(prompt);
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
    for (const path of paths) await assert.rejects(readFile(path), /ENOENT/);
    assert.deepEqual(f.workers.get('owner').transcript, []);
  } finally {
    await f.close();
  }
});
test('judgement failure resumes shared notebook without repeating discovery', async () => {
  const f = await fixture();
  let discoveries = 0,
    judgements = 0;
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async ({ prompt }: any) => {
      if (prompt.includes('Phase: discovery')) {
        discoveries++;
        await output(prompt, { notes: [note] });
      } else {
        judgements++;
        assert.match(await readFile(view(prompt), 'utf8'), /用户曾关注摄影展/);
        if (judgements === 1) throw Error('provider unavailable');
        await output(prompt);
      }
    });
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).lastError);
    assert.equal((await f.invoke('InitiativeStatus')).pendingJudgement, true);
    await f.invoke('InitiativeConfigure', { intervalMinutes: 90 });
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => judgements === 2 && !(await f.invoke('InitiativeStatus')).active);
    assert.equal(discoveries, 1);
    assert.equal((await f.invoke('InitiativeStatus')).lastError, null);
  } finally {
    await f.close();
  }
});
test('missing output is a visible execution error, empty notes are allowed', async () => {
  const f = await fixture();
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async () => {});
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).lastError);
    assert.match((await f.invoke('InitiativeStatus')).lastError, /operations.json/);
    assert.equal((await f.invoke('InitiativeStatus')).judgementSession, undefined);
  } finally {
    await f.close();
  }
});
test('restart preserves shared notes and pending judgement with both role bindings', async () => {
  const f = await fixture();
  try {
    const dir = f.root + '/restart-state';
    const s = new InitiativeStore(dir, 'a');
    s.lease();
    s.bind({ sessionId: 'owner', cwd: f.root });
    s.configure({ sessionId: 'owner', cwd: f.root }, 5400000);
    s.update((v) => {
      v.discoverySession = 'd';
      v.judgementSession = 'j';
      v.pendingJudgement = true;
    });
    const book = new Notebook(dir + '/notebook.sqlite');
    book.appendNote(note, 'note');
    book.close();
    s.control('check');
    s.claim();
    s.release();
    s.close();
    const next = new InitiativeStore(dir, 'b');
    next.lease();
    next.recover();
    next.control('check');
    assert.equal(next.claim().active.phase, 'judgement');
    assert.equal(next.get().intervalMs, 5400000);
    assert.equal(next.get().discoverySession, 'd');
    const restored = new Notebook(dir + '/notebook.sqlite');
    assert.match(restored.render(), /用户曾关注摄影展/);
    restored.close();
    next.release();
    next.close();
  } finally {
    await f.close();
  }
});
