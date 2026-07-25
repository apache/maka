import type { Meta, StoryObj } from '@storybook/react-vite';
import type { DailyReviewSummary } from '@maka/core';
import { DailyReviewPanel } from '../src/daily-review-panel.js';
import type { DailyReviewBridge } from '../src/module-panel-types.js';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Daily Review',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const NOW = Date.now();
const noop = () => undefined;

function dayRange(offsetDays: number) {
  const from = NOW - offsetDays * 86_400_000;
  return { fromMs: from, toMs: from + 86_400_000 };
}

const summary: DailyReviewSummary = {
  day: dayRange(0),
  totals: {
    sessionCount: 6,
    requestCount: 42,
    totalTokens: 18_320,
    costUsd: 0.21,
    errorCount: 1,
  },
  sessions: [
    { id: 's-1', name: '整理 Storybook 表面覆盖', lastMessageAt: NOW - 12 * 60_000, lastMessagePreview: '先把高频页面补齐。' },
    { id: 's-2', name: 'PR #435 发布风险清单', lastMessageAt: NOW - 2 * 60 * 60_000, lastMessagePreview: '权限弹窗的状态要全。' },
    { id: 's-3', name: '生成本周 benchmark 对比表', lastMessageAt: NOW - 5 * 60 * 60_000, lastMessagePreview: '稳定对比表 + 一轮 verifier。' },
  ],
  topTools: [
    { key: 'Bash', label: 'Bash', requests: 18, totalTokens: 4_200, costUsd: 0.05 },
    { key: 'Read', label: 'Read', requests: 12, totalTokens: 2_100, costUsd: 0.02 },
    { key: 'WebFetch', label: 'WebFetch', requests: 4, totalTokens: 900, costUsd: 0.01 },
  ],
  topModels: [
    { key: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', requests: 28, totalTokens: 12_400, costUsd: 0.16 },
    { key: 'glm-4.7', label: 'GLM 4.7', requests: 14, totalTokens: 5_920, costUsd: 0.05 },
  ],
};

function createBridge(input: { fail?: boolean; loading?: boolean }): DailyReviewBridge {
  return {
    async fetchDay() {
      if (input.loading) return new Promise<DailyReviewSummary>(() => undefined);
      if (input.fail) throw new Error('每日回顾暂时不可用，请稍后重试。');
      return summary;
    },
  };
}

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

// Real path: sidebar → 定时任务 → 每日回顾, with reviews already generated.
export const Loaded: Story = {
  render: () => (
    <ModuleFrame>
      <DailyReviewPanel bridge={createBridge({})} onCopyMarkdown={noop} />
    </ModuleFrame>
  ),
};

// Real path: same page while the review is still being generated or fetched.
export const Loading: Story = {
  render: () => (
    <ModuleFrame>
      <DailyReviewPanel bridge={createBridge({ loading: true })} onCopyMarkdown={noop} />
    </ModuleFrame>
  ),
};

// Real path: same page when the main-process bridge fails to return the review.
export const LoadError: Story = {
  render: () => (
    <ModuleFrame>
      <DailyReviewPanel bridge={createBridge({ fail: true })} onCopyMarkdown={noop} />
    </ModuleFrame>
  ),
};
