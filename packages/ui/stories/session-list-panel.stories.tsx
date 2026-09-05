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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
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
  projectId?: string | null;
  cwd?: string;
  lastMessagePreview?: string;
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
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.lastMessagePreview !== undefined
      ? { lastMessagePreview: input.lastMessagePreview }
      : {}),
  };
}

const rowActions: NonNullable<SessionListPanelProps['rowActions']> = {
  onToggleFlag: noop,
  onArchive: noop,
  onUnarchive: noop,
  onRename: noop,
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
  onSelectSession?: SessionListPanelProps['onSelectSession'];
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
    onSelectSession: input.onSelectSession ?? noop,
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

const renderBudgetSessions = Array.from({ length: 32 }, (_, index) =>
  makeSession({
    id: `render-budget-${index}`,
    name: `Rail row ${index}`,
    status: index % 5 === 0 ? 'running' : 'active',
    lastMessageAt: NOW - index * 60_000,
  }),
);

function RenderBudgetRail() {
  const [activeId, setActiveId] = useState('render-budget-0');
  const select = useCallback((sessionId: string) => setActiveId(sessionId), []);
  return (
    <StoryFrame height={800}>
      <SessionRail
        {...panelProps({
          sessions: renderBudgetSessions,
          activeId,
          onSelectSession: select,
        })}
      />
    </StoryFrame>
  );
}

async function waitForRailMutationQuiet(counters: { delta: number }): Promise<void> {
  let quiet = 0;
  await waitFor(() => {
    quiet = counters.delta === 0 ? quiet + 1 : 0;
    counters.delta = 0;
    expect(quiet).toBeGreaterThanOrEqual(3);
  }, { timeout: 10_000, interval: 100 });
}

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

// Real path: switching between two ordinary Sessions in a populated rail. The
// controller unit test pins stable command identities; this real-layout story
// pins the resulting DOM budget, so a different source of whole-rail rewrites
// still fails without paying Electron startup cost.
export const SessionSwitchRenderBudget: Story = {
  render: () => <RenderBudgetRail />,
  play: async ({ canvasElement }) => {
    const counters = {
      styleWrites: 0,
      rowIds: new Set<string>(),
      rowRemounts: 0,
      selectedRowIds: [] as (string | null)[],
      statusNodeChanges: 0,
      delta: 0,
    };
    const selectedRowId = (): string | null =>
      canvasElement
        .querySelector('.maka-session-row button.astryx-side-nav-item.selected')
        ?.closest('.maka-session-row')
        ?.getAttribute('data-session-id') ?? null;
    counters.selectedRowIds.push(selectedRowId());
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') {
          for (const node of record.addedNodes) {
            const element = node as Element;
            if (element.nodeType === 1 && element.classList?.contains('maka-session-row')) {
              counters.rowRemounts += 1;
            }
          }
          for (const node of [...record.addedNodes, ...record.removedNodes]) {
            const element = node as Element;
            if (
              element.nodeType === 1 &&
              (element.matches?.('[data-session-status]') ||
                element.querySelector?.('[data-session-status]'))
            ) {
              counters.statusNodeChanges += 1;
            }
          }
          continue;
        }
        const row = (record.target as Element).closest?.('.maka-session-row');
        if (!row) continue;
        counters.styleWrites += 1;
        counters.delta += 1;
        const rowId = row.getAttribute('data-session-id');
        if (rowId) counters.rowIds.add(rowId);
      }
      const selected = selectedRowId();
      if (selected !== counters.selectedRowIds.at(-1)) counters.selectedRowIds.push(selected);
    });
    observer.observe(canvasElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style'],
    });

    await waitForRailMutationQuiet(counters);
    counters.styleWrites = 0;
    counters.rowIds.clear();
    counters.rowRemounts = 0;
    counters.selectedRowIds = counters.selectedRowIds.slice(-1);
    counters.statusNodeChanges = 0;

    const target = canvasElement.querySelector<HTMLButtonElement>(
      '.maka-session-row[data-session-id="render-budget-3"] button.astryx-side-nav-item',
    );
    await expect(target).not.toBeNull();
    target!.click();
    await waitFor(() => expect(target!).toHaveClass('selected'));
    await waitForRailMutationQuiet(counters);
    observer.disconnect();

    expect(counters.rowIds.size).toBeLessThanOrEqual(2);
    expect(counters.rowRemounts).toBe(0);
    expect(counters.styleWrites).toBeGreaterThan(0);
    // Storybook's focus handoff invokes one extra ref pair compared with the
    // Electron fixture. The stronger two-row budget above still rejects any
    // whole-rail rewrite regardless of the fixture size.
    expect(counters.styleWrites).toBeLessThanOrEqual(10);
    expect(counters.selectedRowIds.slice(1)).toEqual(['render-budget-3']);
    expect(counters.statusNodeChanges).toBe(0);
  },
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
    expect(page.getByRole('menuitem', { name: /^归档$/ })).toBeVisible();
    expect(page.queryByRole('menuitem', { name: /删除/ })).toBeNull();
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
// under the project so titles share one x, worktree mark + project actions.
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
        isFlagged: true,
        lastMessageAt: NOW - 4 * 60 * 1000,
      }),
      makeSession({
        id: 'proj-worktree',
        name: 'worktree 上的修复',
        status: 'running',
        lastMessageAt: NOW - 1 * 60 * 1000,
        projectId: maka.id,
        cwd: '/workspace/maka-agent/.worktree/sidebar',
        lastMessagePreview: '正在把侧栏交互契约迁移到浏览器 story。',
      }),
      makeSession({
        id: 'proj-docs',
        name: '文档站改版',
        lastMessageAt: NOW - 30 * 60 * 1000,
      }),
      makeSession({
        id: 'proj-loose',
        name: '未归属的临时任务',
        projectId: null,
        lastMessageAt: NOW - 45 * 60 * 1000,
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
              {
                id: '__ungrouped__',
                label: '未归属项目',
                sessions: [sessions[3]!],
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const projectRow = canvasElement.querySelector<HTMLElement>(
      '[data-project-id="project:project-maka"]',
    );
    if (!projectRow) throw new Error('project row is missing');
    const navigation = projectRow.querySelector<HTMLElement>(
      'button[aria-controls]:not([aria-haspopup="menu"])',
    );
    if (!navigation) throw new Error('project navigation is missing');
    const action = within(projectRow).getByRole('button', {
      name: 'maka-agent 项目操作',
    });
    const groupId = navigation.getAttribute('aria-controls');
    if (!groupId) throw new Error('project navigation does not own a group');
    const group = canvasElement.ownerDocument.getElementById(groupId);
    if (!group) throw new Error('project task group is missing');
    const taskControl = group.querySelector<HTMLElement>('[data-session-id] button');
    if (!taskControl) throw new Error('nested task control is missing');
    const projectTitle = within(navigation).getByText('maka-agent', { exact: true });
    const taskTitle = within(taskControl).getByText('worktree 上的修复', { exact: true });

    expect(projectRow.querySelectorAll('button button')).toHaveLength(0);
    const projectBox = navigation.getBoundingClientRect();
    const taskBox = taskControl.getBoundingClientRect();
    const sessionInset = taskBox.x - projectBox.x;
    expect(sessionInset).toBeGreaterThanOrEqual(6);
    expect(sessionInset).toBeLessThan(16);
    expect(Math.abs(
      projectTitle.getBoundingClientRect().x - taskTitle.getBoundingClientRect().x,
    )).toBeLessThanOrEqual(2);

    navigation.focus();
    await userEvent.tab();
    await expect(action).toHaveFocus();
    await userEvent.tab();
    await expect(taskControl).toHaveFocus();

    navigation.focus();
    await userEvent.keyboard('{Enter}');
    await expect(navigation).toHaveAttribute('aria-expanded', 'false');
    await expect(group).toHaveAttribute('aria-hidden', 'true');
    expect(group.getAttribute('inert')).not.toBeNull();
    await userEvent.keyboard('{Enter}');
    await expect(navigation).toHaveAttribute('aria-expanded', 'true');
    await expect(group).toHaveAttribute('aria-hidden', 'false');
    expect(group.getAttribute('inert')).toBeNull();

    action.focus();
    await userEvent.keyboard('{Enter}');
    await expect(page.getByRole('menuitem', { name: '新建任务' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(action).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(page.getByRole('menuitem', { name: '重命名' }));
    await expect(page.getByRole('dialog', { name: '重命名项目' })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: '关闭' }));
    await expect(action).toHaveFocus();

    await userEvent.hover(taskControl);
    const taskCard = await page.findByText('正在把侧栏交互契约迁移到浏览器 story。');
    const taskHoverCard = taskCard.closest<HTMLElement>(
      '.maka-sidebar-hover-card[data-kind="session"]',
    );
    if (!taskHoverCard) throw new Error('task hover card is missing');
    await expect(within(taskHoverCard).getByText('worktree 上的修复')).toBeVisible();
    await expect(within(taskHoverCard).getByText(/glm-4\.7/)).toBeVisible();

    await userEvent.hover(navigation);
    await waitFor(() => expect(
      canvasElement.ownerDocument.querySelector<HTMLElement>(
        '.maka-sidebar-hover-card[data-kind="project"]',
      ),
    ).toBeVisible());
    const projectHoverCard = canvasElement.ownerDocument.querySelector<HTMLElement>(
      '.maka-sidebar-hover-card[data-kind="project"]',
    );
    if (!projectHoverCard) throw new Error('project hover card is missing');
    await expect(within(projectHoverCard).getByText('1 个任务')).toBeVisible();
    await expect(within(projectHoverCard).getByText(/目录可用/)).toBeVisible();
    await userEvent.unhover(navigation);
    await waitFor(() => expect(projectHoverCard).not.toBeVisible());

    const taskRow = taskControl.closest<HTMLElement>('[data-session-id]');
    if (!taskRow) throw new Error('task row is missing');
    const timestamp = taskRow.querySelector<HTMLElement>('.maka-session-row-time');
    if (!timestamp) throw new Error('task timestamp is missing');
    const taskActionButton = within(taskRow).getByRole('button', { name: /任务操作$/ });
    taskActionButton.focus();
    await userEvent.keyboard('{Enter}');
    const renameTask = page.getByRole('menuitem', { name: '重命名' });
    await expect(renameTask).toBeVisible();
    const taskAction = taskRow.querySelector<HTMLElement>('.maka-session-row-action');
    if (!taskAction) throw new Error('task action is missing');
    await expect(taskAction).toHaveAttribute(
      'data-menu-open',
      'true',
    );
    await userEvent.hover(renameTask);
    await expect(timestamp).toHaveStyle({ visibility: 'hidden' });
    await userEvent.click(renameTask);
    await expect(await page.findByRole('dialog', { name: '重命名任务' }, {
      timeout: 5_000,
    })).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: '关闭' }));

    const ungroupedRow = canvasElement.querySelector<HTMLElement>(
      '[data-project-id="__ungrouped__"]',
    );
    const ungroupedNavigation = ungroupedRow?.querySelector<HTMLElement>(
      ':scope > div > .astryx-side-nav-item',
    );
    if (!ungroupedNavigation) throw new Error('ungrouped project row is missing');
    ungroupedNavigation.focus();
    await expect(await page.findByRole('dialog', {
      name: '未归属项目 分组详情',
    })).toBeVisible();
  },
};

