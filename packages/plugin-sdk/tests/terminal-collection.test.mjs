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
import test from 'node:test';
import { fixture } from './terminal-transcript-harness.mjs';
import { presenter } from './terminal-presenter-harness.mjs';

test('an independent presenter declares a collection and forwards only its committed action fields', async () => {
  let received;
  const f = await fixture({}, async ({ tui }) =>
    tui.app(
      'tasks',
      {
        entry: 'tasks-ui.mjs',
        backend: (input) => {
          received = input;
          return { kind: 'applied', route: null };
        },
      },
      { title: { fallback: 'Tasks' }, context: 'application' },
    ),
  );
  const p = presenter(
    ({ tui }) => ({
      read: () => ({
        title: 'Tasks',
        revision: 'one',
        fields: ['item', 'group', 'before'].map((id) => tui.line(id, '', 128)),
        actions: [tui.action('move', 'Move', { fields: ['item', 'group', 'before'] })],
        root: tui.collection('tasks', {
          groups: [
            { key: 'todo', label: 'To do' },
            { key: 'done', label: 'Done' },
          ],
          items: [
            {
              key: 'a',
              group: 'todo',
              title: 'Alpha 中文',
              panel: tui.slot('detail', 'task.detail', { id: 'a' }),
            },
          ],
          filter: { label: 'Filter', placeholder: 'Filter tasks' },
          movement: {
            action: 'move',
            item_field: 'item',
            group_field: 'group',
            before_field: 'before',
          },
        }),
      }),
      submit: (_submission, cx) => cx.backend(),
    }),
    async (input) => (await f.invoke('tasks', input)).value,
  );
  const read = await p.invoke({ kind: 'read', route: null, locale: 'en' });
  assert.equal(read.view.version, 8);
  assert.equal(read.view.root.kind, 'collection');
  assert.equal(read.view.root.items[0].panel.context.id, 'a');
  const input = {
    kind: 'submit',
    route: null,
    revision: 'one',
    action: 'move',
    fields: { item: 'a', group: 'done', before: '' },
    grant: null,
    locale: 'en',
  };
  assert.equal((await p.invoke(input)).kind, 'applied');
  assert.deepEqual(JSON.parse(JSON.stringify(received)), input);
  await f.runtime.dispose();
});
