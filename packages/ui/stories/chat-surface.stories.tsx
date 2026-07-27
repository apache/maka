import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps, ReactNode } from 'react';
import type { SessionSummary, StoredMessage } from '@maka/core';
import { ChatView, Composer, type TurnFooterActionMeta } from '../src/components.js';
import type { ChatModelChoice } from '../src/chat-model-helpers.js';

const NOW = Date.UTC(2026, 6, 1, 9, 30, 0);

// Fidelity convention (#1433): every story below names the real app path
// that reaches it. See apps/desktop/stories/FIDELITY.md.

const meta = {
  title: 'Product/Chat Surface',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;
type ChatViewProps = ComponentProps<typeof ChatView>;
type ComposerProps = ComponentProps<typeof Composer>;

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

function noop() {
  return undefined;
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-chat-story',
    name: '整理本周发布风险',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt: NOW,
    lastMessagePreview: '我先看测试、diff 和待确认事项。',
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: false,
    model: 'claude-sonnet-4-5',
    permissionMode: 'ask',
    ...overrides,
  };
}

function user(id: string, turnId: string, minutesAgo: number, text: string): StoredMessage {
  return {
    type: 'user',
    id,
    turnId,
    ts: NOW - minutesAgo * 60_000,
    text,
  };
}

function assistant(id: string, turnId: string, minutesAgo: number, text: string): StoredMessage {
  return {
    type: 'assistant',
    id,
    turnId,
    ts: NOW - minutesAgo * 60_000,
    text,
    modelId: 'claude-sonnet-4-5',
  };
}

function turnState(turnId: string, status: Extract<StoredMessage, { type: 'turn_state' }>['status']): StoredMessage {
  return {
    type: 'turn_state',
    id: `state-${turnId}`,
    turnId,
    ts: NOW - 30_000,
    status,
    partialOutputRetained: status !== 'running',
  };
}

const baseChatProps: ChatViewProps = {
  messages: [],
  activeSession: session(),
  activeConnectionLabel: 'Anthropic',
  activeModel: 'claude-sonnet-4-5',
  activeModelLabel: 'Claude Sonnet 4.5',
  modelChoices,
  userLabel: '你',
  onNew: noop,
  onPromptSuggestion: noop,
};

// #546: default footer actions shown on every turn in the story so the
// redesigned icon-only footer (regenerate / branch / copy / info) is
// visible without each story wiring it up by hand.
const DEFAULT_FOOTER_ACTIONS: ReadonlyArray<TurnFooterActionMeta> = [
  { id: 'regenerate', label: '重新生成', enabled: true, tooltip: '让模型重新生成本轮回答' },
  { id: 'branch', label: '分支', enabled: true, tooltip: '基于此回答的上下文分支出新对话' },
  { id: 'copy', label: '复制', enabled: true, tooltip: '复制回答到剪贴板' },
  { id: 'info', label: '详情', enabled: true, tooltip: 'claude-sonnet-4-5 · 4.9s · $0.0123' },
];

const baseComposerProps: ComposerProps = {
  draftKey: 'storybook-chat-surface',
  onSend: noop,
  onStop: noop,
  onPickAttachments: noop,
  onAttachFilePaths: noop,
  expertTeams: [
    { id: 'code-review', name: 'Code Review Team', description: 'Correctness, simplification, and test-coverage reviewers.' },
  ],
  onStartExpertTeam: noop,
  modelLabel: 'Claude Sonnet 4.5',
  activeSession: session(),
  activeConnectionLabel: 'Anthropic',
  activeModel: 'claude-sonnet-4-5',
  activeModelLabel: 'Claude Sonnet 4.5',
  modelChoices,
  permissionMode: 'ask',
  onPermissionModeChange: noop,
	  workspacePicker: {
	    label: 'maka-agent',
	    branch: 'codex/storybook-chat-surface',
	    projects: [],
	    onAdd: noop,
	    onSelectProject: noop,
	    onRelink: noop,
	    onSelectNoProject: noop,
	  },
};

