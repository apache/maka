import { useEffect, useRef, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { SessionBlockedReason, SessionStatus, SessionSummary } from '@maka/core';
import { SessionListPanel } from '../src/session-list-panel.js';

const NOW = Date.now();

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Sidebar Session List',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
type SessionListPanelProps = Parameters<typeof SessionListPanel>[0];

const noop = () => undefined;

function makeSession(input: {
  id: string;
  name: string;
  status?: SessionStatus;
  blockedReason?: SessionBlockedReason;
  lastMessageAt?: number;
  isFlagged?: boolean;
  isArchived?: boolean;
  hasUnread?: boolean;
  backend?: SessionSummary['backend'];
  llmConnectionSlug?: string;
}): SessionSummary {
  const status = input.status ?? 'active';
  const isArchived = input.isArchived ?? status === 'archived';
  return {
    id: input.id,
    name: input.name,
    isFlagged: input.isFlagged ?? false,
    isArchived,
    labels: [],
    hasUnread: input.hasUnread ?? false,
    status,
    ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
    ...(input.lastMessageAt !== undefined ? { lastMessageAt: input.lastMessageAt } : {}),
    backend: input.backend ?? 'ai-sdk',
    llmConnectionSlug: input.llmConnectionSlug ?? 'zai-live',
    connectionLocked: false,
    model: 'glm-4.7',
    permissionMode: 'ask',
  };
}

const rowActions: NonNullable<SessionListPanelProps['rowActions']> = {
  onToggleFlag: noop,
  onArchive: noop,
  onUnarchive: noop,
  onRename: noop,
  onDelete: noop,
};

function panelProps(input: {
  sessions: SessionSummary[];
  activeId?: string;
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
}): SessionListPanelProps {
  return {
    selection: { section: 'sessions', filter: 'chats' },
    sessions: input.sessions,
    ...(input.activeId ? { activeId: input.activeId } : {}),
    ...(input.streamingSessionIds ? { streamingSessionIds: input.streamingSessionIds } : {}),
    ...(input.staleSessionIds ? { staleSessionIds: input.staleSessionIds } : {}),
    onSelectSession: noop,
    onSelect: noop,
    onOpenSettings: noop,
    onNew: noop,
    viewMode: 'conversation',
    onViewModeChange: noop,
    rowActions,
  };
}

function StoryFrame(props: {
  children: ReactNode;
  width?: number;
  height?: number;
  focusActiveRow?: boolean;
  openActiveRowMenu?: boolean;
}) {
  const { children, width = 240, height = 680, focusActiveRow = false, openActiveRowMenu = false } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusActiveRow && !openActiveRowMenu) return;
    let menuTimeout: number | undefined;
    const focusTimeout = window.setTimeout(() => {
      const activeRow = ref.current?.querySelector<HTMLElement>('.maka-list-row[data-active="true"]');
      activeRow?.querySelector<HTMLButtonElement>('.maka-list-row-main')?.focus({ preventScroll: true });
      if (openActiveRowMenu) {
        menuTimeout = window.setTimeout(() => {
          activeRow?.querySelector<HTMLButtonElement>('[aria-label="对话操作"]')?.click();
        }, 0);
      }
    }, 0);
    return () => {
      window.clearTimeout(focusTimeout);
      if (menuTimeout !== undefined) window.clearTimeout(menuTimeout);
    };
  }, [focusActiveRow, openActiveRowMenu]);

  return (
    <div
      ref={ref}
      data-maka-e2e-fixture="true"
      style={{
        background: 'var(--surface-canvas)',
        height,
        overflow: 'hidden',
        width,
      }}
    >
      {children}
    </div>
  );
}

const coreSessions = [
  makeSession({
    id: 'session-running',
    name: '生成本周 benchmark 对比表',
    status: 'running',
    lastMessageAt: NOW - 2 * 60 * 1000,
  }),
  makeSession({
    id: 'session-active',
    name: 'Harbor adapter metadata 对齐',
    lastMessageAt: NOW - 18 * 60 * 1000,
    hasUnread: true,
  }),
  makeSession({
    id: 'session-stale',
    name: '旧连接里的模型选择',
    lastMessageAt: NOW - 42 * 60 * 1000,
    backend: 'fake',
    llmConnectionSlug: 'removed-connection',
  }),
  makeSession({
    id: 'session-pinned',
    name: 'PR #390 Storybook polish tracking',
    lastMessageAt: NOW - 76 * 60 * 1000,
    isFlagged: true,
  }),
];

