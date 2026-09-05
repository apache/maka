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

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { ComponentProps } from 'react';
import type { ProjectRecord } from '@maka/core/project';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import {
  ChatSurfaceLayout,
  ChatView,
  Composer,
  deriveTitlebarProjectName,
  TitlebarSessionIdentity,
} from '@maka/ui';
import type { ChatModelChoice, SessionViewMode, TurnViewModel } from '@maka/ui';
import { SessionRail, type SessionRailStoryProps } from '../../../packages/ui/stories/session-rail-harness.js';
import { AppShellTopbarActions } from '../src/renderer/app-shell-chrome-actions';
import { WorkbarTitlebarActions } from '../src/renderer/features/workbar';
import { AppShellDetailPanel } from '../src/renderer/app-shell-detail-panel';
import { deriveAppShellTurnPresentation } from '../src/renderer/app-shell-turn-view-model';
import {
  deriveBranchBanner,
  deriveSessionRail,
  deriveSessionRevisionNavigation,
} from '../src/renderer/features/session-navigation/testing';
import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell';
import { GoalDialog } from '../src/renderer/features/goals/testing';

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
type SessionListPanelProps = SessionRailStoryProps;
type SessionGroup = NonNullable<SessionListPanelProps['groups']>[number];

const noop = () => undefined;

