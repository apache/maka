import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SessionSummary } from '@maka/core/session';
import { userEvent } from 'storybook/test';
import { SessionListPanel } from '../src/session-list-panel.js';

// Compares the resting, hover and focus states of two DIFFERENT row components
// — Astryx's side-nav item and its list item — as the sidebar composes them.
// That cross-component seam is why this sits here rather than in
// session-list-panel.stories.tsx, which owns SessionListPanel's own states.
//
// The Astryx Button state matrices that used to share this file were deleted:
// Astryx owns Button and publishes its states upstream.
const meta = {
  title: 'Design System/Composite Row States',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

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
    const hoverTarget = canvasElement.querySelector<HTMLButtonElement>('.astryx-side-nav-item');
    hoverTarget?.setAttribute('data-state-target', 'hover');
    const focusTarget = canvasElement.querySelector<HTMLButtonElement>('[data-maka-contract="session-row"] [aria-current="true"]');
    focusTarget?.setAttribute('data-state-target', 'focus');
    const tabStops = Array.from(canvasElement.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    const focusIndex = focusTarget ? tabStops.indexOf(focusTarget) : -1;
    if (focusIndex > 0) {
      tabStops[focusIndex - 1]?.focus();
      await userEvent.tab();
    }
  },
};

