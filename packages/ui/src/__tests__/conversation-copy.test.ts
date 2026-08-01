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

  assert.equal(zh.status.running, '运行中');
  assert.equal(en.status.running, 'Running');
  assert.equal(zh.sandboxBlocked.title, '操作可能被沙箱阻止');
  assert.equal(en.sandboxBlocked.title, 'Operation may have been blocked by sandbox');
});

test('selectors accept only resolved UI locales', () => {
  const select = (locale: UiLocale) => getConversationCopy(locale).composer.sendLabel;
  assert.equal(select('zh'), '发送');
  assert.equal(select('en'), 'Send');
});
