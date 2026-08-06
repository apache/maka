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
    // One description line carries the whole schedule: recurrence, then the
    // next event. No icons, no separate "重复：" prefix — the row is text.
    const description = markup.match(/>(每周 · 下次触发：[^<]*)</)?.[1];
    assert.ok(description, 'expected one combined schedule line on the row');
    assert.doesNotMatch(description, /<svg|lucide-repeat|lucide-clock/);
    // Normal state stays on the StatusDot's accessible name, never as row text.
    assert.match(markup, /aria-label="待触发"/);
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

  // The page renders identically whether keep-awake is on or off — that is the
  // point of the assertion above — so the settings item is the only thing that
  // carries the state, and it is what a story could never have proven cheaply.
  it('reflects the persisted keep-awake state on the settings menu item', () => {
    const checkbox = (markup: string) => {
      const items = markup.match(/<[^>]*role="menuitemcheckbox"[^>]*>/g) ?? [];
      assert.equal(items.length, 1, 'expected exactly one page-settings checkbox');
      return items[0];
    };

    assert.match(checkbox(render([], true)), /aria-checked="true"/);
    assert.match(checkbox(render([], false)), /aria-checked="false"/);
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

    assert.equal(markup.match(/aria-label="已完成"/g)?.length, 1);
    // A failed delivery reads on the row itself. Scanning this page for what
    // is broken is the reason it exists, and while the row reported only the
    // reminder's own lifecycle a failed reminder and a healthy one rendered
    // identically — findable only by opening every entry in turn.
    //
    // Exactly one, so the tone stays on the row that earned it: `triggered`
    // is a plain "it ran" record and must not colour its row, and the other
    // fixtures here are healthy.
    assert.equal(markup.match(/aria-label="失败"/g)?.length, 1);
    assert.match(markup, /失败 ·/, 'and as text, since colour alone fails WCAG 1.4.1');
    // The run's MESSAGE is still the inspector's and 执行记录's to tell — that
    // part of the original rule holds, and only the status crosses over.
    assert.doesNotMatch(markup, /投递目标不可用。/);
    assert.doesNotMatch(markup, /maka-capability-audit-strip/);
  });
});
