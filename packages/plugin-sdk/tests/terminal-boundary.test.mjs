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
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { presenter } from './terminal-presenter-harness.mjs';
import { fixture } from './terminal-transcript-harness.mjs';

test('ordinary JS app emits the same Boundary input and bottom action View as Rust', async () => {
  const expected = JSON.parse(
    await readFile(new URL('./fixtures/terminal-boundary.json', import.meta.url), 'utf8'),
  );
  let received;
  const f = await fixture({}, async ({ tui }) =>
    tui.app(
      'review',
      {
        entry: 'review-ui.mjs',
        backend: (input) => {
          received = JSON.parse(JSON.stringify(input));
          return { kind: 'applied', route: { saved: true } };
        },
      },
      { title: { fallback: 'Review' }, context: 'application' },
    ),
  );
  const p = presenter(
    ({ tui }) => ({
      read: () => ({
        title: 'Review',
        revision: 'r1',
        fields: [tui.area('note', 'Hello', 4096)],
        actions: [tui.action('save', 'Save', { fields: ['note'] })],
        root: tui.boundary('review', tui.input('note', 'note', 'Note'), {
          bottom: tui.row('meta', [
            tui.text('status', '中文 🦀', 'muted'),
            tui.button('save', 'save', 'primary'),
          ]),
          padding: { horizontal: 1 },
          emphasis: 'accent',
          activity: 'busy',
        }),
      }),
      submit: (_submission, cx) => cx.backend(),
    }),
    async (input) => {
      const result = await f.invoke('review', input);
      assert.equal(result.kind, 'value');
      return result.value;
    },
  );
  const descriptor = f.registrations.find((entry) => entry.name === 'review').terminalView;
  assert.equal(descriptor.version, 8);
  const read = await p.invoke({ kind: 'read', route: null, locale: 'en' });
  assert.deepEqual(JSON.parse(JSON.stringify(read)), { kind: 'view', view: expected });
  const fields = { note: 'Updated\n中文' };
  const written = await p.invoke({
    kind: 'submit',
    route: null,
    revision: 'r1',
    action: 'save',
    fields,
    grant: null,
    locale: 'en',
  });
  assert.equal(written.kind, 'applied');
  assert.deepEqual(received, {
    kind: 'submit',
    route: null,
    revision: 'r1',
    action: 'save',
    fields,
    grant: null,
    locale: 'en',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(f.tui.boundary('plain', f.tui.rule('body')))), {
    kind: 'boundary',
    key: 'plain',
    body: { kind: 'rule', key: 'body' },
    padding: { horizontal: 0, vertical: 0 },
    emphasis: 'normal',
    activity: 'idle',
  });
  await f.runtime.dispose();
});
