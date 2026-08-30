/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@astryxdesign/core/Button';
import type { SessionSortMode, SessionViewMode } from '../src/session-rail-context.js';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionBlockedReason, SessionStatus, SessionSummary } from '@maka/core/session';
import { SessionRail, type SessionRailStoryProps } from './session-rail-harness.js';

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
type SessionListPanelProps = SessionRailStoryProps;

const noop = () => undefined;

// Production path: SessionNavigationProvider supplies the sort preference and
// current Session summaries to the same SessionRailData/Chrome contexts.
function PrioritySortingScenario({ width = 260 }: { width?: number }) {
  const [sortMode, setSortMode] = useState<SessionSortMode>('updated_at');
  const [viewMode, setViewMode] = useState<SessionViewMode>('conversation');
  const [activeId, setActiveId] = useState('recent');
  const [finished, setFinished] = useState(false);
  const rows: SessionSummary[] = [
    makeSession({ id: 'pinned', name: '置顶：项目说明', isFlagged: true, lastMessageAt: NOW - 120 * 60_000 }),
    makeSession({ id: 'recent', name: '已聊完：调整按钮文案', lastMessageAt: NOW }),
    makeSession({ id: 'recent-docs', name: '已聊完：整理 README', lastMessageAt: NOW - 2 * 60_000 }),
    makeSession({ id: 'recent-style', name: '已聊完：修改页面配色', lastMessageAt: NOW - 5 * 60_000 }),
    { ...makeSession({ id: 'running', name: finished ? '检查完成，结果未读' : '正在检查构建结果',
      lastMessageAt: NOW - 30 * 60_000, hasUnread: finished }), runningTurnIds: finished ? [] : ['run-1'] },
    makeSession({ id: 'unread', name: '报告已完成，尚未阅读', hasUnread: true, lastMessageAt: NOW - 20 * 60_000 }),
    makeSession({ id: 'auth', name: '昨天：需要重新登录账号', status: 'blocked', blockedReason: 'auth', lastMessageAt: NOW - 24 * 60 * 60_000 }),
    makeSession({ id: 'waiting', name: '前天：等待你确认修改范围', status: 'waiting_for_user', lastMessageAt: NOW - 48 * 60 * 60_000 }),
  ];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 32 }}>
      <StoryFrame height={680} width={width}>
        <SessionRail
          {...panelProps({ sessions: rows, width })}
          activeId={activeId}
          onSelectSession={setActiveId}
          sortMode={sortMode}
          onSortModeChange={setSortMode}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          groups={viewMode === 'project' ? [
            { id: 'project:one', label: '项目一', sessions: rows.slice(0, 5) },
            { id: 'runtime-host:two', label: '远程 Host', sessions: rows.slice(5) },
          ] : undefined}
        />
      </StoryFrame>
      <aside aria-label="排序演示说明" style={{ maxWidth: 380, padding: 24, lineHeight: 1.7 }}>
        <p style={{ fontSize: 12, opacity: 0.65 }}>演示数据 · 说明区域不属于正式侧栏</p>
        <h2>同一批任务，两种排序</h2>
        <p>点击“全部任务 / 按项目”右侧的排序图标，切换“最近更新 / 优先级”。悬停图标可查看当前排序。</p>
        <p><strong>最近更新：</strong>刚聊完的三条普通任务在前面。前天就在等你确认的任务排在最后。</p>
        <p><strong>优先级：</strong>那条待确认任务会升到置顶区下方的第一位，接着是需要登录、运行中、未读任务。</p>
        <p>置顶任务不变；你当前选中的任务也不会被切换。</p>
        <p aria-live="polite">当前排序：<strong>{sortMode === 'priority' ? '优先级' : '最近更新'}</strong></p>
        <Button label={finished ? '恢复运行中状态' : '模拟运行完成'} onClick={() => setFinished((value) => !value)} />
        <p style={{ fontSize: 12, opacity: 0.65 }}>可反复模拟运行状态变化；这里保留原消息时间，单独观察状态对排序的影响。刷新即可重置演示。</p>
      </aside>
    </div>
  );
}

