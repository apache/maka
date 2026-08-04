import assert from 'node:assert/strict';
import test from 'node:test';
import type { UiLocale } from '@maka/core';
import { getConversationCopy } from '../conversation-copy.js';
import { getToolActivityCopy } from '../tool-activity/copy.js';

test('conversation catalogs are complete and independently selectable', () => {
  const zh = getConversationCopy('zh');
  const en = getConversationCopy('en');

  assert.equal(zh.composer.sendLabel, '发送');
  assert.equal(en.composer.sendLabel, 'Send');
  assert.equal(zh.sessions.status.running, '进行中');
  assert.equal(en.sessions.status.running, 'Running');
  assert.equal(zh.sessions.groupByTime, '按时间');
  assert.equal(en.sessions.groupByTime, 'By time');
  assert.notEqual(en.composer.placeholder, zh.composer.placeholder);
  assert.equal(zh.messages.editMessage, '编辑并重发');
  assert.equal(en.messages.editMessage, 'Edit & resend');
  assert.equal(zh.messages.editMessageDisabledAttachments, '包含附件的历史消息暂不支持编辑并重发');
  assert.equal(en.messages.editMessageDisabledAttachments, 'Edit & resend does not yet support messages with attachments');
  assert.equal(zh.messages.editMessageDisabledTransformedText, '通过显式技能发送的历史消息暂不支持编辑并重发');
  assert.equal(en.messages.editMessageDisabledTransformedText, 'Edit & resend does not yet support messages sent with an explicit skill');
});

test('tool catalogs are complete and independently selectable', () => {
  const zh = getToolActivityCopy('zh');
  const en = getToolActivityCopy('en');

  assert.equal(zh.status.interrupted, '已中断');
  assert.equal(en.status.interrupted, 'Interrupted');
  assert.equal(zh.sandboxBlocked.title, '操作可能被沙箱阻止');
  assert.equal(en.sandboxBlocked.title, 'Operation may have been blocked by sandbox');
});

test('selectors accept only resolved UI locales', () => {
  const select = (locale: UiLocale) => getConversationCopy(locale).composer.sendLabel;
  assert.equal(select('zh'), '发送');
  assert.equal(select('en'), 'Send');
});

test('thinking-level labels stay short single tokens (default / off / low…xhigh)', () => {
  const zh = getConversationCopy('zh').model;
  assert.equal(zh.defaultLevel, '默认');
  assert.deepEqual(zh.level, {
    off: '关',
    minimal: '最少',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最高',
  });
  // Guard against multi-character compound labels that force a wide popout
  // (e.g. “高等”, “Extra high”) on the content-sized thinking Selector.
  for (const label of Object.values(zh.level)) {
    assert.ok(label.length <= 2, `zh thinking label too long: ${label}`);
    assert.doesNotMatch(label, /等$/);
  }
  assert.equal(getConversationCopy('en').model.level.high, 'High');
  assert.equal(getConversationCopy('en').model.level.xhigh, 'Extra high');
});
