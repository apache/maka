import assert from 'node:assert/strict';
import { it } from 'node:test';

import { encodeTerminalInputActions, formatTerminalInputActions } from '../index.js';

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

it('rejects character chords without a portable terminal encoding', () => {
  assert.throws(
    () =>
      encodeTerminalInputActions([{ type: 'key', key: '1', modifiers: ['ctrl'] }], {
        applicationCursorKeysMode: false,
      }),
    /no portable terminal encoding/,
  );
});
