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
import { output, note } from './notebook-output.js';

test('scoped cycles rotate workers, retain current memory and keep retired workers bounded', async () => {
  const f = await fixture();
  const discoveries: string[] = [],
    judgements: string[] = [];
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    const before = await f.invoke('InitiativeStatus');
    await f.invoke('InitiativeConfigure', { contextMode: 'scoped' });
    const configured = await f.invoke('InitiativeStatus');
    assert.equal(configured.enabled, before.enabled);
    assert.equal(configured.intervalMs, before.intervalMs);
    assert.equal(configured.nextAt, before.nextAt);
    f.setRunner(async ({ id, prompt, invoke }: any) => {
      if (prompt.includes('Phase: discovery')) {
        discoveries.push(id);
        if (discoveries.length === 2) {
          const current = await invoke('DiscoveryNotebook', {
            view: 'topic',
            topicId: note.topicId,
          });
          assert.equal(current.items[0].text, note.text);
          assert.equal(
            f.workers.get(id).transcript.length,
            1,
            'new worker does not copy old transcript',
          );
        }
        await output(prompt, { notes: discoveries.length === 1 ? [note] : [] });
      } else {
        judgements.push(id);
        await output(prompt);
      }
    });
    for (let i = 1; i <= 2; i++) {
      await f.invoke('InitiativeControl', { action: 'check' });
      await until(
        async () => judgements.length === i && !(await f.invoke('InitiativeStatus')).active,
      );
      assert.equal((await f.invoke('InitiativeStatus')).lastError, null);
    }
    assert.equal(new Set([...discoveries, ...judgements]).size, 4);
    for (const worker of [...discoveries, ...judgements]) {
      const visible = f
        .filterTools(worker, f.tools.resolve(worker, []).tools)
        .map((tool: any) => tool.name);
      for (const name of ['MatterDelegate', 'MemoryIndexWrite', 'SendUser', 'InitiativeConfigure'])
        assert.ok(!visible.includes(name), `${worker} exposed ${name}`);
    }
    await assert.rejects(
      f.invokeAs(discoveries[0], 'DiscoveryNotebookRemember', {
        key: 'stale',
        executionId: 'old',
        expectedFeedbackRevision: 0,
        notes: [note],
      }),
      /unavailable in this session/,
    );
  } finally {
    await f.close();
  }
});

test('scoped judgement retries keep their worker and prohibit mode changes while pending', async () => {
  const f = await fixture();
  let discovery = 0;
  const judges: string[] = [];
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    await f.invoke('InitiativeConfigure', { contextMode: 'scoped' });
    f.setRunner(async ({ id, prompt }: any) => {
      if (prompt.includes('Phase: discovery')) {
        discovery++;
        await output(prompt, { notes: [note] });
      } else {
        judges.push(id);
        if (judges.length === 1) throw Error('Controlled judgement interruption');
        await output(prompt);
      }
    });
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => (await f.invoke('InitiativeStatus')).lastError);
    await assert.rejects(
      f.invoke('InitiativeConfigure', { contextMode: 'legacy' }),
      /pending discovery/,
    );
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => judges.length === 2 && !(await f.invoke('InitiativeStatus')).active);
    assert.equal(discovery, 1);
    assert.equal(judges[0], judges[1]);
    assert.equal((await f.invoke('InitiativeStatus')).lastError, null);
  } finally {
    await f.close();
  }
});

test('quick scoped wakes rotate only after success and preserve the shared entry', async () => {
  const f = await fixture();
  const workers: string[] = [];
  let entryId = '';
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    await f.invoke('InitiativeConfigure', { contextMode: 'scoped' });
    f.setRunner(async ({ id, invoke }: any) => {
      workers.push(id);
      const context = await invoke('DiscoveryNotebook', {});
      if (workers.length === 1) {
        const result = await invoke('DiscoveryNotebookRemember', {
          key: 'remember',
          executionId: context.executionId,
          expectedFeedbackRevision: context.feedbackRevision,
          notes: [note],
        });
        entryId = result.entryIds[0];
        throw Error('Controlled interruption');
      }
      const topic = await invoke('DiscoveryNotebook', { view: 'topic', topicId: note.topicId });
      assert.equal(topic.items.length, 1);
      assert.equal(topic.items[0].id, entryId);
    });
    await f.remote('assistant.quick-discovery', { action: 'check' });
    await until(async () => (await f.remote('assistant.quick-discovery-status', {})).lastError);
    for (let attempts = 2; attempts <= 3; attempts++) {
      await f.remote('assistant.quick-discovery', { action: 'check' });
      await until(
        async () =>
          workers.length === attempts &&
          !(await f.remote('assistant.quick-discovery-status', {})).active,
      );
      assert.equal((await f.remote('assistant.quick-discovery-status', {})).lastError, null);
    }
    assert.equal(workers[0], workers[1]);
    assert.notEqual(workers[1], workers[2]);
    assert.equal(f.workers.get(workers[2]).transcript.length, 1);
    const oldTools = f.filterTools(workers[0], [
      { name: 'Edit', categoryHint: 'file_write' },
      { name: 'Read', categoryHint: 'read' },
    ]);
    assert.deepEqual(
      oldTools.map((tool: any) => tool.name),
      ['Read'],
    );
  } finally {
    await f.close();
  }
});