// Group-by-project where a project's only task is pinned, so the project row
// has nothing left to show. What the row says about itself — disclosure,
// action placement, the hover card's task count — has to follow what is
// actually under it, and an archived project sits below the live ones.
export const ProjectGroupsPinnedOnlyTask: Story = {
  render: () => {
    const solo = makeProject({
      id: 'project-solo',
      name: '独苗项目',
      preferredPath: '/workspace/solo',
    });
    const docs = makeProject({
      id: 'project-docs',
      name: '产品文档',
      preferredPath: '/workspace/docs',
    });
    const retired = makeProject({
      id: 'project-retired',
      name: '旧版桌面端',
      preferredPath: '/workspace/legacy',
      archivedAt: NOW - 30 * 24 * 60 * 60 * 1000,
    });
    const sessions = [
      makeSession({
        id: 'solo-only',
        name: '唯一的任务',
        isFlagged: true,
        lastMessageAt: NOW - 6 * 60 * 1000,
      }),
      makeSession({
        id: 'docs-a',
        name: '文档站改版',
        lastMessageAt: NOW - 30 * 60 * 1000,
      }),
      makeSession({
        id: 'retired-a',
        name: '旧版遗留任务',
        lastMessageAt: NOW - 40 * 24 * 60 * 60 * 1000,
      }),
    ];
    return (
      <StoryFrame height={720}>
        <SessionRail
          {...panelProps({
            sessions,
            activeId: 'docs-a',
            viewMode: 'project',
            groups: [
              {
                id: `project:${solo.id}`,
                label: solo.name,
                project: solo,
                sessions: [sessions[0]!],
              },
              {
                id: `project:${docs.id}`,
                label: docs.name,
                project: docs,
                sessions: [sessions[1]!],
              },
              {
                id: `project:${retired.id}`,
                label: retired.name,
                project: retired,
                sessions: [sessions[2]!],
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
