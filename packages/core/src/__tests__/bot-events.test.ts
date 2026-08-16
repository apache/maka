import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BOT_PLAINTEXT_HELP_COMMANDS,
  BOT_PLAINTEXT_RESET_COMMANDS,
  botConversationKey,
  botSourceEventKey,
  formatBotMessageForSession,
  isPlaintextHelpCommand,
  isPlaintextResetCommand,
  type BotMessageEvent,
} from '../bot-events.js';

describe('bot event contract', () => {
  const message: BotMessageEvent = {
    platform: 'telegram',
    userId: 'u1',
    userName: ' Alice\u0000 ',
    chatId: 'chat-1',
    isGroup: false,
    text: '  hello  ',
    sourceMessageId: 'm1',
    receivedAt: 1_700_000_000_000,
  };

  test('derives sanitized session text and stable keys', () => {
    assert.equal(botConversationKey(message), 'telegram:chat-1');
    assert.equal(botSourceEventKey(message), 'telegram:chat-1:m1');
    assert.equal(botSourceEventKey({ ...message, sourceMessageId: '   ' }), undefined);
    assert.equal(formatBotMessageForSession(message), '[Telegram:Alice] hello');
  });

  test('recognizes only exact plaintext commands in direct messages', () => {
    assert.equal(isPlaintextResetCommand({ isGroup: false, text: '  RESET  ' }), true);
    assert.equal(isPlaintextHelpCommand({ isGroup: false, text: '帮助' }), true);
    assert.equal(isPlaintextHelpCommand({ isGroup: true, text: 'help' }), false);
    assert.equal(isPlaintextHelpCommand({ isGroup: false, text: 'please help' }), false);
    assert.equal(isPlaintextHelpCommand({ isGroup: false, text: '   ' }), false);
    for (const phrase of BOT_PLAINTEXT_HELP_COMMANDS) {
      assert.equal(BOT_PLAINTEXT_RESET_COMMANDS.includes(phrase), false);
    }
  });
});
