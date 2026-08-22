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

import type { CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ArtifactRecord } from '@maka/core/artifacts';
import type { BrowserState } from '@maka/core/browser';
import type { GitReviewSnapshot } from '@maka/core/git-review';
import type { SessionSummary } from '@maka/core/session';
import type { Task } from '@maka/core/task-ledger';
import type { SessionTrace } from '@maka/core/session-trace';
import type { ContextDiagnosticsResult } from '@maka/runtime-host/protocol';
import { ToastProvider } from '@maka/ui';
import type {
  DesktopSessionUsageSummary,
  MakaBridge,
} from '../src/preload/bridge-contract';
import { SessionWorkbar } from '../src/renderer/session-workbar';
import {
  createSessionWorkbarPanelsState,
  createSessionWorkbarTabsState,
  openStaticSessionWorkbarTab,
} from '../src/renderer/session-workbar-tabs';
import { withScopedMakaBridge } from './maka-bridge';

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.
//
// One group for the whole workbar, because the workbar is the only host any of
// these panels has. Each tab renders its real component inside the real shell,
// so the frame is the app's rather than a retyped approximation — which is what
// FIDELITY asks for, and what a per-panel story cannot give: the earlier
// separate Artifact Pane / Session Trace / Task Ledger groups each carried a
// hand-written box, and two of them re-rendered pixels this group already owns.
//
// What this group cannot show: the seam. The workbar's surface tone only reads
// as a seam against the conversation plate it stands beside, and the plate is
// two levels up in the shell — as is the titlebar clearance the surface bleeds
// through. Both are pinned by computed-style assertions in
// e2e/session-workbar.spec.ts instead.
//
// Read these at a canvas of 990px or wider. The app's own breakpoint is on the
// viewport, and Storybook's canvas IS the viewport, so a narrower window puts
// the panel in its stacked full-width variant rather than in a column. That is
// the real rule firing, not the story misbehaving; the render smoke mounts at
// 1280, above it.

const SESSION_ID = 'session-workbar';
const STACKED_WINDOW_VIEWPORT = {
  makaStackedWindow: {
    name: 'Maka window below the 990px stack point',
    styles: { width: '900px', height: '900px' },
    type: 'desktop' as const,
  },
};
const NOW = Date.UTC(2026, 6, 31, 10, 30, 0);
const EMPTY_BROWSER_STATE: BrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  secure: false,
  hasPage: false,
};
const LOADED_BROWSER_STATE: BrowserState = {
  ...EMPTY_BROWSER_STATE,
  url: 'https://maka.apache.org/docs/getting-started',
  title: 'Getting started — Apache Maka',
  canGoBack: true,
  secure: true,
  hasPage: true,
};
const TOOL_PICKER_SOURCE_SESSION: SessionSummary = {
  id: SESSION_ID,
  name: '工作栏组件审查',
  isFlagged: false,
  isArchived: false,
  labels: [],
  hasUnread: false,
  status: 'active',
  lastMessageAt: NOW,
  backend: 'ai-sdk',
  llmConnectionSlug: 'anthropic-main',
  connectionLocked: false,
  model: 'claude-sonnet-4-5',
  permissionMode: 'ask',
};

// The record-file row reads `app:info`'s operationalStateDatabasePath (the
// exact path main resolves). The short one is what a default workspace looks
// like; the long one proves the row truncates the directory while the
// filename stays (the path is hover/focus-copy reachable, the copy button is
// not pushed out) even at the panel's 320px minimum width.
const DEFAULT_RECORD_FILE_PATH = 'C:\\Users\\reviewer\\Maka\\workspaces\\default\\runtime.sqlite';
const LONG_RECORD_FILE_PATH =
  'C:\\Users\\reviewer\\Maka\\workspaces\\default\\projects\\trace-record-file-truncation-\\with-a-very-long-owner\\runtime.sqlite';

// ---- ledgers -------------------------------------------------------------

// Mirrors the `task-ledger` e2e fixture (apps/desktop/src/main/e2e-fixture/
// scenarios-chat.ts), which builds this tree through the SQLite store; that
// store cannot run in a browser, so the shapes are restated rather than
// imported. The long subject is deliberate: it is what proves a deep indent
// still wraps instead of pushing owner and reason off the panel.
function task(input: Partial<Task> & Pick<Task, 'id' | 'key' | 'subject'>): Task {
  return { status: 'pending', createdAt: NOW, updatedAt: NOW, ...input };
}

