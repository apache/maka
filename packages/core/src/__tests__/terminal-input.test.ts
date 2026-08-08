import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  encodeTerminalInputActions,
  formatTerminalInputActions,
  type TerminalInputNamedKey,
} from '../index.js';

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
