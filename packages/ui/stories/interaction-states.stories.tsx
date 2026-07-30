import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SessionSummary } from '@maka/core';
import { userEvent } from 'storybook/test';
import { SessionListPanel } from '../src/session-list-panel.js';
import { Button } from '../src/ui.js';

const meta = {
  title: 'Design System/Interaction States',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const VARIANTS = ['default', 'secondary', 'ghost', 'quiet', 'destructive'] as const;
const NEUTRAL_VARIANTS = ['secondary', 'ghost', 'quiet'] as const;
const noop = () => undefined;

const COMPOSITE_ROW_SESSIONS: SessionSummary[] = [
  {
    id: 'interaction-active',
    name: '整理中文 compact controls',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'fixture',
    connectionLocked: false,
    model: 'fixture-model',
    permissionMode: 'ask',
  },
  {
    id: 'interaction-default',
    name: 'Review English interaction states',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: true,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'fixture',
    connectionLocked: false,
    model: 'fixture-model',
    permissionMode: 'ask',
  },
];

function StoryFrame(props: { children: React.ReactNode; description: string; title: string }) {
  return (
    <section style={{ display: 'grid', gap: 16, maxWidth: 900 }}>
      <div>
        <h2 style={{ fontSize: 16, margin: 0 }}>{props.title}</h2>
        <p style={{ color: 'var(--foreground-secondary)', fontSize: 12, margin: '4px 0 0' }}>
          {props.description}
        </p>
      </div>
      {props.children}
    </section>
  );
}

const rowStyle = {
  alignItems: 'center',
  display: 'grid',
  gap: 8,
  gridTemplateColumns: '88px repeat(6, max-content)',
} as const;

export const ButtonStates: Story = {
  render: () => (
    <StoryFrame
      title="按钮比例 / Button proportions"
      description="同一个 primitive 负责中英文、五种 variant 与 disabled 的统一比例。"
    >
      {VARIANTS.map((variant) => (
        <div key={variant} style={{ ...rowStyle, gridTemplateColumns: '88px repeat(3, max-content)' }}>
          <code style={{ color: 'var(--foreground-secondary)', fontSize: 11 }}>{variant}</code>
          <Button variant={variant}>中文状态</Button>
          <Button variant={variant}>English state</Button>
          <Button variant={variant} disabled>已禁用 / Disabled</Button>
        </div>
      ))}
    </StoryFrame>
  ),
};

export const ListRowStates: Story = {
  render: () => (
    <StoryFrame
      title="复合行 / Composite rows"
      description="真实侧栏导航与会话行保留自己的布局、选中态和 focus-within seam。"
    >
      <div style={{ height: 440, overflow: 'hidden', width: 260 }}>
        <SessionListPanel
          selection={{ section: 'extensions', module: 'skills' }}
          sessions={COMPOSITE_ROW_SESSIONS}
          activeId="interaction-active"
          onSelectSession={noop}
          onSelect={noop}
          onOpenSettings={noop}
          onNew={noop}
        />
      </div>
    </StoryFrame>
  ),
  play: async ({ canvasElement }) => {
    const hoverTarget = canvasElement.querySelector<HTMLButtonElement>('.maka-nav-row:not([data-active="true"])');
    hoverTarget?.setAttribute('data-state-target', 'hover');
    const focusTarget = canvasElement.querySelector<HTMLButtonElement>('.maka-list-row[data-active="true"] .maka-list-row-main');
    focusTarget?.setAttribute('data-state-target', 'focus');
    const tabStops = Array.from(canvasElement.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    const focusIndex = focusTarget ? tabStops.indexOf(focusTarget) : -1;
    if (focusIndex > 0) {
      tabStops[focusIndex - 1]?.focus();
      await userEvent.tab();
    }
  },
};

export const NeutralButtonStates: Story = {
  render: () => (
    <StoryFrame
      title="中性按钮 / Neutral buttons"
      description="用浏览器指针悬停或按住对应目标；focus 由 story 的真实 DOM focus 固定。"
    >
      <div style={rowStyle}>
        <code style={{ color: 'var(--foreground-secondary)', fontSize: 11 }}>secondary</code>
        <Button variant="secondary">静止</Button>
        <Button variant="secondary" data-state-target="hover">悬停</Button>
        <Button variant="secondary" data-state-target="active">按下</Button>
        <Button variant="secondary" data-state-target="focus">焦点</Button>
        <Button variant="secondary" disabled data-state-target="disabled">禁用</Button>
        <Button variant="secondary" aria-disabled="true" data-state-target="aria-disabled">ARIA 禁用</Button>
      </div>
      {NEUTRAL_VARIANTS.slice(1).map((variant) => (
        <div key={variant} style={{ ...rowStyle, gridTemplateColumns: '88px repeat(3, max-content)' }}>
          <code style={{ color: 'var(--foreground-secondary)', fontSize: 11 }}>{variant}</code>
          <Button variant={variant}>静止</Button>
          <Button variant={variant} disabled>禁用</Button>
          <Button variant={variant} aria-disabled="true">ARIA 禁用</Button>
        </div>
      ))}
    </StoryFrame>
  ),
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[data-state-target="focus"]')?.focus();
  },
};

export const SolidButtonStates: Story = {
  render: () => (
    <StoryFrame
      title="实心按钮 / Solid buttons"
      description="default 与 destructive 共用同一交互层级；按住 Active 目标检查真实 :active。"
    >
      {(['default', 'destructive'] as const).map((variant) => (
        <div key={variant} style={rowStyle}>
          <code style={{ color: 'var(--foreground-secondary)', fontSize: 11 }}>{variant}</code>
          <Button variant={variant}>静止</Button>
          <Button variant={variant} data-state-target="hover">悬停</Button>
          <Button variant={variant} data-state-target="active">按下</Button>
          <Button variant={variant} data-state-target="focus">焦点</Button>
          <Button variant={variant} disabled data-state-target="disabled">禁用</Button>
          <Button variant={variant} aria-disabled="true" data-state-target="aria-disabled">ARIA 禁用</Button>
        </div>
      ))}
    </StoryFrame>
  ),
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[data-state-target="focus"]')?.focus();
  },
};