const tasks: Task[] = [
  task({
    id: 'task-1',
    key: 'T1',
    subject: '完成会话任务台账升级',
    status: 'in_progress',
    owner: { actor: 'main_agent', runId: 'run-task-parent' },
  }),
  task({
    id: 'task-2',
    key: 'T1.1',
    subject: '验证 SQLite authority 与并发短 key 分配',
    parentId: 'task-1',
    status: 'completed',
    completionEvidence: 'Core 与 Storage 定向测试全部通过。',
    endedAt: NOW - 120_000,
    updatedAt: NOW - 120_000,
  }),
  task({
    id: 'task-3',
    key: 'T1.2',
    subject: '检查窄窗口下的任务树布局',
    parentId: 'task-1',
    status: 'blocked',
    blockedReason: '等待视觉回归截图确认 990px 视口没有文字重叠。',
    owner: { actor: 'child_agent', agentId: 'local-read' },
  }),
  task({
    id: 'task-4',
    key: 'T1.2.1',
    subject: '核对深层缩进、超长任务描述、owner 与阻塞原因在窄窗口中仍可完整换行且不遮挡后续内容',
    parentId: 'task-3',
  }),
  task({ id: 'task-5', key: 'T2', subject: '同步生命周期文档与边界说明' }),
  task({
    id: 'task-6',
    key: 'T3',
    subject: '验证 Goal 一次提醒门禁',
    status: 'completed',
    endedAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
  }),
];

const artifacts: ArtifactRecord[] = [
  {
    id: 'artifact-patch',
    sessionId: SESSION_ID,
    turnId: 'turn-review',
    createdAt: NOW,
    name: 'slice-9-conversation.diff',
    kind: 'diff',
    relativePath: `${SESSION_ID}/slice-9-conversation.diff`,
    sizeBytes: 4_812,
    mimeType: 'text/x-diff',
    source: 'tool_result',
    status: 'live',
  },
  {
    id: 'artifact-notes',
    sessionId: SESSION_ID,
    turnId: 'turn-review',
    createdAt: NOW - 60_000,
    name: 'conversation-review-notes-with-a-deliberately-long-name.md',
    kind: 'file',
    relativePath: `${SESSION_ID}/conversation-review-notes.md`,
    sizeBytes: 1_284,
    mimeType: 'text/markdown',
    source: 'tool_result',
    status: 'live',
  },
];

const artifactText: Record<string, string> = {
  'artifact-patch': [
    'diff --git a/apps/desktop/src/renderer/session-workbar.tsx',
    '-    <aside className="maka-session-workbar">',
    '+    <Card variant="transparent" padding={0} height="100%">',
  ].join('\n'),
  'artifact-notes': '# Conversation review\n\n- Long transcript\n- Narrow viewport',
};

const gitReviewFiles: GitReviewSnapshot['files'] = [
  {
    path: 'apps/desktop/src/renderer/session-review-panel.tsx',
    status: 'modified',
    additions: 28,
    deletions: 94,
    diff: [
      'diff --git a/apps/desktop/src/renderer/session-review-panel.tsx b/apps/desktop/src/renderer/session-review-panel.tsx',
      '--- a/apps/desktop/src/renderer/session-review-panel.tsx',
      '+++ b/apps/desktop/src/renderer/session-review-panel.tsx',
      '@@ -30,8 +30,6 @@',
      "-type ReviewSource = GitReviewSource | 'last-turn';",
      '+const REVIEW_FILE_PAGE_SIZE = 20;',
      '-const [messages, setMessages] = useState<StoredMessage[]>([]);',
      "+source: 'branch',",
    ].join('\n'),
  },
  {
    path: 'apps/desktop/src/renderer/locales/conversation-copy.ts',
    status: 'modified',
    additions: 17,
    deletions: 4,
    diff: [
      'diff --git a/apps/desktop/src/renderer/locales/conversation-copy.ts b/apps/desktop/src/renderer/locales/conversation-copy.ts',
      '--- a/apps/desktop/src/renderer/locales/conversation-copy.ts',
      '+++ b/apps/desktop/src/renderer/locales/conversation-copy.ts',
      '@@ -372,1 +372,1 @@',
      "-      review: '审阅',",
      "+      review: '变更',",
    ].join('\n'),
  },
  {
    path: 'apps/desktop/src/main/git-review-main.ts',
    status: 'modified',
    additions: 18,
    deletions: 0,
    diff: [
      'diff --git a/apps/desktop/src/main/git-review-main.ts b/apps/desktop/src/main/git-review-main.ts',
      '--- a/apps/desktop/src/main/git-review-main.ts',
      '+++ b/apps/desktop/src/main/git-review-main.ts',
      '@@ -56,1 +56,4 @@',
      "+const branchComparison = await runGit(repositoryRoot, ['merge-base', baseBranch, 'HEAD']);",
    ].join('\n'),
  },
];