export const PrioritySorting: Story = {
  render: () => <PrioritySortingScenario />,
};

export const PrioritySortingNarrow: Story = {
  render: () => <PrioritySortingScenario width={180} />,
};

// Keep automated state transitions out of the manual demo's initial state.
export const PrioritySortingInteraction: Story = {
  render: () => <PrioritySortingScenario />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ids = () => [...canvasElement.querySelectorAll('[data-maka-contract="session-row"]')]
      .map((row) => row.getAttribute('data-session-id'));
    await expect(ids()).toEqual(['pinned', 'recent', 'recent-docs', 'recent-style', 'unread', 'running', 'auth', 'waiting']);
    await userEvent.click(canvas.getByRole('button', { name: /任务排序方式.*最近更新|Sort tasks by.*Last updated/ }));
    await userEvent.click(within(canvasElement.ownerDocument.body).getByRole('menuitemradio', { name: /^(优先级|Priority)$/ }));
    await waitFor(() => expect(ids()).toEqual(['pinned', 'waiting', 'auth', 'running', 'unread', 'recent', 'recent-docs', 'recent-style']));
    const runningButton = canvasElement.querySelector<HTMLButtonElement>('[data-session-id="running"] button')!;
    runningButton.focus();
    // Keep focus on the row while the simulated live state changes elsewhere.
    canvas.getByRole('button', { name: '模拟运行完成' }).click();
    await waitFor(() => expect(canvas.getByText('检查完成，结果未读', { exact: true })).toBeVisible());
    await expect(ids()).toEqual(['pinned', 'waiting', 'auth', 'unread', 'running', 'recent', 'recent-docs', 'recent-style']);
    await expect(canvasElement.ownerDocument.activeElement).toBe(runningButton);
    await expect(canvasElement.querySelector('[data-session-id="recent"] [aria-current="page"]')).not.toBeNull();
  },
};

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
  return {
    id: input.id,
    name: input.name,
    isFlagged: input.isFlagged ?? false,
    isArchived: input.isArchived ?? false,
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
  selection?: SessionListPanelProps['selection'];
  activeId?: string;
  streamingSessionIds?: Set<string>;
  staleSessionIds?: Set<string>;
  width?: number;
  viewMode?: SessionListPanelProps['viewMode'];
  groups?: SessionListPanelProps['groups'];
  projectActions?: SessionListPanelProps['projectActions'];
  worktreeSessionIds?: SessionListPanelProps['worktreeSessionIds'];
}): SessionListPanelProps {
  return {
    selection: input.selection ?? { section: 'sessions' },
    sessions: input.sessions,
    // The rail's own width, not just the frame's: SideNav keeps its width in
    // `resizable`, so a narrow frame alone only clips a 260px rail instead of
    // showing what the narrow one looks like.
    ...(input.width === undefined ? {} : { width: input.width }),
    ...(input.activeId ? { activeId: input.activeId } : {}),
    ...(input.streamingSessionIds ? { streamingSessionIds: input.streamingSessionIds } : {}),
    ...(input.staleSessionIds ? { staleSessionIds: input.staleSessionIds } : {}),
    ...(input.groups ? { groups: input.groups } : {}),
    ...(input.projectActions ? { projectActions: input.projectActions } : {}),
    ...(input.worktreeSessionIds ? { worktreeSessionIds: input.worktreeSessionIds } : {}),
    onSelectSession: noop,
    onSelect: noop,
    onOpenSettings: noop,
    onNew: noop,
    viewMode: input.viewMode ?? 'conversation',
    onViewModeChange: noop,
    rowActions,
  };
}

function makeProject(
  input: Partial<ProjectRecord> & Pick<ProjectRecord, 'id' | 'name'>,
): ProjectRecord {
  return {
    id: input.id,
    name: input.name,
    available: input.available ?? true,
    preferredPath: input.preferredPath ?? `/workspace/${input.id}`,
    locations: input.locations ?? [
      { path: input.preferredPath ?? `/workspace/${input.id}`, isWorktree: false },
    ],
    ...(input.archivedAt !== undefined ? { archivedAt: input.archivedAt } : {}),
    ...(input.aliases ? { aliases: input.aliases } : {}),
  };
}