const statusSessions = [
  makeSession({
    id: 'status-running',
    name: '运行中的工具链检查',
    status: 'running',
    lastMessageAt: NOW - 1 * 60 * 1000,
  }),
  makeSession({
    id: 'status-waiting',
    name: '等待权限确认',
    status: 'waiting_for_user',
    lastMessageAt: NOW - 8 * 60 * 1000,
    hasUnread: true,
  }),
  makeSession({
    id: 'status-blocked',
    name: 'OAuth 需要重新授权',
    status: 'blocked',
    blockedReason: 'auth',
    lastMessageAt: NOW - 20 * 60 * 1000,
  }),
  makeSession({
    id: 'status-review',
    name: '待审核的文件 diff',
    status: 'review',
    lastMessageAt: NOW - 37 * 60 * 1000,
  }),
  makeSession({
    id: 'status-done',
    name: '已完成的 smoke run',
    status: 'done',
    lastMessageAt: NOW - 2 * 60 * 60 * 1000,
  }),
  makeSession({
    id: 'status-archived',
    name: '归档的旧实验',
    status: 'archived',
    lastMessageAt: NOW - 8 * 24 * 60 * 60 * 1000,
  }),
  makeSession({
    id: 'status-aborted',
    name: '中止的临时尝试',
    status: 'aborted',
    lastMessageAt: NOW - 15 * 24 * 60 * 60 * 1000,
  }),
];

const longListSessions = Array.from({ length: 36 }, (_, index) => makeSession({
  id: `long-list-${index + 1}`,
  name: `${index % 6 === 0 ? '已置顶 ' : ''}会话 ${String(index + 1).padStart(2, '0')} · ${
    [
      '整理发布前检查项',
      '跟进 UI 回归截图',
      '复盘运行时工具输出',
      '确认 provider 配置',
      '收敛 PR body',
      '处理 review 反馈',
    ][index % 6]
  }`,
  lastMessageAt: NOW - index * 47 * 60 * 1000,
  isFlagged: index === 0 || index === 6,
  hasUnread: index === 4 || index === 17,
}));

const longTitleSessions = [
  makeSession({
    id: 'long-title-active',
    name: '这是一个非常长的中文会话标题，用来检查窄侧边栏里标题、状态和时间不会互相挤压',
    lastMessageAt: NOW - 6 * 60 * 1000,
  }),
  makeSession({
    id: 'long-title-stale',
    name: 'Artifact Pane 验收路径和 sidebar row overflow menu 的长标题组合测试',
    status: 'blocked',
    blockedReason: 'permission_required',
    lastMessageAt: NOW - 31 * 60 * 1000,
  }),
  makeSession({
    id: 'long-title-pinned',
    name: 'PR #390 Sidebar session-list storyboard 状态覆盖范围确认',
    isFlagged: true,
    lastMessageAt: NOW - 52 * 60 * 1000,
  }),
];

// Real path: a fresh workspace with no conversations yet — the sidebar list before
// anything is created.
export const Empty: Story = {
  render: () => (
    <StoryFrame>
      <SessionListPanel {...panelProps({ sessions: [] })} />
    </StoryFrame>
  ),
};

// Real path: a workspace with enough history that the conversation list scrolls.
export const LongList: Story = {
  render: () => (
    <StoryFrame>
      <SessionListPanel {...panelProps({
        sessions: longListSessions,
        activeId: 'long-list-4',
      })} />
    </StoryFrame>
  ),
};

// Real path: the same list once its rows carry lifecycle state (running / waiting /
// failed), which the row shows as an indicator rather than a bucket (#1459).
export const ConversationStates: Story = {
  render: () => (
    <StoryFrame>
      <SessionListPanel {...panelProps({
        sessions: statusSessions,
        activeId: 'status-waiting',
        streamingSessionIds: new Set(['status-running']),
        staleSessionIds: new Set(['status-blocked']),
      })} />
    </StoryFrame>
  ),
};

// Real path: sidebar → 扩展 — the list keeps the conversation heading and view switch
// while a non-conversation module is selected (#1458).
export const ExtensionSelected: Story = {
  render: () => (
    <StoryFrame>
      <SessionListPanel
        {...panelProps({
          sessions: coreSessions,
          activeId: 'session-active',
          streamingSessionIds: new Set(['session-running']),
          staleSessionIds: new Set(['session-stale']),
        })}
        selection={{ section: 'extensions', module: 'skills' }}
        viewMode="conversation"
        onViewModeChange={noop}
      />
    </StoryFrame>
  ),
};

// Real path: hover a conversation row → its inline actions appear.
export const RowActions: Story = {
  render: () => (
    <StoryFrame focusActiveRow>
      <SessionListPanel {...panelProps({
        sessions: coreSessions,
        activeId: 'session-active',
        streamingSessionIds: new Set(['session-running']),
        staleSessionIds: new Set(['session-stale']),
      })} />
    </StoryFrame>
  ),
};

// Real path: hover a conversation row → ⋯ → the row menu is open.
export const RowMenuOpen: Story = {
  render: () => (
    <StoryFrame openActiveRowMenu>
      <SessionListPanel {...panelProps({
        sessions: coreSessions,
        activeId: 'session-active',
        streamingSessionIds: new Set(['session-running']),
        staleSessionIds: new Set(['session-stale']),
      })} />
    </StoryFrame>
  ),
};

// Real path: a workspace with long conversation titles, with the sidebar dragged to its
// narrow end.
export const LongTitlesAndNarrow: Story = {
  render: () => (
    <StoryFrame width={176}>
      <SessionListPanel {...panelProps({
        sessions: longTitleSessions,
        activeId: 'long-title-active',
        staleSessionIds: new Set(['long-title-stale']),
      })} />
    </StoryFrame>
  ),
};