const gitReviewSnapshot: GitReviewSnapshot = {
  source: 'branch',
  repositoryRoot: '/Users/reviewer/maka-agent',
  currentBranch: 'feat/git-authoritative-changes',
  baseBranch: 'main',
  baseBranchOptions: ['main', 'release/0.1'],
  revision: 'storybook-git-review',
  additions: gitReviewFiles.reduce((total, file) => total + file.additions, 0),
  deletions: gitReviewFiles.reduce((total, file) => total + file.deletions, 0),
  truncated: false,
  files: gitReviewFiles,
};

const populatedTrace: SessionTrace = {
  schemaVersion: 1,
  sessionId: SESSION_ID,
  turns: [
    {
      turnId: 'turn-1',
      runId: 'run-1',
      startedAt: NOW,
      endedAt: NOW + 8_400,
      durationMs: 8_400,
      steps: [
        {
          kind: 'model_call',
          id: 'call-1',
          turnId: 'turn-1',
          runId: 'run-1',
          startedAt: NOW,
          endedAt: NOW + 3_100,
          durationMs: 3_100,
          callKind: 'main',
          providerId: 'zai',
          modelId: 'glm-5.1',
          step: 0,
          status: 'completed',
          costUsd: 0.0182,
          attempts: [
            {
              attemptId: 'attempt-1a',
              attempt: 0,
              status: 'failed',
              startedAt: NOW,
              completedAt: NOW + 900,
              latencyMs: 900,
              errorClass: 'overloaded',
              costBasis: 'unpriced',
              usageBasis: 'missing',
            },
            {
              attemptId: 'attempt-1b',
              attempt: 1,
              status: 'completed',
              startedAt: NOW + 1_000,
              completedAt: NOW + 3_100,
              latencyMs: 2_100,
              inputTokens: 62_400,
              outputTokens: 480,
              cacheReadInputTokens: 58_900,
              reasoningTokens: 120,
              contextWindow: 200_000,
              costUsd: 0.0182,
              costBasis: 'priced',
              usageBasis: 'reported',
            },
          ],
        },
        {
          kind: 'tool',
          id: 'tool-1',
          turnId: 'turn-1',
          runId: 'run-1',
          startedAt: NOW + 3_200,
          endedAt: NOW + 3_760,
          durationMs: 560,
          toolName: 'read',
          status: 'completed',
        },
        {
          kind: 'compaction',
          id: 'compaction-1',
          turnId: 'turn-1',
          runId: 'run-1',
          startedAt: NOW + 3_800,
          checkpointId: 'checkpoint-9',
        },
      ],
    },
    {
      turnId: 'turn-2',
      runId: 'run-2',
      startedAt: NOW + 20_000,
      endedAt: NOW + 24_500,
      durationMs: 4_500,
      steps: [
        {
          kind: 'tool',
          id: 'tool-2',
          turnId: 'turn-2',
          runId: 'run-2',
          startedAt: NOW + 20_100,
          endedAt: NOW + 21_900,
          durationMs: 1_800,
          toolName: 'bash',
          status: 'failed',
          recovered: { disposition: 'parked', reasonCode: 'sandbox_denied' },
        },
        {
          kind: 'error',
          id: 'error-1',
          turnId: 'turn-2',
          runId: 'run-2',
          startedAt: NOW + 22_000,
          message: 'sandbox denied the write',
        },
      ],
      failure: { code: 'tool_failed', message: 'sandbox denied the write' },
    },
    {
      turnId: 'turn-3',
      runId: 'run-3',
      startedAt: NOW + 40_000,
      endedAt: NOW + 43_600,
      durationMs: 3_600,
      steps: [
        {
          kind: 'model_call',
          id: 'call-3',
          turnId: 'turn-3',
          runId: 'run-3',
          startedAt: NOW + 40_000,
          endedAt: NOW + 42_900,
          durationMs: 2_900,
          callKind: 'main',
          providerId: 'zai',
          modelId: 'glm-5.1',
          step: 0,
          status: 'completed',
          costUsd: 0.0061,
          attempts: [
            {
              attemptId: 'attempt-3a',
              attempt: 0,
              status: 'completed',
              startedAt: NOW + 40_000,
              completedAt: NOW + 42_900,
              latencyMs: 2_900,
              timeToFirstTokenMs: 640,
              inputTokens: 18_900,
              outputTokens: 260,
              cacheReadInputTokens: 15_200,
              contextWindow: 200_000,
              costUsd: 0.0061,
              costBasis: 'priced',
              usageBasis: 'reported',
            },
          ],
        },
      ],
    },
  ],
  coverage: {
    modelCalls: 'partial',
    turnsMissingModelCalls: [{ runId: 'run-2', turnId: 'turn-2' }],
    unreadableRecords: 1,
    oversizedRuns: 0,
    turnsWithFewerModelCallsThanSteps: [],
  },
};

