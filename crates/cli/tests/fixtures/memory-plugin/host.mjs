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

/** @param {import('../../../../../packages/plugin-sdk/src/host.js').HostContext} ctx */
export default async function activate(ctx) {
  const encoder = new TextEncoder();
  const previous = await ctx.storage.read('activations');
  const activations = Number(previous?.data.kind === 'present' ? previous.data.value : 0) + 1;
  await ctx.storage.batch([
    {
      key: 'activations',
      expectedRevision: previous?.revision ?? null,
      data: { kind: 'present', value: activations },
    },
  ]);
  /** @type {import('../../../../../packages/plugin-sdk/src/host.js').TranscriptBlock[]} */
  const blocks = Array.from({ length: 1000 }, (_, index) => {
    const id = String(index).padStart(4, '0');
    const lines = [
      `Memory block ${id} — 中文🦀`,
      'Unicode **progress**: 字符与字节分别计数。',
      'A bounded paragraph for the actual reader.',
      'Another logical line; terminal wrapping is a different count.',
      '```rust',
      `let block = ${index};`,
      '```',
      'The source retains Markdown and Unicode.',
      index === 999 ? '```text' : 'A closed fence precedes this paragraph.',
      `Memory end ${id}`,
    ];
    return {
      key: { turn: 'memory', message: id, part: 'text' },
      revision: '0',
      kind: 'assistant',
      content: { text: lines.join('\n') },
    };
  });
  const initialLogicalLines = blocks.reduce(
    (total, block) => total + block.content.text.split('\n').length,
    0,
  );
  const initialSourceBytes = encoder.encode(JSON.stringify(blocks)).length;
  const source = await ctx.tui.transcriptResource('memory-lines', { blocks });
  ctx.effect(() => source.close());
  const changed = await ctx.tui.changes('memory-changed');
  ctx.effect(() => changed.close());
  let viewReads = 0;
  let appends = 0;
  let appendedBytes = 0;
  let appendedLines = 0;
  await ctx.remote.method('memory-append', (input) => {
    if (
      typeof input !== 'number' ||
      !Number.isSafeInteger(input) ||
      input !== appends ||
      appends >= 300
    ) {
      throw new Error('Expected the next bounded append index');
    }
    const marker = `Memory update ${String(appends).padStart(3, '0')}`;
    const text = `\n${marker} — 中文🦀${appends === 299 ? '\n```\nStream complete.' : ''}`;
    source.append({ turn: 'memory', message: '0999', part: 'text' }, text, String(++appends));
    appendedBytes += encoder.encode(text).length;
    appendedLines += text.split('\n').length - 1;
    return { marker, bytes: encoder.encode(text).length };
  });
  await ctx.remote.method('memory-stats', () => ({
    ...source.stats,
    activations,
    viewReads,
    appends,
    appendedBytes,
    sourceBlocks: blocks.length,
    initialLogicalLines,
    initialSourceBytes,
    currentLogicalLines: initialLogicalLines + appendedLines,
  }));
  await ctx.tui.app(
    'memory',
    {
      entry: 'memory-ui.mjs',
      resources: [source.resource],
      async backend(input) {
        if (input.kind !== 'read') throw new Error('Memory page is read only');
        viewReads++;
        return { resource: source.resource };
      },
    },
    {
      title: {
        fallback: 'Memory lab',
        translations: { 'zh-CN': '内存测量', 'zh-TW': '記憶體測量' },
      },
      context: 'application',
      changes: 'memory-changed',
      icon: { glyph: '▤', ascii: 'M' },
    },
  );
}
