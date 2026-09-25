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

// The test replaces only this label when installing independent packages.
const title = '__ACCEPTANCE_TITLE__';

export default async function activate(ctx) {
  const { tui } = ctx;
  let mode = 'good';
  let reads = 0;
  let entered = 0;
  // UI cancellation is observed through document/source cleanup, not a UI write.
  const cancelled = 0;
  let submissions = 0;
  let revision = 1;
  let arm = 0;
  let marked = false;
  const markEntered = async (callback) => {
    if (marked) return;
    marked = true;
    await ctx.storage.batch([
      {
        key: `acceptance/entered/${arm}`,
        expectedRevision: null,
        data: { kind: 'present', value: { arm, mode, callback } },
      },
    ]);
  };
  const key = { turn: 'retained', message: 'history', part: 'text' };
  const content = Array.from(
    { length: 60 },
    (_, index) => `Retained record ${String(index).padStart(3, '0')} — 中文 🚀`,
  ).join('  \n');
  const transcript = await tui.transcriptResource('history', {
    blocks: [{ key, revision: '1', kind: 'assistant', content: { text: content } }],
  });
  ctx.effect(() => transcript.close());
  const changed = await tui.changes('changed');
  const stats = () => ({ arm, mode, reads, entered, cancelled, submissions, ...transcript.stats });
  await ctx.remote.method('ping', () => ({ title, alive: true }));
  await ctx.remote.method('stats', stats);
  await ctx.remote.method('control', async (input) => {
    arm++;
    marked = false;
    mode = String(input.mode);
    if (mode === 'overflow') {
      await markEntered('control');
      // One synchronous burst prevents a slow consumer from draining the bounded
      // SDK queue. Replacing one small block keeps producer storage bounded.
      for (let index = 0; index < 9000; index++) {
        transcript.replace({
          key,
          revision: String(++revision),
          kind: 'assistant',
          content: { text: `${content}\nBurst ${index}` },
        });
      }
    } else if (input.refresh) changed();
    return stats();
  });
  await tui.app(
    'panel',
    {
      entry: 'faults-ui.mjs',
      resources: [transcript.resource],
      async backend(request) {
        if (request.kind === 'read') {
          reads++;
          if (!['good', 'runaway_submit', 'overflow'].includes(mode)) {
            entered++;
            await markEntered('read');
          }
          return { title, mode, history: transcript.resource };
        }
        if (request.kind !== 'submit') return { kind: 'unrecorded' };
        submissions++;
        await markEntered('submit');
        return { kind: 'rejected', message: 'Acceptance action has no writes' };
      },
    },
    { title: { fallback: title, translations: {} }, context: 'application', changes: 'changed' },
  );
}
