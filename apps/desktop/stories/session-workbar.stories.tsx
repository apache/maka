import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ArtifactRecord, Task } from '@maka/core';
import type { SessionTrace } from '@maka/core/session-trace';
import { ToastProvider } from '@maka/ui';
import { SessionWorkbar } from '../src/renderer/session-workbar';
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
// the real rule firing, not the story misbehaving; the visual smoke pass
// renders at 1280, above it.

const SESSION_ID = 'session-workbar';
const NOW = Date.UTC(2026, 6, 31, 10, 30, 0);

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
      totals: {
        durationMs: 8_400,
        modelAttempts: 2,
        retries: 1,
        compactions: 1,
        inputTokens: 62_400,
        outputTokens: 480,
        costUsd: 0.0182,
        unpricedAttempts: 1,
      },
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
      totals: {
        durationMs: 4_500,
        modelAttempts: 0,
        retries: 0,
        compactions: 0,
        inputTokens: 0,
        outputTokens: 0,
        unpricedAttempts: 0,
      },
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
      totals: {
        durationMs: 3_600,
        modelAttempts: 1,
        retries: 0,
        compactions: 0,
        inputTokens: 18_900,
        outputTokens: 260,
        costUsd: 0.0061,
        unpricedAttempts: 0,
      },
    },
  ],
  totals: {
    durationMs: 16_500,
    modelAttempts: 3,
    retries: 1,
    compactions: 1,
    inputTokens: 81_300,
    outputTokens: 740,
    costUsd: 0.0243,
    unpricedAttempts: 1,
  },
  coverage: {
    modelCalls: 'partial',
    turnsMissingModelCalls: ['turn-2'],
    unreadableRecords: 1,
    turnsWithFewerModelCallsThanSteps: [],
  },
};

/**
 * The same session with its latest prompt resized, rather than a second copy
 * of the fixture: what the near-limit story is about is the size of one call,
 * and a fork would drift from `populatedTrace` on every other axis.
 */
const nearLimitTrace: SessionTrace = {
  ...populatedTrace,
  turns: populatedTrace.turns.map((turn, index) =>
    index !== populatedTrace.turns.length - 1
      ? turn
      : {
          ...turn,
          steps: turn.steps.map((step) =>
            step.kind !== 'model_call'
              ? step
              : {
                  ...step,
                  attempts: step.attempts.map((attempt) => ({
                    ...attempt,
                    inputTokens: 186_400,
                    cacheReadInputTokens: 151_800,
                  })),
                },
          ),
        },
  ),
};

const emptyTrace: SessionTrace = {
  schemaVersion: 1,
  sessionId: SESSION_ID,
  turns: [],
  totals: {
    durationMs: 0,
    modelAttempts: 0,
    retries: 0,
    compactions: 0,
    inputTokens: 0,
    outputTokens: 0,
    unpricedAttempts: 0,
  },
  coverage: {
    modelCalls: 'none',
    turnsMissingModelCalls: [],
    unreadableRecords: 0,
    turnsWithFewerModelCallsThanSteps: [],
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
  traceFail?: boolean;
} = {}) {
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
      openArtifactPath: async () => ({ ok: true, opened: 'artifact-patch' }),
      saveArtifactAs: async () => ({ ok: true, saved: 'slice-9-conversation.diff' }),
    },
    inspector: {
      trace: async () =>
        options.traceFail
          ? { ok: false, error: { message: '追踪读取失败：无法读取运行记录' } }
          : { ok: true, data: options.trace ?? emptyTrace },
    },
    sessions: { subscribeEvents: unsubscribe },
  });
}

/** The column AppShell hands the workbar, at the width it restores by default. */
function Workbar(props: { tab: 'tasks' | 'files' | 'inspector' }) {
  return (
    <div style={{ height: 720, display: 'flex', justifyContent: 'flex-end' }}>
      <ToastProvider>
        <SessionWorkbar
          sessionId={SESSION_ID}
          browserLive={false}
          hidden={false}
          onDismiss={noop}
          activeTab={props.tab}
          onActiveTabChange={noop}
        />
      </ToastProvider>
    </div>
  );
}

const meta = {
  title: 'Product/Session Workbar',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Real path: sidebar → a session → 展开会话工作栏, landing on the tab the app
// restored. Tasks is the default: an in-progress root, a child claimed and
// blocked by a subagent, and the finished ones folded into 最近结束.
export const Tasks: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="tasks" />,
};

// Real path: 会话工作栏 → 任务 on a session whose agent never wrote a task.
export const TasksEmpty: Story = {
  decorators: [bridge({ tasks: [] })],
  render: () => <Workbar tab="tasks" />,
};

// Real path: 会话工作栏 → 任务 when `tasks.list` rejects; 重试 re-runs the read.
export const TasksLoadFailed: Story = {
  decorators: [bridge({ tasksFail: true })],
  render: () => <Workbar tab="tasks" />,
};

// Real path: 会话工作栏 → 文件, on a session whose agent wrote artifacts. The
// count in the tab is the pane's own filtered total, reported upward.
// The pane's empty state renders the same EmptyState as TraceEmpty below, so it
// is not a second story.
export const Files: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="files" />,
};

// Real path: 会话工作栏 → 追踪, on a session that has run turns — the overview
// reads a context budget, token/cache figures and the session's facts off a
// retried model call and a post-compaction call, while a turn that failed on a
// denied tool sits in the raw record under the coverage notice the projection
// raises when records are missing.
export const Trace: Story = {
  decorators: [bridge({ trace: populatedTrace })],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 会话工作栏 → 追踪 on a long session whose latest call sits near the
// top of its window — the tier the context bands and their legend switch to
// before a compaction, and the state a reader is most likely to open the tab
// for. Same session as Trace, sized differently, so the two read side by side.
export const TraceContextNearLimit: Story = {
  decorators: [bridge({ trace: nearLimitTrace })],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 会话工作栏 → 追踪 on a session that has not run a turn yet — the
// state the task-ledger e2e fixture opens on.
export const TraceEmpty: Story = {
  decorators: [bridge()],
  render: () => <Workbar tab="inspector" />,
};

// Real path: 会话工作栏 → 追踪 when `inspector.trace` reports a failed read (an
// unreadable or partially written run ledger); retry lives on the banner.
export const TraceReadFailed: Story = {
  decorators: [bridge({ traceFail: true })],
  render: () => <Workbar tab="inspector" />,
};