const populatedContext: ContextDiagnosticsResult = {
  status: 'available',
  providerId: 'zai',
  modelId: 'glm-5.1',
  completedAt: NOW + 42_900,
  inputTokens: 18_900,
  // Providers that cache always count the hits, and most real sessions carry
  // one — the bar splits the prompt only when the snapshot reports it.
  cacheReadInputTokens: 15_200,
  contextWindow: 200_000,
  composition: {
    segments: [
      { kind: 'system_instructions', bytes: 12_000 },
      { kind: 'tool_definitions', bytes: 42_000 },
      { kind: 'messages', bytes: 21_800 },
      { kind: 'other', bytes: 400 },
    ],
    tools: [
      { name: 'Bash', bytes: 9_400 },
      { name: 'Read', bytes: 7_100 },
      { name: 'Edit', bytes: 6_300 },
      { name: 'Grep', bytes: 5_200 },
      { name: 'mcp__Claude_Browser__computer', bytes: 4_800 },
      { name: 'WebFetch', bytes: 3_900 },
      { name: 'Write', bytes: 3_100 },
      { name: 'Glob', bytes: 2_200 },
    ],
  },
};

/** A ledger written before tool schemas carried a name: bytes, no names. */
/**
 * The same session with its latest prompt resized. The bar reads the snapshot
 * now, so "near the limit" is a property of the snapshot rather than of a
 * trace attempt (#2323).
 */
const nearLimitContext: ContextDiagnosticsResult = {
  ...populatedContext,
  ...(populatedContext.status === 'available'
    ? { inputTokens: 186_400, cacheReadInputTokens: 151_800 }
    : {}),
};

const unnamedToolsContext: ContextDiagnosticsResult = {
  ...populatedContext,
  composition: {
    segments: populatedContext.status === 'available' ? populatedContext.composition!.segments : [],
    unlabelledToolBytes: 42_000,
  },
};

/**
 * The durable metering record named this request; the best-effort capture that
 * would have explained it never landed. A real state, and the one the panel
 * must state rather than render as an empty prompt.
 */
const unrecordedContext: ContextDiagnosticsResult = {
  status: 'available',
  providerId: 'zai',
  modelId: 'glm-5.1',
  completedAt: NOW + 42_900,
  inputTokens: 18_900,
  contextWindow: 200_000,
};

const emptyTrace: SessionTrace = {
  schemaVersion: 1,
  sessionId: SESSION_ID,
  turns: [],
  coverage: {
    modelCalls: 'none',
    turnsMissingModelCalls: [],
    unreadableRecords: 0,
    oversizedRuns: 0,
    turnsWithFewerModelCallsThanSteps: [],
  },
};

const olderTrace: SessionTrace = {
  ...emptyTrace,
  turns: [
    {
      turnId: 'turn-older',
      runId: 'run-older',
      startedAt: NOW - 60_000,
      endedAt: NOW - 60_000,
      durationMs: 0,
      steps: [],
    },
  ],
};

