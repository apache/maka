import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseSideChatCommand,
} from '../../renderer/side-chat-command.js';

describe('side chat slash command', () => {
  it('matches only /side and preserves an optional multiline prompt', () => {
    assert.deepEqual(parseSideChatCommand('/side'), { prompt: '' });
    assert.deepEqual(parseSideChatCommand('  /side   inspect this\ncarefully  '), {
      prompt: 'inspect this\ncarefully',
    });
    assert.equal(parseSideChatCommand('/sidebar'), null);
    assert.equal(parseSideChatCommand('before /side'), null);
  });

});