function SurfaceFrame(props: { children: ReactNode; narrow?: boolean }) {
  return (
    <div
      style={{
        width: props.narrow ? 560 : 960,
        maxWidth: 'calc(100vw - 48px)',
        height: props.narrow ? 700 : 760,
        margin: '0 auto',
        display: 'flex',
        minHeight: 0,
        overflow: 'hidden',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-xl)',
        background: 'var(--background)',
      }}
    >
      {props.children}
    </div>
  );
}

function ChatSurface(props: {
  chat?: Partial<ChatViewProps>;
  composer?: Partial<ComposerProps>;
  narrow?: boolean;
}) {
  const messages = props.chat?.messages ?? baseChatProps.messages;
  const turnFooterActionsByTurn = Object.fromEntries(
    [...new Set(messages.map((m) => m.turnId))].map((id) => [id, DEFAULT_FOOTER_ACTIONS]),
  );
  return (
    <SurfaceFrame narrow={props.narrow}>
      <div
        style={{
          display: 'flex',
          minHeight: 0,
          width: '100%',
          flexDirection: 'column',
          background: 'var(--background)',
        }}
      >
        <ChatView {...baseChatProps} turnFooterActionsByTurn={turnFooterActionsByTurn} {...props.chat} />
        <div style={{ padding: '0 24px 24px' }}>
          <Composer {...baseComposerProps} {...props.composer} />
        </div>
      </div>
    </SurfaceFrame>
  );
}

function ComposerTray(props: { children: ReactNode }) {
  return (
    <SurfaceFrame>
      <div
        style={{
          width: '100%',
          display: 'grid',
          alignContent: 'center',
          gap: 28,
          padding: 32,
          background: 'var(--surface-canvas)',
        }}
      >
        {props.children}
      </div>
    </SurfaceFrame>
  );
}

const shortConversation: StoredMessage[] = [
  user('msg-user-1', 'turn-1', 16, '帮我把这轮 UI polish 前的风险列出来，只保留真正会影响 review 的部分。'),
  assistant(
    'msg-assistant-1',
    'turn-1',
    14,
    '可以。现在最值得先固定的是状态覆盖：空对话、流式输出、工具调用、分支提示、长消息和 composer 的 pending/disabled 状态。视觉细节先不要动。',
  ),
];

