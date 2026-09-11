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
import { test } from 'node:test';
import { createMakaPiTranscriptState } from '../pi-transcript.js';
import {
  MakaPiLayoutComponent,
  MakaTranscriptComponent,
  MakaActivityStripComponent,
  MakaPendingQueueComponent,
} from '../pi-tui-layout.js';
import { FakeTerminal } from './tui-terminal-mock.js';

test('current Todo reserves one chrome row and yields to the minimum composer on short screens', () => {
  const terminal = new FakeTerminal();
  const state = createMakaPiTranscriptState();
  const metadata = () => ({
    title: 'Maka',
    cwd: '/repo',
    model: 'm',
    connectionSlug: 'c',
    permissionMode: 'bypass',
  });
  let viewport = 0;
  const editor = {
    invalidate() {},
    render: () => ['EDITOR'],
    setViewportRows(rows: number) {
      viewport = rows;
    },
    isShowingAutocomplete: () => false,
    minimumViewportRows: () => 3,
  };
  const layout = new MakaPiLayoutComponent(
    state,
    new MakaTranscriptComponent(state, metadata),
    new MakaActivityStripComponent(metadata),
    new MakaPendingQueueComponent(state, 'en'),
    editor,
    { invalidate() {}, render: () => ['STATUS'] },
    terminal,
    { invalidate() {}, render: () => ['TODO', 'MUST NOT RENDER'] },
  );
  terminal.rows = 10;
  const lines = layout.render(80);
  assert.deepEqual(lines.slice(-3), ['TODO', 'EDITOR', 'STATUS']);
  assert.equal(lines.includes('MUST NOT RENDER'), false);
  assert.equal(viewport, 7);
  terminal.rows = 5;
  assert.equal(layout.render(80).includes('TODO'), false);
  assert.equal(viewport, 3);
});
