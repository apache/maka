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
import { it } from 'node:test';

import {
  encodeTerminalInputActions,
  encodedTerminalInputActionsByteLength,
  formatTerminalInputActions,
  type TerminalInputNamedKey,
} from '../terminal-input.js';

const NORMAL_NAMED_KEYS = {
  enter: '\r',
  escape: '\u001b',
  tab: '\t',
  backspace: '\u007f',
  delete: '\u001b[3~',
  arrow_up: '\u001b[A',
  arrow_down: '\u001b[B',
  arrow_left: '\u001b[D',
  arrow_right: '\u001b[C',
  home: '\u001b[H',
  end: '\u001b[F',
  insert: '\u001b[2~',
  page_up: '\u001b[5~',
  page_down: '\u001b[6~',
  f1: '\u001bOP',
  f2: '\u001bOQ',
  f3: '\u001bOR',
  f4: '\u001bOS',
  f5: '\u001b[15~',
  f6: '\u001b[17~',
  f7: '\u001b[18~',
  f8: '\u001b[19~',
  f9: '\u001b[20~',
  f10: '\u001b[21~',
  f11: '\u001b[23~',
  f12: '\u001b[24~',
} as const satisfies Record<TerminalInputNamedKey, string>;

it('encodes an ordered terminal prefix sequence atomically', () => {
  const actions = [
    { type: 'key' as const, key: 'b', modifiers: ['ctrl' as const] },
    { type: 'text' as const, text: 'c' },
  ];

  assert.equal(
    encodeTerminalInputActions(actions, { applicationCursorKeysMode: false }),
    '\u0002c',
  );
  assert.equal(formatTerminalInputActions(actions), 'Ctrl-B → "c"');
});

it('encodes cursor keys from the terminal mode active at the input cut', () => {
  const actions = [{ type: 'key' as const, key: 'arrow_up' }];

  assert.equal(
    encodeTerminalInputActions(actions, { applicationCursorKeysMode: false }),
    '\u001b[A',
  );
  assert.equal(
    encodeTerminalInputActions(actions, { applicationCursorKeysMode: true }),
    '\u001bOA',
  );
});

it('encodes every named key and xterm modifier family', () => {
  for (const [key, expected] of Object.entries(NORMAL_NAMED_KEYS)) {
    assert.equal(
      encodeTerminalInputActions([{ type: 'key', key }], {
        applicationCursorKeysMode: false,
      }),
      expected,
      key,
    );
  }

  const modified = [
    [{ type: 'key' as const, key: 'tab', modifiers: ['shift' as const] }, '\u001b[Z'],
    [{ type: 'key' as const, key: 'arrow_left', modifiers: ['ctrl' as const] }, '\u001b[1;5D'],
    [{ type: 'key' as const, key: 'delete', modifiers: ['alt' as const] }, '\u001b[3;3~'],
    [{ type: 'key' as const, key: 'f2', modifiers: ['shift' as const] }, '\u001b[1;2Q'],
    [
      {
        type: 'key' as const,
        key: 'arrow_up',
        modifiers: ['ctrl' as const, 'alt' as const, 'shift' as const],
      },
      '\u001b[1;8A',
    ],
    [{ type: 'key' as const, key: 'x', modifiers: ['alt' as const] }, '\u001bx'],
    [{ type: 'key' as const, key: '?', modifiers: ['ctrl' as const] }, '\u007f'],
  ] as const;
  for (const [action, expected] of modified) {
    assert.equal(
      encodeTerminalInputActions([action], { applicationCursorKeysMode: false }),
      expected,
    );
  }
});

it('rejects character chords without a portable terminal encoding', () => {
  assert.throws(
    () =>
      encodeTerminalInputActions([{ type: 'key', key: '1', modifiers: ['ctrl'] }], {
        applicationCursorKeysMode: false,
      }),
    /no portable terminal encoding/,
  );
});

it('encodes SGR cell mouse actions from live terminal state', () => {
  const state = {
    applicationCursorKeysMode: false,
    mouseTrackingMode: 'any' as const,
    mouseEncoding: 'sgr' as const,
    cols: 80,
    rows: 24,
  };
  const actions = [
    { type: 'mouse' as const, event: 'click' as const, button: 'left' as const, x: 2, y: 3 },
    {
      type: 'mouse' as const,
      event: 'move' as const,
      button: 'right' as const,
      x: 4,
      y: 5,
      modifiers: ['ctrl' as const],
    },
    { type: 'mouse' as const, event: 'scroll' as const, direction: 'down' as const, x: 6, y: 7 },
  ];

  const encoded = encodeTerminalInputActions(actions, state);
  assert.equal(encoded, '\u001b[<0;3;4M\u001b[<0;3;4m\u001b[<50;5;6M\u001b[<65;7;8M');
  assert.equal(encodedTerminalInputActionsByteLength(actions), Buffer.byteLength(encoded));
  assert.equal(
    formatTerminalInputActions(actions),
    'Click Left @ (2, 3) → Ctrl-Move Right @ (4, 5) → ScrollDown @ (6, 7)',
  );
});

it('rejects mouse input outside the application protocol and viewport', () => {
  const click = [
    { type: 'mouse' as const, event: 'click' as const, button: 'left' as const, x: 2, y: 3 },
  ];
  const state = {
    applicationCursorKeysMode: false,
    mouseTrackingMode: 'any' as const,
    mouseEncoding: 'sgr' as const,
    cols: 80,
    rows: 24,
  };

  assert.throws(
    () => encodeTerminalInputActions(click, { ...state, mouseTrackingMode: 'none' }),
    /has not enabled mouse tracking/,
  );
  assert.throws(
    () => encodeTerminalInputActions(click, { ...state, mouseEncoding: 'sgr_pixels' }),
    /has not enabled SGR cell mouse reporting/,
  );
  assert.throws(() => encodeTerminalInputActions(click, { ...state, cols: 2 }), /outside 2x24/);
});
