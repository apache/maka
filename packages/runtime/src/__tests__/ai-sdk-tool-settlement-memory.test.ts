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

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const CHILD_SOURCE = String.raw`
  import assert from 'node:assert/strict';
  import { mkdtemp, rm } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { setImmediate as tick } from 'node:timers/promises';
  import { jsonSchema } from 'ai';
  import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
  const { createTestAiSdkBackend } = await import(process.argv[1]);
  const { createSqliteRuntimeStore } = await import(process.argv[2]);
  const { createSessionEventMapMemory, mapSessionEventToRuntimeEvent } = await import(process.argv[3]);
  async function gc() { for (let i = 0; i < 8; i++) { await tick(); global.gc(); } }
  const alive = refs => refs.filter(ref => ref.deref() !== undefined).length;
  const control = Array.from({ length: 8 }, () => ({ text: Buffer.alloc(1024 * 1024, 120).toString() }));
  const controls = control.map(value => new WeakRef(value));
  await gc();
  assert.equal(alive(controls), 8, 'positive control must keep all raw results');
  control.length = 0;
  await gc();
  assert.equal(alive(controls), 0, 'released controls must collect');
  const dir = await mkdtemp(join(tmpdir(), 'maka-tool-settlement-memory-'));
  const store = createSqliteRuntimeStore(join(dir, 'runtime.sqlite'));
  const count = 20;
  const resultBytes = 128 * 1024;
  const resultRefs = [];
  let sequence = 0;
  const header = { id: 'session-1', workspaceRoot: dir, cwd: dir, createdAt: 1, name: 'memory', titleIsManual: false,
    isFlagged: false, labels: [], isArchived: false, status: 'active', statusUpdatedAt: 1, hasUnread: false,
    backend: 'ai-sdk', llmConnectionSlug: 'c', connectionLocked: true, model: 'mock', permissionMode: 'ask', schemaVersion: 1 };
  const connection = { slug: 'c', name: 'test', providerType: 'anthropic', defaultModel: 'mock', enabled: true, createdAt: 1, updatedAt: 1 };
  const anchor = { id: 'anchor', invocationId: 'invocation-1', runId: 'run-1', sessionId: header.id, turnId: 'turn-1', ts: 1,
    partial: false, role: 'user', author: 'user', content: { kind: 'text', text: 'Read the fixture' } };
  await store.appendRuntimeEvent(header.id, 'run-1', anchor);
  const tool = { name: 'FixtureRead', description: 'fixture', activityKind: 'read',
    parameters: jsonSchema({ type: 'object', properties: {} }), impl: async () => {
      const index = resultRefs.length;
      const result = { text: 'fixture-result-' + index + '-' + Buffer.alloc(resultBytes, 65 + index).toString() };
      resultRefs.push(new WeakRef(result));
      return result;
    } };
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const nextRequest = new Promise(resolve => { reached = resolve; });
  let calls = 0;
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const model = new MockLanguageModelV4({ doStream: async options => {
    const first = ++calls === 1;
    if (!first) {
      // Verify the next request still includes every complete durable result.
      const serialized = JSON.stringify(options.prompt);
      for (let i = 0; i < count; i++) {
        assert(serialized.includes('fixture-result-' + i + '-' + String.fromCharCode(65 + i).repeat(resultBytes)));
      }
      reached();
      await gate;
    }
    return { stream: convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      ...(first ? Array.from({ length: count }, (_, i) => ({ type: 'tool-call', toolCallId: 'call-' + i,
        toolName: tool.name, input: '{}' })) : []),
      { type: 'finish', finishReason: { unified: first ? 'tool-calls' : 'stop', raw: first ? 'tool-calls' : 'stop' }, usage },
    ]) };
  } });
  const backend = createTestAiSdkBackend({ sessionId: header.id, header, connection, modelId: 'mock', apiKey: 'test',
    newId: () => 'id-' + ++sequence, now: () => ++sequence, tools: [tool], modelFactory: () => model,
    loadTurnRuntimeEvents: async () => store.readImmutableRuntimeEvents(header.id, 'run-1') });
  const memory = createSessionEventMapMemory();
  const ctx = { sessionId: header.id, invocationId: 'invocation-1', runId: 'run-1', turnId: 'turn-1', now: () => ++sequence };
  const draining = (async () => {
    for await (const event of backend.send({ turnId: 'turn-1', runId: 'run-1', invocationId: 'invocation-1',
      text: 'Read the fixture', context: [], headAnchorRuntimeEvent: anchor })) {
      assert.notEqual(event.type, 'error', event.message);
      const mapped = mapSessionEventToRuntimeEvent(event, ctx, memory);
      if (mapped.partial !== true) await store.appendRuntimeEvent(header.id, 'run-1', mapped);
    }
  })();
  try {
    assert.equal(await Promise.race([nextRequest.then(() => 'waiting'), draining.then(() => 'done')]), 'waiting');
    // The provider fixture must not retain its captured request arguments.
    model.doStreamCalls.length = 0;
    await gc();
    const retained = alive(resultRefs);
    assert.equal(resultRefs.length, count);
    // The event drain may retain its last yielded event; the completed batch
    // must not remain live while the provider is waiting for a response.
    assert(retained <= 1, 'completed tool batch retained ' + retained + ' raw results');
    release();
    await draining;
    await gc();
    assert.equal(alive(resultRefs), 0, 'completed turn must release all raw results');
    console.log(JSON.stringify({ count, retained, released: alive(resultRefs) }));
  } finally {
    release();
    await draining;
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
`;

test('completed tool batches release raw results during the next provider request', (context) => {
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '--eval',
      CHILD_SOURCE,
      new URL('./execution-boundary-test-helpers.js', import.meta.url).href,
      new URL('../../../storage/dist/sqlite-runtime-store.js', import.meta.url).href,
      new URL('../session-event-runtime-mapper.js', import.meta.url).href,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  context.diagnostic(result.stdout.trim());
});
