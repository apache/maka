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
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture, until } from './fixture.js';
import { PROACTIVE_TASK } from '../../../../src/assistant/index-initiative/prompt.js';

test('first open binds one ordinary chat without import, indexing, model calls or heartbeat', async () => {
  const f = await fixture();
  let calls = 0;
  f.setRunner(async () => {
    calls++;
  });
  try {
    await assert.rejects(f.remote('assistant.bind', { sessionId: 'missing' }), /Host/);
    const results = await Promise.all([
      f.remote('assistant.bind', { sessionId: 'owner' }),
      f.remote('assistant.bind', { sessionId: 'owner' }),
    ]);
    assert.ok(results.every((s) => s.sessionId === 'owner' && !s.enabled));
    const s = await f.remote('assistant.status');
    assert.equal(s.state.lastCheckedAt, null);
    assert.equal(s.memory.installed, true);
    assert.ok(s.memory.sources.some((source: any) => source.id === 'maka'));
    assert.equal(s.memory.indexes.length, 0);
    assert.equal(s.tasks.installed, true);
    assert.equal(f.workers.size, 1);
    assert.equal(calls, 0);
    f.workers.set('other', { status: 'idle' });
    assert.equal((await f.remote('assistant.bind', { sessionId: 'other' })).sessionId, 'owner');
    assert.equal((await f.remote('assistant.binding')).state.sessionId, 'owner');
    const prompt = await f.prompts.assemble(
      { sessionId: 'owner', turnId: 'first-chat', cwd: f.root },
      undefined,
    );
    assert.doesNotMatch(prompt.text ?? '', /正常回应用户/); // Chat is a transport, not an executing Agent.
  } finally {
    await f.close();
  }
});

test('UI enable checks immediately, status exposes failure without disabling scheduled discovery', async () => {
  const f = await fixture();
  let checks = 0;
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    f.setRunner(async ({ prompt }: any) => {
      assert.ok(prompt.includes(PROACTIVE_TASK), 'new UI binding uses the new default');
      checks++;
      throw Error('test provider unavailable');
    });
    await f.remote('assistant.control', { action: 'enable', intervalMinutes: 60 });
    await until(async () => (await f.remote('assistant.status')).state.lastError);
    let s = (await f.remote('assistant.status')).state;
    assert.equal(checks, 1);
    assert.equal(s.enabled, true);
    assert.equal(s.intervalMs, 3600000);
    assert.match(s.lastError, /provider unavailable/);
    f.setRunner(async () => {
      checks++;
    });
    await f.remote('assistant.control', { action: 'enable', intervalMinutes: 30 });
    await until(async () => (await f.remote('assistant.status')).state.lastCheckedAt);
    s = (await f.remote('assistant.status')).state;
    assert.equal(checks, 2);
    assert.equal(s.lastError, null);
    await f.remote('assistant.control', { action: 'pause' });
    assert.equal((await f.remote('assistant.status')).state.enabled, false);
    assert.equal(f.cancels(), 0);
  } finally {
    await f.close();
  }
});

test('original reader uses an existing chat, pages original content, and does not require assistant binding', async () => {
  const f = await fixture();
  try {
    f.sessions.set('project', [{ id: 'large', type: 'user', text: '证据'.repeat(24000) }]);
    const range = await f.invoke('MemoryRange', {});
    const history = await f.invoke('MemoryHistory', {
      to: range.to,
      mode: 'messages',
      recordId: 'project',
    });
    const ref = history.items[0].ref;
    const first = await f.remote('assistant.original', { sessionId: 'owner', ref });
    assert.equal(first.ref, ref);
    assert.equal(first.status, 'ok');
    assert.equal(first.text.length, 24000);
    assert.equal(first.nextOffset, 24000);
    const next = await f.remote('assistant.original', {
      sessionId: 'owner',
      ref,
      offset: first.nextOffset,
    });
    assert.equal(next.offset, 24000);
    assert.ok(next.text.length);
    assert.equal((await f.remote('assistant.binding')).state, null);
    await assert.rejects(f.remote('assistant.original', { sessionId: 'missing', ref }), /Host/);
    await assert.rejects(
      f.remote('assistant.original', { sessionId: 'owner', ref: 'unknown' }),
      /Unknown original/,
    );
    assert.equal(f.workers.size, 1);
  } finally {
    await f.close();
  }
});

