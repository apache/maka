/**
 * Subagent sessions — session presentation contract (design lock).
 *
 * - Sidebar lists only root/user sessions (no nested subagent tree).
 * - Multiple spawn_subagent calls in one turn render as compact linked-session
 *   rows in source order; ordinary tool evidence keeps its own ChatToolCalls.
 * - Opening a linked subagent switches the main chat column (option A);
 *   titlebar is project › parent › child.
 * - No composer drawer, strip, or parallel card system for subagents.
 *
 * Titlebar and sidebar use the same product components as app-shell
 * (TitlebarSessionIdentity, SessionListPanel, deriveSessionRail). The
 * multi-spawn group renders through the production ToolTrow; each child
 * session is one native Astryx row and the row itself opens the session.
 */
import { useState, type CSSProperties, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent } from 'storybook/test';
import {
  ChatComposer,
  ChatComposerInput,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
} from '@astryxdesign/core/Chat';
import { Text } from '@astryxdesign/core/Text';
import type { SessionSummary } from '@maka/core/session';
import type { ToolResultContent } from '@maka/core/events';
import {
  SessionListPanel,
  TitlebarSessionIdentity,
} from '@maka/ui';
import { ToolTrow } from '../../../packages/ui/src/tool-activity.js';
import type { ToolActivityItem } from '../../../packages/ui/src/materialize.js';
import { deriveSessionRail } from '../src/renderer/session-rail.js';

// ---------------------------------------------------------------------------
// Fixtures — multi-subagent contiguous tool run
// ---------------------------------------------------------------------------

const NOW = 1_735_689_600_000;
const PARENT_NAME = '实现会话任务台账';
const PROJECT_NAME = 'maka-agent';

function subagentResult(
  partial: Partial<Extract<ToolResultContent, { kind: 'subagent' }>> &
    Pick<Extract<ToolResultContent, { kind: 'subagent' }>, 'agentName' | 'status'>,
): Extract<ToolResultContent, { kind: 'subagent' }> {
  return {
    kind: 'subagent',
    agentId: partial.agentId ?? `agent-${partial.agentName}`,
    agentName: partial.agentName,
    turnId: partial.turnId ?? `turn-${partial.agentName}`,
    runId: partial.runId ?? `run-${partial.agentName}`,
    // Linked child id is what product open wiring needs; stories seed it so
    // expanded tool detail shows the same Open control as the shell.
    childSessionId: partial.childSessionId ?? `session-${partial.agentName}`,
    status: partial.status,
    permissionMode: partial.permissionMode ?? 'ask',
    summary: partial.summary ?? '',
    artifactIds: partial.artifactIds ?? [],
    startedAt: partial.startedAt ?? NOW - 60_000,
    completedAt: partial.completedAt,
    durationMs: partial.durationMs ?? 12_000,
    eventCount: partial.eventCount ?? 8,
    ...(partial.failureClass ? { failureClass: partial.failureClass } : {}),
  };
}

