import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState, type ReactNode } from 'react';
import type { ComponentProps } from 'react';
import type { ProjectRecord, SessionSummary, StoredMessage } from '@maka/core';
import { ChatSurfaceLayout, ChatView, Composer, SessionListPanel } from '@maka/ui';
import type { ChatModelChoice, SessionViewMode } from '@maka/ui';
import { AppShellTopbarActions, AppShellWorkspaceTopActions } from '../src/renderer/app-shell-chrome-actions';
import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell';
import type { SideNavImperativeCollapseHandle } from '@astryxdesign/core/SideNav';

const NOW = Date.UTC(2026, 6, 1, 9, 30, 0);

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Shell Official AppShell',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
type ChatViewProps = ComponentProps<typeof ChatView>;
type ComposerProps = ComponentProps<typeof Composer>;
type SessionListPanelProps = ComponentProps<typeof SessionListPanel>;
type SessionGroup = NonNullable<SessionListPanelProps['groups']>[number];

const noop = () => undefined;

const modelChoices: ChatModelChoice[] = [
  {
    connectionSlug: 'anthropic-main',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
  },
  {
    connectionSlug: 'openai-main',
    providerType: 'openai',
    model: 'gpt-5.1',
    label: 'GPT-5.1',
  },
];

function makeSession(input: {
  id: string;
  name: string;
  status?: SessionSummary['status'];
  lastMessageAt?: number;
  isFlagged?: boolean;
  hasUnread?: boolean;
  projectId?: string;
  cwd?: string;
}): SessionSummary {
  return {
    id: input.id,
    name: input.name,
    isFlagged: input.isFlagged ?? false,
    isArchived: false,
    labels: [],
    hasUnread: input.hasUnread ?? false,
    status: input.status ?? 'active',
    lastMessageAt: input.lastMessageAt ?? NOW - 12 * 60_000,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: false,
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
  };
}

const sidebarSessions: SessionSummary[] = [
  makeSession({ id: 'session-running', name: '生成本周 benchmark 对比表', status: 'running', lastMessageAt: NOW - 2 * 60_000, projectId: 'project-maka', cwd: '/workspace/maka-agent' }),
  makeSession({ id: 'session-active', name: '整理 Storybook 表面覆盖', lastMessageAt: NOW - 14 * 60_000, hasUnread: true, projectId: 'project-maka', cwd: '/workspace/maka-agent/.worktree/storybook' }),
  makeSession({ id: 'session-waiting', name: '等待权限确认的部署任务', status: 'waiting_for_user', lastMessageAt: NOW - 8 * 60_000, projectId: 'project-docs', cwd: '/workspace/docs' }),
  makeSession({ id: 'session-pinned', name: 'PR #435 发布风险清单', lastMessageAt: NOW - 76 * 60_000, isFlagged: true, projectId: 'project-maka', cwd: '/workspace/maka-agent' }),
  makeSession({ id: 'session-review', name: '已完成的 smoke 回归', status: 'done', lastMessageAt: NOW - 3 * 60 * 60_000, projectId: 'project-archived', cwd: '/workspace/legacy' }),
];

function project(input: Partial<ProjectRecord> & Pick<ProjectRecord, 'id' | 'name'>): ProjectRecord {
  return {
    locations: [],
    available: true,
    ...input,
  };
}

const catalogProjects: ProjectRecord[] = [
  project({
    id: 'project-maka',
    name: 'maka-agent',
    preferredPath: '/workspace/maka-agent',
    locations: [
      { path: '/workspace/maka-agent', isWorktree: false },
      { path: '/workspace/maka-agent/.worktree/storybook', isWorktree: true },
    ],
  }),
  project({ id: 'project-docs', name: '产品文档', preferredPath: '/workspace/docs' }),
  project({ id: 'project-missing', name: '旧版桌面端', available: false }),
  ...Array.from({ length: 7 }, (_, index) =>
    project({ id: `project-recent-${index}`, name: `最近项目 ${index + 1}` })),
  project({ id: 'project-archived', name: '历史实验', archivedAt: NOW - 86_400_000 }),
];

const sidebarRowActions: NonNullable<SessionListPanelProps['rowActions']> = {
  onToggleFlag: noop,
  onArchive: noop,
  onUnarchive: noop,
  onRename: noop,
  onDelete: noop,
};
const projectRowActions: NonNullable<SessionListPanelProps['projectActions']> = {
  onNew: noop,
  onRename: noop,
  onArchive: noop,
  onRestore: noop,
  onRelink: noop,
};

const activeSession = sidebarSessions[1];

function user(id: string, turnId: string, minutesAgo: number, text: string): StoredMessage {
  return { type: 'user', id, turnId, ts: NOW - minutesAgo * 60_000, text };
}

function assistant(id: string, turnId: string, minutesAgo: number, text: string): StoredMessage {
  return { type: 'assistant', id, turnId, ts: NOW - minutesAgo * 60_000, text, modelId: 'claude-sonnet-4-5' };
}