function StoryFrame(props: {
  children: ReactNode;
  width?: number;
  height?: number;
  openSessionMenuId?: string;
}) {
  // 260 is `SessionListPanel`'s own default width. The frame used to default to
  // 240 and clip the rail by 20px in every story that did not pass a width —
  // which lands squarely on the trailing slot, so the stories could not show
  // whether the timestamp fits. Stories that want a narrow rail pass the width
  // to both, as `panelProps` explains.
  const {
    children,
    width = 260,
    height = 680,
    openSessionMenuId,
  } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openSessionMenuId) return;
    const timeout = window.setTimeout(() => {
      const targetRow = Array.from(
        ref.current?.querySelectorAll<HTMLElement>('[data-maka-contract="session-row"]') ?? [],
      ).find((row) => row.dataset.sessionId === openSessionMenuId);
      if (!targetRow) {
        throw new Error(`Missing task row fixture: ${openSessionMenuId}`);
      }
      const menuButton = targetRow.querySelector<HTMLButtonElement>(
        '[aria-label$="任务操作"]',
      );
      if (!menuButton) {
        throw new Error('Task row is missing its actions menu');
      }
      menuButton.click();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [openSessionMenuId]);

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
    id: 'status-aborted',
    name: '中止的临时尝试',
    status: 'aborted',
    lastMessageAt: NOW - 15 * 24 * 60 * 60 * 1000,
  }),
];

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

const liveRunAuthoritySessions: SessionSummary[] = [
  {
    ...makeSession({
      id: 'live-unknown',
      name: 'Unknown：兼容旧 Host 的 persisted fallback',
      status: 'running',
      lastMessageAt: NOW - 4 * 60 * 1000,
    }),
  },
  {
    ...makeSession({
      id: 'live-known-empty',
      name: 'Known empty：忽略崩溃遗留的 running',
      status: 'running',
      lastMessageAt: NOW - 3 * 60 * 1000,
    }),
    runningTurnIds: [],
  },
  {
    ...makeSession({
      id: 'live-remote-running',
      name: 'Remote running：来自机器人或第二窗口',
      lastMessageAt: NOW - 2 * 60 * 1000,
    }),
    runningTurnIds: ['turn-remote'],
  },
  {
    ...makeSession({
      id: 'live-local-race',
      name: 'Local streaming：catalog 刷新前仍显示运行',
      lastMessageAt: NOW - 1 * 60 * 1000,
    }),
    runningTurnIds: [],
  },
];

// Real path: a fresh workspace with no tasks yet — the rail's list before
// anything is created.
export const Empty: Story = {
  render: () => (
    <StoryFrame>
      <SessionRail {...panelProps({ sessions: [] })} />
    </StoryFrame>
  ),
};

// Real path: the same list once its rows carry lifecycle state (running / waiting /
// failed), which the row shows as an indicator rather than a bucket (#1459).
export const ConversationStates: Story = {
  render: () => (
    <StoryFrame>
      <SessionRail {...panelProps({
        sessions: statusSessions,
        activeId: 'status-waiting',
        streamingSessionIds: new Set(['status-running']),
        staleSessionIds: new Set(['status-blocked']),
      })} />
    </StoryFrame>
  ),
};

// Real path: the active task row's overflow menu after its semantic trigger is
// opened. The menu is portaled outside the rail, so the play assertion reads
// from the owning document rather than only the story canvas.
export const ActiveTaskActionsOpen: Story = {
  render: () => (
    <StoryFrame openSessionMenuId="status-waiting">
      <SessionRail {...panelProps({
        sessions: statusSessions,
        activeId: 'status-waiting',
      })} />
    </StoryFrame>
  ),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByRole('menu')).toBeVisible());
    expect(page.getByRole('menuitem', { name: '重命名' })).toBeVisible();
  },
};