const MULTI_SUBAGENT_ITEMS: ToolActivityItem[] = [
  {
    toolUseId: 'sa-explore-layout',
    toolName: 'spawn_subagent',
    displayName: 'explore · 读布局',
    intent: '扫 desktop session list 与 workbar 相关样式',
    status: 'running',
    args: { agentName: 'explore · 读布局', objective: '扫 desktop session list 与 workbar 相关样式' },
    result: subagentResult({
      agentName: 'explore · 读布局',
      status: 'running',
      permissionMode: 'explore',
      durationMs: 72_000,
      startedAt: NOW - 72_000,
    }),
    durationMs: 72_000,
  },
  {
    toolUseId: 'sa-coder-draft',
    toolName: 'spawn_subagent',
    displayName: 'coder · 写草案',
    intent: '起草 titlebar breadcrumb 扩展点',
    status: 'running',
    args: { agentName: 'coder · 写草案', objective: '起草 titlebar breadcrumb 扩展点' },
    result: subagentResult({
      agentName: 'coder · 写草案',
      status: 'running',
      durationMs: 48_000,
      startedAt: NOW - 48_000,
    }),
    durationMs: 48_000,
  },
  {
    toolUseId: 'sa-review-contract',
    toolName: 'spawn_subagent',
    displayName: 'review · 契约',
    intent: '核对侧栏不再渲染 data-subagent 嵌套行',
    status: 'completed',
    args: { agentName: 'review · 契约', objective: '核对侧栏不再渲染 data-subagent 嵌套行' },
    result: subagentResult({
      agentName: 'review · 契约',
      status: 'completed',
      summary: '侧栏无嵌套；入口仅在流内工具组。',
      durationMs: 125_000,
      startedAt: NOW - 200_000,
      completedAt: NOW - 75_000,
    }),
    durationMs: 125_000,
  },
  {
    toolUseId: 'sa-explore-fail',
    toolName: 'spawn_subagent',
    displayName: 'explore · 失败样例',
    intent: '演示失败态在分组工具行中的可读性',
    status: 'errored',
    args: { agentName: 'explore · 失败样例', objective: '演示失败态' },
    result: subagentResult({
      agentName: 'explore · 失败样例',
      status: 'failed',
      summary: '权限边界拒绝读取 .env。',
      failureClass: 'permission_denied',
      durationMs: 19_000,
      startedAt: NOW - 40_000,
      completedAt: NOW - 21_000,
    }),
    durationMs: 19_000,
  },
  {
    toolUseId: 'sa-waiting',
    toolName: 'spawn_subagent',
    displayName: 'explore · 等用户',
    intent: '等待批准后再读路径',
    status: 'running',
    args: { agentName: 'explore · 等用户', objective: '等待批准后再读路径', permissionMode: 'explore' },
    result: subagentResult({
      agentName: 'explore · 等用户',
      status: 'waiting_for_user',
      permissionMode: 'explore',
      summary: 'Waiting for approval before reading the requested path.',
      durationMs: 4_000,
      startedAt: NOW - 4_000,
    }),
    durationMs: 4_000,
  },
];

function childLabel(item: ToolActivityItem): string {
  if (item.result?.kind === 'subagent' && item.result.agentName) return item.result.agentName;
  return item.displayName || item.toolName;
}

function childObjective(item: ToolActivityItem): string {
  if (typeof item.intent === 'string' && item.intent.trim()) return item.intent;
  return childLabel(item);
}

/**
 * Hosted under `.maka-turn` so product hover paint applies:
 * `apps/desktop/src/renderer/styles/chat-message.css` scopes
 * `.astryx-chat-tool-calls [role="button"]:hover` to that turn root.
 */
function SubagentToolGroup(props: {
  items: ToolActivityItem[];
  onOpenLinkedSession?(sessionId: string): void;
}) {
  return (
    <div className="maka-turn">
      <ToolTrow items={props.items} onOpenLinkedSession={props.onOpenLinkedSession} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const shell: Record<string, CSSProperties> = {
  root: {
    height: 720,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--color-background-body, #f4f4f5)',
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-sans, system-ui)',
  },
  titlebar: {
    height: 44,
    display: 'flex',
    alignItems: 'center',
    paddingInline: 16,
    gap: 12,
    borderBottom: '1px solid var(--color-border-muted, rgba(0,0,0,0.08))',
    flex: '0 0 auto',
  },
  body: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  plate: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--color-background-surface, #fff)',
    borderRadius: 12,
    overflow: 'hidden',
  },
  stream: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: '16px 20px',
  },
  composerStack: {
    flex: '0 0 auto',
    padding: '0 16px 16px',
  },
  caption: {
    padding: '6px 12px',
    borderBottom: '1px solid var(--color-border-muted, rgba(0,0,0,0.06))',
    background: 'var(--color-background-muted, rgba(0,0,0,0.03))',
  },
  rail: {
    width: 260,
    flex: '0 0 auto',
    minHeight: 0,
    alignSelf: 'stretch',
  },
  compareRoot: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 16,
    padding: 16,
    minHeight: 560,
    boxSizing: 'border-box' as const,
    background: 'var(--color-background-body, #f4f4f5)',
  },
  comparePane: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    padding: 14,
    borderRadius: 12,
    background: 'var(--color-background-surface, #fff)',
    border: '1px solid var(--color-border-muted, rgba(0,0,0,0.1))',
  },
};

