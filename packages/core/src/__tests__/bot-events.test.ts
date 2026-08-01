import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BOT_PLAINTEXT_HELP_COMMANDS,
  BOT_PLAINTEXT_RESET_COMMANDS,
  botConversationKey,
  botDisplayLabel,
  botSourceEventKey,
  formatBotMessageForSession,
  humanizeBotStatusReason,
  isPlaintextHelpCommand,
  isPlaintextResetCommand,
  nonTextMessageAck,
  plaintextHelpReply,
  type BotAttachmentKind,
  type BotMessageEvent,
} from '../index.js';

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

  test('derives user-visible labels, session text, and stable keys', () => {
    assert.deepEqual(
      ['telegram', 'feishu', 'dingtalk'].map((platform) => botDisplayLabel(platform as never)),
      ['Telegram', '飞书', '钉钉'],
    );
    assert.equal(botConversationKey(message), 'telegram:chat-1');
    assert.equal(botSourceEventKey(message), 'telegram:chat-1:m1');
    assert.equal(botSourceEventKey({ ...message, sourceMessageId: '   ' }), undefined);
    assert.equal(formatBotMessageForSession(message), '[Telegram:Alice] hello');
  });

  test('recognizes only exact plaintext commands in direct messages', () => {
    const commandCases = [
      [isPlaintextResetCommand, BOT_PLAINTEXT_RESET_COMMANDS],
      [isPlaintextHelpCommand, BOT_PLAINTEXT_HELP_COMMANDS],
    ] as const;
    for (const [matches, commands] of commandCases) {
      for (const text of commands) assert.equal(matches({ isGroup: false, text }), true, text);
      assert.equal(matches({ isGroup: false, text: `  ${commands[0]!.toUpperCase()}  ` }), true);
      assert.equal(matches({ isGroup: true, text: commands[0]! }), false);
      assert.equal(matches({ isGroup: false, text: `please ${commands[0]}` }), false);
      assert.equal(matches({ isGroup: false, text: '   ' }), false);
    }
    for (const phrase of BOT_PLAINTEXT_HELP_COMMANDS) {
      assert.equal(BOT_PLAINTEXT_RESET_COMMANDS.includes(phrase), false);
    }
  });

  test('help copy exposes actionable commands without roadmap language', () => {
    const reply = plaintextHelpReply();
    assert.match(reply, /Maka 机器人帮助/);
    assert.match(reply, /restart/);
    assert.match(reply, /重置/);
    assert.equal(/即将|尚未|TODO|coming soon/i.test(reply), false);
  });

  test('humanizes known runtime reasons and preserves useful diagnostics', () => {
    const cases: Array<[string, RegExp]> = [
      ['rate-limited', /节流/],
      ['polling-timeout', /轮询超时/],
      ['send-failed', /发送失败/],
      ['get-me-failed', /凭据探测失败/],
      ['gateway-bot-401', /Gateway.*401/],
      ['gateway-closed-4004', /Gateway 连接关闭.*4004.*重连/],
      ['connections-open-503', /Stream 订阅打开失败.*503/],
      ['stream-closed-1006', /Stream 连接关闭.*1006.*重连/],
      ['send-failed-403', /发送失败.*403/],
      ['getAppAccessToken-401', /access_token.*401/],
    ];
    for (const [reason, expected] of cases)
      assert.match(humanizeBotStatusReason(reason)!, expected);
    assert.equal(humanizeBotStatusReason('  Unauthorized  '), 'Unauthorized');
    assert.equal(humanizeBotStatusReason('something-weird-42'), 'something-weird-42');
    assert.equal(humanizeBotStatusReason('A'.repeat(300)), 'A'.repeat(200));
  });

  test('does not manufacture errors for empty or non-error status reasons', () => {
    for (const reason of [
      undefined,
      '',
      '   ',
      'disabled',
      'stopped',
      'no-token',
      'scaffold-only',
      'unimplemented',
      'feishu-domain-required',
    ]) {
      assert.equal(humanizeBotStatusReason(reason), undefined);
    }
  });

  test('attachment acknowledgements describe current text-only behavior', () => {
    const expected: Array<[BotAttachmentKind, RegExp]> = [
      ['photo', /caption/],
      ['voice', /语音/],
      ['audio', /语音/],
      ['sticker', /贴纸/],
      ['video', /视频/],
      ['animation', /视频/],
      ['document', /附件文件/],
      ['unknown', /文字/],
    ];
    for (const [kind, pattern] of expected) {
      const reply = nonTextMessageAck(kind);
      assert.match(reply, pattern);
      assert.match(reply, /Maka/);
      assert.equal(/即将|尚未|TODO|coming soon|后续版本/i.test(reply), false);
    }
  });
});