const emptyUsageSummary: DesktopSessionUsageSummary = {
  range: { from: NOW, to: NOW },
  totalRequests: 0,
  totalCostUsd: 0,
  totalTokens: {
    input: 0,
    output: 0,
    cacheMiss: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
  },
  cacheHitRequests: 0,
  cacheCreateRequests: 0,
  errorRequests: 0,
  provenance: {
    coverage: {
      attempts: 0,
      pricedAttempts: 0,
      unpricedAttempts: 0,
      usageReportedAttempts: 0,
      usagePartialAttempts: 0,
      usageMissingAttempts: 0,
    },
    legacyRecords: 0,
    unreadableRecords: 0,
    pendingRepairs: 0,
  },
};

const populatedUsageSummary: DesktopSessionUsageSummary = {
  range: { from: NOW, to: NOW + 43_600 },
  totalRequests: 3,
  totalCostUsd: 0.0243,
  totalTokens: {
    input: 81_300,
    output: 740,
    cacheMiss: 7_200,
    cacheRead: 74_100,
    cacheWrite: 0,
    reasoning: 120,
    total: 82_040,
  },
  cacheHitRequests: 2,
  cacheCreateRequests: 0,
  errorRequests: 1,
  provenance: {
    coverage: {
      attempts: 3,
      pricedAttempts: 2,
      unpricedAttempts: 1,
      usageReportedAttempts: 2,
      usagePartialAttempts: 0,
      usageMissingAttempts: 1,
    },
    legacyRecords: 0,
    unreadableRecords: 1,
    pendingRepairs: 0,
  },
};

// ---- bridge --------------------------------------------------------------

const noop = () => undefined;
const unsubscribe = () => () => undefined;

/**
 * The four bridges the workbar reads at once. Needing all of them together is
 * why the shell had no story before; each option below is the one fact a story
 * varies, and everything else stays on the populated default.
 */
function bridge(options: {
  tasks?: Task[];
  tasksFail?: boolean;
  trace?: SessionTrace;
  traceNextCursor?: string;
  traceFail?: boolean;
  /** The context snapshot the composition block reads (#2323). */
  context?: ContextDiagnosticsResult;
  recordFilePath?: string;
  browserState?: BrowserState;
} = {}) {
  const browserState = options.browserState ?? EMPTY_BROWSER_STATE;
  return withScopedMakaBridge({
    tasks: {
      list: async () => {
        if (options.tasksFail) throw new Error('读取任务失败');
        return options.tasks ?? tasks;
      },
      subscribeChanges: unsubscribe,
    },
    artifacts: {
      list: async () => artifacts,
      get: async (id: string) => artifacts.find((record) => record.id === id) ?? null,
      readText: async (id: string) => ({ ok: true, text: artifactText[id] ?? '' }),
      readBinary: async () => ({ ok: false, reason: 'unsupported_mime' }),
      delete: async () => undefined,
      subscribeChanges: unsubscribe,
    },
    app: {
      // The record-file row reads only operationalStateDatabasePath; the rest
      // of AppInfo is real-IPC data no story needs, so the mock carries just
      // the seam.
      info: async () => ({
        operationalStateDatabasePath: options.recordFilePath ?? DEFAULT_RECORD_FILE_PATH,
      }),
      openArtifactPath: async () => ({ ok: true, opened: 'artifact-patch' }),
      saveArtifactAs: async () => ({ ok: true, saved: 'slice-9-conversation.diff' }),
    },
    inspector: {
      trace: async (_sessionId, cursor) =>
        options.traceFail
          ? {
              ok: false,
              error: { code: 'TRACE_READ_FAILED', message: '追踪读取失败：无法读取运行记录' },
            }
          : {
              ok: true,
              data: cursor
                ? { trace: olderTrace, nextCursor: null }
                : {
                    trace: options.trace ?? emptyTrace,
                    nextCursor: options.traceNextCursor ?? null,
                  },
            },
      summary: async () => ({
        ok: true,
        data:
          options.trace && options.trace.turns.length > 0
            ? populatedUsageSummary
            : emptyUsageSummary,
      }),
      subscribeUsageChanges: unsubscribe,
      context: async () => ({
        ok: true,
        data: options.context ?? { status: 'unavailable', reason: 'no_completed_request' },
      }),
    } satisfies MakaBridge['inspector'],
    gitReview: {
      read: async () => ({
        ok: true,
        snapshot: gitReviewSnapshot,
      }),
    },
    browser: {
      getState: async () => browserState,
      onState: unsubscribe,
      setViewport: noop,
      navigate: async () => undefined,
      back: async () => undefined,
      forward: async () => undefined,
      reload: async () => undefined,
      stop: async () => undefined,
      close: async () => undefined,
    },
    sessions: { subscribeEvents: unsubscribe },
  });
}