test('original reader preserves cited evidence and rechecks external permissions including after I/O', async () => {
  const f = await fixture();
  let allowed = true,
    revision = 'v1',
    body = '旧证据',
    deleted = false,
    revokeDuringRead = false;
  const object = () => ({
    id: 'message',
    locator: { id: 'message' },
    revision,
    kind: 'text',
    title: '测试原文',
  });
  f.ctx
    .extend({
      maka: {
        rootId: 'profile',
        packageId: 'test-sources',
        entryId: 'test-sources',
        generation: 1,
      },
    })
    .sources.register({
      id: 'source.test',
      description: 'synthetic source',
      queryHelp: 'query',
      scope: {},
      enumerate: async () => ({ items: [object()] }),
      query: async () => ({ items: [object()] }),
      authorize: async (objects: any[]) => (allowed ? objects.map((o) => o.id) : []),
      read: async () => {
        if (revokeDuringRead) allowed = false;
        return deleted
          ? { status: 'deleted', object: object() }
          : { status: 'ok', object: object(), content: body };
      },
    });
  try {
    const { items } = await f.invoke('MemorySourceQuery', { source: 'source.test', query: {} });
    const ref = items[0].ref;
    const read = (extra: any = {}) =>
      f.remote('assistant.original', { sessionId: 'owner', ref, ...extra });
    assert.equal((await read()).text, '旧证据');
    revision = 'v2';
    body = '新证据';
    assert.equal((await read()).text, '旧证据');
    const latest = await read({ latest: true });
    assert.equal(latest.text, '新证据');
    assert.notEqual(latest.ref, ref);
    assert.equal((await read()).revision, 'v1');
    allowed = false;
    await assert.rejects(read(), /permission|visibil|accessible|denied|authorized/i);
    allowed = true;
    revokeDuringRead = true;
    await assert.rejects(read({ latest: true }), /permission/i);
    allowed = true;
    revokeDuringRead = false;
    deleted = true;
    assert.equal((await read({ latest: true })).status, 'deleted');
    assert.equal(f.workers.size, 1);
  } finally {
    await f.close();
  }
});

test('actual heartbeat ignores obsolete saved instructions and the configuration tool no longer offers them', async () => {
  const f = await fixture();
  const obsolete = 'obsolete saved prompt must never reach the heartbeat';
  const prompts: string[] = [];
  f.setRunner(async ({ prompt }: any) => {
    prompts.push(prompt);
  });
  try {
    const bound = await f.remote('assistant.bind', { sessionId: 'owner' });
    assert.equal(Object.hasOwn(bound, 'instructions'), false);
    const enable = f.tools
      .resolve('owner', [])
      .tools.find((tool: any) => tool.name === 'InitiativeEnable');
    assert.ok(enable);
    assert.equal(Object.hasOwn(enable.parameters.shape, 'instructions'), false);
    // Simulate a previously saved configuration; even before recovery it cannot override code.
    const db = new DatabaseSync(join(f.root, 'dev.maka.index-initiative', 'initiative.sqlite'));
    try {
      db.prepare('UPDATE state SET payload=? WHERE id=1').run(
        JSON.stringify({ ...bound, instructions: obsolete }),
      );
    } finally {
      db.close();
    }
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => prompts.length === 1 && !(await f.invoke('InitiativeStatus')).active);
    assert.ok(prompts[0].includes(PROACTIVE_TASK));
    assert.ok(!prompts[0].includes(obsolete));
    // Enable no longer silently accepts a cadence or obsolete prompt override.
    await assert.rejects(
      f.invoke('InitiativeEnable', {
        instructions: obsolete,
        intervalMinutes: 60,
      }),
    );
    const configured = await f.invoke('InitiativeConfigure', { intervalMinutes: 60 });
    assert.equal(Object.hasOwn(configured, 'instructions'), false);
    assert.equal(configured.intervalMs, 3600000);
    await f.invoke('InitiativeEnable', {});
    await f.remote('assistant.control', { action: 'enable', intervalMinutes: 60 });
    await until(async () => prompts.length === 2 && !(await f.invoke('InitiativeStatus')).active);
    assert.ok(prompts[1].includes(PROACTIVE_TASK));
    assert.ok(!prompts[1].includes(obsolete));
  } finally {
    await f.close();
  }
});
