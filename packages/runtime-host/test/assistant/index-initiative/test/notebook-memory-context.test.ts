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
import { readFile } from 'node:fs/promises';
import { view } from './notebook-output.js';
import assert from 'node:assert/strict';
import { fixture, until } from './fixture.js';
import { output, note } from './notebook-output.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

for (const lane of ['broad', 'quick']) {
  test(`${lane} abandonment drops late worker writes and keeps earlier knowledge`, async () => {
    let lost = false;
    let worker = '';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      beforeSnapshot: (id: string) => {
        if (lost && id === worker) throw Error('Host snapshot unavailable');
      },
    });
    let db: DatabaseSync | undefined;
    let saved: any;
    let lateFinished = false;
    let later = 0;
    const check = () =>
      lane === 'broad'
        ? f.invoke('InitiativeControl', { action: 'check' })
        : f.remote('assistant.quick-discovery', { action: 'check' });
    try {
      await f.remote('assistant.bind', { sessionId: 'owner' });
      f.setRunner(async ({ id, prompt, invoke }: any) => {
        if (!worker) {
          worker = id;
          const context = await invoke('DiscoveryNotebook', {});
          saved = {
            key: 'before-disconnect',
            executionId: context.executionId,
            expectedFeedbackRevision: context.feedbackRevision,
            notes: [note],
          };
          await invoke('DiscoveryNotebookRemember', saved);
          lost = true;
          await gate;
          await assert.rejects(invoke('DiscoveryNotebookRemember', { ...saved, key: 'late' }));
          if (lane === 'quick')
            await assert.rejects(
              invoke('QuickDiscoveryReport', { key: 'late', messages: ['old report'] }),
            );
          else await output(prompt, { notes: [{ ...note, text: 'late final draft' }] });
          lateFinished = true;
        } else {
          assert.notEqual(id, worker, 'even legacy mode rotates the abandoned worker');
          const context = await invoke('DiscoveryNotebook', {
            view: 'topic',
            topicId: note.topicId,
          });
          assert.deepEqual(
            context.items.map((entry: any) => entry.text),
            [note.text],
          );
          later++;
          if (lane === 'broad') await output(prompt);
        }
      });
      await check();
      db = new DatabaseSync(join(f.root, 'dev.maka.index-initiative', 'initiative.sqlite'));
      await until(() => db!.prepare("SELECT 1 FROM discovery_jobs WHERE state='recovering'").get());
      const job = db.prepare("SELECT id FROM discovery_jobs WHERE state='recovering'").get()!;
      db.prepare('UPDATE discovery_jobs SET recovery_since=? WHERE id=?').run(
        Date.now() - 300_001,
        job.id,
      );
      await until(() =>
        db!.prepare("SELECT 1 FROM discovery_jobs WHERE id=? AND outcome='abandoned'").get(job.id),
      );
      const state =
        lane === 'broad'
          ? await f.invoke('InitiativeStatus')
          : await f.remote('assistant.quick-discovery-status', {});
      assert.equal(state.active, null);
      assert.equal(state.checkRequested, false);
      assert.ok((lane === 'broad' ? state.nextAt : state.retryAt) > Date.now());
      assert.match(state.lastError, /abandoned/);
      assert.ok(f.cancels() >= 1);
      assert.equal(later, 0, 'timeout did not immediately start another investigation');

      await check(); // explicit user check may override the ordinary cadence
      await until(
        () =>
          later === (lane === 'broad' ? 2 : 1) &&
          !db!.prepare("SELECT 1 FROM discovery_jobs WHERE state!='done'").get(),
      );
      release();
      await until(() => lateFinished);
      assert.deepEqual(f.workers.get('owner').transcript, [], 'late output never reached Bot');
      const tools = f.filterTools(worker, [
        { name: 'MatterDelegate', categoryHint: 'file_write' },
        { name: 'SendUser', categoryHint: 'file_write' },
        { name: 'Read', categoryHint: 'read' },
      ]);
      assert.deepEqual(
        tools.map((tool: any) => tool.name),
        ['Read'],
      );
    } finally {
      release();
      db?.close();
      await f.close();
    }
  });
}

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
          const seed = JSON.parse(
            (await readFile(view(prompt), 'utf8')).split('\n').slice(1).join('\n'),
          );
          assert.equal(seed.recentProgress[0].text, '已核对原始记录；等待新版本后复查。');
          const original = await invoke('DiscoveryNotebook', seed.recentProgress[0].read);
          assert.equal(JSON.parse(original.text).payload.topicId, note.topicId);
          assert.equal(
            f.workers.get(id).transcript.length,
            1,
            'new worker does not copy old transcript',
          );
        }
        await output(
          prompt,
          discoveries.length === 1
            ? {
                notes: [note],
                checkpoints: [
                  { topicId: note.topicId, text: '已核对原始记录；等待新版本后复查。' },
                ],
              }
            : {},
        );
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
    f.setRunner(async ({ id, prompt, invoke }: any) => {
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
        await invoke('DiscoveryNotebookRemember', {
          key: 'progress',
          executionId: context.executionId,
          expectedFeedbackRevision: context.feedbackRevision,
          checkpoints: [
            { topicId: note.topicId, text: '已检查版本；下一步核对新产物。', entryIds: [entryId] },
          ],
        });
        throw Error('Controlled interruption');
      }
      assert.match(prompt, /已检查版本；下一步核对新产物/);
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
