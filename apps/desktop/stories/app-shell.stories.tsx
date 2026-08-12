import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type CSSProperties, type ReactNode } from 'react';
import type { ComponentProps } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import {
  ChatSurfaceLayout,
  ChatView,
  Composer,
  deriveTitlebarProjectName,
  SessionListPanel,
  TitlebarSessionIdentity,
} from '@maka/ui';
import type { ChatModelChoice, SessionViewMode, TurnViewModel } from '@maka/ui';
import { AppShellTopbarActions, AppShellWorkspaceTopActions } from '../src/renderer/app-shell-chrome-actions';
import { AppShellDetailPanel } from '../src/renderer/app-shell-detail-panel';
import { deriveAppShellTurnPresentation } from '../src/renderer/app-shell-turn-view-model';
import { deriveBranchBanner } from '../src/renderer/branch-banner';
import { deriveSessionRevisionNavigation } from '../src/renderer/session-revisions';
import { deriveSessionRail } from '../src/renderer/session-rail';
import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell';

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
    providerLabel: 'Anthropic',
    model: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    isDefault: true,
    thinkingLevels: [],
  },
  {
    connectionSlug: 'openai-main',
    providerType: 'openai',
    providerLabel: 'OpenAI',
    model: 'gpt-5.1',
    label: 'GPT-5.1',
    isDefault: true,
    thinkingLevels: [],
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

function user(
  id: string,
  turnId: string,
  minutesAgo: number,
  text: string,
): Extract<StoredMessage, { type: 'user' }> {
  return { type: 'user', id, turnId, ts: NOW - minutesAgo * 60_000, text };
}

function assistant(id: string, turnId: string, minutesAgo: number, text: string): StoredMessage {
  return { type: 'assistant', id, turnId, ts: NOW - minutesAgo * 60_000, text, modelId: 'claude-sonnet-4-5' };
}

const conversation: StoredMessage[] = [
  user('msg-1', 'turn-1', 14, '帮我把这轮 Storybook 覆盖的风险列出来，只保留真正会影响 review 的部分。'),
  assistant('msg-2', 'turn-1', 12, '现在最值得先固定的是几个高频但还没有 story 的页面：权限弹窗、顶层布局、首次启动引导。把它们的可见状态摆出来，reviewer 就能在 Storybook 里逐个看，不用手动把 app 驱动到这些路径。'),
  user('msg-3', 'turn-2', 6, '顶层布局怎么处理？它依赖很多 IPC。'),
  assistant('msg-4', 'turn-2', 4, '直接挂载 Astryx AppShell 的 sideNav 与 content 列，窗体标题栏作为透明 drag 叠层挂在 frame 上。Story 只隔离 IPC，布局 authority 与产品保持一致。'),
];

const baseChatProps: ChatViewProps = {
  messages: conversation,
  scrollBehavior: 'smooth',
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
  // Production wires this whenever the shell has a project catalog
  // (app-shell.tsx), unconditionally: the composer renders it only while no
  // session owns it, so the active-session stories below carry it without
  // showing it.
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
  onSend: noop,
  onStop: noop,
  modelLabel: 'Claude Sonnet 4.5',
  activeSession,
  activeConnectionLabel: 'Anthropic',
  activeModel: 'claude-sonnet-4-5',
  activeModelLabel: 'Claude Sonnet 4.5',
  modelChoices,
  // Production always wires this (app-shell.tsx); without it ChatModelSwitcher
  // renders disabled, so every shell story understated the composer.
  onModelChange: noop,
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
  graphModeActive: false,
  onGraphModeChange: noop,
  // Thinking is a separate right-footer Selector when levels are offered.
  activeThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
  activeThinkingLevel: 'medium',
  onThinkingLevelChange: noop,
  mentionSkills: [
    { id: 'pdf', name: 'PDF 工具', description: '读取、拆分与合并 PDF' },
    { id: 'commit', name: 'Commit', description: '生成提交信息' },
    { id: 'review', name: 'Code Review', description: '按仓库规范审查改动' },
  ],
};

function ShellFrame(props: {
  children: ReactNode;
  motionEnabled?: boolean;
  sidebarCollapsed?: boolean;
}) {
  return (
    <div
      className="appFrame agents-layout-root"
      data-maka-e2e-fixture={props.motionEnabled ? undefined : 'true'}
      /* Production writes this on the frame and keys collapsed-state rules off
         it (app-shell.tsx). Without it here the story renders a state the app
         does not have — the collapsed rail kept its footer hairline in
         Storybook while the app dropped it — and these stories are the pixel
         review surface, so the drift lands exactly where it is trusted. */
      data-sidebar-state={props.sidebarCollapsed ? 'collapsed' : 'expanded'}
      style={
        {
          height: '100%',
          minHeight: 640,
          /* Same publication point as production, for the same reason as
             `data-sidebar-state` above: the titlebar's first grid track is a
             `calc()` on this variable, and an unset variable makes the whole
             track list invalid — the breadcrumb then parks against the icon
             rail instead of the plate seam, so the seam and truncation stories
             would be reviewing a layout the app never renders. Collapsed is
             left to the CSS rule, exactly as in the app.
             `SessionListPanel`'s own default width. */
          ...(props.sidebarCollapsed ? null : { '--maka-sidenav-width': '260px' }),
        } as CSSProperties
      }
    >
      {props.children}
    </div>
  );
}

// Production-faithful shell composition: Astryx AppShell owns the columns;
// window chrome is a transparent frame-level drag overlay (not topNav).
function ComposedShell(props: {
  sidebarCollapsed?: boolean;
  initialViewMode?: SessionViewMode;
  /**
   * The ONE active-session scenario, as an overlay on the sidebar's active
   * row. ComposedShell projects the result across the sidebar row, the chat
   * header, and the composer, so the three regions can never disagree about
   * what state the active session is in (review P2: stories used to patch
   * each region independently and drifted). `streaming` additionally marks
   * the active session as live-streaming and flips the composer into its
   * streaming state. `id` is excluded: the sidebar row, the header and the
   * composer are all located by the fixed active id, so overriding it would
   * desynchronize exactly what this projection exists to keep together.
   *
   * `null` means there is no active session at all — the 新任务 state, where
   * production hands ChatView and Composer `undefined` and the composer swaps
   * ChatModelSwitcher for NewChatModelPicker.
   */
  session?: (Omit<Partial<SessionSummary>, 'id'> & { streaming?: boolean }) | null;
  chat?: Partial<ChatViewProps>;
  composer?: Partial<ComposerProps>;
  detailChildren?: ReactNode;
  motionEnabled?: boolean;
  /**
   * Extra sessions the sidebar shows alongside the fixed catalog. Lineage
   * states need them: production derives the branch banner and the revision
   * navigation from the visible session list, so a story asks for the state by
   * supplying the relatives, not by hand-writing what the helpers would return.
   */
  relatedSessions?: SessionSummary[];
  /** Drives the footer's update action; `undefined` is the silent phase. */
  updateReminder?: SessionListPanelProps['updateReminder'];
}) {
  const [collapsed, setCollapsed] = useState(props.sidebarCollapsed ?? false);
  const [viewMode, setViewMode] = useState<SessionViewMode>(props.initialViewMode ?? 'conversation');
  const sidebarWidth = 260;
  const { streaming: sessionStreaming, ...sessionOverrides } = props.session ?? {};
  const sessions = [
    ...sidebarSessions.map((s) => (s.id === activeSession.id ? { ...s, ...sessionOverrides } : s)),
    ...(props.relatedSessions ?? []),
  ];
  const active =
    props.session === null
      ? undefined
      : (sessions.find((s) => s.id === activeSession.id) ?? activeSession);
  const streamingIds = new Set(
    sessionStreaming && active ? ['session-running', active.id] : ['session-running'],
  );
  // Same helpers the renderer calls (app-shell.tsx). Deriving here rather than
  // letting a story pass a banner or a footer-action list keeps a story from
  // showing lineage the production rules would not produce for its sessions.
  const branchBanner = deriveBranchBanner(active, sessions);
  const revisionNavigation = deriveSessionRevisionNavigation(sessions, active?.id);
  // Same rail projection as app-shell: revision-tree roots only (linked
  // children stay off the list). Stories include every fixture row.
  const { sessions: sidebarRows } = deriveSessionRail(sessions, active?.id, () => true);
  const messages = props.chat?.messages ?? baseChatProps.messages;
  // ChatView projects the transcript and calls this back with the turns, the
  // same seam production uses (app-shell.tsx), so a story cannot show footer
  // actions the production rules would not produce for its messages.
  const deriveTurnPresentation = (turns: readonly TurnViewModel[]) =>
    deriveAppShellTurnPresentation(turns, {
      activeId: active?.id,
      pendingTurnActions: new Set<string>(),
      uiLocale: 'zh',
      pendingKeyOf: (sessionId, turnId, actionId) => `${sessionId}:${turnId}:${actionId}`,
    });
  const projectGroups: SessionGroup[] = catalogProjects.map((item) => ({
    id: `project:${item.id}`,
    label: item.name,
    project: item,
    sessions: sidebarRows.filter((session) => session.projectId === item.id),
  }));

  return (
    <ShellFrame motionEnabled={props.motionEnabled} sidebarCollapsed={collapsed}>
      <header className="maka-window-titlebar">
        <AppShellTopbarActions
          sidebarCollapsed={collapsed}
          onToggleSidebar={() => setCollapsed((current) => !current)}
          onOpenSearchModal={noop}
        />
        {/* Derived from the same session and project catalog the sidebar reads,
            not hand-passed: a story cannot show a project the session does not
            belong to. Absent for the 新任务 state, where production has no
            session to name. */}
        {active && (
          <TitlebarSessionIdentity
            sessionName={active.name}
            onRenameSession={noop}
            project={(() => {
              const name = deriveTitlebarProjectName({
                projectName: catalogProjects.find((item) => item.id === active.projectId)?.name,
                projectPath: active.cwd,
              });
              return name ? { name, onOpenFolder: noop } : undefined;
            })()}
          />
        )}
        <AppShellWorkspaceTopActions
          workbarAvailable
          workbarCollapsed={false}
          onToggleWorkbar={noop}
        />
      </header>
      <AstryxAppShell
        className="app maka-shell-astryx agents-layout-body"
        /* Astryx's default: nav column takes --color-background-body, content takes
           --color-background-surface. Both point at the product palette through
           makaTheme.ts, so the shell follows a palette switch. Declared rather
           than defaulted — it decides what separates the two columns. */
        variant="elevated"
        height="fill"
        contentPadding={0}
        mobileNav={{ breakpoint: 'none', hasToggle: false }}
        sideNav={
          <SessionListPanel
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            width={sidebarWidth}
            onWidthChange={noop}
            minWidth={180}
            maxWidth={480}
            selection={{ section: 'sessions', filter: 'chats' }}
            sessions={sidebarRows}
            activeId={active?.id}
            groups={viewMode === 'project' ? projectGroups : undefined}
            streamingSessionIds={streamingIds}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            onSelect={noop}
            onSelectSession={noop}
            onOpenSettings={noop}
            updateReminder={props.updateReminder}
            onOpenUpdate={noop}
            onNew={noop}
            rowActions={sidebarRowActions}
            projectActions={projectRowActions}
            worktreeSessionIds={new Set(['session-active'])}
          />
        }
      >
        <AppShellDetailPanel agentsView="im_hub">
          {props.detailChildren ?? (
            // Same two wrappers the renderer puts between the detail panel and
            // the chat column (app-shell.tsx). `.mainColumn` owns composer
            // padding, so a story without it measures its own box.
            (<div className="maka-detail-with-artifacts">
              <div className="mainColumn">
              <ChatSurfaceLayout
                composer={
                  <Composer
                    {...baseComposerProps}
                    activeSession={active}
                    streaming={sessionStreaming ?? false}
                    {...props.composer}
                  />
                }
              >
                <ChatView
                  {...baseChatProps}
                  activeSession={active}
                  deriveTurnPresentation={deriveTurnPresentation}
                  {...props.chat}
                  branchBanner={branchBanner}
                  revisionNavigation={revisionNavigation}
                />
              </ChatSurfaceLayout>
              </div>
            </div>)
          )}
        </AppShellDetailPanel>
      </AstryxAppShell>
    </ShellFrame>
  );
}

// Real path: returning user with session history → open a session that has
// messages (sidebar expanded, composer ready).
export const DefaultLayout: Story = {
  render: () => <ComposedShell />,
};

// Real path: the updater finishes downloading in the background (autoDownload
// is on) → the footer's settings row grows an accent update button. Discovery
// and download show nothing, so this is the first moment the shell says
// anything about an update at all.
export const UpdateDownloaded: Story = {
  render: () => <ComposedShell updateReminder={{ state: 'downloaded', latestVersion: '0.1.7' }} />,
};

// Real path: the same download fails → same slot, muted variant, retry.
export const UpdateFailed: Story = {
  render: () => <ComposedShell updateReminder={{ state: 'error', latestVersion: '0.1.7' }} />,
};

// Real path: an update is waiting while the rail is collapsed to 48px. The row
// cannot hold two controls side by side there, so it stacks — off the frame's
// own `data-sidebar-state`, which is why ShellFrame above has to carry it.
export const UpdateDownloadedCollapsed: Story = {
  render: () => (
    <ComposedShell sidebarCollapsed updateReminder={{ state: 'downloaded', latestVersion: '0.1.7' }} />
  ),
};

// Real path: send a message → the turn is streaming (composer shows the
// stop button and the streaming hint).
export const StreamingTurn: Story = {
  render: () => (
    <ComposedShell
      session={{ status: 'running', streaming: true }}
      chat={{
        runningStatus: true,
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

// Real path: ask for something long-running → a tool has been going for
// minutes and the model has produced nothing to look at. The cue this replaced
// was hidden exactly here — it only covered the gap before the first content
// event — so this state used to offer no evidence the harness was still
// working.
//
// What renders is the frozen form: the shell frame carries the e2e-fixture
// attribute, and the elapsed clock is dropped rather than pinned under it,
// because any value it could print is a real wall-clock difference that would
// differ between two captures. In the app the same row reads
// "正在琢磨… · 2m 1s", with the phrase swapping every 20s.
export const RunningStatusDuringToolRun: Story = {
  render: () => (
    <ComposedShell
      session={{ status: 'running', streaming: true }}
      chat={{
        runningStatus: true,
        messages: [
          user('msg-t-1', 'turn-t', 2, '把整个测试套件跑一遍，看看那三个失败用例是不是同一个原因。'),
          { type: 'turn_state', id: 'state-t', turnId: 'turn-t', ts: NOW - 120_000, status: 'running', partialOutputRetained: false },
        ],
        liveTurn: {
          turnId: 'turn-t', phase: 'streamed', steps: [{
            stepId: 'msg-assistant-t',
            tools: [{
              toolUseId: 'tool-t-1',
              toolName: 'Bash',
              activityKind: 'command',
              status: 'running',
              args: { command: 'npm test' },
            }],
          }],
        },
      }}
    />
  ),
};

// Real path: the agent calls a tool that needs approval → session enters
// waiting_for_user and the permission-mode picker is locked with a reason.
//
// The composer stays usable: app-shell.tsx never passes `disabled` to
// ChatComposerRegion, so the textarea keeps accepting input while a tool waits.
// This story used to force disabled: true, which made a locked input look like
// the product's answer to waiting for permission.
export const WaitingForPermission: Story = {
  render: () => (
    <ComposedShell
      session={{ status: 'waiting_for_user', blockedReason: 'permission_required' }}
      composer={{
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
// Scope: an EXISTING session with no messages yet. Opening 新任务 is the other
// half and it is not the same screen — see NewChatComposer below — so this
// story is the one where the composer still binds to a session.
export const EmptyHome: Story = {
  render: () => <ComposedShell chat={{ messages: [] }} />,
};

// Real path: 新任务 → no session exists yet. The composer swaps
// ChatModelSwitcher for NewChatModelPicker and drops the thinking selector,
// because both are keyed on an active session (composer.tsx). That branch has
// no other story, so without this one nothing renders the picker a user meets
// before their first send.
export const NewChatComposer: Story = {
  render: () => (
    <ComposedShell
      session={null}
      chat={{ messages: [] }}
      composer={{
        newChatModel: { llmConnectionSlug: 'anthropic-main', model: 'claude-sonnet-4-5' },
        onPickNewChatModel: noop,
        onOpenModelSettings: noop,
      }}
    />
  ),
};

// Real path: 新任务 → 切换项目 → 项目 picker 处于 pending（切换中）。
// Production passes `pending: projectPickerPending` while a project switch is
// in flight; the trigger locks with a spinner and every menu row disables,
// matching the model switcher's mid-switch treatment.
export const NewChatComposerProjectPending: Story = {
  render: () => (
    <ComposedShell
      session={null}
      chat={{ messages: [] }}
      composer={{
        newChatModel: { llmConnectionSlug: 'anthropic-main', model: 'claude-sonnet-4-5' },
        onPickNewChatModel: noop,
        onOpenModelSettings: noop,
        workspacePicker: {
          ...baseComposerProps.workspacePicker!,
          pending: true,
        },
      }}
    />
  ),
};

const longConversation: StoredMessage[] = [
  user(
    'msg-user-long',
    'turn-long-1',
    42,
    [
      '我想把 Chat surface 的 review 状态固定下来，但不要把 PR 做大。',
      '请同时考虑窄窗口、很长的用户输入、很长的模型回复，以及 composer 被禁用时用户是否能看懂当前系统在等什么。',
      '这段消息故意很长，用来观察右侧用户气泡的换行、时间和复制按钮是否仍然稳。',
    ].join('\n\n'),
  ),
  assistant(
    'msg-assistant-long',
    'turn-long-1',
    39,
    [
      '可以按状态板而不是重构来切。',
      '',
      '第一步只把可见状态摆出来：空态、streaming、tool activity、branch banner、import actions、disabled composer 和长消息。第二步才进入 polish。这样 reviewer 能在 Storybook 里逐个看状态，而不需要手动把桌面 app 驱动到这些路径。',
      '',
      '- 空态用于确认初始引导没有被 app shell 依赖卡住。',
      '- streaming 用于确认 live bubble 与 composer stop 状态同时出现。',
      '- long messages 用于确认阅读列、用户气泡和 markdown 内容不会互相挤压。',
      '',
      '这个 story 不评价最终视觉，只提供稳定的 review 基线。',
    ].join('\n'),
  ),
  user('msg-user-long-2', 'turn-long-2', 34, '再给一个短问题：如果工具调用失败，这个 PR 要覆盖吗？'),
  assistant(
    'msg-assistant-long-2',
    'turn-long-2',
    33,
    '不用。失败、截断、overlay preview 等细分工具状态属于 ToolActivity storyboard。Chat surface 这里只需要证明工具活动能嵌入对话。',
  ),
];

// Multi-step reasoning turn: two think->say->call steps
// in a single turn. Each step persists an assistant row (thinking + text) plus
// tool_calls tagged with that row's id as `stepId`, so the turn timeline
// reconstructs the real order — 深度思考 → answer text → tool row — per step,
// instead of lumping every tool into one trailing group.
const multiStepConversation: StoredMessage[] = [
  user('msg-user-multistep', 'turn-multistep', 12, '看一下 assistant-stream 的投影逻辑有没有边界问题，然后跑一下单测。'),
  {
    type: 'tool_call',
    id: 'tool-read-assistant-stream',
    turnId: 'turn-multistep',
    ts: NOW - 11 * 60_000,
    toolName: 'Read',
    displayName: '读取 assistant-stream.ts',
    intent: '读取 assistant delta 的脱敏与截断边界',
    stepId: 'msg-assistant-step-1',
    args: { file_path: 'packages/ui/src/assistant-stream.ts' },
  },
  {
    type: 'tool_result',
    id: 'tool-read-assistant-stream-result',
    turnId: 'turn-multistep',
    ts: NOW - 11 * 60_000 + 900,
    toolUseId: 'tool-read-assistant-stream',
    isError: false,
    durationMs: 640,
    content: {
      kind: 'text',
      text: 'export function applyAssistantDelta(...) { /* redact + cap */ }',
    },
  },
  {
    type: 'assistant',
    id: 'msg-assistant-step-1',
    turnId: 'turn-multistep',
    ts: NOW - 10 * 60_000,
    text: '状态边界顺序正确：delta 先脱敏，append 后覆盖跨 delta 密钥，再执行总量截断。接下来我跑一下单测确认。',
    thinking: {
      text: '重点确认原始 delta 不会先进入状态，跨 delta 拼接后会再次脱敏，并且总量上限保留用户正在阅读的前缀。',
    },
    modelId: 'claude-sonnet-4-5',
  },
  {
    type: 'tool_call',
    id: 'tool-run-tests',
    turnId: 'turn-multistep',
    ts: NOW - 10 * 60_000 + 500,
    toolName: 'Bash',
    displayName: '运行 assistant-stream 单测',
    intent: '执行 assistant stream 脱敏与截断单测',
    stepId: 'msg-assistant-step-2',
    args: { cmd: 'node --test dist/main/__tests__/assistant-stream.test.js' },
  },
  {
    type: 'tool_result',
    id: 'tool-run-tests-result',
    turnId: 'turn-multistep',
    ts: NOW - 9 * 60_000,
    toolUseId: 'tool-run-tests',
    isError: false,
    durationMs: 1930,
    content: {
      kind: 'terminal',
      cwd: '/workspace/maka-agent/apps/desktop',
      cmd: 'node --test dist/main/__tests__/assistant-stream.test.js',
      status: 'completed',
      exitCode: 0,
      output: {
        mode: 'pipes',
        stdout: 'tests 8\npass 8\nfail 0\n',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    },
  },
  {
    type: 'assistant',
    id: 'msg-assistant-step-2',
    turnId: 'turn-multistep',
    ts: NOW - 8 * 60_000,
    text: '13 个单测全绿，环的窗口滑动、乱序快照取龄和上限都被覆盖。边界没有问题。',
    thinking: {
      text: '测试包含窗口滑动、乱序 age 查询与上限三类，全过说明剪枝和 cap 的顺序是对的，可以收尾。',
    },
    modelId: 'claude-sonnet-4-5',
  },
];

// A ScheduledTask injects this turn; the transcript marks that
// provenance above the user bubble instead of impersonating typed input.
// Migrated here from the deleted chat-surface catalog (#1853): the marker is a
// transcript detail, and rendering an eighth shell around it would be the
// duplication this PR removes. That story carried a `play` assertion on the
// marker's line height, but product contracts do not belong in catalog
// interactions. The provenance contract now lives where it runs, in
// packages/ui/src/__tests__/host-origin-presentation.test.tsx; CI mounts this
// story without autoplay.
const scheduledTaskTurn: StoredMessage[] = [
  {
    ...user('msg-user-scheduled-task', 'turn-scheduled-task', 6, '生成今日项目回顾'),
    origin: { kind: 'scheduled_task', scheduledTaskId: 'daily-review' },
  },
  assistant('msg-assistant-scheduled-task', 'turn-scheduled-task', 5, '今日项目回顾已生成。'),
];

// Real path: a long session that has accumulated reasoning, several native
// Astryx tool calls and long prose, a ScheduledTask-triggered turn, with an image
// staged in the composer and thinking set to medium. Each part is individually
// reachable; they are stacked into one screen on purpose, as the canonical
// visual-acceptance scaffold for the transcript. Open this first, then the
// focused stories above.
export const NativeConversation: Story = {
  render: () => (
    <ComposedShell
      chat={{
        messages: [...longConversation, ...multiStepConversation, ...scheduledTaskTurn],
        memoryActive: true,
        onOpenMemorySettings: noop,
      }}
      composer={{
        pendingAttachments: [
          {
            displayName: 'chat-surface-review.png',
            kind: 'image',
            mimeType: 'image/png',
            size: 284_160,
          },
        ],
        onRemoveAttachment: noop,
      }}
    />
  ),
};

// The relatives that make the active session a branch AND revision 2 of 3.
// ComposedShell feeds them to the production derive helpers, so the banner and
// the revision counter appear only if the real rules still produce them.
//
// The shape follows what `reviseBeforeTurn` actually writes: the root keeps no
// revision fields and each revision gets all five, which is also what the store
// enforces — `isValidRevisionLineage` accepts the five together or not at all,
// and rejects any index below 2. Revising a branched session keeps its
// parentSessionId, so branch and revision lineage coexist by design.
const REVISION_ROOT_ID = 'session-active-v1';

function revision(input: {
  id: string;
  name: string;
  parentRevisionId: string;
  index: number;
}): SessionSummary {
  return {
    ...makeSession({ id: input.id, name: input.name }),
    parentSessionId: 'session-parent',
    branchOfTurnId: 'turn-1',
    revisionRootSessionId: REVISION_ROOT_ID,
    revisionParentSessionId: input.parentRevisionId,
    revisionOfTurnId: 'turn-1',
    revisionIndex: input.index,
    revisionState: 'committed',
  };
}

const LINEAGE_SESSIONS: SessionSummary[] = [
  makeSession({
    id: 'session-parent',
    name: 'UI polish 主线评审与跨会话来源追踪的完整上下文',
    lastMessageAt: NOW - 90 * 60_000,
  }),
  {
    ...makeSession({ id: REVISION_ROOT_ID, name: 'Session Context Layer 收敛（初版）' }),
    parentSessionId: 'session-parent',
    branchOfTurnId: 'turn-1',
  },
  revision({
    id: 'session-active-v3',
    name: 'Session Context Layer 收敛（第三版）',
    parentRevisionId: 'session-active',
    index: 3,
  }),
];

// Real path: open a derived revision that is running an autonomous goal with
// local memory and Deep Research enabled. Session metadata stays in one context
// layer above the transcript instead of splitting across header pills and
// standalone branch/revision rows. The long session name is the point: it is
// what forces that layer to collapse rather than wrap.
//
// The banner reads 分自 without 从中断前: deriveBranchBanner only adds that hint
// when the caller supplies it, and the renderer deliberately does not until
// parent-message preloading lands (app-shell.tsx). A story that showed it would
// be showing a screen the app cannot currently produce.
export const SessionContextLayer: Story = {
  render: () => (
    <ComposedShell
      relatedSessions={LINEAGE_SESSIONS}
      session={{
        name: 'Chat Surface 会话上下文在极窄窗口中的响应式收敛与信息优先级验证',
        labels: ['mode:deep_research'],
        parentSessionId: 'session-parent',
        branchOfTurnId: 'turn-1',
        revisionRootSessionId: REVISION_ROOT_ID,
        revisionParentSessionId: REVISION_ROOT_ID,
        revisionOfTurnId: 'turn-1',
        revisionIndex: 2,
        revisionState: 'committed',
      }}
      chat={{
        memoryActive: true,
        onOpenMemorySettings: noop,
        goalIndicator: {
          condition: '把 Session Context Layer 收敛到可 review 状态',
          status: 'active',
          iterations: 4,
          maxIterations: 12,
          onClear: noop,
        },
        onBranchBannerClick: noop,
        onRevisionNavigate: noop,
      }}
    />
  ),
};

// The titlebar states the session's identity in every session view, so the
// stories above already show its ordinary state. These two cover what they
// cannot: a session with no directory to name, and a name long enough to reach
// the action cluster.

// Real path: a session started before any project was picked. The breadcrumb
// collapses to the session name — a leading empty crumb would read as a project
// whose name failed to load.
export const TitlebarIdentityWithoutProject: Story = {
  render: () => <ComposedShell session={{ projectId: null, cwd: undefined }} />,
};

// Real path: a long auto-generated session name, sidebar collapsed so the
// identity sits closest to the conversation column. It must truncate itself
// rather than push the workbar toggle off the strip.
export const TitlebarIdentityTruncated: Story = {
  render: () => (
    <ComposedShell
      sidebarCollapsed
      session={{
        name: 'Chat Surface 会话上下文在极窄窗口中的响应式收敛与信息优先级验证',
      }}
    />
  ),
};

// Real path: 开启 Plan Mode from the ＋ menu. The mode is session-scoped — it
// survives the send — so it reads as a mark at the tail of the composer's
// footer controls rather than as staged context in the drawer (#1897). It
// trails the model + thinking pair so switching it never shifts those two.
export const PlanModeOn: Story = {
  render: () => <ComposedShell composer={{ planModeActive: true }} />,
};

// Real path: the same for the orchestration side. All marks share the one
// product accent, so the icon is what has to keep the modes distinguishable —
// this story is where that carries its own weight.
export const SwarmModeOn: Story = {
  render: () => <ComposedShell composer={{ swarmModeActive: true }} />,
};

// Real path: Plan and Swarm are independent switches (collaborationMode vs
// orchestrationMode), so both can be on at once. This is the widest the mode
// tail ever gets next to a real model name.
export const PlanAndSwarmModeOn: Story = {
  render: () => (
    <ComposedShell composer={{ planModeActive: true, swarmModeActive: true }} />
  ),
};

// Real path: a mode is on AND context is staged for the next send. The point of
// the story is the split: the drawer badge counts the two attachments only,
// while Plan reads off the footer — the mode is not something the send consumes.
export const ModeOnWithPendingAttachments: Story = {
  render: () => (
    <ComposedShell
      composer={{
        planModeActive: true,
        pendingAttachments: [
          { displayName: 'design-review.pdf', kind: 'pdf', size: 182_400 },
          { displayName: 'composer.tsx', kind: 'code', size: 41_200 },
        ],
        onRemoveAttachment: noop,
      }}
    />
  ),
};
