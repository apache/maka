import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  duplicatePlanReminderTitle,
  formatReminderCountdown,
  planReminderFormValidation,
  planReminderTemplateSeed,
} from '../plan-reminder-helpers.js';
import { getPlanReminderCopy } from '../plan-reminder-copy.js';

describe('plan reminder localization', () => {
  it('provides coherent page copy in both locales', () => {
    assert.equal(getPlanReminderCopy('zh').page.title, '定时任务');
    assert.equal(getPlanReminderCopy('en').page.title, 'Scheduled tasks');
  });

  it('formats validation, duplication, and countdowns with the resolved locale', () => {
    const input = {
      title: '',
      parsedRunAt: Date.now() + 60_000,
      recurrence: 'none' as const,
      cronExpression: '',
      delivery: { channel: 'local' as const },
      now: Date.now(),
    };
    assert.deepEqual(
      planReminderFormValidation(input, 'zh'),
      { field: 'title', message: '填写标题后才能保存提醒。' },
    );
    assert.deepEqual(
      planReminderFormValidation(input, 'en'),
      { field: 'title', message: 'Add a title before saving this reminder.' },
    );
    assert.deepEqual(
      planReminderFormValidation({
        ...input,
        title: 'Review',
        recurrence: 'cron',
        cronExpression: 'invalid',
      }, 'en'),
      {
        field: 'cron',
        message: 'Cron expressions need five fields, for example 0 9 * * 1-5.',
      },
    );
    assert.deepEqual(
      planReminderFormValidation({
        ...input,
        title: 'Review',
        parsedRunAt: Number.NaN,
      }, 'zh'),
      { field: 'time', message: '选择有效的提醒时间。' },
    );
    assert.deepEqual(
      planReminderFormValidation({
        ...input,
        title: 'Review',
        parsedRunAt: input.now - 1,
      }, 'zh'),
      { field: 'time', message: '提醒时间必须晚于当前时间。' },
    );
    assert.deepEqual(
      planReminderFormValidation({
        ...input,
        title: 'Review',
        delivery: { channel: 'bot', platform: 'telegram', chatId: '' },
      }, 'en'),
      {
        field: 'chatId',
        message: 'Enter a Chat ID when delivering to a bot chat.',
      },
    );
    assert.equal(duplicatePlanReminderTitle('Review', 'en'), 'Review copy');
    assert.equal(formatReminderCountdown(120_000, 'en', 0), 'in 2 minutes');
    assert.equal(formatReminderCountdown(120_000, 'zh', 0), '2 分钟后');
  });

  it('prefills a localized template into the existing create form seed', () => {
    const now = new Date(2026, 6, 25, 10, 0).getTime();
    const template = getPlanReminderCopy('zh').templates.find(({ id }) => id === 'daily-news-brief');

    assert.ok(template);
    const seed = planReminderTemplateSeed(template, now);
    assert.match(
      seed.runAtLocal,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
      'local date-time values use the ISO minute shape',
    );
    const runAt = new Date(seed.runAtLocal);

    assert.equal(seed.editingId, null);
    assert.equal(seed.title, '每日新闻摘要');
    assert.match(seed.note, /科技 \/ AI \/ Maka/);
    assert.equal(seed.recurrence, 'cron');
    assert.equal(seed.cronExpression, '30 9 * * *');
    assert.equal(runAt.getHours(), 9);
    assert.equal(runAt.getMinutes(), 30);
    assert.ok(runAt.getTime() > now);
  });
});