const NOOP_ROW_ACTIONS = {
  onToggleFlag() {},
  onArchive() {},
  onUnarchive() {},
  onRename() {},
  onDelete() {},
};

function makeRailSession(
  overrides: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'name'>,
): SessionSummary {
  return {
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'fake',
    permissionMode: 'ask',
    ...overrides,
  };
}

const PARENT_SESSION_ID = 'parent';
const LINKED_CHILD_SESSION_ID = 'session-explore-layout';

/** Full session catalog: roots plus one linked child (child stays off the rail). */
const RAIL_FIXTURE_SESSIONS: SessionSummary[] = [
  makeRailSession({ id: PARENT_SESSION_ID, name: PARENT_NAME, lastMessageAt: 30 }),
  makeRailSession({ id: 'peer-ci', name: '修 CI 绿线', lastMessageAt: 20 }),
  makeRailSession({ id: 'peer-docs', name: '文档润色', lastMessageAt: 10 }),
  makeRailSession({
    id: LINKED_CHILD_SESSION_ID,
    name: 'explore · 读布局',
    lastMessageAt: 25,
    subagentParent: {
      kind: 'subagent',
      parentSessionId: PARENT_SESSION_ID,
      spawnedBy: {
        parentRunId: 'run',
        parentTurnId: 'turn',
        toolCallId: 'tool',
      },
      lifecycle: 'foreground',
    },
  }),
];

function Caption(props: { children: ReactNode }) {
  return (
    <div style={shell.caption}>
      <Text type="supporting" color="secondary">
        {props.children}
      </Text>
    </div>
  );
}

function ProductTitlebar(props: {
  sessionName: string;
  parentName?: string;
}) {
  return (
    <TitlebarSessionIdentity
      sessionName={props.sessionName}
      onRenameSession={() => undefined}
      project={{
        name: PROJECT_NAME,
        onOpenFolder: () => undefined,
      }}
      parentSession={
        props.parentName
          ? {
              name: props.parentName,
              onOpen: () => undefined,
            }
          : undefined
      }
    />
  );
}

function ProductRail(props: { activeSessionId: string }) {
  const { sessions, activeRowId } = deriveSessionRail(
    RAIL_FIXTURE_SESSIONS,
    props.activeSessionId,
    () => true,
  );
  return (
    <div style={shell.rail}>
      <SessionListPanel
        selection={{ section: 'sessions', filter: 'chats' }}
        sessions={sessions}
        activeId={activeRowId}
        width={260}
        onSelectSession={() => undefined}
        onSelect={() => undefined}
        onOpenSettings={() => undefined}
        onNew={() => undefined}
        rowActions={NOOP_ROW_ACTIONS}
      />
    </div>
  );
}