const conversation: StoredMessage[] = [
  user('msg-1', 'turn-1', 14, '帮我把这轮 Storybook 覆盖的风险列出来，只保留真正会影响 review 的部分。'),
  assistant('msg-2', 'turn-1', 12, '现在最值得先固定的是几个高频但还没有 story 的页面：权限弹窗、顶层布局、首次启动引导。把它们的可见状态摆出来，reviewer 就能在 Storybook 里逐个看，不用手动把 app 驱动到这些路径。'),
  user('msg-3', 'turn-2', 6, '顶层布局怎么处理？它依赖很多 IPC。'),
  assistant('msg-4', 'turn-2', 4, '直接挂载 Astryx AppShell，并通过官方 topNav、sideNav 和 content 插槽组合真实侧栏、聊天区与标题栏。Story 只隔离 IPC，布局 authority 与产品保持一致。'),
];

const baseChatProps: ChatViewProps = {
  messages: conversation,
  activeSession,
  activeConnectionLabel: 'Anthropic',
  activeModel: 'claude-sonnet-4-5',
  activeModelLabel: 'Claude Sonnet 4.5',
  modelChoices,
  userLabel: '你',
  onNew: noop,
  onPromptSuggestion: noop,
};

const baseComposerProps: ComposerProps = {
  draftKey: 'storybook-app-shell',
  onSend: noop,
  onStop: noop,
  modelLabel: 'Claude Sonnet 4.5',
  activeSession,
  activeConnectionLabel: 'Anthropic',
  activeModel: 'claude-sonnet-4-5',
  activeModelLabel: 'Claude Sonnet 4.5',
  modelChoices,
  permissionMode: 'ask',
  onPermissionModeChange: noop,
  // Fidelity: production app-shell always wires these (app-shell.tsx
  // ~1851-1960), so the daily composer renders the upload button, the
  // modes menu (Plan / Swarm), and the Skills picker. Omitting them here
  // understated the persistent element count in every shell story.
  onPickAttachments: noop,
  planModeActive: false,
  onPlanModeChange: noop,
  swarmModeActive: false,
  onSwarmModeChange: noop,
  mentionSkills: [
    { ref: 'user:pdf', id: 'pdf', name: 'PDF 工具', description: '读取、拆分与合并 PDF' },
    { ref: 'user:commit', id: 'commit', name: 'Commit', description: '生成提交信息' },
    { ref: 'project:review', id: 'review', name: 'Code Review', description: '按仓库规范审查改动' },
  ],
  workspacePicker: {
    label: 'maka-agent',
    branch: 'opencode/storybook-surface-coverage',
    projects: catalogProjects.filter((item) => item.archivedAt === undefined),
    selectedProjectId: 'project-maka',
    onAdd: noop,
    onSelectProject: noop,
    onRelink: noop,
    onSelectNoProject: noop,
  },
};

function ShellFrame(props: { children: ReactNode; motionEnabled?: boolean }) {
  return (
    <div
      data-maka-e2e-fixture={props.motionEnabled ? undefined : 'true'}
      style={{ background: 'var(--surface-canvas)', height: '100%', minHeight: 640 }}
    >
      {props.children}
    </div>
  );
}

