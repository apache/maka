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
import type { TUI } from '@earendil-works/pi-tui';
import { MakaSkillHighlightEditor } from '../skill-highlight-editor.js';

const undo = '\x1f';
const plain = (text: string) => text;
function createEditor() {
  return new MakaSkillHighlightEditor({ requestRender() {} } as TUI, {
    borderColor: plain,
    selectList: {
      selectedPrefix: plain,
      selectedText: plain,
      description: plain,
      scrollInfo: plain,
      noMatch: plain,
    },
  });
}
function paste(editor: MakaSkillHighlightEditor, text: string) {
  editor.handleInput(`\x1b[200~${text}\x1b[201~`);
}

test('editor undo independently restores multiline state and cursor across further edits', () => {
  const editor = createEditor();
  paste(editor, 'alpha\nbeta');
  const cursor = editor.getCursor();
  editor.insertTextAtCursor('\ngamma');
  editor.handleInput('x');
  editor.handleInput(undo);
  assert.deepEqual(editor.getLines(), ['alpha', 'beta', 'gamma']);
  editor.handleInput(undo);
  assert.deepEqual(editor.getLines(), ['alpha', 'beta']);
  assert.deepEqual(editor.getCursor(), cursor);
  editor.handleInput('\x01'); // Start of second line.
  editor.handleInput('\x7f'); // Merge lines, mutating the live lines array.
  assert.equal(editor.getText(), 'alphabeta');
  editor.handleInput(undo);
  assert.deepEqual(editor.getLines(), ['alpha', 'beta']);
  assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
  editor.handleInput(undo);
  assert.equal(editor.getText(), '');
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
});

test('undo restores deleted and renumbered pastes, and submission clears snapshots', () => {
  const editor = createEditor();
  const first = 'a'.repeat(1200);
  const second = 'b'.repeat(1300);
  const third = 'c'.repeat(1400);
  paste(editor, first);
  paste(editor, second);
  const bothMarkers = editor.getText();
  editor.handleInput('\x01');
  editor.handleInput('\x1b[C'); // Move over the first atomic paste marker.
  const cursor = editor.getCursor();
  editor.handleInput('\x7f');
  assert.equal(editor.getText(), '[paste #1 1300 chars]');
  assert.equal(editor.getExpandedText(), second);
  editor.handleInput(undo);
  assert.equal(editor.getText(), bothMarkers);
  assert.equal(editor.getExpandedText(), first + second);
  assert.deepEqual(editor.getCursor(), cursor);
  editor.handleInput('\x05');
  paste(editor, third);
  assert.match(editor.getText(), /\[paste #3 1400 chars\]$/);
  assert.equal(editor.getExpandedText(), first + second + third);
  editor.handleInput(undo);
  assert.equal(editor.getExpandedText(), first + second);
  // Another mutation after restoring a snapshot must not alter older maps.
  editor.handleInput('\x7f');
  assert.equal(editor.getExpandedText(), first);
  editor.handleInput(undo);
  assert.equal(editor.getExpandedText(), first + second);
  editor.handleInput(undo);
  assert.equal(editor.getExpandedText(), first);
  paste(editor, third);
  assert.match(editor.getText(), /\[paste #2 1400 chars\]$/);
  let submitted = '';
  editor.onSubmit = (text) => {
    submitted = text;
  };
  editor.handleInput('\r');
  assert.equal(submitted, first + third);
  editor.handleInput(undo);
  assert.equal(editor.getExpandedText(), '');
  paste(editor, second);
  assert.equal(editor.getText(), '[paste #1 1300 chars]');
  editor.handleInput(undo);
  assert.equal(editor.getExpandedText(), '');
});

test('ordinary typing after a large paste retains one payload, with all undo steps available', (t) => {
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '--eval',
      `(${probe.toString()})(${JSON.stringify(new URL('../skill-highlight-editor.js', import.meta.url).href)})`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /all 60 words undone/);
  t.diagnostic(result.stdout.trim());
});

async function probe(editorUrl: string) {
  const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
  const { randomBytes, createHash } = await import('node:crypto');
  const { MakaSkillHighlightEditor }: typeof import('../skill-highlight-editor.js') = await import(
    editorUrl
  );
  const plain = (text: string) => text;
  const editor = new MakaSkillHighlightEditor({ requestRender() {} } as TUI, {
    borderColor: plain,
    selectList: {
      selectedPrefix: plain,
      selectedText: plain,
      description: plain,
      scrollInfo: plain,
      noMatch: plain,
    },
  });
  assert.ok(global.gc);
  const gc = global.gc;
  const heap = () => {
    gc();
    return process.memoryUsage().heapUsed;
  };
  const baseline = heap();
  const payload = randomBytes(512 * 1024).toString('hex');
  const digest = createHash('sha256').update(payload).digest('hex');
  editor.handleInput(`\x1b[200~${payload}\x1b[201~`);
  const pasted = heap();
  const samples = [pasted];
  for (let word = 1; word <= 60; word++) {
    editor.handleInput(' ');
    editor.handleInput('x');
    if (word % 20 === 0) samples.push(heap());
  }
  const edited = heap();
  for (let word = 60; word > 0; word--) {
    assert.equal(editor.getText(), `[paste #1 1048576 chars]${' x'.repeat(word)}`);
    editor.handleInput('\x1f');
  }
  assert.equal(editor.getText(), '[paste #1 1048576 chars]');
  assert.equal(createHash('sha256').update(editor.getExpandedText()).digest('hex'), digest);
  const undone = heap();
  let submittedDigest = '';
  editor.onSubmit = (text) => {
    submittedDigest = createHash('sha256').update(text).digest('hex');
  };
  editor.handleInput('\r');
  assert.equal(submittedDigest, digest);
  editor.handleInput('\x1f');
  assert.equal(editor.getExpandedText(), '');
  const submitted = heap();
  console.log(JSON.stringify({ baseline, samples, edited, undone, submitted }));
  // 60 copies cost ~60 MiB before the fix. Allow ample GC/platform variance,
  // but never allow retained storage proportional to payload size per word.
  assert.ok(edited - pasted < 12 * 1024 * 1024, 'undo snapshots duplicated the 1 MiB paste');
  console.log('all 60 words undone');
}
