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

test('archived workers are excluded from discovery and replaced when already bound', async () => {
  const f = await fixture();
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    for (const phase of ['discovery', 'judgement'])
      f.workers.set(`archived-${phase}`, {
        status: 'idle',
        isArchived: true,
        labels: [`assistant-${phase}:owner`],
      });
    const seen: string[] = [];
    f.setRunner(async ({ id, prompt }: any) => {
      assert.equal(f.workers.get(id).isArchived, undefined);
      seen.push(id);
      if (seen.length <= 4) {
        assert.match(prompt, /你是/); // Replacement sessions receive role instructions again.
      }
      await output(prompt);
    });
    const run = async () => {
      const expected = seen.length + 2;
      await f.invoke('InitiativeControl', { action: 'check' });
      await until(
        async () => !(await f.invoke('InitiativeStatus')).active && seen.length === expected,
      );
      const state = await f.invoke('InitiativeStatus');
      assert.equal(state.lastError, null);
      return state;
    };
    const first = await run();
    for (const id of [first.discoverySession, first.judgementSession])
      f.workers.get(id).isArchived = true;
    const second = await run();
    assert.notEqual(second.discoverySession, first.discoverySession);
    assert.notEqual(second.judgementSession, first.judgementSession);
    const third = await run();
    assert.equal(third.discoverySession, second.discoverySession);
    assert.equal(third.judgementSession, second.judgementSession);
    assert.equal(seen.length, 6);
    for (const id of [
      first.discoverySession,
      first.judgementSession,
      'archived-discovery',
      'archived-judgement',
    ])
      assert.equal(f.workers.get(id).isArchived, true);
  } finally {
    await f.close();
  }
});

test('repaired judgement reaches the actual Bot SendUser conversation exactly once', async () => {
  const f = await fixture();
  let judgements = 0;
  const text = '报名窗口今天关闭，确认后及时报名。';
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async ({ prompt, invoke }: any) => {
      if (prompt.startsWith('Inbox 有新消息')) {
        const batch = await invoke('InboxCheck', {});
        for (const item of batch.items) {
          assert.equal(item.type, 'discovery');
          await invoke('SendUser', {
            messageId: `recovery:${item.id}`,
            messages: [{ text: JSON.parse(item.content), discoveryIds: [item.id] }],
          });
        }
        await invoke('Sleep', {});
      } else if (prompt.includes('Phase: discovery')) {
        await output(prompt, { notes: [note] });
      } else {
        judgements++;
        if (judgements === 2) assert.match(prompt, /不在待发送队列/);
        await output(prompt, {
          feedbackDecisions:
            judgements === 1
              ? [{ feedbackId: 'raw-history-id', understanding: 'old user request', rules: [] }]
              : [],
          messages: [{ text, topicIds: [note.topicId] }],
        });
      }
    });
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => {
      const binding = await f.remote('assistant.binding');
      if (binding.bot?.error || binding.bot?.wakeError) throw Error(JSON.stringify(binding.bot));
      return (
        judgements >= 2 &&
        !binding.state.active &&
        !binding.state.checkRequested &&
        binding.bot?.sleeping &&
        f.workers.get('owner').transcript.some((m: any) => m.text === text)
      );
    });
    assert.equal(judgements, 2);
    assert.equal((await f.invoke('InitiativeStatus')).lastError, null);
    assert.equal(f.workers.get('owner').transcript.filter((m: any) => m.text === text).length, 1);
  } finally {
    await f.close();
  }
});
