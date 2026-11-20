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
import { note, output } from './notebook-output.js';

test('quick knowledge reaches exploration and judgement without a user notification', async () => {
  const f = await fixture();
  let entryId = '',
    worker = '',
    submission: any;
  let phases = 0;
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async ({ id, prompt, invoke }: any) => {
      if (!prompt.includes('Phase:')) {
        worker = id;
        const context = await invoke('DiscoveryNotebook', {});
        submission = {
          key: 'investigation',
          executionId: context.executionId,
          expectedFeedbackRevision: context.feedbackRevision,
          notes: [note],
        };
        const saved = await invoke('DiscoveryNotebookRemember', submission);
        entryId = saved.entryIds[0];
        assert.deepEqual(await invoke('DiscoveryNotebookRemember', submission), saved);
        await assert.rejects(
          invoke('DiscoveryNotebookRemember', {
            ...submission,
            key: 'stale',
            executionId: 'a-previous-wake',
          }),
          /execution changed/,
        );
        assert.ok(
          !f
            .filterTools(id, f.tools.resolve(id, []).tools)
            .some((tool: any) => tool.name === 'MatterDelegate'),
        );
      } else {
        phases++;
        const current = await invoke('DiscoveryNotebook', { view: 'topic', topicId: note.topicId });
        assert.equal(current.items.length, 1);
        assert.equal(current.items[0].id, entryId);
        if (prompt.includes('Phase: discovery')) {
          assert.equal(current.items[0].text, note.text);
          await output(prompt, {
            updates: [
              {
                entryId,
                expectedRevision: 1,
                text: '已核实近期展览开放安排。',
                kind: 'observation',
                sources: ['开放安排原文'],
                occurredAt: null,
                reason: '本轮核对原文。',
              },
            ],
          });
        } else {
          assert.equal(current.items[0].revision, 2);
          assert.equal(current.items[0].text, '已核实近期展览开放安排。');
          await output(prompt);
        }
      }
    });
    await f.remote('assistant.quick-discovery', { action: 'check' });
    await until(
      async () => entryId && !(await f.remote('assistant.quick-discovery-status', {})).active,
    );
    assert.deepEqual(f.workers.get('owner').transcript, []);
    await assert.rejects(
      f.invokeAs(worker, 'DiscoveryNotebookRemember', submission),
      /No active quick/,
    );
    assert.ok(
      !f
        .filterTools('owner', f.tools.resolve('owner', []).tools)
        .some((tool: any) => tool.name === 'DiscoveryNotebook'),
    );
    const read = f.tools
      .resolve(worker, [])
      .tools.find((tool: any) => tool.name === 'DiscoveryNotebook');
    await assert.rejects(read.impl({}, { sessionId: 'owner' }), /unavailable in this session/);
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => phases === 2 && !(await f.invoke('InitiativeStatus')).active);
    assert.equal((await f.invoke('InitiativeStatus')).lastError, null);
    assert.deepEqual(f.workers.get('owner').transcript, []);
  } finally {
    await f.close();
  }
});

test('a failed quick wake can retry a committed memory operation without duplicating it', async () => {
  const f = await fixture();
  let attempts = 0,
    originalExecution = '',
    originalEntry = '';
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async ({ invoke }: any) => {
      attempts++;
      const context = await invoke('DiscoveryNotebook', {});
      const saved = await invoke('DiscoveryNotebookRemember', {
        key: 'stable',
        executionId: context.executionId,
        expectedFeedbackRevision: context.feedbackRevision,
        notes: [note],
      });
      if (attempts === 1) {
        originalExecution = context.executionId;
        originalEntry = saved.entryIds[0];
        throw Error('Controlled provider interruption after the memory commit');
      }
      assert.equal(context.executionId, originalExecution);
      assert.equal(saved.entryIds[0], originalEntry);
      const topic = await invoke('DiscoveryNotebook', { view: 'topic', topicId: note.topicId });
      assert.equal(topic.items.length, 1);
    });
    await f.remote('assistant.quick-discovery', { action: 'check' });
    await until(async () => (await f.remote('assistant.quick-discovery-status', {})).lastError);
    await f.remote('assistant.quick-discovery', { action: 'check' });
    await until(
      async () =>
        attempts === 2 && !(await f.remote('assistant.quick-discovery-status', {})).active,
    );
    assert.equal((await f.remote('assistant.quick-discovery-status', {})).lastError, null);
  } finally {
    await f.close();
  }
});
