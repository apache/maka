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
import { describe, test } from 'node:test';
import { Editor, Text, TuiMainScreen } from '@earendil-works/pi-tui';
import {
  fitAutocompleteLines,
  MakaAutocompleteAboveEditorComponent,
} from '../tui-autocomplete-layout.js';
import { fitPendingQueueLines } from '../pi-tui-layout.js';
import { editorTheme } from '../tui-ansi.js';
import { FakeTerminal } from './tui-terminal-mock.js';

const REVERSE_ON = '\x1b[7m';
const CYAN_FOREGROUND = '\x1b[36m';
const RESET_FOREGROUND = '\x1b[39m';

test('an overlay hides the composer cursor, preserves its draft and colors, and restores focus', (t) => {
  const terminal = new FakeTerminal();
  const tui = new TuiMainScreen(terminal);
  t.after(() => tui.stop());
  const editor = new Editor(tui, {
    ...editorTheme(),
    // Emit color even under NO_COLOR so the test can detect accidental style loss.
    borderColor: (text) => `${CYAN_FOREGROUND}${text}${RESET_FOREGROUND}`,
  });
  editor.setText('draft');
  const composer = new MakaAutocompleteAboveEditorComponent(editor);
  tui.addChild(composer);
  tui.setFocus(composer);
  const renderScreen = () => {
    terminal.writes.length = 0;
    tui.renderNow(true);
    return terminal.output();
  };

  assert.ok(renderScreen().includes(REVERSE_ON));
  const overlay = tui.showOverlay(new Text('Picker', 0, 0), { anchor: 'top-left' });
  const screen = renderScreen();
  assert.ok(screen.includes('Picker'));
  assert.ok(screen.includes('draft'));
  assert.ok(screen.includes(CYAN_FOREGROUND), 'unfocused editor borders must keep their color');
  assert.ok(!screen.includes(REVERSE_ON), 'the inactive composer must not show a block cursor');
  overlay.hide();
  assert.ok(renderScreen().includes(REVERSE_ON));
});

describe('fitAutocompleteLines', () => {
  test('keeps the selected item visible and reports the full command count', () => {
    const commands = Array.from(
      { length: 18 },
      (_, index) => `${index === 0 ? '→' : ' '} /command-${index + 1}`,
    );

    assert.deepEqual(fitAutocompleteLines(commands, 16), [...commands.slice(0, 15), '  (1/18)']);
  });

  test('moves the fitted window with a selection near the end', () => {
    const commands = Array.from(
      { length: 18 },
      (_, index) => `${index === 17 ? '→' : ' '} /command-${index + 1}`,
    );

    assert.deepEqual(fitAutocompleteLines(commands, 6), [...commands.slice(13), '  (18/18)']);
  });

  test('preserves an upstream picker position when fitting an already-windowed list', () => {
    const window = [
      '  /command-18',
      '  /command-19',
      '→ /command-20',
      '  /command-21',
      '  /command-22',
      '  (20/30)',
    ];

    assert.deepEqual(fitAutocompleteLines(window, 4), [
      '  /command-19',
      '→ /command-20',
      '  /command-21',
      '  (20/30)',
    ]);
  });

  test('uses the selected row when only one autocomplete row fits', () => {
    assert.deepEqual(fitAutocompleteLines(['  /one', '→ /two', '  /three'], 1), ['→ /two']);
  });
});

describe('fitPendingQueueLines', () => {
  test('summarizes overflow after preserving the visible pending rows', () => {
    const pending = Array.from({ length: 15 }, (_, index) => `Queued: message ${index + 1}`);

    assert.deepEqual(fitPendingQueueLines(pending, 3), [
      'Queued: message 1',
      'Queued: message 2',
      '… 13 more',
    ]);
  });

  test('uses the only available row as an overflow summary', () => {
    assert.deepEqual(fitPendingQueueLines(['Queued: one', 'Queued: two'], 1), ['… 2 more']);
  });
});
