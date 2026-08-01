import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps, ReactNode } from 'react';
import type { SessionSummary, StoredMessage } from '@maka/core';
import { ChatSurfaceLayout, ChatView, Composer, type TurnFooterActionMeta } from '../src/components.js';
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
  modelLabel: 'Claude Sonnet 4.5',
  activeSession: session(),
  activeConnectionLabel: 'Anthropic',
  activeModel: 'claude-sonnet-4-5',
  activeModelLabel: 'Claude Sonnet 4.5',
  modelChoices,
  onModelChange: noop,
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

function SurfaceFrame(props: { children: ReactNode; narrow?: boolean; width?: number }) {
  return (
    <div
      style={{
        width: props.width ?? (props.narrow ? 560 : 960),
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
  width?: number;
}) {
  const messages = props.chat?.messages ?? baseChatProps.messages;
  const turnFooterActionsByTurn = Object.fromEntries(
    [...new Set(messages.map((m) => m.turnId))].map((id) => [id, DEFAULT_FOOTER_ACTIONS]),
  );
  return (
    <SurfaceFrame narrow={props.narrow} width={props.width}>
      <ChatSurfaceLayout
        style={{ width: '100%' }}
        composer={
          <div style={{ padding: '0 16px 16px' }}>
            <Composer {...baseComposerProps} {...props.composer} />
          </div>
        }
      >
        <ChatView {...baseChatProps} turnFooterActionsByTurn={turnFooterActionsByTurn} {...props.chat} />
      </ChatSurfaceLayout>
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

// Real path: a session already exists but has not produced its first turn yet.
// This locks the Astryx ChatMessageList empty-state path separately from 新任务.
export const ActiveEmptyChat: Story = {
  render: () => (
    <ChatSurface
      chat={{
        activeSession: session({ name: '尚未开始的会话' }),
        messages: [],
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

// Real path: a long session that has accumulated reasoning, several native
// Astryx tool calls and long prose, with an image staged in the composer and
// thinking set to medium. Each part is individually reachable; they are stacked
// into one screen on purpose, as the canonical Slice 9 visual-acceptance
// scaffold. Open this first, then the focused stories below for single states.
export const AstryxNativeConversation: Story = {
  render: () => (
    <ChatSurface
      chat={{
        messages: [...longMessages, ...multiStepConversation],
        memoryActive: true,
        onOpenMemorySettings: noop,
      }}
      composer={{
        draftKey: 'composer-astryx-native-conversation',
        pendingAttachments: [
          {
            displayName: 'chat-surface-review.png',
            kind: 'image',
            mimeType: 'image/png',
            size: 284_160,
          },
        ],
        onRemoveAttachment: noop,
        mentionSkills: [
          { id: 'review', name: 'Review', description: '检查实现与回归风险' },
          { id: 'frontend-design', name: 'Frontend Design', description: '检查界面层级与交互' },
        ],
        activeThinkingLevels: ['off', 'low', 'medium', 'high'],
        activeThinkingLevel: 'medium',
        onThinkingLevelChange: noop,
        onPlanModeChange: noop,
        onSwarmModeChange: noop,
        onGraphModeChange: noop,
        onToggleVoiceCapture: noop,
        onToggleRealtimeVoice: noop,
        voiceProviderLabel: '系统语音',
      }}
    />
  ),
};

// Real path: a derived revision is running an autonomous goal with local
// memory and Deep Research enabled. Session metadata stays in one context
// layer above the transcript instead of splitting across header pills and
// standalone branch/revision rows.
export const SessionContextCombined: Story = {
  render: () => {
    const activeSession = session({
      id: 'session-context-combined',
      name: 'Chat Surface 会话上下文在极窄窗口中的响应式收敛与信息优先级验证',
      labels: ['mode:deep_research'],
      parentSessionId: 'session-parent',
      branchOfTurnId: 'turn-1',
    });
    return (
      <ChatSurface
        chat={{
          activeSession,
          messages: shortConversation,
          memoryActive: true,
          onOpenMemorySettings: noop,
          goalIndicator: {
            condition: '把 Session Context Layer 收敛到可 review 状态',
            status: 'active',
            iterations: 4,
            maxIterations: 12,
            onClear: noop,
          },
          branchBanner: {
            parentSessionId: 'session-parent',
            parentSessionName: 'UI polish 主线评审与跨会话来源追踪的完整上下文',
            fromAbortedTurn: true,
          },
          onBranchBannerClick: noop,
          revisionNavigation: {
            current: 2,
            total: 3,
            previousSessionId: 'session-context-revision-1',
            nextSessionId: 'session-context-revision-3',
          },
          onRevisionNavigate: noop,
        }}
        composer={{
          draftKey: 'composer-session-context-combined',
          activeSession,
        }}
      />
    );
  },
};

// Real path: the same combined context with a narrow chat column. Goal remains
// visible while lower-priority metadata collapses into Astryx MoreMenu.
export const SessionContextNarrow: Story = {
  render: () => {
    const activeSession = session({
      id: 'session-context-narrow',
      name: 'Chat Surface 收敛',
      labels: ['mode:deep_research'],
      parentSessionId: 'session-parent',
      branchOfTurnId: 'turn-1',
    });
    return (
      <ChatSurface
        narrow
        width={360}
        chat={{
          activeSession,
          messages: shortConversation,
          memoryActive: true,
          onOpenMemorySettings: noop,
          goalIndicator: {
            condition: '把 Session Context Layer 收敛到可 review 状态',
            status: 'active',
            iterations: 4,
            maxIterations: 12,
            onClear: noop,
          },
          branchBanner: {
            parentSessionId: 'session-parent',
            parentSessionName: 'UI polish 主线评审',
            fromAbortedTurn: true,
          },
          onBranchBannerClick: noop,
          revisionNavigation: {
            current: 2,
            total: 3,
            previousSessionId: 'session-context-revision-1',
            nextSessionId: 'session-context-revision-3',
          },
          onRevisionNavigate: noop,
        }}
        composer={{
          draftKey: 'composer-session-context-narrow',
          activeSession,
        }}
      />
    );
  },
};
