import type { Meta, StoryObj } from '@storybook/react-vite';
import type { PlanReminder } from '@maka/core';
import { PlanReminderPanel } from '../src/plan-reminder-panel.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Plan Reminder',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const NOW = Date.now();
const noop = () => undefined;

const reminders: PlanReminder[] = [
  {
    id: 'plan-weekly',
    title: '每周发布风险复盘',
    note: '聚合本周未解决的发布风险项。',
    schedule: { kind: 'recurring', startAt: NOW - 7 * 86_400_000, recurrence: 'weekly' },
    delivery: { channel: 'local' },
    status: 'scheduled',
    enabled: true,
    createdAt: NOW - 14 * 86_400_000,
    updatedAt: NOW - 2 * 86_400_000,
    nextRunAt: NOW + 2 * 86_400_000,
    runs: [],
    runCount: 0,
  },
  {
    id: 'plan-cron',
    title: '工作日早 9 点同步进度',
    note: '',
    schedule: { kind: 'cron', startAt: NOW - 30 * 86_400_000, expression: '0 9 * * 1-5' },
    delivery: { channel: 'local' },
    status: 'scheduled',
    enabled: true,
    createdAt: NOW - 30 * 86_400_000,
    updatedAt: NOW - 30 * 86_400_000,
    nextRunAt: NOW + 18 * 3_600_000,
    runs: [
      { id: 'run-1', at: NOW - 86_400_000, status: 'triggered', message: '已生成进度摘要。', blockReason: undefined },
    ],
    runCount: 1,
  },
  {
    id: 'plan-paused',
    title: '一次性补一次截图基线',
    note: '发布前再补一轮稳定基线。',
    schedule: { kind: 'once', runAt: NOW + 3 * 86_400_000 },
    delivery: { channel: 'local' },
    status: 'paused',
    enabled: false,
    createdAt: NOW - 5 * 86_400_000,
    updatedAt: NOW - 86_400_000,
    runs: [],
    runCount: 0,
  },
  {
    id: 'plan-completed',
    title: '发布日提醒',
    note: '',
    schedule: { kind: 'once', runAt: NOW - 2 * 86_400_000 },
    delivery: { channel: 'local' },
    status: 'completed',
    enabled: false,
    createdAt: NOW - 10 * 86_400_000,
    updatedAt: NOW - 2 * 86_400_000,
    runs: [
      { id: 'run-done', at: NOW - 2 * 86_400_000, status: 'triggered', message: '已发送。', blockReason: undefined },
    ],
    runCount: 1,
  },
];

function ModuleFrame(props: { children: React.ReactNode }) {
  return (
    <div
      data-maka-e2e-fixture="true"
      style={{
        background: 'var(--surface-canvas)',
        height: '100%',
        minHeight: 560,
      }}
    >
      <div
        className="maka-panel maka-panel-detail maka-floating-panel agents-content-area agents-parchment-paper-surface"
        style={{ height: '100%', overflow: 'auto' }}
      >
        {props.children}
      </div>
    </div>
  );
}

const panelCallbacks = {
  onRefresh: noop,
  onCreate: noop,
  onUpdate: noop,
  onToggle: noop,
  onTriggerNow: noop,
  onSnooze: noop,
  onClearRunHistory: noop,
  onDelete: noop,
};

// Real path: sidebar → 定时任务 → 计划提醒, with reminders configured — including a completed
// one and one that failed its last run.
export const Populated: Story = {
  render: () => (
    <ModuleFrame>
      <PlanReminderPanel reminders={reminders} {...panelCallbacks} />
    </ModuleFrame>
  ),
};

// Real path: same page on a fresh install, before any reminder exists.
export const Empty: Story = {
  render: () => (
    <ModuleFrame>
      <PlanReminderPanel reminders={[]} {...panelCallbacks} />
    </ModuleFrame>
  ),
};