// Real path: Runtime Host catalog refreshes distinguish an older Host (unknown),
// an authoritative empty run set, a run started by another Client, and the
// renderer-local synchronization window immediately after send.
export const LiveRunAuthorityStates: Story = {
  render: () => (
    <StoryFrame>
      <SessionRail {...panelProps({
        sessions: liveRunAuthoritySessions,
        activeId: 'live-remote-running',
        streamingSessionIds: new Set(['live-local-race']),
      })} />
    </StoryFrame>
  ),
};

// Real path: a workspace with long task titles, with the rail dragged to its
// narrow end (180px, the panel's own minWidth).
export const LongTitlesAndNarrow: Story = {
  render: () => (
    <StoryFrame width={180}>
      <SessionRail {...panelProps({
        width: 180,
        sessions: longTitleSessions,
        activeId: 'long-title-active',
        staleSessionIds: new Set(['long-title-stale']),
      })} />
    </StoryFrame>
  ),
};

// Real path: time-sort with both flagged and unflagged sessions — two
// SideNavSection zones (置顶 / 最近), not a single labeled exception.
export const PinnedAndRecentSections: Story = {
  render: () => (
    <StoryFrame>
      <SessionRail
        {...panelProps({
          sessions: [
            makeSession({
              id: 'pinned-a',
              name: '发布风险清单',
              isFlagged: true,
              lastMessageAt: NOW - 40 * 60 * 1000,
            }),
            makeSession({
              id: 'pinned-b',
              name: '长期跟踪的客户反馈',
              isFlagged: true,
              status: 'running',
              lastMessageAt: NOW - 5 * 60 * 1000,
            }),
            makeSession({
              id: 'recent-a',
              name: '刚结束的 smoke 回归',
              lastMessageAt: NOW - 12 * 60 * 1000,
            }),
            makeSession({
              id: 'recent-b',
              name: '整理 compact controls',
              lastMessageAt: NOW - 2 * 60 * 60 * 1000,
            }),
          ],
          activeId: 'recent-a',
          streamingSessionIds: new Set(['pinned-b']),
        })}
      />
    </StoryFrame>
  ),
};

// Real path: group-by-project — collapsible project rows, sessions nested 8px
// under the project so titles share one x, worktree mark + count badge.
export const ProjectGroups: Story = {
  render: () => {
    const maka = makeProject({
      id: 'project-maka',
      name: 'maka-agent',
      preferredPath: '/workspace/maka-agent',
      locations: [
        { path: '/workspace/maka-agent', isWorktree: false },
        { path: '/workspace/maka-agent/.worktree/sidebar', isWorktree: true },
      ],
    });
    const docs = makeProject({
      id: 'project-docs',
      name: '产品文档',
      preferredPath: '/workspace/docs',
    });
    const missing = makeProject({
      id: 'project-missing',
      name: '旧版桌面端',
      available: false,
    });
    const sessions = [
      makeSession({
        id: 'proj-main',
        name: '主仓会话',
        lastMessageAt: NOW - 4 * 60 * 1000,
      }),
      makeSession({
        id: 'proj-worktree',
        name: 'worktree 上的修复',
        status: 'running',
        lastMessageAt: NOW - 1 * 60 * 1000,
      }),
      makeSession({
        id: 'proj-docs',
        name: '文档站改版',
        lastMessageAt: NOW - 30 * 60 * 1000,
      }),
    ];
    return (
      <StoryFrame height={720}>
        <SessionRail
          {...panelProps({
            sessions,
            activeId: 'proj-worktree',
            streamingSessionIds: new Set(['proj-worktree']),
            viewMode: 'project',
            worktreeSessionIds: new Set(['proj-worktree']),
            groups: [
              {
                id: `project:${maka.id}`,
                label: maka.name,
                project: maka,
                sessions: [sessions[0]!, sessions[1]!],
              },
              {
                id: `project:${docs.id}`,
                label: docs.name,
                project: docs,
                sessions: [sessions[2]!],
              },
              {
                id: `project:${missing.id}`,
                label: missing.name,
                project: missing,
                sessions: [],
              },
            ],
            projectActions: {
              onNew: noop,
              onRename: noop,
              onArchive: noop,
              onRestore: noop,
              onRelink: noop,
            },
          })}
        />
      </StoryFrame>
    );
  },
};