const modelChoices: ChatModelChoice[] = [
  {
    connectionId: 'connection-anthropic-main',
    connectionSlug: 'anthropic-main',
    providerType: 'anthropic',
    providerLabel: 'Anthropic',
    model: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    isDefault: true,
    thinkingLevels: [],
  },
  {
    connectionId: 'connection-openai-main',
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
    llmConnectionId: 'connection-anthropic-main',
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
  makeSession({ id: 'session-aborted', name: '中止的 smoke 回归', status: 'aborted', lastMessageAt: NOW - 3 * 60 * 60_000, projectId: 'project-archived', cwd: '/workspace/legacy' }),
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
    label: 'backend-service',
    hostBadge: 'Lab server',
    selectedGroupId: 'lab-server',
    groups: [
      {
        id: 'local',
        label: 'This device',
        projects: catalogProjects.filter((item) => item.archivedAt === undefined),
        selectedProjectId: 'project-maka',
        onAdd: noop,
        onSelectProject: noop,
        onRelink: noop,
        onSelectNoProject: noop,
      },
      {
        id: 'lab-server',
        label: 'Lab server',
        projects: [
          project({ id: 'project-backend', name: 'backend-service' }),
          project({ id: 'project-infra', name: 'infrastructure' }),
        ],
        selectedProjectId: 'project-backend',
        onSelectProject: noop,
      },
    ],
  },
  onSend: noop,
  onStop: noop,
  modelLabel: 'Claude Sonnet 4.5',
  activeSession,
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
  // mode controls (Plan / orchestration), and the Skills picker. Omitting them
  // here understated the persistent element count in every shell story.
  onPickAttachments: noop,
  planModeActive: false,
  onPlanModeChange: noop,
  orchestrationMode: 'default',
  onOrchestrationModeChange: noop,
  // Production wires this for every Session it can interact with locally
  // (app-shell.tsx), so the ＋ menu always carries the Goal entry.
  onSetGoal: noop,
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
      uiLocale: 'zh-CN',
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
        <WorkbarTitlebarActions
          available
          collapsed={false}
          onToggle={noop}
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
          <SessionRail
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            width={sidebarWidth}
            onWidthChange={noop}
            minWidth={180}
            maxWidth={480}
            selection={{ section: 'sessions' }}
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
                scrollOwner="host"
                composer={
                  <Composer
                    {...baseComposerProps}
                    activeSession={active}
                    modelSwitchHasHistory={messages.some(
                      (message) => message.type === 'user' || message.type === 'assistant',
                    )}
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

// Real path: an update is waiting while the sidebar is fully hidden. The
// titlebar's restore action remains visible; expanding the sidebar reveals the
// pending update in its footer again.
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

// A real prefix of `npm test` stdout, copied verbatim from an actual run killed
// mid-build (the full suite runs for minutes, so a cancel here is genuinely
// reachable). Kept short by cutting inside the build phase — no test-runner
// interleaving, no truncation. Cutting the fixture from a real run is what keeps
// the expanded panel's bytes honest.
const NPM_TEST_STDOUT_AT_CANCEL = "\n> maka@0.2.0 test\n> npm run build:test && node scripts/run-workspace-tests-parallel.mjs --concurrency=3\n\n\n> maka@0.2.0 build:test\n> npm run clean && npm --workspace @maka/core run build && npm --workspace @maka/storage run build && npm --workspace @maka/mcp run build && npm --workspace @maka/runtime run build && npm --workspace @maka/runtime-host run build && npm --workspace @maka/computer-use run build && npm --workspace @maka/eval run build && npm --workspace maka-agent run build && npm --workspace @maka/ui run build && npm --workspace @maka/desktop run build:test\n\n\n> maka@0.2.0 clean\n> node scripts/clean-build.mjs\n\ncleaned packages/core/dist\ncleaned packages/core/tsconfig.tsbuildinfo\ncleaned packages/storage/dist\ncleaned packages/storage/tsconfig.tsbuildinfo\ncleaned packages/mcp/dist\ncleaned packages/mcp/tsconfig.tsbuildinfo\ncleaned packages/runtime/dist\ncleaned packages/runtime/tsconfig.tsbuildinfo\ncleaned packages/runtime-host/dist\ncleaned packages/runtime-host/tsconfig.tsbuildinfo\ncleaned packages/eval/dist\ncleaned packages/eval/tsconfig.tsbuildinfo\ncleaned packages/computer-use/dist\ncleaned packages/computer-use/tsconfig.tsbuildinfo\ncleaned packages/cli/dist\ncleaned packages/cli/tsconfig.tsbuildinfo\ncleaned packages/ui/dist\ncleaned packages/ui/tsconfig.tsbuildinfo\ncleaned apps/desktop/dist\ncleaned apps/desktop/tsconfig.main.tsbuildinfo\ncleaned apps/desktop/tsconfig.renderer.tsbuildinfo\ncleaned 21 path(s).\n\n> @maka/core@0.1.0 build\n> tsc -p tsconfig.json\n\n\n> @maka/storage@0.1.0 build\n> tsc -p tsconfig.json\n\n\n> @maka/mcp@0.1.0 build\n> tsc -p tsconfig.json\n";

// Real path: run the full test suite → the user hits stop before it returns.
// Aborting settles the call as a cancelled `terminal` result (isError), and
// `toolResultActivityStatus` maps a cancelled terminal to `interrupted`. There is
// no `interrupted` turn status (only running/completed/aborted/failed) — the
// tool-level state is derived from the settled result, not asserted. Because the
// turn kept that partial result, `partialOutputRetained` is true.
//
// `npm test` runs for minutes (build:test then the runner), so a cancel at ~16s is
// still inside a running process — it settles `cancelled`/130, not `timed_out`/124
// (which needs the 120s foreground default) and not a `completed` run. The retained
// stdout is a verbatim prefix of a real run (see NPM_TEST_STDOUT_AT_CANCEL), cut in
// the build phase so there is no runner interleaving and nothing is truncated.
//
// This is the interrupted counterpart to RunningStatusDuringToolRun, and the only
// story that reaches the interrupted tool row. It goes through the real
// ChatView → materializeTurns → ToolTrow path, so the row renders inside the
// production `.maka-turn` frame. The session is `aborted` too, so the sidebar row
// and composer agree with the transcript instead of still reading as active.
export const InterruptedToolAfterTurnAbort: Story = {
  render: () => (
    <ComposedShell
      session={{ status: 'aborted', lastMessageAt: NOW - 98_000 }}
      chat={{
        messages: [
          user('msg-i-1', 'turn-i', 2, '把整套测试跑一遍，我刚改完 core，想确认没打断别的。'),
          {
            type: 'turn_state',
            id: 'state-i-running',
            turnId: 'turn-i',
            ts: NOW - 118_000,
            status: 'running',
            partialOutputRetained: false,
          },
          {
            type: 'assistant',
            id: 'msg-assistant-i',
            turnId: 'turn-i',
            ts: NOW - 116_000,
            text: '跑 npm test —— 先全量重建再跑用例。',
            modelId: 'claude-sonnet-4-5',
          },
          {
            type: 'tool_call',
            id: 'tool-i-1',
            turnId: 'turn-i',
            ts: NOW - 114_000,
            toolName: 'Bash',
            activityKind: 'command',
            stepId: 'msg-assistant-i',
            origin: 'provider',
            modelVisibility: 'visible',
            args: { command: 'npm test' },
          },
          {
            type: 'tool_result',
            id: 'tool-i-1-result',
            turnId: 'turn-i',
            ts: NOW - 98_000,
            toolUseId: 'tool-i-1',
            isError: true,
            durationMs: 16_000,
            origin: 'provider',
            modelVisibility: 'visible',
            content: {
              kind: 'terminal',
              cwd: '/workspace/maka-agent/.worktree/storybook',
              cmd: 'npm test',
              status: 'cancelled',
              exitCode: 130,
              failureMessage: 'Command cancelled',
              output: {
                mode: 'pipes',
                stdout: NPM_TEST_STDOUT_AT_CANCEL,
                stderr: '',
                stdoutTruncated: false,
                stderrTruncated: false,
                redacted: false,
              },
            },
          },
          {
            type: 'turn_state',
            id: 'state-i-aborted',
            turnId: 'turn-i',
            ts: NOW - 98_000,
            status: 'aborted',
            abortedAt: NOW - 98_000,
            abortSource: 'renderer.stop_button',
            partialOutputRetained: true,
          },
        ],
      }}
    />
  ),
};

// Real path: a tool call fails mid-turn and the turn settles as failed. The
// errored tool row renders inside `.maka-turn`, and the turn wears its failed
// Banner (`describeTurnErrorClass('tool_failed')`) with the erroredTool
// execution-state description — the failed-turn chrome no story exercised.
export const FailedTurnWithToolError: Story = {
  render: () => (
    <ComposedShell
      session={{ lastMessageAt: NOW - 4 * 60_000 }}
      chat={{
        messages: [
          user('msg-f-1', 'turn-f', 5, '把 core 里的类型错误修掉，然后跑一遍类型检查确认。'),
          { type: 'turn_state', id: 'state-f-running', turnId: 'turn-f', ts: NOW - 290_000, status: 'running', partialOutputRetained: false },
          { type: 'assistant', id: 'msg-assistant-f', turnId: 'turn-f', ts: NOW - 285_000, text: '先运行类型检查定位问题。', modelId: 'claude-sonnet-4-5' },
          {
            type: 'tool_call',
            id: 'tool-f-1',
            turnId: 'turn-f',
            ts: NOW - 284_000,
            toolName: 'Bash',
            activityKind: 'command',
            stepId: 'msg-assistant-f',
            origin: 'provider',
            modelVisibility: 'visible',
            args: { command: 'npm run typecheck' },
          },
          {
            type: 'tool_result',
            id: 'tool-f-1-result',
            turnId: 'turn-f',
            ts: NOW - 281_000,
            toolUseId: 'tool-f-1',
            isError: true,
            durationMs: 3_400,
            origin: 'provider',
            modelVisibility: 'visible',
            content: {
              kind: 'text',
              text: "src/session.ts(88,7): error TS2322: Type 'string' is not assignable to type 'number'.\nnpm run typecheck exited with code 2.",
            },
          },
          { type: 'turn_state', id: 'state-f-failed', turnId: 'turn-f', ts: NOW - 281_000, status: 'failed', errorClass: 'tool_failed', partialOutputRetained: false },
        ],
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const banner = canvasElement.querySelector('.maka-turn-failed-banner');
      expect(banner?.textContent).toContain('工具调用失败');
      expect(banner?.textContent).toContain('这一轮有工具执行出错');
    });
  },
};

// Real path: the provider rate-limits the request and the turn settles failed.
// The failed Banner carries the rate-limit guidance — the settled provider
// error a bare transcript never shows.
export const ProviderRateLimited: Story = {
  render: () => (
    <ComposedShell
      session={{ lastMessageAt: NOW - 3 * 60_000 }}
      chat={{
        messages: [
          user('msg-r-1', 'turn-r', 4, '再生成三个对照方案，越详细越好。'),
          { type: 'turn_state', id: 'state-r-running', turnId: 'turn-r', ts: NOW - 200_000, status: 'running', partialOutputRetained: false },
          { type: 'turn_state', id: 'state-r-failed', turnId: 'turn-r', ts: NOW - 198_000, status: 'failed', errorClass: 'rate_limit', partialOutputRetained: false },
        ],
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelector('.maka-turn-failed-banner')?.textContent).toContain(
        '模型请求太频繁被限流了',
      ),
    );
  },
};

// Real path: the provider throttles a live request and Runtime schedules a
// retry. The running turn swaps its working phrase for the retry Banner
// (`ModelProviderRetryIndicator`) — the "retrying" state no story reached.
export const ProviderRetrying: Story = {
  render: () => (
    <ComposedShell
      session={{ status: 'running', streaming: true }}
      chat={{
        runningStatus: true,
        messages: [
          user('msg-rr-1', 'turn-rr', 1, '把这份长文档翻译成英文。'),
          { type: 'turn_state', id: 'state-rr', turnId: 'turn-rr', ts: NOW - 20_000, status: 'running', partialOutputRetained: false },
        ],
        liveTurn: {
          turnId: 'turn-rr',
          phase: 'streamed',
          steps: [{ stepId: 'msg-assistant-rr', tools: [] }],
          providerRetry: {
            event: {
              type: 'provider_retry',
              phase: 'scheduled',
              id: 'retry-rr',
              turnId: 'turn-rr',
              ts: NOW - 5_000,
              attempt: 2,
              maxAttempts: 5,
              delayMs: 30_000,
              remainingMs: 30_000,
              reason: 'rate_limit',
            },
            receivedAtMs: NOW - 5_000,
          },
        },
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelector('.maka-turn-provider-retry')).not.toBeNull(),
    );
  },
};

// Real path: the app restarted mid-turn, so the last turn is failed with
// errorClass 'app_restarted' and offers safe-resume. The warning-severity
// Banner carries the 继续这一轮 button (`safeResumeAction`) — the recovery
// affordance no story reached.
export const SafeResumeAfterRestart: Story = {
  render: () => (
    <ComposedShell
      session={{ lastMessageAt: NOW - 2 * 60_000 }}
      chat={{
        safeResumeAction: { pending: false, onResume: noop },
        messages: [
          user('msg-sr-1', 'turn-sr', 3, '把这份报告整理成要点清单。'),
          { type: 'turn_state', id: 'state-sr-running', turnId: 'turn-sr', ts: NOW - 150_000, status: 'running', partialOutputRetained: false },
          { type: 'assistant', id: 'msg-assistant-sr', turnId: 'turn-sr', ts: NOW - 148_000, text: '好的，我先通读一遍，抓住主要结论——', modelId: 'claude-sonnet-4-5' },
          { type: 'turn_state', id: 'state-sr-failed', turnId: 'turn-sr', ts: NOW - 146_000, status: 'failed', errorClass: 'app_restarted', partialOutputRetained: true },
        ],
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const banner = canvasElement.querySelector('.maka-turn-failed-banner');
      expect(banner?.textContent).toContain('本地应用重启');
      expect(banner?.textContent).toContain('继续这一轮');
    });
  },
};

// Real path: a long session with 120 turns — past the transcript virtualizer's
// window, so it must stay correct and quiet where a handful of seeded turns
// would never trip the virtualization path.
export const ManyTurns: Story = {
  render: () => (
    <ComposedShell
      session={{ lastMessageAt: NOW - 60_000 }}
      chat={{
        messages: Array.from({ length: 120 }, (_, index) => {
          const turnId = `turn-m-${index}`;
          const minutesAgo = (120 - index) * 3;
          return [
            user(`msg-m-u-${index}`, turnId, minutesAgo, `第 ${index + 1} 轮：这个模块的边界条件该怎么覆盖？`),
            assistant(`msg-m-a-${index}`, turnId, minutesAgo - 1, `第 ${index + 1} 轮回答：先列输入域，再对空、超长、并发三类分别加断言。`),
          ];
        }).flat(),
      }}
    />
  ),
};

// Real path: Desktop Computer Use is exposed through the Runtime Host Client
// Capability bridge. The settled observation establishes the confirmed target;
// the following sequence inherits it while live progress replaces the generic
// working phrase at the bottom of the turn.
export const ComputerUseObservability: Story = {
  render: () => (
    <ComposedShell
      session={{ status: 'running', streaming: true }}
      chat={{
        runningStatus: true,
        messages: [
          user('msg-cu-1', 'turn-cu', 2, '在计算器里完成这组输入，并确认结果。'),
          {
            type: 'turn_state',
            id: 'state-cu',
            turnId: 'turn-cu',
            ts: NOW - 40_000,
            status: 'running',
            partialOutputRetained: false,
          },
        ],
        liveTurn: {
          turnId: 'turn-cu',
          phase: 'streamed',
          steps: [{
            stepId: 'msg-assistant-cu',
            tools: [
              {
                toolUseId: 'tool-cu-observe',
                toolName: 'mcp__desktop_computer_use__maka_computer',
                activityKind: 'computer',
                displayName: 'Maka Computer',
                status: 'completed',
                args: { action: 'observe', app: '计算器', window_id: 7 },
                durationMs: 728,
              },
              {
                toolUseId: 'tool-cu-sequence',
                toolName: 'mcp__desktop_computer_use__maka_computer',
                activityKind: 'computer',
                displayName: 'Maka Computer',
                status: 'running',
                args: {
                  action: 'element_sequence',
                  observation_id: '00000000-0000-0000-0000-000000000001',
                  steps: Array.from({ length: 11 }, (_, index) => ({
                    label: `<text:${String(index).length}>`,
                  })),
                },
                progress: { current: 7, total: 11 },
              },
            ],
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
        newChatModel: { llmConnectionId: 'connection-anthropic-main', llmConnectionSlug: 'anthropic-main', model: 'claude-sonnet-4-5' },
        onPickNewChatModel: noop,
        onOpenModelSettings: noop,
      }}
    />
  ),
};

// A ready Local Host with no registered Projects must still expose its two
// bootstrap actions while another Host owns the draft.
export const NewChatComposerEmptyLocalHost: Story = {
  render: () => (
    <ComposedShell
      session={null}
      chat={{ messages: [] }}
      composer={{
        newChatModel: { llmConnectionId: 'connection-anthropic-main', llmConnectionSlug: 'anthropic-main', model: 'claude-sonnet-4-5' },
        onPickNewChatModel: noop,
        onOpenModelSettings: noop,
        workspacePicker: {
          ...baseComposerProps.workspacePicker!,
          groups: baseComposerProps.workspacePicker!.groups.map((group) =>
            group.id === 'local'
              ? { ...group, projects: [], selectedProjectId: undefined }
              : group),
        },
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
        newChatModel: { llmConnectionId: 'connection-anthropic-main', llmConnectionSlug: 'anthropic-main', model: 'claude-sonnet-4-5' },
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

function GoalContextStory(props: { goal: NonNullable<ChatViewProps['goalIndicator']> }) {
  return (
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
        goalIndicator: props.goal,
        onBranchBannerClick: noop,
        onRevisionNavigate: noop,
      }}
    />
  );
}

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
    <GoalContextStory
      goal={{
        condition: '把 Session Context Layer 收敛到可 review 状态',
        status: 'active',
        iterations: 4,
        maxIterations: 12,
        setAt: Date.now() - 12 * 60_000,
        tokensSpent: 72_000,
        tokenBudget: 200_000,
        onPause: noop,
        onClear: noop,
      }}
    />
  ),
};

export const SessionContextLayerWaiting: Story = {
  render: () => (
    <GoalContextStory
      goal={{
        condition: '等待 CI 状态变化后继续处理 review',
        status: 'waiting',
        iterations: 4,
        maxIterations: 12,
        setAt: Date.now() - 12 * 60_000,
        tokensSpent: 72_000,
        tokenBudget: 200_000,
        onPause: noop,
        onClear: noop,
      }}
    />
  ),
};

export const SessionContextLayerPaused: Story = {
  render: () => {
    const pausedAt = Date.now() - 4 * 60_000;
    return (
      <GoalContextStory
        goal={{
          condition: '把 Session Context Layer 收敛到可 review 状态',
          status: 'paused',
          iterations: 4,
          maxIterations: 12,
          setAt: pausedAt - 8 * 60_000,
          pausedAt,
          tokensSpent: 72_000,
          tokenBudget: 200_000,
          onResume: noop,
          onClear: noop,
        }}
      />
    );
  },
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
  render: () => <ComposedShell composer={{ orchestrationMode: 'swarm' }} />,
};

// Real path: Plan and orchestration are separate Session fields with separate
// lifetimes, so both can be on at once — Plan is a temporary excursion, Swarm
// is the standing default the execution afterwards runs under. This is the
// widest the mode tail ever gets next to a real model name.
export const PlanAndSwarmModeOn: Story = {
  render: () => (
    <ComposedShell composer={{ planModeActive: true, orchestrationMode: 'swarm' }} />
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

// Real path: this Session already has a running Goal, which the composer shows
// above the input. Arming refuses a second one, so the ＋ menu's Goal entry
// says why instead of opening a dialog that would fail on submit.
export const GoalAlreadySet: Story = {
  render: () => <ComposedShell composer={{ goalActive: true }} />,
};

// Real path: composer ＋ → 设定 Goal…, on a Session with no Goal running and no
// Turn in flight — app-shell mounts this dialog at the top level, over the
// shell, exactly as composed here. It is the only place the two budgets that
// stop a Goal are visible before one starts.
export const GoalDialogOpen: Story = {
  render: () => (
    <>
      <ComposedShell />
      <GoalDialog
        sessionId="session-1"
        onArm={async () => ({
          kind: 'armed',
          goal: {
            id: 'storybook-goal',
            revision: 1,
            sessionId: 'storybook-session',
            condition: 'Ship the Storybook example',
            status: 'active',
            setAt: Date.now(),
            iterations: 0,
            maxIterations: 25,
            consecutiveNoProgress: 0,
            blockCap: 8,
            tokensAtStart: 0,
            tokensNow: 0,
            tokensBaselinePending: false,
          },
        })}
        onClose={noop}
      />
    </>
  ),
};

/**
 * Transcript geometry.
 *
 * Assert positions against the scroller's own end, never as a pixel delta: a
 * delta is satisfiable by two wrongs, where the content grew by as much as the
 * view moved.
 */
const TAIL_SCROLLER = '[data-chat-scroll-container="true"]';

// Enough to push the transcript past a viewport twice, few enough that a
// stream of them ends while a story is still settling.
const TAIL_LINES = Array.from(
  { length: 60 },
  (_, index) => `第 ${index} 行：这一段用来把转录推过滚动视口的高度。`,
);

function tailScroller(): HTMLElement {
  const root = document.querySelector<HTMLElement>(TAIL_SCROLLER);
  if (!root) throw new Error('the chat scroll container is missing');
  return root;
}

/** The distance to the tail plus the three numbers it came from. */
function tailMetrics(): {
  distance: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
} {
  const root = tailScroller();
  return {
    distance: Math.round(root.scrollHeight - root.scrollTop - root.clientHeight),
    scrollTop: Math.round(root.scrollTop),
    scrollHeight: root.scrollHeight,
    clientHeight: root.clientHeight,
  };
}

/**
 * Samples every frame while the answer grows: a tail slipping away *while*
 * content arrives is indistinguishable, afterwards, from a view dragged back
 * at the last delta. Stops on the content; the budget is only a fuse.
 */
function measureTailLag(frameBudget: number): Promise<{
  worstLag: number;
  worstFrameGrowth: number;
  grewBy: number;
  viewportHeight: number;
}> {
  return new Promise((resolve) => {
    const root = tailScroller();
    const startedAt = root.scrollHeight;
    let previousScrollHeight = startedAt;
    let worstLag = 0;
    let worstFrameGrowth = 0;
    let left = frameBudget;
    const tick = (): void => {
      const settledTail = previousScrollHeight - root.clientHeight;
      worstLag = Math.max(worstLag, Math.abs(root.scrollTop - settledTail));
      worstFrameGrowth = Math.max(worstFrameGrowth, root.scrollHeight - previousScrollHeight);
      previousScrollHeight = root.scrollHeight;
      const enough = root.scrollHeight - startedAt > root.clientHeight;
      if (enough || --left <= 0) {
        resolve({
          worstLag: Math.round(worstLag),
          worstFrameGrowth: Math.round(worstFrameGrowth),
          grewBy: Math.round(root.scrollHeight - startedAt),
          viewportHeight: root.clientHeight,
        });
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Waits out the frames a layout change needs to commit and paint. */
function painted(frames = 3): Promise<void> {
  return new Promise((resolve) => {
    const tick = (left: number): void => {
      if (left <= 0) resolve();
      else requestAnimationFrame(() => tick(left - 1));
    };
    tick(frames);
  });
}

function messageList(): HTMLElement {
  const list = tailScroller().querySelector<HTMLElement>('.maka-chat-message-list');
  if (!list) throw new Error('the transcript content box is missing');
  return list;
}

function turnTop(turnId: string): number {
  const turn = document.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
  if (!turn) throw new Error(`turn ${turnId} is not mounted`);
  return Math.round(turn.getBoundingClientRect().top);
}

function firstResidentTurnId(): string | null {
  return document
    .querySelector('[data-transcript-turn-id]')
    ?.getAttribute('data-transcript-turn-id') ?? null;
}

/**
 * The dock affordance is always in the DOM — Astryx toggles opacity and
 * pointer-events — so presence proves nothing and a visibility check passes on
 * the transparent one. `dockOffered` is the real question.
 */
function dockButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    /底部|to bottom/i.test(
      `${candidate.getAttribute('aria-label') ?? ''} ${candidate.textContent ?? ''}`,
    ),
  );
  if (!button) throw new Error('the scroll-to-bottom affordance is missing');
  return button;
}

function dockOffered(): boolean {
  const style = getComputedStyle(dockButton());
  return style.pointerEvents !== 'none' && Number(style.opacity) > 0.5;
}

/**
 * The rule this drives reads `composedPath()` and the overflow of what the
 * wheel crossed — DOM state — so a dispatched wheel takes the same branch a
 * real one does. What it cannot do is scroll, so cases that need the reader to
 * move set `scrollTop` themselves.
 */
function wheelUp(target: Element): void {
  target.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
}

/** A scroller inside the transcript, standing in for a tool-output box. */
function injectNestedScroller(parent: Element): HTMLElement {
  const box = document.createElement('div');
  box.dataset.nestedScroller = 'true';
  box.style.cssText = 'height:120px;overflow-y:auto';
  const filler = document.createElement('div');
  filler.style.height = '2000px';
  box.append(filler);
  parent.append(box);
  // Away from both ends, so scrolling up inside it never reaches a boundary.
  box.scrollTop = 600;
  return box;
}

/** Answered turns, oldest first. `from` may go negative as history loads. */
function transcriptTurns(from: number, count: number): StoredMessage[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = from + offset;
    const turnId = `turn-scroll-${index}`;
    return [
      user(`msg-scroll-${index}-u`, turnId, 500 - index * 2, `第 ${index} 个问题`),
      assistant(
        `msg-scroll-${index}-a`,
        turnId,
        499 - index * 2,
        TAIL_LINES.slice(0, 4).join('\n\n'),
      ),
    ];
  }).flat();
}

/** Stops the harness below, so the tail can be read against a settled transcript. */
let stopTailStream: (() => void) | undefined;

/** Streams one line per frame into a live Turn. */
function StreamingTailHarness() {
  const [lines, setLines] = useState(1);
  useEffect(() => {
    // Paced by frames, not by the clock, so it stays in step with the
    // per-frame sampler on a slow runner.
    let frame = 0;
    let stopped = false;
    const tick = (): void => {
      if (stopped) return;
      setLines((count) => (count >= TAIL_LINES.length ? count : count + 1));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const stop = (): void => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
    stopTailStream = stop;
    return () => {
      stop();
      stopTailStream = undefined;
    };
  }, []);
  return (
    <ComposedShell
      session={{ status: 'running', streaming: true }}
      chat={{
        runningStatus: true,
        messages: [
          user('msg-tail-1', 'turn-tail', 3, '把转录推过一屏，看看尾巴还跟不跟得住。'),
          {
            type: 'turn_state',
            id: 'state-tail',
            turnId: 'turn-tail',
            ts: NOW - 30_000,
            status: 'running',
            partialOutputRetained: false,
          },
        ],
        liveTurn: {
          turnId: 'turn-tail',
          phase: 'streamed',
          steps: [{
            stepId: 'msg-assistant-tail',
            text: {
              // Paragraph breaks, not single newlines: Markdown folds those
              // back into one block and the transcript stops growing by rows.
              text: TAIL_LINES.slice(0, lines).join('\n\n'),
              truncated: false,
              complete: false,
            },
            tools: [],
          }],
        },
      }}
    />
  );
}

export const StreamingTailFollow: Story = {
  render: () => <StreamingTailHarness />,
  play: async () => {
    // The fuse runs out inside the smoke's per-story budget, so a stalled
    // stream fails saying so instead of timing the story out.
    const lag = await measureTailLag(600);

    // The samples have to have covered more than a viewport of real growth, or
    // every reading above is a stationary transcript and proves nothing.
    expect(lag.grewBy).toBeGreaterThan(lag.viewportHeight);
    expect(lag.worstLag).toBeLessThanOrEqual(lag.worstFrameGrowth + 8);

    // Settle against a transcript that stopped growing, or the reading only
    // says the sampler caught a frame between deltas.
    stopTailStream?.();
    await waitFor(
      () => {
        const settled = tailMetrics();
        expect(settled.distance, JSON.stringify(settled)).toBeLessThanOrEqual(4);
      },
      { timeout: 5_000 },
    );

    // A reader the tail never left has nothing to dock to.
    expect(dockOffered()).toBe(false);
  },
};

/** Lets a play function drive props React owns. One story renders per page. */
let appendTurn: (() => void) | undefined;

/** Every `onLoadEarlierHistory` the transcript asked for, anchor turn first. */
const historyLoads: string[] = [];

const HISTORY_BATCH = 4;

// More than any story here consumes. Running the history out retires the
// "earlier history" notice, and that removal is a height change above the
// reader with no arrival to explain it.
const HISTORY_BATCHES_AVAILABLE = 8;

/** A settled transcript with a turn the play function can make arrive. */
function SettledTranscriptHarness({ turns }: { turns: number }) {
  const [extra, setExtra] = useState(0);
  useEffect(() => {
    appendTurn = () => setExtra((count) => count + 1);
    return () => {
      appendTurn = undefined;
    };
  }, []);
  return <ComposedShell chat={{ messages: transcriptTurns(0, turns + extra) }} />;
}

/** The history seam is two props: `hasOlderHistory`, and a loader that prepends. */
function HistoryHarness({ turns }: { turns: number }) {
  const [range, setRange] = useState({ from: 0, count: turns });
  useEffect(() => {
    historyLoads.length = 0;
  }, []);
  return (
    <ComposedShell
      chat={{
        messages: transcriptTurns(range.from, range.count),
        hasOlderHistory: range.from > -HISTORY_BATCH * HISTORY_BATCHES_AVAILABLE,
        onLoadEarlierHistory: (anchorTurnId) => {
          historyLoads.push(anchorTurnId ?? '(none)');
          setRange((current) => ({
            from: current.from - HISTORY_BATCH,
            count: current.count + HISTORY_BATCH,
          }));
        },
      }}
    />
  );
}

/** The band inside which the transcript treats a reader move as asking. */
function loadBand(): number {
  return Math.max(640, tailScroller().clientHeight * 2);
}

export const TailFollowsGrowthOutsideTurns: Story = {
  render: () => <SettledTranscriptHarness turns={12} />,
  play: async () => {
    await waitFor(() => expect(tailMetrics().distance).toBeLessThanOrEqual(4));

    const grown = document.createElement('div');
    grown.dataset.outsideTurnGrowth = 'true';
    grown.style.height = '600px';
    messageList().append(grown);
    // Outside a wrapper is what makes this the uncovered path: growth inside
    // one is what every other story here already exercises.
    expect(
      grown.closest('[data-transcript-turn-id]'),
      'the injected box landed inside a turn wrapper',
    ).toBe(null);

    await painted(6);
    await waitFor(() => {
      const settled = tailMetrics();
      expect(settled.distance, JSON.stringify(settled)).toBeLessThanOrEqual(4);
    });
  },
};

export const ReaderScrolledUpIsNotPulledBack: Story = {
  render: () => <SettledTranscriptHarness turns={12} />,
  play: async () => {
    const root = tailScroller();
    await waitFor(() => expect(tailMetrics().distance).toBeLessThanOrEqual(4));

    root.scrollTop -= 500;
    await painted(6);
    const before = tailMetrics().distance;
    expect(before, JSON.stringify(tailMetrics())).toBeGreaterThan(100);
    await waitFor(() => expect(dockOffered()).toBe(true));

    const viewport = root.getBoundingClientRect();
    const anchorTurnId = [...root.querySelectorAll<HTMLElement>('[data-transcript-turn-id]')]
      .find((turn) => {
        const bounds = turn.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      })?.dataset.transcriptTurnId;
    if (!anchorTurnId) throw new Error('the transcript has no visible turn');
    const anchorTop = turnTop(anchorTurnId);

    appendTurn?.();

    // Track the first visible turn. The first mounted turn can be thousands
    // of pixels above the reader; native anchoring correctly moves that turn
    // when intervening content-visibility estimates resolve while holding the
    // reader still. Keep both checks together as the arriving turn settles.
    await waitFor(() => {
      expect(tailMetrics().distance).toBeGreaterThan(before);
      const afterTop = turnTop(anchorTurnId);
      expect(
        Math.abs(afterTop - anchorTop),
        JSON.stringify({ anchorTurnId, anchorTop, afterTop, ...tailMetrics() }),
      ).toBeLessThanOrEqual(4);
    });
  },
};

export const DockAffordanceReturnsToTail: Story = {
  render: () => <SettledTranscriptHarness turns={12} />,
  play: async () => {
    await waitFor(() => expect(tailMetrics().distance).toBeLessThanOrEqual(4));

    tailScroller().scrollTop = 0;
    await painted(6);
    // Offered at all is the assertion: with Astryx's scroll layer off, its
    // `isScrolledUp` never updates again, so the stock button would stay
    // transparent forever. This one reads Maka's pin.
    await waitFor(() => expect(dockOffered()).toBe(true));

    dockButton().click();
    await waitFor(() => {
      const settled = tailMetrics();
      expect(settled.distance, JSON.stringify(settled)).toBeLessThanOrEqual(4);
    });
    expect(dockOffered()).toBe(false);
  },
};

export const NestedScrollerNearHistoryBoundaryAsksForNothing: Story = {
  render: () => <HistoryHarness turns={7} />,
  play: async () => {
    await waitFor(() => {
      const settled = tailMetrics();
      expect(settled.scrollTop, JSON.stringify(settled)).toBeLessThanOrEqual(loadBand());
      expect(settled.distance, JSON.stringify(settled)).toBeLessThanOrEqual(4);
    });

    const nested = injectNestedScroller(messageList());
    await painted(6);
    historyLoads.length = 0;

    wheelUp(nested);
    await painted(6);
    // The gesture crossed a scroller that could act on it, so it was never the
    // reader asking for what is above the transcript.
    expect(historyLoads).toEqual([]);
    expect(nested.scrollTop).toBe(600);
  },
};

export const TailFollowDoesNotAskForHistory: Story = {
  render: () => <HistoryHarness turns={7} />,
  play: async () => {
    const before = firstResidentTurnId();
    // A transcript shorter than about three viewports has its tail inside the
    // band that asks for earlier history, so "near the start" cannot mean the
    // reader wants it.
    await waitFor(() => {
      const settled = tailMetrics();
      expect(settled.scrollTop, JSON.stringify(settled)).toBeLessThanOrEqual(loadBand());
      expect(settled.distance, JSON.stringify(settled)).toBeLessThanOrEqual(4);
    });

    await painted(12);
    // Nothing arrived that the reader did not ask for.
    expect(historyLoads).toEqual([]);
    expect(firstResidentTurnId()).toBe(before);
  },
};

export const AWheelTheScrollerCannotActOnAsksForHistory: Story = {
  render: () => <HistoryHarness turns={1} />,
  play: async () => {
    const before = firstResidentTurnId();
    await painted(6);
    const settled = tailMetrics();
    // Too short to move: no scroll can follow the wheel, so the authority
    // never learns the reader asked. The wheel itself has to carry it.
    expect(settled.scrollHeight, JSON.stringify(settled)).toBeLessThanOrEqual(
      settled.clientHeight,
    );

    wheelUp(tailScroller());
    await waitFor(() => expect(firstResidentTurnId()).not.toBe(before));
  },
};

export const EarlierHistoryLandsAboveTheReader: Story = {
  render: () => <HistoryHarness turns={30} />,
  play: async () => {
    const root = tailScroller();
    await waitFor(() => expect(tailMetrics().distance).toBeLessThanOrEqual(4));

    // Just short of the band that asks for more, so the active range has
    // painted turns around the reader before the load starts. Landing straight
    // on zero leaves no visible turn above the load boundary to anchor on.
    root.scrollTop = loadBand() + 400;
    await painted(6);
    const before = firstResidentTurnId();
    const heightBefore = root.scrollHeight;
    historyLoads.length = 0;

    // The move that asks for earlier history and the reading of where the
    // reader is, in one task.
    root.scrollTop = Math.min(300, root.scrollHeight - root.clientHeight);
    const rootTop = root.getBoundingClientRect().top;
    const turn = [...root.querySelectorAll<HTMLElement>('[data-turn-id]')].find(
      (candidate) => candidate.getBoundingClientRect().bottom > rootTop,
    );
    if (!turn?.dataset.turnId) throw new Error('no turn is on screen');
    const anchor = { turnId: turn.dataset.turnId, top: Math.round(turn.getBoundingClientRect().top) };
    wheelUp(root);

    await waitFor(() => expect(firstResidentTurnId()).not.toBe(before));
    await painted(6);

    // The turns that arrived went above the reader, and the reader did not go
    // with them. Asserting the element rather than a `scrollTop` delta is the
    // point: a compensation computed from `scrollHeight` satisfies the delta
    // while putting the reader somewhere else entirely.
    //
    // Budgeted against what arrived rather than in fixed pixels. A Turn carries
    // `content-visibility: auto`, so one that lands off screen is anchored
    // against its estimated height and settles a few pixels away from it; a
    // reader who went with the history instead moves by the whole insert.
    await waitFor(() =>
      expect(
        tailScroller().scrollHeight - heightBefore,
        JSON.stringify({ anchor, loads: historyLoads }),
      ).toBeGreaterThan(400),
    );

    // Fixed once, after the arrival has settled. Recomputed on every retry it
    // would grow along with the drift it is supposed to bound, so a late
    // `content-visibility` resolution could admit a reading that was failing.
    await painted(8);
    const inserted = tailScroller().scrollHeight - heightBefore;
    const budget = Math.max(4, inserted * 0.02);
    expect(
      Math.abs(turnTop(anchor.turnId) - anchor.top),
      JSON.stringify({ anchor, inserted, budget, now: turnTop(anchor.turnId), ...tailMetrics() }),
    ).toBeLessThanOrEqual(budget);
  },
};

/**
 * The reader going *up* through Turns that have never rendered.
 *
 * A bound, not stillness. A Turn off screen is laid out at
 * `contain-intrinsic-block-size: auto 280px` and swaps to its real height on
 * the way past, so travelling through them moves things by construction —
 * about 8% of the transcript here. What the bound says is that one Turn owes
 * at most one estimate, keeping the correction proportional to Turns crossed
 * rather than to what is inside them.
 */
const TRAVERSAL_STEP = 700;

/** What one Turn is worth, measured after everything has rendered once. */
function medianTurnHeight(): number {
  const heights = [...tailScroller().querySelectorAll<HTMLElement>('[data-turn-id]')]
    .map((turn) => turn.getBoundingClientRect().height)
    .sort((a, b) => a - b);
  if (heights.length === 0) throw new Error('the transcript has no mounted turn');
  return heights[Math.floor(heights.length / 2)];
}

/** The first Turn whose box is still on screen, and where it starts. */
function anchorInView(): { turnId: string; top: number } {
  const root = tailScroller();
  const rootTop = root.getBoundingClientRect().top;
  const turn = [...root.querySelectorAll<HTMLElement>('[data-turn-id]')].find(
    (candidate) => candidate.getBoundingClientRect().bottom > rootTop,
  );
  if (!turn?.dataset.turnId) throw new Error('no turn is on screen');
  return { turnId: turn.dataset.turnId, top: Math.round(turn.getBoundingClientRect().top) };
}

export const UpwardTraversalHoldsTurnGeometry: Story = {
  render: () => <SettledTranscriptHarness turns={40} />,
  play: async () => {
    const root = tailScroller();
    await waitFor(() => expect(tailMetrics().distance).toBeLessThanOrEqual(4));
    const heightBefore = root.scrollHeight;
    expect(
      heightBefore / root.clientHeight,
      'the transcript has to be deep enough to hold unrendered Turns',
    ).toBeGreaterThan(6);

    const drifts: number[] = [];
    let steps = 0;
    while (root.scrollTop > 0 && steps < 40) {
      const anchor = anchorInView();
      const scrollBefore = root.scrollTop;
      root.scrollTop = Math.max(0, scrollBefore - TRAVERSAL_STEP);
      await painted(4);

      // The reader moved by what the scroller actually moved, so the Turn under
      // them comes down the viewport by that much plus whatever the estimates
      // above them were off by.
      const travelled = scrollBefore - root.scrollTop;
      drifts.push(Math.round(turnTop(anchor.turnId) - (anchor.top + travelled)));
      steps += 1;
    }
    expect(steps, 'the traversal has to have taken real steps').toBeGreaterThan(6);

    const worstDrift = Math.max(...drifts.map(Math.abs));
    const turnHeight = medianTurnHeight();
    // No single step throws the reader past a whole exchange. One Turn's worth
    // of correction is the most one Turn can owe.
    expect(worstDrift, `per-step drift: ${drifts.join(' ')} against a Turn of ${turnHeight}`)
      .toBeLessThanOrEqual(turnHeight);

    // And over the whole traversal the corrections stay proportional to the
    // Turns crossed. Measured at ~8% here; #4259's 63% is the failure this
    // exists to catch.
    const heightAfter = root.scrollHeight;
    expect(
      Math.abs(heightAfter - heightBefore) / heightBefore,
      JSON.stringify({ heightBefore, heightAfter, steps, turnHeight }),
    ).toBeLessThanOrEqual(0.15);

    // And the reader can still get back.
    dockButton().click();
    await waitFor(
      () => {
        const settled = tailMetrics();
        expect(settled.distance, JSON.stringify(settled)).toBeLessThanOrEqual(4);
      },
      { timeout: 5_000 },
    );
  },
};

export const HistoryAtTheTopStillLandsAboveTheReader: Story = {
  render: () => <HistoryHarness turns={16} />,
  play: async () => {
    const root = tailScroller();
    // Writing zero while the scroller is still at zero is a no-op, so require
    // the initial pin to have provably moved before exercising the real one.
    await waitFor(() => {
      const settled = tailMetrics();
      expect(settled.scrollTop, JSON.stringify(settled)).toBeGreaterThan(0);
      expect(settled.distance, JSON.stringify(settled)).toBeLessThanOrEqual(4);
    });
    const before = firstResidentTurnId();

    // The one position where the browser declines to anchor, and the one the
    // wheel-to-load path puts the reader in.
    root.scrollTop = 0;
    wheelUp(root);

    await waitFor(() => expect(firstResidentTurnId()).not.toBe(before));
    await painted(6);

    // Anchoring resumes at an offset of one pixel, so the offset itself is the
    // evidence: left at zero the browser holds the scroller at the top and
    // every turn that arrives pushes the reader's content down the viewport.
    expect(tailScroller().scrollTop).toBeGreaterThanOrEqual(1);
  },
};

/**
 * The prompt anchor rail (#563). All three of its shipped regressions had the
 * same shape — the code kept working and the pixels stopped — so the
 * assertions here are geometric.
 *
 * Tick count comes from `transcriptTurnIndex`, not from mounted Turns: the
 * transcript holds only the Host's active range and the index carries the rest
 * of the landmarks, so the rail gets all 64 ticks against 10 Turns. That is
 * what the Host does in production.
 */
const PROMPT_RAIL_TURN_COUNT = 120;

/** `DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS`, restated to keep stories off preload. */
const PROMPT_RAIL_ACTIVE_RANGE = 10;

/** `MAX_PROMPT_RAIL_TICKS` in prompt-anchor-rail.tsx, which does not export it. */
const PROMPT_RAIL_MAX_TICKS = 64;

const PROMPT_RAIL_TAIL_RANGE_START = PROMPT_RAIL_TURN_COUNT - PROMPT_RAIL_ACTIVE_RANGE + 1;

const promptRailIndex = Array.from({ length: PROMPT_RAIL_TURN_COUNT }, (_, offset) => ({
  turnId: `turn-scroll-${offset + 1}`,
  sequence: offset + 1,
  label: `第 ${offset + 1} 个问题`,
}));

const promptRailMessages = transcriptTurns(PROMPT_RAIL_TAIL_RANGE_START, PROMPT_RAIL_ACTIVE_RANGE);

function PromptRailHarness() {
  return (
    <ComposedShell
      chat={{ messages: promptRailMessages, transcriptTurnIndex: promptRailIndex }}
    />
  );
}

function railTicks(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.maka-prompt-rail-tick')];
}

function railBars(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.maka-prompt-rail-tick-bar')];
}

/** Positive on all four = the rail's box is inside the scrollport, clear of the dock. */
function railInsets(): {
  insetTop: number;
  insetBottom: number;
  insetRight: number;
  dockClearance: number;
} {
  const scroller = tailScroller();
  const rail = document.querySelector('.maka-prompt-rail');
  if (!rail) throw new Error('the prompt rail is missing');
  const scrollport = scroller.getBoundingClientRect();
  const box = rail.getBoundingClientRect();
  // Astryx renders the composer dock as the scroll container's last child; the
  // rail measures it the same way, for want of a published hook.
  const dock = scroller.lastElementChild?.getBoundingClientRect();
  if (!dock) throw new Error('the composer dock is missing');
  return {
    insetTop: Math.round(box.top - scrollport.top),
    insetBottom: Math.round(scrollport.bottom - box.bottom),
    insetRight: Math.round(scrollport.right - box.right),
    dockClearance: Math.round(dock.top - box.bottom),
  };
}

export const PromptRailTicksPaintRealBoxes: Story = {
  render: () => <PromptRailHarness />,
  play: async () => {
    await waitFor(() => expect(railBars().length).toBeGreaterThan(0));

    // Measured over ALL ticks, not a sample: a helper that skips what it
    // cannot evaluate creates its blind spot exactly where a regression lives.
    const bars = railBars().map((bar) => {
      const box = bar.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    });

    expect(bars).toHaveLength(Math.min(PROMPT_RAIL_TURN_COUNT, PROMPT_RAIL_MAX_TICKS));
    // #2580 shipped bars at 0x0 — present in the DOM, painting nothing.
    expect(Math.min(...bars.map((bar) => bar.width))).toBeGreaterThan(0);
    expect(Math.min(...bars.map((bar) => bar.height))).toBeGreaterThan(0);
  },
};

export const PromptRailStaysInsideTheScrollport: Story = {
  render: () => <PromptRailHarness />,
  play: async () => {
    const scroller = tailScroller();
    await waitFor(() => expect(railBars().length).toBeGreaterThan(0));
    // Without an overflowing transcript the rail has nothing to be pinned
    // against and the rest of this proves nothing.
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);

    for (const position of ['top', 'bottom'] as const) {
      scroller.scrollTop = position === 'top' ? 0 : scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
      await painted(4);

      // The bottom is where it bites: a sticky offset is clamped by its
      // containing block, and the chat shell ends a dock-height above the
      // scrollport's bottom edge (#2161 showed up as a negative insetTop).
      await waitFor(() => {
        const insets = railInsets();
        expect(
          Object.entries(insets).filter(([, inset]) => inset < 0),
          `rail geometry at the ${position}: ${JSON.stringify(insets)}`,
        ).toEqual([]);
      });
    }
  },
};

export const PromptRailHasNoGapsBetweenTicks: Story = {
  render: () => <PromptRailHarness />,
  play: async () => {
    await waitFor(() => expect(railBars().length).toBeGreaterThan(1));

    // Two things at once, both by walking the rail a pixel at a time: no gap
    // between hit boxes, where the hover falloff would drop out and pick up
    // again every few pixels; and nothing occluding the ticks, which is #2338
    // — macOS's overlay scrollbar takes no layout space but still swallows the
    // pointer. `elementFromPoint`, not a dispatched pointer event, because a
    // dispatched event cannot see occlusion at all.
    //
    // The occlusion half only bites in a headed browser on macOS: headless
    // Chromium paints no platform scrollbar at all, and Linux's in-flow one
    // moves the content column left instead of overlaying it. So #2338 is
    // inert on CI, exactly as it was in E2E. Before touching the rail's right
    // edge, run this on a Mac with `SMOKE_HEADED=1` — a plain local smoke run
    // is headless and proves nothing about occlusion.
    //
    // Where the walk goes matters for the same reason. The bar sits at the
    // tick's right edge, ~11px from the scrollport, inside the 14px the macOS
    // overlay scrollbar claims; a column further left is outside it and sees
    // no occlusion at all.
    const bars = railBars();
    const first = bars[0].getBoundingClientRect();
    const last = bars[bars.length - 1].getBoundingClientRect();
    const x = Math.round(first.left + first.width / 2);
    const misses: number[] = [];
    for (
      let y = Math.round(first.top + first.height / 2);
      y <= Math.round(last.top + last.height / 2);
      y += 1
    ) {
      if (!document.elementFromPoint(x, y)?.closest('.maka-prompt-rail-tick')) misses.push(y);
    }

    // The walk has to have covered the rail, not two adjacent bars: a rail
    // that laid out almost nothing would otherwise pass with no misses.
    const walked = Math.round(last.bottom - first.top);
    const railHeight = Math.round(
      document.querySelector('.maka-prompt-rail')?.getBoundingClientRect().height ?? 0,
    );
    expect(walked, `walked ${walked} of a rail ${railHeight} tall`).toBeGreaterThan(
      railHeight * 0.8,
    );
    expect(misses, `misses at y=${misses.slice(0, 12).join(',')}`).toHaveLength(0);
  },
};

/** Away from the tail, but still inside the band that would ask for history. */
async function scrollAwayFromTail(): Promise<void> {
  const root = tailScroller();
  root.scrollTop = Math.min(root.scrollHeight - root.clientHeight - 100, loadBand() + 200);
  root.dispatchEvent(new Event('scroll'));
  await painted(4);
}

async function scrollTranscriptTo(position: 'top' | 'bottom'): Promise<void> {
  const root = tailScroller();
  root.scrollTop = position === 'top' ? 0 : root.scrollHeight;
  root.dispatchEvent(new Event('scroll'));
  await painted(4);
}

export const ActiveTurnsKeepStableDomIdentities: Story = {
  render: () => <PromptRailHarness />,
  play: async () => {
    await waitFor(() => expect(railBars().length).toBeGreaterThan(0));
    const sourceCount = Number(
      messageList().getAttribute('data-turn-source-count'),
    );
    expect(sourceCount).toBe(PROMPT_RAIL_ACTIVE_RANGE);
    expect(document.querySelectorAll('[data-turn-id]')).toHaveLength(sourceCount);

    // Marked on the elements themselves: a remount drops the attribute, which
    // a count alone cannot tell apart from a remount that produced the same
    // number of Turns.
    for (const turn of document.querySelectorAll<HTMLElement>('[data-turn-id]')) {
      turn.dataset.stableMountProbe = turn.dataset.turnId;
    }

    await scrollTranscriptTo('bottom');
    await scrollAwayFromTail();

    expect(document.querySelectorAll('[data-turn-id]')).toHaveLength(sourceCount);
    expect(document.querySelectorAll('[data-turn-id][data-stable-mount-probe]')).toHaveLength(
      sourceCount,
    );
  },
};

export const ScrollingAwayPreservesTurnOwnedFocus: Story = {
  render: () => <PromptRailHarness />,
  play: async () => {
    await waitFor(() => expect(railBars().length).toBeGreaterThan(0));
    await scrollTranscriptTo('bottom');

    const tailTurnId = `turn-scroll-${PROMPT_RAIL_TURN_COUNT}`;
    const turn = document.querySelector<HTMLElement>(`[data-turn-id="${tailTurnId}"]`);
    if (!turn) throw new Error('the tail Turn is missing');

    const action = document.createElement('button');
    action.dataset.turnOwnedAction = 'true';
    action.textContent = 'Turn-owned action';
    turn.append(action);
    action.focus();
    const range = document.createRange();
    range.selectNodeContents(action);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    await scrollAwayFromTail();

    await waitFor(() => {
      const active = document.activeElement;
      expect({
        retained: document.querySelector(`[data-turn-id="${tailTurnId}"]`) !== null,
        focusRetained: active instanceof HTMLElement && active.dataset.turnOwnedAction === 'true',
        selectionRetained: document.getSelection()?.isCollapsed === false,
      }).toEqual({ retained: true, focusRetained: true, selectionRetained: true });
    });
  },
};

export const OffscreenActiveTurnsStayFindable: Story = {
  render: () => <PromptRailHarness />,
  play: async () => {
    await waitFor(() => expect(railBars().length).toBeGreaterThan(0));
    const firstTurnId = document
      .querySelector('[data-turn-id]')
      ?.getAttribute('data-turn-id');
    const turnNumber = Number(firstTurnId?.split('-').at(-1));
    expect(turnNumber).toBeGreaterThan(0);
    const needle = `第 ${turnNumber} 个问题`;

    await scrollTranscriptTo('bottom');

    // `window.find` walks the rendered text, so a Turn skipped by
    // `content-visibility` would not be there to find.
    //
    // The E2E original also asserted the Turn's text was in the accessibility
    // tree, which needs CDP and so did not come across. The smoke's AX audit
    // is not a substitute: it checks for unnamed actionable nodes and
    // duplicate landmarks, never that a given string is exposed.
    document.getSelection()?.removeAllRanges();
    // `window.find` is non-standard, so it is not on the DOM lib's Window.
    const found = (window as unknown as { find(text: string): boolean }).find(needle);

    expect(found, `searching for ${needle}`).toBe(true);
    expect(document.getSelection()?.toString() ?? '').toContain(needle);
    document.getSelection()?.removeAllRanges();
  },
};

/** Where a Turn sits relative to the top of the scrollport. */
function turnOffsetFromScroller(turnId: string): number {
  const root = tailScroller();
  const turn = document.querySelector(`[data-turn-id="${CSS.escape(turnId)}"]`);
  if (!turn) throw new Error(`turn ${turnId} is not mounted`);
  return Math.round(turn.getBoundingClientRect().top - root.getBoundingClientRect().top);
}

/**
 * The Host's half of a rail jump: a tick for a Turn outside the active range
 * comes back out as `onLoadTranscriptTurn`, and the range moves to it. ChatView
 * holds the claim until the Turn mounts, then aligns to it.
 */
function PromptRailNavigationHarness() {
  const [firstIndex, setFirstIndex] = useState(PROMPT_RAIL_TAIL_RANGE_START);
  return (
    <ComposedShell
      chat={{
        messages: transcriptTurns(firstIndex, PROMPT_RAIL_ACTIVE_RANGE),
        transcriptTurnIndex: promptRailIndex,
        onLoadTranscriptTurn: (target) => setFirstIndex(target.sequence),
      }}
    />
  );
}

export const FirstRailClickLandsOnItsPromptAndHolds: Story = {
  render: () => <PromptRailNavigationHarness />,
  play: async () => {
    await waitFor(() => expect(railTicks().length).toBeGreaterThan(0));

    // The bug only exists while a scroll is in flight: a jump that finishes in
    // one frame has nothing for the tail-follow lock to collide with, which is
    // why the E2E original ran under a fixture that asked for motion back.
    // Here the fixture passes `scrollBehavior: 'smooth'` outright, so the one
    // thing that can still collapse the scroll under it is the browser's own
    // reduced-motion state.
    expect(
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      'a reduced-motion browser finishes the jump in one frame and this story stops testing anything',
    ).toBe(false);

    // The case that used to fail: the head of the conversation is not mounted,
    // so the jump has to bring it in, and the fill that follows changes
    // scrollHeight underneath the tail-follow lock. A lock that ignores
    // scroll-ups arriving with a changed height stays on and pulls the
    // transcript back to the bottom — the click looks dead until the reader
    // scrolls by hand.
    const targetTurnId = 'turn-scroll-1';
    expect(document.querySelector(`[data-turn-id="${targetTurnId}"]`)).toBe(null);

    railTicks()[0].click();

    // Bounded on both sides: below is the Turn never arriving, above is it
    // arriving and then being pulled off the top of the scrollport.
    await waitFor(
      () => expect(Math.abs(turnOffsetFromScroller(targetTurnId))).toBeLessThan(24),
      { timeout: 10_000 },
    );
    expect(railTicks()[0].getAttribute('aria-current')).toBe('true');

    // And stays: Turns keep resolving their content and remeasuring after the
    // jump, so one that only wins the first frame reads as landing and then
    // sliding away.
    await painted(72);
    const settled = turnOffsetFromScroller(targetTurnId);
    expect(settled, `the prompt slid to ${settled} after landing`).toBeGreaterThan(-24);
    expect(settled).toBeLessThan(24);
    expect(railTicks()[0].getAttribute('aria-current')).toBe('true');
  },
};

/**
 * Which tick the reading position maps to, derived the way the rail derives
 * it: the newest Turn when parked at the end, otherwise the first Turn in the
 * top third of the scrollport, projected onto the tick count.
 */
function promptRailSnapshot(): {
  currentIds: string[];
  expectedId: string | null;
  sourceTurnId: string | null;
} {
  const root = tailScroller();
  const ticks = railTicks();
  const currentIds = ticks
    .filter((tick) => tick.getAttribute('aria-current') === 'true')
    .map((tick) => tick.dataset.promptTurnId ?? '');
  const rootBounds = root.getBoundingClientRect();
  const atEnd = root.scrollHeight - root.scrollTop - root.clientHeight <= 2;
  const turns = [...root.querySelectorAll<HTMLElement>('[data-transcript-turn-id]')]
    .map((turn) => ({
      element: turn,
      id: turn.dataset.transcriptTurnId ?? '',
      index: Number(turn.dataset.transcriptTurnId?.split('-').at(-1)) - 1,
    }))
    .filter((turn) => turn.id.length > 0 && Number.isFinite(turn.index));
  const inScrollport = (element: HTMLElement, bottomEdge: number): boolean => {
    const bounds = element.getBoundingClientRect();
    return bounds.bottom > rootBounds.top && bounds.top < bottomEdge;
  };
  const readingBandTurns = turns
    .filter(({ element }) => inScrollport(element, rootBounds.top + rootBounds.height * 0.34))
    .sort((left, right) => left.index - right.index);
  const scrollportTurns = turns
    .filter(({ element }) => inScrollport(element, rootBounds.bottom))
    .sort((left, right) => left.index - right.index);
  const sourceTurn = atEnd
    ? turns.reduce<(typeof turns)[number] | null>(
        (latest, turn) => (latest === null || turn.index > latest.index ? turn : latest),
        null,
      )
    : (readingBandTurns[0] ?? scrollportTurns[0] ?? null);
  const expectedRailIndex =
    sourceTurn === null || ticks.length === 0
      ? null
      : Math.round((sourceTurn.index * (ticks.length - 1)) / (PROMPT_RAIL_TURN_COUNT - 1));
  return {
    currentIds,
    expectedId:
      expectedRailIndex === null ? null : (ticks[expectedRailIndex]?.dataset.promptTurnId ?? null),
    sourceTurnId: sourceTurn?.id ?? null,
  };
}

async function expectRailMatchesReadingPosition(where: string): Promise<void> {
  await waitFor(() => {
    const snapshot = promptRailSnapshot();
    expect(snapshot.expectedId, `no visible Turn at the ${where}`).not.toBe(null);
    expect(snapshot.currentIds, `rail at the ${where}: ${JSON.stringify(snapshot)}`).toEqual([
      snapshot.expectedId,
    ]);
  });
}

export const RailStaysOnTheVisiblePrompt: Story = {
  render: () => <PromptRailNavigationHarness />,
  play: async () => {
    const root = tailScroller();
    await waitFor(() => expect(railTicks().length).toBeGreaterThan(0));

    await scrollTranscriptTo('bottom');
    await expectRailMatchesReadingPosition('tail');
    expect(railTicks().at(-1)?.getAttribute('aria-current')).toBe('true');

    // Counted across every change, not sampled at rest: two current ticks for
    // one frame in the middle of a scroll is the failure, and it is invisible
    // to a reading taken after the scroll settles.
    const currentCounts: number[] = [];
    const rail = document.querySelector('.maka-prompt-rail');
    if (!rail) throw new Error('the prompt rail is missing');
    const record = (): void => {
      currentCounts.push(rail.querySelectorAll('.maka-prompt-rail-tick[aria-current="true"]').length);
    };
    const observer = new MutationObserver(record);
    observer.observe(rail, { attributes: true, subtree: true, attributeFilter: ['aria-current'] });
    record();

    try {
      // Reading positions across the active range, then a jump that replaces
      // the range entirely — the two ways the rail's input changes.
      for (const fraction of [0.75, 0.5, 0.25, 0]) {
        root.scrollTop = Math.round((root.scrollHeight - root.clientHeight) * fraction);
        root.dispatchEvent(new Event('scroll'));
        await painted(4);
        await expectRailMatchesReadingPosition(`${fraction * 100}% of the transcript`);
      }

      railTicks()[0].click();
      await waitFor(
        () => expect(document.querySelector('[data-turn-id="turn-scroll-1"]')).not.toBe(null),
        { timeout: 10_000 },
      );
      await scrollTranscriptTo('top');
      await expectRailMatchesReadingPosition('head');
      expect(railTicks()[0].getAttribute('aria-current')).toBe('true');
    } finally {
      observer.disconnect();
    }

    expect(currentCounts.length).toBeGreaterThan(1);
    expect(
      currentCounts.every((count) => count === 1),
      `current tick count over time: ${currentCounts.join(',')}`,
    ).toBe(true);
  },
};
