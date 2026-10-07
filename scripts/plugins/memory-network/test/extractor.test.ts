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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './host-fixture.js';
import { extractHistory } from '../src/extractor.js';

for (const bundle of [false, true])
  test(`extractor bundle=${bundle}: bulk single call, exact receipt, no index mutation`, async (t) => {
    const f = await fixture(bundle);
    t.after(() => f.close());
    f.sessions.set(
      'chat-a',
      Array.from({ length: 600 }, (_, n) => ({
        id: `m${n}`,
        type: 'user',
        text: `原文${n}:` + '保留来龙去脉。'.repeat(50),
      })),
    );
    const range = await f.invoke('MemoryRange', {});
    f.setExtractRunner(async (input) => {
      const p = JSON.parse(input.prompt);
      assert.equal(p.originals.length, 600);
      assert.ok(input.prompt.length > 200000);
      assert.equal(p.originals.at(-1).message.id, 'm599');
      assert.equal(p.requirement, '提取用户偏好，自行组织内容');
      assert.equal(input.maxOutputTokens, 32768);
      assert.equal(input.tools, undefined);
      return {
        text: `自由格式草稿\n${p.originals[599].citation}\n` + '结果'.repeat(10000),
        modelId: 'test-large-context',
        finishReason: 'stop',
      };
    });
    const result = await f.invoke('MemoryExtract', {
      to: range.to,
      recordIds: ['chat-a'],
      requirements: '提取用户偏好，自行组织内容',
      maxInputChars: 800000,
    });
    assert.equal(result.status, 'generated');
    assert.equal(f.llmCalls.length, 1);
    assert.equal(f.workers.size, 0);
    assert.equal(result.selection.nextOffset, null);
    assert.equal(result.selection.totalMatchingMessages, 600);
    assert.equal((await readFile(result.path, 'utf8')).length, result.outputChars);
    assert.ok(result.outputChars > result.preview.length);
    // The parent receives neither the bulk source payload nor the full generated draft.
    assert.ok(JSON.stringify(result).length < 5000);
    assert.equal(result.originals, undefined);
    assert.ok(!JSON.stringify(result).includes('保留来龙去脉。'));
    const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8'));
    assert.equal(receipt.originals.length, 600);
    assert.equal(receipt.modelId, 'test-large-context');
    assert.deepEqual(await f.invoke('MemoryIndexList', {}), []);
  });

test('extractor rejects oversized selections without silent clipping or model calls', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  f.sessions.set('chat-a', [{ id: 'large', type: 'user', text: 'x'.repeat(20000) }]);
  const range = await f.invoke('MemoryRange', {});
  const result = await f.invoke('MemoryExtract', {
    to: range.to,
    requirements: 'Extract',
    maxInputChars: 1000,
  });
  assert.equal(result.status, 'input_too_large');
  assert.equal(result.selection.includedMessages, 2);
  assert.equal(f.llmCalls.length, 0);
  assert.equal(f.workers.size, 0);
});

test('extractor respects immutable delta, explicit filters and remaining input', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  const before = await f.invoke('MemoryRange', {});
  f.sessions
    .get('chat-a')!
    .push(
      { id: 'new-user', type: 'user', text: 'new requirement' },
      { id: 'new-tool', type: 'tool', text: 'execution data' },
    );
  const after = await f.invoke('MemoryRange', {});
  const result = await f.invoke('MemoryExtract', {
    from: before.to,
    to: after.to,
    recordIds: ['chat-a'],
    requirements: 'Extract all',
    limit: 1,
  });
  const sent = JSON.parse(f.llmCalls[0].prompt);
  assert.equal(sent.originals[0].message.id, 'new-user');
  assert.equal(result.selection.totalMatchingMessages, 2);
  assert.equal(result.selection.nextOffset, 1);
  const tools = await f.invoke('MemoryExtract', {
    from: before.to,
    to: after.to,
    recordIds: ['chat-a'],
    types: ['tool'],
    requirements: 'Extract tools',
  });
  assert.equal(tools.selection.includedMessages, 1);
  assert.equal(JSON.parse(f.llmCalls[1].prompt).originals[0].message.type, 'tool');
  const empty = await f.invoke('MemoryExtract', {
    to: before.to,
    types: ['tool'],
    requirements: 'Extract',
  });
  assert.equal(empty.status, 'empty');
  assert.equal(f.llmCalls.length, 2);
});

test('extractor identifies output truncation and invented citations', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  const range = await f.invoke('MemoryRange', {});
  f.setExtractRunner(async () => ({
    text: '[bad](memory-original:invented:0)',
    modelId: 'fixture',
    finishReason: 'length',
  }));
  const cut = await f.invoke('MemoryExtract', { to: range.to, requirements: 'Extract' });
  assert.equal(cut.status, 'truncated');
  assert.deepEqual(cut.unknownRefs, ['invented:0']);
  f.setExtractRunner(async () => ({
    text: '[bad](memory-original:invented:0)',
    modelId: 'fixture',
    finishReason: 'stop',
  }));
  assert.equal(
    (await f.invoke('MemoryExtract', { to: range.to, requirements: 'Extract' })).status,
    'needs_review',
  );
  assert.deepEqual(await f.invoke('MemoryIndexList', {}), []);
});

test('extractor rechecks visibility after generation and saves no result on revocation', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  const range = await f.invoke('MemoryRange', {});
  f.setExtractRunner(async () => {
    f.setIncognito(true);
    return { text: 'private result', modelId: 'fixture', finishReason: 'stop' };
  });
  await assert.rejects(
    f.invoke('MemoryExtract', { to: range.to, requirements: 'Extract' }),
    /Incognito/,
  );
  await assert.rejects(readdir(join(f.root, 'data', 'extractions')), /ENOENT/);
});

test('extractor has no fixed deadline; caller cancellation settles even if provider ignores signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store: any = {
    history: () => ({
      total: 1,
      nextOffset: null,
      items: [{ ref: 'a:0', message: { id: 'a', text: 'original' } }],
    }),
  };
  let observed: AbortSignal;
  let started!: () => void;
  const generating = new Promise<void>((resolve) => {
    started = resolve;
  });
  const ctx = {
    sessionQuery: {},
    llm: {
      generate: (input: any) => {
        observed = input.signal;
        started();
        return new Promise(() => {});
      },
    },
  };
  const input = { from: null, to: 'cursor', requirements: 'Extract', maxInputChars: 400000 };
  const abort = new AbortController();
  const pending = extractHistory(ctx, store, '/unused', async () => [], input, {
    abortSignal: abort.signal,
  });
  await generating;
  t.mock.timers.tick(30 * 60 * 1000);
  assert.equal(observed!.aborted, false, 'long extraction must not hit a local deadline');
  abort.abort(new Error('User stopped'));
  await assert.rejects(pending, /User stopped/);
});