const toolConversation: StoredMessage[] = [
  user('msg-user-tools', 'turn-tools', 18, '检查一下这个分支的 Storybook 是否能独立构建。'),
  {
    type: 'tool_call',
    id: 'tool-build-storybook',
    turnId: 'turn-tools',
    ts: NOW - 17 * 60_000,
    toolName: 'Bash',
    displayName: '构建 Storybook',
    intent: '运行 desktop Storybook 静态构建，确认 stories 能离开 app shell 渲染',
    args: {
      cmd: 'npm run -w @maka/desktop build-storybook',
      cwd: '/workspace/maka-agent',
    },
  },
  {
    type: 'tool_result',
    id: 'tool-build-storybook-result',
    turnId: 'turn-tools',
    ts: NOW - 16 * 60_000,
    toolUseId: 'tool-build-storybook',
    isError: false,
    durationMs: 7140,
    content: {
      kind: 'terminal',
      cwd: '/workspace/maka-agent',
      cmd: 'npm run -w @maka/desktop build-storybook',
      status: 'completed',
      exitCode: 0,
      output: {
        mode: 'pipes',
        stdout: 'storybook v10.4.6\ninfo => Output directory: apps/desktop/storybook-static\n',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    },
  },
  assistant(
    'msg-assistant-tools',
    'turn-tools',
    15,
    'Storybook 可以构建。这个状态重点看工具调用卡片在对话 turn 内的位置，以及回答文本落在工具调用之后是否清楚。',
  ),
];

const longMessages: StoredMessage[] = [
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

// Multi-step reasoning turn (streaming UI rework): two think->say->call steps
// in a single turn. Each step persists an assistant row (thinking + text) plus
// tool_calls tagged with that row's id as `stepId`, so the turn timeline
// reconstructs the real order — 深度思考 → answer text → tool trow — per step,
// instead of lumping every tool into one trailing group.
const multiStepConversation: StoredMessage[] = [
  user('msg-user-multistep', 'turn-multistep', 12, '看一下 stream-fade 的环逻辑有没有边界问题，然后跑一下单测。'),
  {
    type: 'tool_call',
    id: 'tool-read-stream-fade',
    turnId: 'turn-multistep',
    ts: NOW - 11 * 60_000,
    toolName: 'Read',
    displayName: '读取 stream-fade.ts',
    intent: '读取淡入环的实现，确认窗口滑动与上限',
    stepId: 'msg-assistant-step-1',
    args: { file_path: 'packages/ui/src/stream-fade.ts' },
  },
  {
    type: 'tool_result',
    id: 'tool-read-stream-fade-result',
    turnId: 'turn-multistep',
    ts: NOW - 11 * 60_000 + 900,
    toolUseId: 'tool-read-stream-fade',
    isError: false,
    durationMs: 640,
    content: {
      kind: 'text',
      text: 'export function updateFadeRing(...) { /* prune + cap */ }',
    },
  },
  {
    type: 'assistant',
    id: 'msg-assistant-step-1',
    turnId: 'turn-multistep',
    ts: NOW - 10 * 60_000,
    text: '环逻辑没问题：增长记录批次、超窗剪枝、再按上限截断，收缩时整体重置。接下来我跑一下单测确认。',
    thinking: {
      text: '先读实现，确认 boundary 取的是最老存活批次的 start，age 用 now 减去覆盖该 offset 的批次时间。看起来窗口滑动和上限都覆盖了，值得跑一遍测试坐实。',
    },
    modelId: 'claude-sonnet-4-5',
  },
  {
    type: 'tool_call',
    id: 'tool-run-tests',
    turnId: 'turn-multistep',
    ts: NOW - 10 * 60_000 + 500,
    toolName: 'Bash',
    displayName: '运行 stream-fade 单测',
    intent: '执行 node --test 跑淡入环与 tokenizer 的单测',
    stepId: 'msg-assistant-step-2',
    args: { cmd: 'node --test dist/main/__tests__/stream-fade.test.js' },
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
      cmd: 'node --test dist/main/__tests__/stream-fade.test.js',
      status: 'completed',
      exitCode: 0,
      output: {
        mode: 'pipes',
        stdout: 'tests 13\npass 13\nfail 0\n',
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

// #1307: reasoning + tool calls between two answer texts fold into one
// collapsed "Processing" block. Here a single reasoning/tool phase (two
// think-then-call steps with no answer text between them, one failing tool)
// collapses into one Processing summary — the tool roll-up「读取 1 个文件，搜索
// 1 次，运行 1 条命令，1 个失败」(folded reasoning stays inside the block but is
// not counted) — followed by the assistant's answer text rendered in place.
const processingConversation: StoredMessage[] = [
  user('msg-user-processing', 'turn-processing', 13, '排查 stream-fade 的环边界，跑一下单测确认。'),
  {
    type: 'tool_call',
    id: 'proc-read',
    turnId: 'turn-processing',
    ts: NOW - 12 * 60_000,
    toolName: 'Read',
    activityKind: 'read',
    displayName: '读取 stream-fade.ts',
    intent: '读取淡入环实现，确认窗口滑动与上限',
    stepId: 'proc-a1',
    args: { file_path: 'packages/ui/src/stream-fade.ts' },
  },
  {
    type: 'tool_result',
    id: 'proc-read-result',
    turnId: 'turn-processing',
    ts: NOW - 12 * 60_000 + 700,
    toolUseId: 'proc-read',
    isError: false,
    durationMs: 620,
    content: { kind: 'text', text: 'export function updateFadeRing(...) { /* prune + cap */ }' },
  },
  {
    type: 'assistant',
    id: 'proc-a1',
    turnId: 'turn-processing',
    ts: NOW - 11 * 60_000,
    text: '',
    thinking: { text: '先读实现，确认 boundary 取最老存活批次的 start，age 用 now 减去覆盖该 offset 的批次时间。' },
    modelId: 'claude-sonnet-4-5',
  },
  {
    type: 'tool_call',
    id: 'proc-grep',
    turnId: 'turn-processing',
    ts: NOW - 11 * 60_000 + 400,
    toolName: 'Grep',
    activityKind: 'search',
    displayName: '搜索 updateFadeRing 调用点',
    intent: '搜索环更新的调用点，确认边界处理是否一致',
    stepId: 'proc-a2',
    args: { pattern: 'updateFadeRing' },
  },
  {
    type: 'tool_result',
    id: 'proc-grep-result',
    turnId: 'turn-processing',
    ts: NOW - 11 * 60_000 + 900,
    toolUseId: 'proc-grep',
    isError: false,
    durationMs: 480,
    content: { kind: 'text', text: 'packages/ui/src/stream-fade.ts:42\npackages/ui/src/chat-turn.tsx:910' },
  },
  {
    type: 'tool_call',
    id: 'proc-test',
    turnId: 'turn-processing',
    ts: NOW - 11 * 60_000 + 1_200,
    toolName: 'Bash',
    activityKind: 'command',
    displayName: '运行 stream-fade 单测',
    intent: '执行 node --test 跑淡入环单测',
    stepId: 'proc-a2',
    args: { cmd: 'node --test dist/main/__tests__/stream-fade.test.js' },
  },
  {
    type: 'tool_result',
    id: 'proc-test-result',
    turnId: 'turn-processing',
    ts: NOW - 10 * 60_000,
    toolUseId: 'proc-test',
    isError: true,
    durationMs: 1_640,
    content: {
      kind: 'terminal',
      cwd: '/workspace/maka-agent/apps/desktop',
      cmd: 'node --test dist/main/__tests__/stream-fade.test.js',
      status: 'failed',
      exitCode: 1,
      output: {
        mode: 'pipes',
        stdout: 'tests 13\npass 12\nfail 1\n',
        stderr: 'not ok 7 - collapses the ring when a batch ages out\n',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    },
  },
  {
    type: 'assistant',
    id: 'proc-a2',
    turnId: 'turn-processing',
    ts: NOW - 10 * 60_000 + 500,
    text: '',
    thinking: { text: '调用点只有两处，边界一致；跑测试却挂了一个 age-out 用例，说明剪枝顺序还有问题。' },
    modelId: 'claude-sonnet-4-5',
  },
  assistant(
    'proc-a3',
    'turn-processing',
    9,
    '有一个 age-out 用例失败，说明批次超窗剪枝在收缩路径上漏了一步。我先补上重置逻辑，再重跑这条单测。上面的 Processing 折叠里保留了完整的思考与工具时间线。',
  ),
];

// Real path: 新任务 → the chat surface before the first send: no active session, ChatView
// falls back to its empty hero, the composer picks the model for the session it is about
// to create.
export const EmptyChat: Story = {
  render: () => (
    <ChatSurface
      chat={{
        activeSession: undefined,
        messages: [],
        emptyOverride: undefined,
      }}
      composer={{
        activeSession: undefined,
        activeConnectionLabel: undefined,
        activeModel: undefined,
        activeModelLabel: undefined,
        newChatModel: {
          llmConnectionSlug: 'anthropic-main',
          model: 'claude-sonnet-4-5',
        },
        onPickNewChatModel: noop,
        onOpenModelSettings: noop,
      }}
    />
  ),
};

// Real path: send a message → the turn is running and text is streaming in; the composer
// shows Stop.
export const StreamingResponse: Story = {
  render: () => (
    <ChatSurface
      chat={{
        messages: [
          user('msg-user-streaming', 'turn-streaming', 6, '用三句话说明这个 PR 的 review 重点。'),
          turnState('turn-streaming', 'running'),
        ],
        liveTurn: {
          turnId: 'turn-streaming', phase: 'streamed', steps: [{
            stepId: 'msg-assistant-streaming',
            text: { text: '第一，状态覆盖要完整。第二，fixture 要小，不复制 app shell。第三，验证以 Storybook build 和 typecheck 为准。', truncated: false, complete: false },
            tools: [],
          }],
        },
      }}
      composer={{
        streaming: true,
      }}
    />
  ),
};

// Real path: send a message the agent answers with tool calls → the tool rows render
// inline in the turn.
export const WithToolActivity: Story = {
  render: () => (
    <ChatSurface
      chat={{
        messages: toolConversation,
      }}
    />
  ),
};

// Real path: a turn where the agent thinks, answers, and calls tools more than once →
// each step keeps its own thinking/text/tool order.
export const MultiStepReasoning: Story = {
  render: () => (
    <ChatSurface
      chat={{
        messages: multiStepConversation,
      }}
    />
  ),
};

// Real path: a turn whose reasoning and tool calls sit between two answer texts → they
// fold into one collapsed Processing block (#1307).
export const Processing: Story = {
  render: () => (
    <ChatSurface
      chat={{
        messages: processingConversation,
      }}
    />
  ),
};

// Real path: hover a turn → 从这里分支 → the new session opens with the parent banner above
// the transcript.
export const BranchedConversation: Story = {
  render: () => (
    <ChatSurface
      chat={{
        activeSession: session({
          id: 'session-chat-branch',
          name: '从 polish 计划分支',
          parentSessionId: 'session-parent',
          branchOfTurnId: 'turn-1',
        }),
        messages: shortConversation,
        branchBanner: {
          parentSessionId: 'session-parent',
          parentSessionName: 'UI polish 主线评审',
        },
        onBranchBannerClick: noop,
      }}
      composer={{
        activeSession: session({
          id: 'session-chat-branch',
          name: '从 polish 计划分支',
          parentSessionId: 'session-parent',
          branchOfTurnId: 'turn-1',
        }),
      }}
    />
  ),
};

// Real path: two composer states, side by side as a review scaffold: left = Stop pressed
// while streaming (stop pending); right = the agent is waiting on a permission answer,
// so the composer is disabled and the permission select explains why.
export const ComposerPendingAndDisabled: Story = {
  render: () => (
    <ComposerTray>
      <Composer
        {...baseComposerProps}
        draftKey="composer-streaming-pending"
        streaming
        stopPending
      />
      <Composer
        {...baseComposerProps}
        draftKey="composer-disabled-permission"
        disabled
        activeSession={session({
          status: 'waiting_for_user',
          blockedReason: 'permission_required',
        })}
        permissionModeDisabledReason="当前有工具调用正在等待确认，处理后再切换权限模式。"
      />
    </ComposerTray>
  ),
};

// Real path: 新任务 → ＋ in the composer → the add-context menu, which is where attachment
// and file import start.
export const ImportActions: Story = {
  render: () => (
    <ChatSurface
      chat={{
        activeSession: undefined,
        messages: [],
      }}
      composer={{
        activeSession: undefined,
        activeConnectionLabel: undefined,
        activeModel: undefined,
        activeModelLabel: undefined,
        onPickAttachments: noop,
        onAttachFilePaths: noop,
        newChatModel: {
          llmConnectionSlug: 'anthropic-main',
          model: 'claude-sonnet-4-5',
        },
        onPickNewChatModel: noop,
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const trigger = canvasElement.querySelector<HTMLButtonElement>('button[aria-label="添加上下文"]');
    trigger?.click();
  },
};

// Real path: any session whose turns are long enough to exercise prose wrapping, with
// local memory enabled so the memory pill shows.
export const LongMessages: Story = {
  render: () => (
    <ChatSurface
      chat={{
        messages: longMessages,
        memoryActive: true,
        onOpenMemorySettings: noop,
      }}
      composer={{
        draftKey: 'composer-long-messages',
      }}
    />
  ),
};

// Real path: the same session with the window narrowed (or the workbar open), which is
// what drives the narrow chat layout.
export const NarrowViewport: Story = {
  render: () => (
    <ChatSurface
      narrow
      chat={{
        messages: longMessages,
        memoryActive: true,
        onOpenMemorySettings: noop,
      }}
      composer={{
        draftKey: 'composer-narrow-viewport',
      }}
    />
  ),
};