/**
 * The AppShell grid the workbar really lives in, with an empty conversation
 * column. Its 990px media query is what stacks the column in narrow windows.
 */
function Workbar(props: {
  tab?: 'review' | 'tasks' | 'browser' | 'files' | 'inspector';
  sourceSession?: SessionSummary;
  /** Overrides the restored column width, the way the resize handle does. */
  width?: number;
}) {
  const emptyTabsState = createSessionWorkbarTabsState();
  const tabsState = props.tab
    ? openStaticSessionWorkbarTab(emptyTabsState, props.tab)
    : emptyTabsState;
  return (
    <ToastProvider>
      <div
        className="maka-detail-with-artifacts"
        style={{
          // Fill the preview viewport like AppShell fills the window; a fixed
          // height pushes the stacked workbar below the fold in short windows.
          height: '100dvh',
          ...(props.width ? { '--maka-session-workbar-width': `${props.width}px` } : {}),
        } as CSSProperties}
      >
        <div className="mainColumn" />
        <SessionWorkbar
          sessionId={SESSION_ID}
          hidden={false}
          onDismissPanel={noop}
          panelsState={createSessionWorkbarPanelsState(tabsState)}
          rightCollapsed={false}
          bottomOpen={false}
          onActivateTab={noop}
          onCloseTab={noop}
          onCloseTabs={noop}
          onReorderTab={noop}
          onMoveTab={noop}
          onMoveTabToPanel={noop}
          onPinTab={noop}
          onOpenLauncher={noop}
          onRequestOpenTab={noop}
          sourceSession={props.sourceSession}
        />
      </div>
    </ToastProvider>
  );
}

const meta = {
  title: 'Product/Session Workbar',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Real path: sidebar → a session → expand an empty workbar. The picker is the
// workbar's empty content, composed entirely from Astryx List primitives.
export const ToolPicker: Story = {
  decorators: [bridge()],
  render: () => <Workbar sourceSession={TOOL_PICKER_SOURCE_SESSION} />,
};

// Real path: 任务工作栏 → 变更, showing the live branch comparison from the
// session cwd. The panel is Git-backed; no message or tool-result fixture is
// involved in this story.
export const Changes: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="review" />,
};

// Real path: sidebar → a session → 展开任务工作栏, landing on the tab the app
// restored. Tasks is the default: an in-progress root, a child claimed and
// blocked by a subagent, and the finished ones folded into 最近结束.
export const Tasks: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="tasks" />,
};

// Real path: 任务工作栏 → 任务 on a session whose agent never wrote a task.
export const TasksEmpty: Story = {
  decorators: [bridge({ tasks: [] })],
  render: () => <Workbar tab="tasks" />,
};

// Real path: 任务工作栏 → 任务 when `tasks.list` rejects; 重试 re-runs the read.
export const TasksLoadFailed: Story = {
  decorators: [bridge({ tasksFail: true })],
  render: () => <Workbar tab="tasks" />,
};

// Storybook cannot host the native WebContentsView, so these pin what the panel
// itself draws — chrome and empty state — inside the real workbar shell.
export const BrowserEmpty: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="browser" />,
};

// The first navigation: hasPage is derived from the URL, still empty until the
// page commits, so the empty state and a live 停止 control share a frame.
export const BrowserLoading: Story = {
  decorators: [bridge({ browserState: { ...EMPTY_BROWSER_STATE, loading: true } })],
  render: () => <Workbar tab="browser" />,
};

// A committed page. The strip below the toolbar is blank here because the native
// view owns that rect in the app.
export const BrowserLoaded: Story = {
  decorators: [bridge({ browserState: LOADED_BROWSER_STATE })],
  render: () => <Workbar tab="browser" />,
};