// Production-faithful shell composition: Astryx AppShell owns the frame,
// SideNav owns sidebar geometry, and Maka supplies only Electron chrome and
// product content through their public slots.
function ComposedShell(props: {
  sidebarCollapsed?: boolean;
  initialViewMode?: SessionViewMode;
  /**
   * The ONE active-session scenario. ComposedShell projects it across the
   * sidebar row, the chat header, and the composer, so the three regions
   * can never disagree about what state the active session is in (review
   * P2: stories used to patch each region independently and drifted).
   * `streaming` additionally marks the active session as live-streaming
   * and flips the composer into its streaming state.
   */
  session?: {
    status?: SessionSummary['status'];
    blockedReason?: SessionSummary['blockedReason'];
    streaming?: boolean;
  };
  chat?: Partial<ChatViewProps>;
  composer?: Partial<ComposerProps>;
  detailChildren?: ReactNode;
  motionEnabled?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(props.sidebarCollapsed ?? false);
  const sidebarHandleRef = useRef<SideNavImperativeCollapseHandle>(null);
  const [viewMode, setViewMode] = useState<SessionViewMode>(props.initialViewMode ?? 'conversation');
  const sidebarWidth = 260;
  const sessions = sidebarSessions.map((s) =>
    s.id === activeSession.id && (props.session?.status || props.session?.blockedReason)
      ? { ...s, status: props.session.status ?? s.status, blockedReason: props.session.blockedReason ?? s.blockedReason }
      : s,
  );
  const active = sessions.find((s) => s.id === activeSession.id) ?? activeSession;
  const streamingIds = new Set(
    props.session?.streaming ? ['session-running', active.id] : ['session-running'],
  );
  const projectGroups: SessionGroup[] = catalogProjects.map((item) => ({
    id: `project:${item.id}`,
    label: item.name,
    project: item,
    sessions: sessions.filter((session) => session.projectId === item.id),
  }));

  return (
    <ShellFrame motionEnabled={props.motionEnabled}>
      <AstryxAppShell
        className="app maka-shell-astryx agents-layout-body"
        variant="surface"
        height="fill"
        contentPadding={0}
        mobileNav={{ breakpoint: 'none', hasToggle: false }}
        data-sidebar-state={collapsed ? 'collapsed' : 'expanded'}
        topNav={
          <header className="maka-window-titlebar">
            <AppShellTopbarActions
              sidebarCollapsed={collapsed}
              sidebarHandleRef={sidebarHandleRef}
              onOpenSearchModal={noop}
              onCreateSession={noop}
            />
            <AppShellWorkspaceTopActions
              workbarAvailable
              workbarCollapsed={false}
              onToggleWorkbar={noop}
              onOpenFeedback={noop}
              onOpenPalette={noop}
              onOpenHelp={noop}
              onOpenHealth={noop}
            />
          </header>
        }
        sideNav={
          <SessionListPanel
            collapseHandleRef={sidebarHandleRef}
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            width={sidebarWidth}
            onWidthChange={noop}
            minWidth={180}
            maxWidth={480}
            selection={{ section: 'sessions', filter: 'chats' }}
            sessions={sessions}
            activeId={active.id}
            groups={viewMode === 'project' ? projectGroups : undefined}
            streamingSessionIds={streamingIds}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            onSelect={noop}
            onSelectSession={noop}
            onOpenSettings={noop}
            onNew={noop}
            rowActions={sidebarRowActions}
            projectActions={projectRowActions}
            worktreeSessionIds={new Set(['session-active'])}
          />
        }
      >
        <div
          className="maka-panel maka-panel-detail agents-parchment-paper-surface"
          data-sidebar-state={collapsed ? 'collapsed' : 'expanded'}
          data-agents-view="im_hub"
          style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
        >
          {props.detailChildren ?? (
            <div style={{ display: 'flex', minHeight: 0, width: '100%', flexDirection: 'column', flex: 1 }}>
              <ChatSurfaceLayout
                composer={
                  <div style={{ padding: '0 16px 16px' }}>
                    <Composer
                      {...baseComposerProps}
                      activeSession={active}
                      streaming={props.session?.streaming ?? false}
                      {...props.composer}
                    />
                  </div>
                }
              >
                <ChatView {...baseChatProps} activeSession={active} {...props.chat} />
              </ChatSurfaceLayout>
            </div>
          )}
        </div>
      </AstryxAppShell>
    </ShellFrame>
  );
}

// Real path: returning user with session history → open a session that has
// messages (sidebar expanded, composer ready).
export const DefaultLayout: Story = {
  render: () => <ComposedShell />,
};

// Real path: send a message → the turn is streaming (composer shows the
// stop button and the streaming hint).
export const StreamingTurn: Story = {
  render: () => (
    <ComposedShell
      session={{ status: 'running', streaming: true }}
      chat={{
        messages: [
          user('msg-s-1', 'turn-s', 3, '顶层布局的 story 怎么做最稳？'),
          { type: 'turn_state', id: 'state-s', turnId: 'turn-s', ts: NOW - 30_000, status: 'running', partialOutputRetained: false },
        ],
        liveTurn: {
          turnId: 'turn-s', phase: 'streamed', steps: [{
            stepId: 'msg-assistant-s',
            text: { text: '直接挂载 Astryx AppShell，通过官方插槽组合真实产品子组件，只隔离 IPC。', truncated: false, complete: false },
            tools: [],
          }],
        },
      }}
    />
  ),
};

// Real path: the agent calls a tool that needs approval → session enters
// waiting_for_user, composer is disabled, the permission-mode picker is
// locked with an explanatory reason.
export const WaitingForPermission: Story = {
  render: () => (
    <ComposedShell
      session={{ status: 'waiting_for_user', blockedReason: 'permission_required' }}
      composer={{
        disabled: true,
        permissionModeDisabledReason: '当前有工具调用正在等待确认，处理后再切换权限模式。',
      }}
    />
  ),
};

// Real path: any user with onboarding finished → start a new chat, or open a
// session with no messages yet. This is the ONLY empty home: ChatView falls
// back to its built-in EmptyChatHero (greeting + composer). Do NOT render
// OnboardingHero here — #1433 narrowed the hero's gate to unfinished setup, so
// a configured user with zero sessions now lands on this same empty chat, not
// on a first-run screen. The setup states are covered by Product/Onboarding;
// presenting one of them as the empty home makes every comparison against this
// story wrong.
//
// Scope: the chat surface, not the whole shell. ComposedShell always projects
// one active session across the sidebar, header and composer so those three
// cannot disagree, so what this story shows is the empty chat WITH history
// present. The zero-session shell differs only in the sidebar; a story for it
// would mean making the active session optional throughout ComposedShell, and
// nothing renders differently in the detail pane.
export const EmptyHome: Story = {
  render: () => <ComposedShell chat={{ messages: [] }} />,
};
