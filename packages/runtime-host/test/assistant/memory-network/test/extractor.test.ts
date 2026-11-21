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
import { extractHistory } from '../../../../src/assistant/memory-network/extractor.js';

test(`extractor native: bulk single call, exact receipt, no index mutation`, async (t) => {
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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
  const f = await fixture();
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

test('master disable aborts an in-flight extractor before closing its database', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const range = await f.invoke('MemoryRange', {});
  let began!: () => void;
  const generating = new Promise<void>((r) => (began = r));
  f.setExtractRunner(async () => {
    began();
    return new Promise(() => {});
  });
  const pending = f.invoke('MemoryExtract', { to: range.to, requirements: 'Extract' });
  const rejected = assert.rejects(pending, /disabled/);
  await generating;
  await f.remote('assistant.set-enabled', { enabled: false });
  await rejected;
  assert.deepEqual(await f.remote('assistant.enablement'), { enabled: false });
  await assert.rejects(readdir(join(f.root, 'data', 'extractions')), /ENOENT/);
});

test('extractor accepts queried fixed-version refs without a history cursor or source scan', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  let scans = 0,
    revision = '1';
  const body = 'noise'.repeat(30000) + '最终状态：已停用';
  f.sources.register({
    id: 'logs',
    description: 'logs',
    queryHelp: 'text',
    scope: { account: 'one' },
    enumerate: async () => {
      scans++;
      throw Error('No scan expected');
    },
    query: async () => ({ items: [{ id: 'log', revision, kind: 'log', locator: {} }] }),
    authorize: async (items: any[]) => items.map((x) => x.id),
    read: async (object: any) => ({
      status: 'ok',
      object,
      content: revision === '1' ? body : 'changed',
    }),
  });
  const found = await f.invoke('MemorySourceQuery', {
    source: 'logs',
    query: { text: '已停用' },
    view: 'content',
  });
  const ref = found.items[0].ref;
  assert.ok(found.items[0].matches[0].text.includes('已停用'));
  revision = '2';
  f.setExtractRunner(async (input) => {
    const p = JSON.parse(input.prompt);
    assert.equal(p.originals.length, 1);
    assert.equal(p.originals[0].content, body);
    assert.equal(p.originals[0].object.revision, '1');
    assert.equal(input.boundedInput, true);
    return { text: p.originals[0].citation + ' 已停用', modelId: 'fixture' };
  });
  const result = await f.invoke('MemoryExtract', { refs: [ref, ref], requirements: '当前状态' });
  assert.equal(result.status, 'generated');
  assert.equal(scans, 0);
  assert.equal(result.selection.includedMessages, 1);
  assert.equal(result.selection.nextOffset, null);
  assert.ok((await readFile(result.path, 'utf8')).includes('已停用'));
  await assert.rejects(
    f.invoke('MemoryExtract', { refs: [ref], to: 'made-up', requirements: 'x' }),
    /exactly one/,
  );
  await assert.rejects(
    f.invoke('MemoryExtract', { refs: [ref], types: ['user'], requirements: 'x' }),
    /do not mix/,
  );
});

test('extractor rejects invented history cursors with actionable recovery and no model call', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (const field of ['to', 'from']) {
    const to = (await f.invoke('MemoryRange', {})).to;
    const result = await f.invoke('MemoryExtract', {
      to,
      [field]: 'icloud-evidence',
      requirements: 'Extract',
    });
    assert.equal(result.status, 'invalid_cursor');
    assert.equal(result.field, field);
    assert.equal(result.modelCalled, false);
    assert.match(result.message, /MemoryRange.to/);
    assert.match(result.message, /refs/);
  }
  assert.equal(f.llmCalls.length, 0);
});

test('ref extraction rechecks external permissions and scope after generation', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  let allowed = true,
    scope = 1;
  f.sources.register({
    id: 'external',
    description: 'external',
    queryHelp: '',
    get scope() {
      return { version: scope };
    },
    enumerate: async () => ({ items: [] }),
    query: async () => ({ items: [{ id: 'm', revision: '1', kind: 'message', locator: {} }] }),
    authorize: async (items: any[]) => (allowed ? items.map((x) => x.id) : []),
    read: async (object: any) => ({ status: 'ok', object, content: 'original' }),
  });
  const ref = (await f.invoke('MemorySourceQuery', { source: 'external' })).items[0].ref;
  for (const change of [
    () => {
      allowed = false;
    },
    () => {
      scope++;
    },
  ]) {
    allowed = true;
    f.setExtractRunner(async () => {
      change();
      return { text: 'private result', modelId: 'fixture' };
    });
    await assert.rejects(
      f.invoke('MemoryExtract', { refs: [ref], requirements: 'Extract' }),
      /permission|scope|visible|access/i,
    );
  }
  await assert.rejects(readdir(join(f.root, 'data', 'extractions')), /ENOENT/);
});

test('ref extraction supports local originals and fails explicitly on missing refs', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const range = await f.invoke('MemoryRange', {});
  const history = await f.invoke('MemoryHistory', { to: range.to, mode: 'messages' });
  const result = await f.invoke('MemoryExtract', {
    refs: [history.items[0].ref],
    requirements: 'Extract',
  });
  assert.equal(result.status, 'generated');
  assert.ok(JSON.parse(f.llmCalls[0].prompt).originals[0].message);
  await assert.rejects(
    f.invoke('MemoryExtract', { refs: ['missing'], requirements: 'Extract' }),
    /Unknown original ref/,
  );
  assert.equal(f.llmCalls.length, 1);
});

test('extractor uses the selected model capacity, not only a character limit', async () => {
  let called = false;
  const result = await extractHistory(
    {
      sessionQuery: {},
      llm: {
        budget: async () => ({ modelId: 'small', maxInputTokens: 100, maxOutputTokens: 256 }),
        generate: async () => {
          called = true;
          throw Error('must not call');
        },
      },
    },
    {} as any,
    '/unused',
    async () => [],
    {
      refs: ['ref'],
      requirements: 'Extract',
      maxInputChars: 2000000,
      maxOutputTokens: 256,
    },
    {},
    undefined,
    async () => ({
      items: [{ ref: 'ref', content: 'large original'.repeat(1000) }],
      total: 1,
      nextOffset: null,
    }),
  );
  assert.equal(result.status, 'input_too_large');
  assert.equal(result.budget.maxInputTokens, 100);
  assert.equal(result.modelCalled, false);
  assert.equal(called, false);
  assert.match(result.message, /No input was truncated/);
});

test('unavailable original never becomes a partial successful extraction', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  f.sources.register({
    id: 'unavailable',
    description: 'unavailable',
    queryHelp: '',
    scope: {},
    enumerate: async () => ({ items: [] }),
    query: async () => ({ items: [{ id: 'm', revision: '1', kind: 'message', locator: {} }] }),
    authorize: async (items: any[]) => items.map((x) => x.id),
    read: async () => ({ status: 'version_unavailable' }),
  });
  const ref = (await f.invoke('MemorySourceQuery', { source: 'unavailable' })).items[0].ref;
  await assert.rejects(
    f.invoke('MemoryExtract', { refs: [ref], requirements: 'Extract' }),
    /version_unavailable.*no extraction/,
  );
  assert.equal(f.llmCalls.length, 0);
});