// An http page, where `secure` turns into Astryx's warning status on the field.
export const BrowserInsecure: Story = {
  decorators: [bridge({
    browserState: { ...LOADED_BROWSER_STATE, url: 'http://192.168.1.10:8080/dashboard', title: 'Local dashboard', secure: false },
  })],
  render: () => <Workbar tab="browser" />,
};

// The column's 320px floor — the least room the toolbar row ever gets.
export const BrowserAtColumnFloor: Story = {
  decorators: [bridge({ browserState: LOADED_BROWSER_STATE })],
  render: () => <Workbar tab="browser" width={320} />,
};

// The width the resize handle lands on most often, between the floor and default.
export const BrowserAt400: Story = {
  decorators: [bridge({ browserState: LOADED_BROWSER_STATE })],
  render: () => <Workbar tab="browser" width={400} />,
};

// Below 990px the grid stacks the same right-placement column under the
// conversation: full width, capped at 42dvh. Storybook-UI only: the smoke lane
// loads iframes at 1280px, above the stack point, so it renders wide there.
export const BrowserStacked: Story = {
  parameters: { viewport: { options: STACKED_WINDOW_VIEWPORT } },
  globals: { viewport: { value: 'makaStackedWindow', isRotated: false } },
  decorators: [bridge({ browserState: LOADED_BROWSER_STATE })],
  render: () => <Workbar tab="browser" />,
};

// Real path: 任务工作栏 → 文件, on a session whose agent wrote artifacts. The
// count in the tab is the pane's own filtered total, reported upward.
// The pane's empty state renders the same EmptyState as TraceEmpty below, so it
// is not a second story.
export const Files: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="files" />,
};

// Real path: 任务工作栏 → 追踪, on a session that has run turns — the overview
// reads a context budget, token/cache figures and the session's facts off a
// retried model call and a post-compaction call, while a turn that failed on a
// denied tool sits in the raw record under the coverage notice the projection
// raises when records are missing.
export const Trace: Story = {
  decorators: [bridge({ trace: populatedTrace, context: populatedContext })],
  render: () => <Workbar tab="inspector" />,
};

// Real path: the first bounded page of a longer trace. The continuation control
// sits before the ascending timeline because earlier records are inserted at
// that edge, not after the newest turn.
export const TraceMoreHistory: Story = {
  decorators: [
    bridge({
      trace: populatedTrace,
      traceNextCursor: 'older-session-trace-page',
      context: populatedContext,
    }),
  ],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 任务工作栏 → 追踪 on a long session whose latest call sits near the
// top of its window — the tier the context bands and their legend switch to
// before a compaction, and the state a reader is most likely to open the tab
// for. Same session as Trace, sized differently, so the two read side by side.
export const TraceContextNearLimit: Story = {
  decorators: [bridge({ trace: populatedTrace, context: nearLimitContext })],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 任务工作栏 → 追踪 on a session recorded before tool schemas carried
// a name — the shape of every ledger written prior to #2323. The composition
// block still has to show those bytes, as unnamed tools rather than as a
// missing category, which is what gating the tool list on the NAMED rows alone
// silently broke.
export const TraceUnnamedTools: Story = {
  decorators: [bridge({ trace: populatedTrace, context: unnamedToolsContext })],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 任务工作栏 → 追踪 when the durable metering record names the latest
// request but its best-effort capture never landed — the composition block has
// to SAY so, since an absent section reads as "nothing to explain" and a zero
// reads as an empty prompt.
export const TraceCompositionUnrecorded: Story = {
  decorators: [bridge({ trace: populatedTrace, context: unrecordedContext })],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 任务工作栏 → 追踪 on a session that has not run a turn yet — the
// state the task-ledger e2e fixture opens on.
export const TraceEmpty: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 任务工作栏 → 追踪 when `inspector.trace` reports a failed read (an
// unreadable or partially written run ledger); retry lives on the banner.
export const TraceReadFailed: Story = {
  decorators: [bridge({ traceFail: true })],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 任务工作栏 → 追踪 on a workspace whose path overflows the panel
// — the record-file row keeps its label and copy button, and the path alone
// truncates. (The default stories above already show the row with a short
// path; this variant pins the truncation contract.)
export const TraceRecordFile: Story = {
  decorators: [bridge({ trace: populatedTrace, recordFilePath: LONG_RECORD_FILE_PATH })],
  render: () => <Workbar tab="inspector" />,
};
