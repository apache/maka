import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { PlanReminder } from '@maka/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '../locale-context.js';
import { PlanReminderPanel } from '../plan-reminder-panel.js';
import { ToastProvider } from '../toast.js';

const NOW = Date.UTC(2026, 6, 26, 8);

function reminder(
  overrides: Partial<PlanReminder> & Pick<PlanReminder, 'id' | 'title'>,
): PlanReminder {
  return {
    note: '',
    schedule: { kind: 'recurring', startAt: NOW, recurrence: 'daily' },
    delivery: { channel: 'local' },
    status: 'scheduled',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    nextRunAt: NOW + 86_400_000,
    runs: [],
    runCount: 0,
    ...overrides,
  };
}

function render(reminders: PlanReminder[], keepSystemAwake = false): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="zh">
      <ToastProvider>
        <PlanReminderPanel
          reminders={reminders}
          keepSystemAwake={keepSystemAwake}
          onKeepSystemAwakeChange={async () => {}}
        />
      </ToastProvider>
    </LocaleProvider>,
  );
}

describe('Plan Reminder scanning hierarchy', () => {
  it('keeps normal scheduled reminders focused on identity and the next event', () => {
    const markup = render([
      reminder({
        id: 'scheduled',
        title: '每周发布风险复盘',
        note: '聚合本周未解决的发布风险项。',
        schedule: { kind: 'recurring', startAt: NOW, recurrence: 'weekly' },
        nextRunAt: NOW + 2 * 86_400_000,
      }),
    ]);

    assert.match(markup, /每周发布风险复盘/);
    assert.match(markup, /重复：每周/);
    assert.match(markup, /下次触发：/);
    assert.doesNotMatch(markup, /lucide-repeat|lucide-clock/);
    assert.doesNotMatch(markup, />待触发</);
    assert.doesNotMatch(markup, /尚未执行/);
  });

  it('uses view labels without repeating collection counts in the tabs', () => {
    const markup = render([]);

    assert.match(markup, />我的定时任务</);
    assert.match(markup, />执行记录</);
    assert.doesNotMatch(markup, /我的定时任务<span>/);
    assert.doesNotMatch(markup, /执行记录<span>/);
  });

  it('keeps the keep-awake state inside page settings instead of the page header', () => {
    const markup = render([], true);

    assert.doesNotMatch(markup, /保持唤醒已开启/);
    assert.match(markup, /aria-label="定时任务页面设置"/);
  });

  it('shows exceptional lifecycle and run states once instead of repeating normal state', () => {
    const markup = render([
      reminder({
        id: 'completed',
        title: '发布日提醒',
        schedule: { kind: 'once', runAt: NOW - 60_000 },
        status: 'completed',
        enabled: false,
        updatedAt: NOW - 60_000,
        nextRunAt: undefined,
        lastRun: {
          id: 'run-completed',
          at: NOW - 60_000,
          status: 'triggered',
          message: '已发送。',
        },
        runCount: 1,
      }),
      reminder({
        id: 'failed',
        title: '发送每日客户反馈摘要',
        lastRun: {
          id: 'run-failed',
          at: NOW - 60_000,
          status: 'failed',
          message: '投递目标不可用。',
        },
        runCount: 1,
      }),
    ]);

    assert.equal(markup.match(/>已完成</g)?.length, 1);
    assert.equal(markup.match(/>失败</g)?.length, 1);
    assert.match(markup, /投递目标不可用。/);
    assert.doesNotMatch(markup, /maka-capability-audit-strip/);
  });
});