function ParentShell() {
  const [activeChildId, setActiveChildId] = useState<string>();
  const activeChild = MULTI_SUBAGENT_ITEMS.find(
    item => item.result?.kind === 'subagent' && item.result.childSessionId === activeChildId,
  );
  if (activeChild) return <ChildShell item={activeChild} />;

  return (
    <div style={shell.root} data-maka-contract="subagent-session-layout">
      <header style={shell.titlebar}>
        <ProductTitlebar sessionName={PARENT_NAME} />
      </header>
      <Caption>
        侧栏为 SessionListPanel + deriveSessionRail（仅 root）。流内连续
        spawn_subagent 保持为紧凑 Astryx 会话行。无 ComposerDrawer / strip。
      </Caption>
      <div style={shell.body}>
        <ProductRail activeSessionId={PARENT_SESSION_ID} />
        <div style={shell.plate}>
          <div style={shell.stream}>
            <ChatMessageList>
              <ChatMessage sender="user">
                <ChatMessageBubble>
                  并行派多个子代理做布局扫描、草案与契约核对。
                </ChatMessageBubble>
              </ChatMessage>
              <ChatMessage sender="assistant" name="Maka">
                <ChatMessageBubble>
                  当轮连续 spawn_subagent 保持原始顺序，每个子会话占一小行；点某行进入对应会话。
                </ChatMessageBubble>
                <ChatMessageMetadata timestamp="刚刚" />
                <div style={{ marginTop: 10, width: '100%' }}>
                  <SubagentToolGroup
                    items={MULTI_SUBAGENT_ITEMS}
                    onOpenLinkedSession={setActiveChildId}
                  />
                </div>
              </ChatMessage>
            </ChatMessageList>
          </div>
          <div style={shell.composerStack}>
            <ChatComposer
              onSubmit={() => undefined}
              placeholder="继续编排父会话…"
              input={<ChatComposerInput aria-label="消息输入" />}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ChildShell({ item }: { item: ToolActivityItem }) {
  return (
    <div style={shell.root}>
      <header style={shell.titlebar}>
        <ProductTitlebar sessionName={childLabel(item)} parentName={PARENT_NAME} />
      </header>
      <Caption>
        从工具组打开后的主区。侧栏仍是 deriveSessionRail 的 root 列表并高亮父会话。
      </Caption>
      <div style={shell.body}>
        <ProductRail activeSessionId={LINKED_CHILD_SESSION_ID} />
        <div style={shell.plate}>
          <div style={shell.stream}>
            <ChatMessageList>
              <ChatMessage sender="user">
                <ChatMessageBubble>{childObjective(item)}</ChatMessageBubble>
              </ChatMessage>
              <ChatMessage sender="assistant" name={childLabel(item)}>
                <ChatMessageBubble>子代理完整会话流。</ChatMessageBubble>
                <ChatMessageMetadata timestamp="运行中" />
              </ChatMessage>
            </ChatMessageList>
          </div>
          <div style={shell.composerStack}>
            <ChatComposer
              onSubmit={() => undefined}
              placeholder="向该子代理追问…"
              input={<ChatComposerInput aria-label="子会话消息输入" />}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stories — three locks, nothing else
// ---------------------------------------------------------------------------

const meta = {
  title: 'Product/Subagent Sessions',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Session presentation for subagents: flat sidebar, compact linked-session rows, ' +
          'main-column open with parent › child titlebar. No composer drawer.',
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Real path: parent session with multi-subagent tool group; flat SessionListPanel rail + TitlebarSessionIdentity.
export const ParentSession: Story = {
  name: '父会话 · 工具组 + 打开子会话',
  render: () => <ParentShell />,
  play: async ({ canvasElement }) => {
    const row = Array.from(canvasElement.querySelectorAll<HTMLButtonElement>('button'))
      .find(candidate => candidate.textContent?.includes('explore · 读布局'));
    if (!row) throw new Error('linked subagent row not found');
    await userEvent.click(row);
    if (!canvasElement.querySelector('[aria-label="子会话消息输入"]')) {
      throw new Error('linked subagent session did not open');
    }
  },
};

// Real path: one native Astryx row per linked child session.
export const ToolGroupFold: Story = {
  name: '多子代理 · 原生会话行',
  render: () => (
    <div style={shell.comparePane}>
      <Text type="body" style={{ fontWeight: 600 }}>
        {MULTI_SUBAGENT_ITEMS.length} 个子代理会话
      </Text>
      <Text type="supporting" color="secondary">
        每个子会话是一条紧凑的原生 Astryx 行；点击该行直接打开会话。
      </Text>
      <SubagentToolGroup
        items={MULTI_SUBAGENT_ITEMS}
        onOpenLinkedSession={() => undefined}
      />
    </div>
  ),
};

// Real path: child open — product titlebar parent crumb; rail still roots only (parent highlighted).
export const ChildSession: Story = {
  name: '子会话 · 面包屑回父',
  render: () => <ChildShell item={MULTI_SUBAGENT_ITEMS[0]!} />,
};
