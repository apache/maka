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

import {
  cleanup,
  computed,
  mount,
  safeAreaInsets,
  Scroll,
  signal,
  Text,
  UrlScheme,
  View,
  type ScrollRef,
} from 'nsh';
import { Input } from 'nsh/base';
import {
  ApplePermissionCard,
  AppleQuestionCard,
  TurnPanel,
  type PermissionAction,
  type PermissionCardItem,
  type QuestionCardItem,
  type TurnStepItem,
} from './AppleCards';
import {
  agentChangeSession,
  agentEditQueue,
  agentQueueMessage,
  agentControlGoal,
  agentCreateSession,
  agentGitWorkspaceDiff,
  agentHistory,
  agentListDirectoryRoots,
  agentListModels,
  agentListProjects,
  agentListSchedules,
  agentListSessions,
  agentMarkRead,
  agentObserve,
  agentOpenBot,
  agentPendingInteractions,
  agentReadGoal,
  agentReadInteraction,
  agentRespondInteraction,
  agentSelectBackend,
  agentSend,
  agentStop,
  agentUpdateMetadata,
  bootstrap,
  connectHost,
  disconnectHost,
  hasAgentEndpoint,
  hostCall,
  onHostState,
  onPairingUri,
  onSubscriptionEnded,
  onSubscriptionItem,
  pairHost,
  parseTicket,
  removeHost,
  setFilter,
  subscribe,
  unsubscribe,
  type AgentBackendPreference,
  type AgentDeliveryPage,
  type AgentGoalDetail,
  type AgentGoalView,
  type AgentHistoryChunk,
  type AgentHistoryPage,
  type AgentInteractionRecord,
  type AgentModelChoice,
  type AgentProject,
  type AgentQueue,
  type AgentQueueEntry,
  type AgentRoomMessage,
  type AgentScheduledSummary,
  type AgentSession,
  type AgentSessionPage,
  type AgentWorkspaceSelection,
  type HostStateSnapshot,
  type ParsedTicketInfo,
  type SavedHostItem,
} from './bridge';
import { DrawerHome, type CatalogFilterMode } from './DrawerHome';
import { GoalBar } from './GoalBar';
import {
  AutomationsOverlay,
  DiffOverlay,
  ModelPickerOverlay,
  NewRoomOverlay,
  PairingOverlay,
  parseUnifiedWorkspacePatch,
  SettingsOverlay,
  WorkspacePickerOverlay,
  type DiffLineItem,
} from './Overlays';
import {
  createBurstController,
  ReactionBurstLayer,
  ReactionPickerBar,
  ReactionPillsRow,
  type ReactionEntry,
} from './Reactions';
import {
  LivePreviewAccumulator,
  type LivePreviewSnapshot,
  type LiveToolPreview,
} from './streaming';
import { palette } from './theme';
import { TurnRail, type TurnRailEntry } from './TurnRail';

type Route =
  | 'home'
  | 'chat'
  | 'pairing'
  | 'diff'
  | 'automations'
  | 'settings'
  | 'new_room'
  | 'workspace_picker'
  | 'model_picker';

interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  author?: string;
  text: string;
  turnSummary?: string;
  steps?: TurnStepItem[];
  reactions: ReactionEntry[];
}

const PREVIEW_MESSAGES: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    text: '帮我检查一下远端 Host 连接状态，并跑一次实时 RPC 验证通路。',
    reactions: [{ emoji: '🫡', count: 1, mine: false, fromAgent: true }],
  },
  {
    id: 'm2',
    role: 'agent',
    author: 'Maka',
    text: '已就绪。配对并连接任意远端 Host 后，这里会实时同步你的项目、会话流式输出、权限确认和代码 Diff。',
    turnSummary: '已检查本机凭据 · 2 步完成',
    steps: [
      {
        id: 'st-1',
        kind: 'thinking',
        title: '核对本机配对票据与 Root ID 准入策略',
        detail: '校验 PairingTicketV1 签名结构，确认 fail-closed Root ID 绑定已启用。',
      },
      {
        id: 'st-2',
        kind: 'edit',
        title: 'platform/remote-client/src/client.rs',
        additions: 24,
        deletions: 4,
        diffPath: 'platform/remote-client/src/client.rs',
      },
    ],
    reactions: [],
  },
];

const PREVIEW_DIFF_LINES: DiffLineItem[] = [
  {
    id: 'd1',
    kind: 'ctx',
    num: '338',
    text: 'if connected.source.state_domain != expected_root_id {',
    file: 'platform/remote-client/src/client.rs',
  },
  {
    id: 'd2',
    kind: 'add',
    num: '339',
    text: '+   let _ = anchor.into_inner().shutdown().await;',
    file: 'platform/remote-client/src/client.rs',
  },
  {
    id: 'd3',
    kind: 'add',
    num: '340',
    text: '+   return Err(RemoteClientError::RootIdMismatch {',
    file: 'platform/remote-client/src/client.rs',
  },
  {
    id: 'd4',
    kind: 'add',
    num: '341',
    text: '+       expected: expected_root_id.to_owned(),',
    file: 'platform/remote-client/src/client.rs',
  },
  {
    id: 'd5',
    kind: 'add',
    num: '342',
    text: '+       actual: connected.source.state_domain,',
    file: 'platform/remote-client/src/client.rs',
  },
  {
    id: 'd6',
    kind: 'add',
    num: '343',
    text: '+   });',
    file: 'platform/remote-client/src/client.rs',
  },
  {
    id: 'd7',
    kind: 'ctx',
    num: '344',
    text: '}',
    file: 'platform/remote-client/src/client.rs',
  },
];

const PREVIEW_PERMISSION: PermissionCardItem = {
  id: 'ap-preview',
  mode: 'permissions',
  canAllowOnce: true,
  title: '允许执行远端日志读取？',
  subtitle: '请求读取 Host 运行状态 · 仅本次生效',
  command: 'hostLogs.read({ position: { kind: "tail" } })',
};

const PREVIEW_QUESTION: QuestionCardItem = {
  id: 'q-preview',
  questions: [
    {
      id: 'q-preview-0',
      index: 0,
      prompt: '连接恢复后希望如何继续当前任务？',
      options: [
        { id: 'opt-1', label: '自动继续未完成步骤', description: '沿用当前工作区与权限边界' },
        { id: 'opt-2', label: '先汇报改动摘要再决定', description: '暂停写入并等待进一步指令' },
      ],
    },
  ],
};

function formatBackendPill(backend: AgentBackendPreference | null | undefined): string {
  if (!backend) return '默认模型';
  if (backend.kind === 'executor') return backend.selection.executor;
  const lvl = backend.thinkingLevel ? ' · ' + backend.thinkingLevel : '';
  return backend.modelId + lvl;
}

function toolTitleOf(tool: AgentHistoryChunk['tool']): string {
  if (!tool) return '执行工具';
  if (typeof tool.title === 'string' && tool.title.length > 0) return tool.title;
  if (tool.title && typeof tool.title === 'object' && typeof tool.title.text === 'string') {
    return tool.title.text;
  }
  return tool.name ?? '执行工具';
}

function mapHistoryPageToMessages(
  page: AgentHistoryPage,
  knownSessions: AgentSession[] = [],
): ChatMessage[] {
  if (page.kind === 'room') {
    return (page.page?.items ?? []).map((item: AgentRoomMessage) => {
      if (item.author.kind === 'human') {
        return {
          id: item.id,
          role: 'user',
          author: '你',
          text: item.content?.text ?? '',
          reactions: [],
        };
      }
      const sessionId = item.author.execution.sessionId;
      const authorLabel = knownSessions.find((s) => s.id === sessionId)?.title ?? sessionId;
      return {
        id: item.id,
        role: 'agent',
        author: authorLabel,
        text: item.content?.text ?? '',
        reactions: [],
      };
    });
  }

  const chunks = page.chunks ?? [];
  const out: ChatMessage[] = [];
  let pendingSteps: TurnStepItem[] = [];
  let stepCounter = 0;

  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i];
    const id = ch.messageId ?? 'chunk-' + String(i);
    const role = (ch.role ?? '').toLowerCase();

    if (role === 'user') {
      if (ch.text.trim().length > 0) {
        out.push({
          id,
          role: 'user',
          text: ch.text,
          reactions: [],
        });
      }
      continue;
    }

    if (ch.field === 'thinking' && ch.text.trim().length > 0) {
      stepCounter += 1;
      pendingSteps.push({
        id: 'think-' + String(stepCounter),
        kind: 'thinking',
        title: '思考过程',
        detail: ch.text.slice(0, 600),
      });
      continue;
    }

    if (ch.tool) {
      stepCounter += 1;
      const tName = (ch.tool.name ?? '').toLowerCase();
      const kind: TurnStepItem['kind'] =
        tName.includes('edit') || tName.includes('write') || tName.includes('patch')
          ? 'edit'
          : tName.includes('shell') || tName.includes('exec') || tName.includes('bash')
            ? 'command'
            : 'read';
      pendingSteps.push({
        id: ch.tool.toolUseId ?? 'tool-' + String(stepCounter),
        kind,
        title: toolTitleOf(ch.tool),
        detail: ch.text ? ch.text.slice(0, 400) : undefined,
      });
      continue;
    }

    if (ch.text.trim().length > 0) {
      const steps = pendingSteps.length > 0 ? pendingSteps : undefined;
      pendingSteps = [];
      out.push({
        id,
        role: 'agent',
        author: 'Maka',
        text: ch.text,
        turnSummary: steps ? '执行过程 · ' + String(steps.length) + ' 步' : undefined,
        steps,
        reactions: [],
      });
    }
  }

  if (pendingSteps.length > 0) {
    out.push({
      id: 'steps-tail',
      role: 'agent',
      author: 'Maka',
      text: '正在整理结果…',
      turnSummary: '执行过程 · ' + String(pendingSteps.length) + ' 步',
      steps: pendingSteps,
      reactions: [],
    });
  }
  return out;
}

function mapInteractionToCards(records: AgentInteractionRecord[]): {
  permissions: PermissionCardItem[];
  questions: QuestionCardItem[];
} {
  const permissions: PermissionCardItem[] = [];
  const questions: QuestionCardItem[] = [];

  for (const rec of records) {
    if (rec.outcome !== null && rec.outcome !== undefined) continue;
    const req = rec.request;
    if (!req) continue;

    if (req.kind === 'question' && Array.isArray(req.questions) && req.questions.length > 0) {
      questions.push({
        id: rec.requestId,
        requestId: rec.requestId,
        questions: req.questions.map((q, qIdx) => ({
          id: rec.requestId + '-q-' + String(qIdx),
          index: qIdx,
          prompt: q.question,
          options: q.options.map((opt, optIdx) => ({
            id: rec.requestId + '-q-' + String(qIdx) + '-opt-' + String(optIdx),
            label: opt.label,
            description: opt.description,
          })),
        })),
      });
      continue;
    }

    if (req.kind === 'permissions') {
      const cmd = req.request.command?.command ?? req.request.reason;
      const cwd = req.request.command?.cwd ? ' · ' + req.request.command.cwd : '';
      permissions.push({
        id: rec.requestId,
        requestId: rec.requestId,
        interactionKind: 'permissions',
        mode: 'permissions',
        canAllowOnce: req.toolUseId !== null && req.toolUseId !== undefined,
        title: '请求工作区额外权限',
        subtitle: req.request.reason + cwd,
        command: cmd,
        requestedPermissions: req.request.permissions,
      });
      continue;
    }

    if (req.kind === 'computer_app') {
      permissions.push({
        id: rec.requestId,
        requestId: rec.requestId,
        interactionKind: 'computer_app',
        mode: 'computer_app',
        title: '允许控制桌面应用 ' + req.display.name + '？',
        subtitle: req.display.warning ?? req.display.appPath,
        command: req.display.appPath,
        allowAlways: req.allowAlways,
      });
      continue;
    }

    if (req.kind === 'service_approval') {
      permissions.push({
        id: rec.requestId,
        requestId: rec.requestId,
        interactionKind: 'service_approval',
        mode: 'binary',
        title: '允许调用服务 ' + req.toolName + '？',
        subtitle: req.service + '.' + req.method,
        command: req.binding + ' → ' + req.service + '.' + req.method,
      });
      continue;
    }

    if (req.kind === 'session_approval') {
      permissions.push({
        id: rec.requestId,
        requestId: rec.requestId,
        interactionKind: 'session_approval',
        mode: 'binary',
        title: '允许子会话审批决策？',
        subtitle: '子会话 ' + req.sessionId,
        command: 'request ' + req.requestId,
      });
      continue;
    }

    if (req.kind === 'client_capability') {
      permissions.push({
        id: rec.requestId,
        requestId: rec.requestId,
        interactionKind: 'client_capability',
        mode: 'binary',
        title: '允许访问客户端能力？',
        subtitle: req.target.capability ?? 'client_capability',
        command: req.target.toolName ?? req.target.serverId ?? 'capability',
      });
      continue;
    }

    const detail =
      req.kind === 'system_permission'
        ? req.application + ': ' + req.grants.join(', ')
        : req.kind === 'form'
          ? req.message
          : String((req as { kind?: string }).kind ?? 'unknown');
    permissions.push({
      id: rec.requestId,
      requestId: rec.requestId,
      interactionKind: req.kind,
      mode: 'unsupported',
      title: req.kind === 'system_permission' ? '需要桌面端系统权限' : '需在桌面端完成表单',
      subtitle: '移动端暂不直接提交此类请求',
      command: detail,
      unsupportedNotice:
        req.kind === 'system_permission'
          ? '系统授权需在桌面端完成，或在此取消等待'
          : '此请求 (' + req.kind + ') 需在桌面端 Maka 处理',
    });
  }
  return { permissions, questions };
}

function buildInteractionAnswer(
  card: PermissionCardItem,
  action: PermissionAction,
): Record<string, unknown> | null {
  if (action === 'cancel_system_permission' && card.interactionKind === 'system_permission') {
    return { kind: 'system_permission_cancel' };
  }
  if (card.mode === 'unsupported') return null;

  if (card.interactionKind === 'permissions') {
    if (action === 'deny') {
      return { kind: 'permissions', decision: { decision: 'deny' } };
    }
    if (!card.requestedPermissions) {
      return null;
    }
    const scope =
      action === 'session' || action === 'always' ? 'session' : action === 'run' ? 'run' : 'once';
    return {
      kind: 'permissions',
      decision: {
        decision: 'allow',
        permissions: card.requestedPermissions,
        scope,
      },
    };
  }

  if (card.interactionKind === 'computer_app') {
    const decision =
      action === 'deny'
        ? 'deny'
        : action === 'always' && card.allowAlways
          ? 'always'
          : action === 'session'
            ? 'session'
            : 'once';
    return { kind: 'computer_app', decision };
  }

  if (
    card.interactionKind === 'session_approval' ||
    card.interactionKind === 'service_approval' ||
    card.interactionKind === 'client_capability'
  ) {
    return {
      kind: card.interactionKind,
      decision: action === 'deny' ? 'deny' : 'allow',
    };
  }

  return null;
}

function App() {
  const insets = safeAreaInsets();
  const route = signal<Route>('home');
  const drawerOpen = signal(false);

  const hostState = signal<HostStateSnapshot>({
    devicePeerId: '',
    filter: { kind: 'all_computers' },
    hosts: [],
    active: null,
  });
  const statusBanner = signal<string | null>(null);
  const busy = signal(false);

  // Host-owned Agent catalog projection
  const projects = signal<AgentProject[]>([]);
  const directoryRoots = signal<{ name: string; path: string }[]>([]);
  const sessions = signal<AgentSession[]>([]);
  const catalogFilter = signal<CatalogFilterMode>('all');
  const catalogQuery = signal('');
  const catalogRevision = signal<string | null>(null);
  const catalogAfter = signal<string | null>(null);
  const needsYouCount = signal(0);

  // Active session / Draft state
  const activeSession = signal<AgentSession | null>(null);
  const draftWorkspace = signal<{ selection: AgentWorkspaceSelection; label: string } | null>(null);
  const draftBackend = signal<AgentBackendPreference | null>(null);
  const creatingDraft = signal(false);
  const headerRenaming = signal(false);
  const headerRenameDraft = signal('');

  // Model catalog picker state
  const modelChoices = signal<AgentModelChoice[]>([]);
  const modelsLoading = signal(false);

  // Run / streaming / goal state
  const activeRunId = signal<string | null>(null);
  const activeGoal = signal<AgentGoalDetail | null>(null);
  const streamingText = signal<string>('');
  const streamingThinking = signal<string>('');
  const streamingThinkingExpanded = signal<boolean>(true);
  const streamingTools = signal<LiveToolPreview[]>([]);
  const awaitingReply = signal<boolean>(false);
  const schedules = signal<AgentScheduledSummary[]>([]);
  const schedulesLoading = signal(false);

  // Pairing state
  const ticketUri = signal('');
  const parsedTicket = signal<ParsedTicketInfo | null>(null);
  const pairingError = signal<string | null>(null);

  // Chat & history window state
  const messages = signal<ChatMessage[]>(PREVIEW_MESSAGES);
  const historyBefore = signal<unknown | null>(null);
  const historyThrough = signal<number | null>(null);
  const loadingEarlier = signal(false);
  const permissions = signal<PermissionCardItem[]>([PREVIEW_PERMISSION]);
  const questions = signal<QuestionCardItem[]>([PREVIEW_QUESTION]);
  const activeReactionMsgId = signal<string | null>(null);
  const composerDraft = signal('');
  const quotedLine = signal<string | null>(null);
  const defaultDelivery = signal<'steer' | 'queue'>('steer');
  const catalogError = signal<string | null>(null);
  const watchError = signal<string | null>(null);
  const queue = signal<AgentQueue | null>(null);
  const queueOpen = signal(false);
  const queueEdit = signal<{
    messageId: string;
    revision: number;
    text: string;
    hasAttachments: boolean;
    quotes: unknown[];
  } | null>(null);
  const queueReview = signal<{
    revision: number;
    message: string;
    hasAttachments: boolean;
    quotes: unknown[];
  } | null>(null);
  const queueFresh = signal(false);
  const queueBusy = signal<
    'request' | { revision: number; submitted: { messageId: string; text: string } | null } | null
  >(null);
  const queueError = signal<string | null>(null);
  const queuedMessages = computed(() =>
    (queue()?.entries ?? []).filter(
      (entry) =>
        (entry.kind === 'followup' || entry.kind === 'held') &&
        entry.origin?.kind !== 'session_completion',
    ),
  );
  const queueNeighbors = computed(() => {
    const previous = new Map<string, string>();
    const neighbors = new Map<string, { up: boolean; down: boolean }>();
    for (const entry of queuedMessages()) {
      const prev = previous.get(entry.kind);
      neighbors.set(entry.messageId, { up: prev !== undefined, down: false });
      if (prev !== undefined) neighbors.get(prev)!.down = true;
      previous.set(entry.kind, entry.messageId);
    }
    return neighbors;
  });
  const resetQueue = () => {
    queue.set(null);
    queueFresh.set(false);
    queueOpen.set(false);
    queueEdit.set(null);
    queueReview.set(null);
    queueBusy.set(null);
    queueError.set(null);
  };
  const diffTitle = signal('platform/remote-client/src/client.rs');
  const diffLines = signal<DiffLineItem[]>(PREVIEW_DIFF_LINES);
  const diffTruncatedNotice = signal<string | null>(null);
  const activeTurnId = signal<string | null>(null);
  const burst = createBurstController();

  interface SubSlot {
    subscriptionId: string;
    generation: number | null;
    ended: boolean;
    hostGen: number;
    hostEpoch: string;
    queryGen?: number;
    sessionGen?: number;
    sessionId?: string;
  }

  // Monotonic fencing generations preventing stale Host, Catalog Query, or Session
  // async responses from overwriting newer UI state.
  let hostSyncGen = 0;
  let catalogQueryGen = 0;
  let catalogSubReceivedForQuery = false;
  let loadingMoreSessions = false;
  let sessionSyncGen = 0;
  let goalWatchReceived = false;
  let streamGen = 0;
  let subOpenSeq = 0;
  let watchCursor = 0;
  let lastHostEpoch: string | null = null;
  let catalogSub: SubSlot | null = null;
  let watchSub: SubSlot | null = null;
  let goalSub: SubSlot | null = null;
  let chatScroll: ScrollRef | null = null;
  let stickToBottom = true;
  let lastContentHeight = 0;
  let currentDraftKey = 'offline:draft';
  let inFlightDraft: { key: string; text: string; quote: string | null } | null = null;
  const sessionDrafts = new Map<string, { text: string; quote: string | null }>();
  const turnOffsets = new Map<string, number>();
  const previewAccumulator = new LivePreviewAccumulator();

  const draftKeyFor = (hostKey: string | null | undefined, sessionId: string | null | undefined) =>
    (hostKey ?? 'offline') + ':' + (sessionId ?? 'draft');

  const switchDraftPartition = (nextKey: string) => {
    const pending = inFlightDraft;
    inFlightDraft = null;
    if (nextKey === currentDraftKey) {
      if (pending !== null) {
        if (pending.key === nextKey && composerDraft().length === 0 && quotedLine() === null) {
          composerDraft.set(pending.text);
          quotedLine.set(pending.quote);
        } else if (!sessionDrafts.has(pending.key)) {
          sessionDrafts.set(pending.key, { text: pending.text, quote: pending.quote });
        }
      }
      return;
    }
    const text = composerDraft();
    const quote = quotedLine();
    if (text.length > 0 || quote !== null) {
      sessionDrafts.set(currentDraftKey, { text, quote });
    } else {
      sessionDrafts.delete(currentDraftKey);
    }
    if (pending !== null && !sessionDrafts.has(pending.key)) {
      sessionDrafts.set(pending.key, { text: pending.text, quote: pending.quote });
    }
    currentDraftKey = nextKey;
    const restored = sessionDrafts.get(nextKey);
    composerDraft.set(restored?.text ?? '');
    quotedLine.set(restored?.quote ?? null);
  };

  const applyLivePreview = (snap: LivePreviewSnapshot) => {
    streamGen += 1;
    streamingThinking.set(snap.thinking);
    streamingText.set(snap.body);
    streamingTools.set(snap.tools);
    if (snap.thinking.length > 0 || snap.body.length > 0 || snap.tools.length > 0) {
      awaitingReply.set(false);
    }
  };

  const resetLivePreview = () => {
    applyLivePreview(previewAccumulator.reset());
    awaitingReply.set(false);
  };

  const isHostStillCurrent = (gen: number, epoch: string) =>
    gen === hostSyncGen && hostState().active?.epoch === epoch;

  const isSessionStillCurrent = (gen: number, epoch: string, sGen: number, sessionId: string) =>
    isHostStillCurrent(gen, epoch) && sGen === sessionSyncGen && activeSession()?.id === sessionId;

  const stopWatchSubscription = (clearError = true) => {
    queueFresh.set(false);
    queueReview.set(null);
    if (clearError) watchError.set(null);
    if (watchSub) {
      const id = watchSub.subscriptionId;
      watchSub = null;
      unsubscribe(id).catch(() => {});
    }
  };

  const stopGoalSubscription = () => {
    if (goalSub) {
      const id = goalSub.subscriptionId;
      goalSub = null;
      unsubscribe(id).catch(() => {});
    }
  };

  const stopCatalogSubscription = (clearError = true) => {
    if (clearError) catalogError.set(null);
    if (catalogSub) {
      const id = catalogSub.subscriptionId;
      catalogSub = null;
      unsubscribe(id).catch(() => {});
    }
  };

  const defaultDraftWorkspace = (): { selection: AgentWorkspaceSelection; label: string } => {
    const cur = activeSession();
    if (cur?.workspace?.projectId && cur.workspace.path) {
      const proj = projects().find((p) => p.reference.id === cur.workspace.projectId);
      return {
        selection: {
          kind: 'project',
          projectId: cur.workspace.projectId,
          path: cur.workspace.path,
        },
        label: proj?.name ?? cur.workspace.name ?? '当前项目',
      };
    }
    const firstProj = projects().find((p) => !p.archived && !!p.path);
    if (firstProj && firstProj.path) {
      return {
        selection: { kind: 'project', projectId: firstProj.reference.id, path: firstProj.path },
        label: firstProj.name,
      };
    }
    const firstRoot = directoryRoots()[0];
    if (firstRoot) {
      return {
        selection: { kind: 'directory', path: firstRoot.path },
        label: firstRoot.name,
      };
    }
    return { selection: { kind: 'directory', path: '~' }, label: '默认工作区' };
  };

  const upsertSessionInList = (updated: AgentSession) => {
    const existing = sessions();
    const idx = existing.findIndex((s) => s.id === updated.id);
    if (idx >= 0) {
      sessions.set(existing.map((s) => (s.id === updated.id ? updated : s)));
    } else {
      sessions.set([updated, ...existing]);
    }
    if (activeSession()?.id === updated.id) {
      activeSession.set(updated);
    }
  };

  const markVisibleSessionRead = (
    sess: AgentSession,
    mapped: ChatMessage[],
    gen: number,
    epoch: string,
    sGen: number,
  ) => {
    if (!sess.hasUnread) return;
    const msgId = sess.tailMessageId ?? mapped[mapped.length - 1]?.id ?? null;
    if (
      !msgId ||
      msgId.startsWith('chunk-') ||
      msgId.startsWith('optimistic-') ||
      msgId === 'steps-tail'
    ) {
      return;
    }
    agentMarkRead(sess.id, msgId).then(
      (res) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sess.id)) return;
        if (res.kind === 'observed' && res.session) {
          upsertSessionInList(res.session);
        }
      },
      () => {},
    );
  };

  const loadSessionInteractions = (sessionId: string, gen: number, epoch: string, sGen: number) => {
    agentPendingInteractions(sessionId).then(
      async (pending) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
        const records: AgentInteractionRecord[] = [];
        for (const entry of pending.entries ?? []) {
          try {
            const rec = await agentReadInteraction(sessionId, entry.requestId);
            if (rec) records.push(rec);
          } catch {
            // Individual closed interaction is skipped cleanly.
          }
        }
        if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
        const mapped = mapInteractionToCards(records);
        const resolvedPerms = permissions().filter((p) => !!p.resolved);
        const resolvedPermIds = new Set(resolvedPerms.map((p) => p.id));
        permissions.set([
          ...resolvedPerms,
          ...mapped.permissions.filter((p) => !resolvedPermIds.has(p.id)),
        ]);
        const resolvedQuestions = questions().filter((q) => !!q.answered);
        const resolvedQIds = new Set(resolvedQuestions.map((q) => q.id));
        questions.set([
          ...resolvedQuestions,
          ...mapped.questions.filter((q) => !resolvedQIds.has(q.id)),
        ]);
      },
      () => {},
    );
  };

  const refreshSessionTranscript = (
    sessionId: string,
    clearStream = false,
    gen = hostSyncGen,
    epoch = hostState().active?.epoch ?? '',
    sGen = sessionSyncGen,
  ) => {
    const streamGenAtStart = streamGen;
    agentObserve(sessionId).then(
      (obs) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
        activeSession.set(obs.session);
        activeRunId.set(obs.run?.runId ?? null);
        if (typeof obs.through === 'number' && obs.through > watchCursor) {
          watchCursor = obs.through;
        }
      },
      () => {},
    );
    agentHistory(sessionId).then(
      (page) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
        const mapped = mapHistoryPageToMessages(page, sessions());
        messages.set(mapped);
        if (page.kind === 'ready') {
          historyThrough.set(page.through ?? null);
          historyBefore.set(page.before ?? null);
        } else {
          historyThrough.set(page.page?.through ?? null);
          historyBefore.set(page.page?.before ?? null);
        }
        if (clearStream) {
          if (streamGen === streamGenAtStart) {
            resetLivePreview();
          } else {
            const handoff = previewAccumulator.completeHandoffIfPending();
            if (handoff) applyLivePreview(handoff);
          }
        }
        const curSess = activeSession();
        if (curSess && curSess.id === sessionId) {
          markVisibleSessionRead(curSess, mapped, gen, epoch, sGen);
        }
      },
      (err: Error) => {
        if (isSessionStillCurrent(gen, epoch, sGen, sessionId)) {
          statusBanner.set('读取历史失败: ' + err.message);
        }
      },
    );
    loadSessionInteractions(sessionId, gen, epoch, sGen);
  };

  const loadEarlierHistory = () => {
    const sess = activeSession();
    const active = hostState().active;
    const before = historyBefore();
    if (!sess || !active || !before || loadingEarlier()) return;
    const gen = hostSyncGen;
    const epoch = active.epoch;
    const sGen = sessionSyncGen;
    const sessionId = sess.id;
    loadingEarlier.set(true);
    stickToBottom = false;
    const position =
      sess.kind === 'room' && typeof before === 'string'
        ? ({ kind: 'before_message', messageId: before } as const)
        : ({ kind: 'before', cursor: before } as const);
    agentHistory(sessionId, { through: historyThrough(), position }).then(
      (page) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
        loadingEarlier.set(false);
        const older = mapHistoryPageToMessages(page, sessions());
        const existingIds = new Set(messages().map((m) => m.id));
        const deduped = older.filter((m) => !existingIds.has(m.id));
        messages.set([...deduped, ...messages()]);
        if (page.kind === 'ready') {
          historyBefore.set(page.before ?? null);
        } else {
          historyBefore.set(page.page?.before ?? null);
        }
      },
      (err: Error) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
        loadingEarlier.set(false);
        statusBanner.set('加载更早历史失败: ' + err.message);
      },
    );
  };

  const startWatchSubscription = (
    sessionId: string,
    after: number,
    gen: number,
    epoch: string,
    sGen: number,
  ) => {
    stopWatchSubscription(false);
    subOpenSeq += 1;
    const subId = 'watch:' + sessionId + ':' + String(sGen) + ':' + String(subOpenSeq);
    const slot: SubSlot = {
      subscriptionId: subId,
      generation: null,
      ended: false,
      hostGen: gen,
      hostEpoch: epoch,
      sessionGen: sGen,
      sessionId,
    };
    watchSub = slot;
    subscribe(subId, 'agent', 'watch', { sessionId, after }).then(
      (handle) => {
        if (
          watchSub !== slot ||
          slot.ended ||
          !isSessionStillCurrent(gen, epoch, sGen, sessionId)
        ) {
          if (watchSub === slot) watchSub = null;
          unsubscribe(handle.subscriptionId).catch(() => {});
          return;
        }
        slot.generation = handle.generation;
        watchError.set(null);
      },
      (err: Error) => {
        if (watchSub !== slot) return;
        watchSub = null;
        if (isSessionStillCurrent(gen, epoch, sGen, sessionId)) {
          queueFresh.set(false);
          queueReview.set(null);
          watchError.set('实时会话订阅失败: ' + err.message);
        }
      },
    );
  };

  const applyGoalView = (view: AgentGoalView, source: 'read' | 'watch') => {
    const incoming = view.enabled ? (view.current ?? null) : null;
    if (source === 'watch') {
      goalWatchReceived = true;
      activeGoal.set(incoming);
      return;
    }
    const current = activeGoal();
    if (incoming === null) {
      if (goalWatchReceived && current !== null) return;
      activeGoal.set(null);
      return;
    }
    if (current && current.id === incoming.id && current.revision > incoming.revision) {
      return;
    }
    activeGoal.set(incoming);
  };

  const startGoalSubscription = (sessionId: string, gen: number, epoch: string, sGen: number) => {
    stopGoalSubscription();
    goalWatchReceived = false;
    agentReadGoal(sessionId).then(
      (view) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sessionId) || goalWatchReceived) return;
        applyGoalView(view, 'read');
      },
      () => {},
    );
    subOpenSeq += 1;
    const subId = 'goal:' + sessionId + ':' + String(sGen) + ':' + String(subOpenSeq);
    const slot: SubSlot = {
      subscriptionId: subId,
      generation: null,
      ended: false,
      hostGen: gen,
      hostEpoch: epoch,
      sessionGen: sGen,
      sessionId,
    };
    goalSub = slot;
    subscribe(subId, 'agent', 'watchGoal', { sessionId }).then(
      (handle) => {
        if (goalSub !== slot || slot.ended || !isSessionStillCurrent(gen, epoch, sGen, sessionId)) {
          if (goalSub === slot) goalSub = null;
          unsubscribe(handle.subscriptionId).catch(() => {});
          return;
        }
        slot.generation = handle.generation;
      },
      () => {
        if (goalSub === slot) goalSub = null;
      },
    );
  };

  const startCatalogSubscription = (
    gen: number,
    epoch: string,
    filter: CatalogFilterMode = catalogFilter(),
    titleQuery = catalogQuery(),
    qGen = catalogQueryGen,
  ) => {
    stopCatalogSubscription(false);
    subOpenSeq += 1;
    const subId =
      'catalog:' + epoch + ':' + String(gen) + ':' + String(qGen) + ':' + String(subOpenSeq);
    const slot: SubSlot = {
      subscriptionId: subId,
      generation: null,
      ended: false,
      hostGen: gen,
      hostEpoch: epoch,
      queryGen: qGen,
    };
    catalogSub = slot;
    subscribe(subId, 'agent', 'catalog', {
      kind: null,
      filter,
      includeArchived: filter === 'archived',
      rootsOnly: false,
      position: { kind: 'start' },
      scope: { kind: 'all' },
      titleQuery,
    }).then(
      (handle) => {
        if (
          catalogSub !== slot ||
          slot.ended ||
          !isHostStillCurrent(gen, epoch) ||
          qGen !== catalogQueryGen
        ) {
          if (catalogSub === slot) catalogSub = null;
          unsubscribe(handle.subscriptionId).catch(() => {});
          return;
        }
        slot.generation = handle.generation;
        catalogError.set(null);
      },
      (err: Error) => {
        if (catalogSub !== slot) return;
        catalogSub = null;
        if (isHostStillCurrent(gen, epoch) && qGen === catalogQueryGen) {
          catalogError.set('会话目录订阅失败: ' + err.message);
        }
      },
    );
  };

  const applyCatalogPage = (page: AgentSessionPage, append = false) => {
    const incoming = page.sessions ?? [];
    catalogRevision.set(page.revision ?? null);
    catalogAfter.set(page.after ?? null);
    if (typeof page.needsYouCount === 'number') {
      needsYouCount.set(page.needsYouCount);
    }
    if (append) {
      const seen = new Set(sessions().map((s) => s.id));
      sessions.set([...sessions(), ...incoming.filter((s) => !seen.has(s.id))]);
    } else {
      sessions.set(incoming);
    }
    const cur = activeSession();
    if (cur) {
      const refreshed = incoming.find((s) => s.id === cur.id);
      if (refreshed) activeSession.set(refreshed);
    }
  };

  const reloadCatalog = (
    filter: CatalogFilterMode,
    query: string,
    gen = hostSyncGen,
    epoch = hostState().active?.epoch ?? '',
  ) => {
    if (!epoch || !isHostStillCurrent(gen, epoch)) return;
    catalogError.set(null);
    catalogQueryGen += 1;
    const qGen = catalogQueryGen;
    catalogSubReceivedForQuery = false;
    loadingMoreSessions = false;
    agentListSessions(filter, query).then(
      (page) => {
        if (
          !isHostStillCurrent(gen, epoch) ||
          qGen !== catalogQueryGen ||
          catalogFilter() !== filter ||
          catalogQuery() !== query
        ) {
          return;
        }
        if (!catalogSubReceivedForQuery) {
          applyCatalogPage(page, false);
        }
        if (
          filter === 'all' &&
          query.trim().length === 0 &&
          route() === 'chat' &&
          !drawerOpen() &&
          activeSession() === null &&
          draftWorkspace() === null &&
          (page.sessions ?? []).length > 0
        ) {
          openAgentSession(page.sessions[0]);
        }
      },
      (err: Error) => {
        if (isHostStillCurrent(gen, epoch) && qGen === catalogQueryGen) {
          statusBanner.set('读取会话列表失败: ' + err.message);
        }
      },
    );
    startCatalogSubscription(gen, epoch, filter, query, qGen);
  };

  const openAgentSession = (session: AgentSession) => {
    const active = hostState().active;
    if (!active) return;
    const gen = hostSyncGen;
    const epoch = active.epoch;
    sessionSyncGen += 1;
    const sGen = sessionSyncGen;

    stopWatchSubscription();
    stopGoalSubscription();
    busy.set(false);
    creatingDraft.set(false);
    headerRenaming.set(false);
    stickToBottom = true;
    lastContentHeight = 0;
    turnOffsets.clear();
    activeTurnId.set(null);
    draftWorkspace.set(null);
    activeSession.set(session);
    switchDraftPartition(draftKeyFor(active.rootId, session.id));
    activeRunId.set(null);
    activeGoal.set(null);
    watchCursor = 0;
    streamingThinkingExpanded.set(true);
    resetLivePreview();
    resetQueue();
    messages.set([]);
    historyBefore.set(null);
    historyThrough.set(null);
    permissions.set([]);
    questions.set([]);
    drawerOpen.set(false);
    route.set('chat');

    agentObserve(session.id).then(
      (obs) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, session.id)) return;
        activeSession.set(obs.session);
        activeRunId.set(obs.run?.runId ?? null);
        watchCursor = typeof obs.through === 'number' ? obs.through : 0;
        startWatchSubscription(session.id, watchCursor, gen, epoch, sGen);
      },
      (err: Error) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, session.id)) return;
        statusBanner.set('观察会话状态失败: ' + err.message);
        startWatchSubscription(session.id, 0, gen, epoch, sGen);
      },
    );

    agentHistory(session.id).then(
      (page) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, session.id)) return;
        const mapped = mapHistoryPageToMessages(page, sessions());
        messages.set(mapped);
        if (page.kind === 'ready') {
          historyThrough.set(page.through ?? null);
          historyBefore.set(page.before ?? null);
        } else {
          historyThrough.set(page.page?.through ?? null);
          historyBefore.set(page.page?.before ?? null);
        }
        markVisibleSessionRead(session, mapped, gen, epoch, sGen);
      },
      (err: Error) => {
        if (isSessionStillCurrent(gen, epoch, sGen, session.id)) {
          statusBanner.set('读取历史失败: ' + err.message);
        }
      },
    );
    loadSessionInteractions(session.id, gen, epoch, sGen);
    if (session.kind === 'agent') {
      startGoalSubscription(session.id, gen, epoch, sGen);
    }
  };

  const startDraft = (workspace?: { selection: AgentWorkspaceSelection; label: string }) => {
    const active = hostState().active;
    if (!active || !hasAgentEndpoint(active)) return;
    // If already editing an unsubmitted draft with no explicit workspace change, focus it without wiping text.
    if (activeSession() === null && draftWorkspace() !== null && !workspace) {
      drawerOpen.set(false);
      route.set('chat');
      return;
    }
    sessionSyncGen += 1;
    stopWatchSubscription();
    stopGoalSubscription();
    busy.set(false);
    creatingDraft.set(false);
    headerRenaming.set(false);
    stickToBottom = true;
    lastContentHeight = 0;
    turnOffsets.clear();
    activeTurnId.set(null);
    activeSession.set(null);
    activeRunId.set(null);
    activeGoal.set(null);
    resetLivePreview();
    resetQueue();
    messages.set([]);
    historyBefore.set(null);
    historyThrough.set(null);
    permissions.set([]);
    questions.set([]);
    draftWorkspace.set(workspace ?? defaultDraftWorkspace());
    switchDraftPartition(draftKeyFor(active.rootId, null));
    drawerOpen.set(false);
    route.set('chat');
  };

  const syncConnectedAgentHost = (snap: HostStateSnapshot) => {
    const active = snap.active;
    if (!active) {
      hostSyncGen += 1;
      catalogQueryGen += 1;
      loadingMoreSessions = false;
      goalWatchReceived = false;
      sessionSyncGen += 1;
      stopWatchSubscription();
      stopGoalSubscription();
      stopCatalogSubscription();
      creatingDraft.set(false);
      busy.set(false);
      switchDraftPartition('offline:draft');
      lastHostEpoch = null;
      projects.set([]);
      sessions.set([]);
      directoryRoots.set([]);
      catalogRevision.set(null);
      catalogAfter.set(null);
      needsYouCount.set(0);
      activeSession.set(null);
      draftWorkspace.set(null);
      draftBackend.set(null);
      activeRunId.set(null);
      activeGoal.set(null);
      resetQueue();
      resetLivePreview();
      return;
    }
    if (lastHostEpoch === active.epoch) return;
    lastHostEpoch = active.epoch;
    hostSyncGen += 1;
    catalogQueryGen += 1;
    loadingMoreSessions = false;
    goalWatchReceived = false;
    sessionSyncGen += 1;
    const gen = hostSyncGen;
    const epoch = active.epoch;

    stopWatchSubscription();
    stopGoalSubscription();
    stopCatalogSubscription();
    creatingDraft.set(false);
    busy.set(false);
    switchDraftPartition(draftKeyFor(active.rootId, null));
    projects.set([]);
    sessions.set([]);
    directoryRoots.set([]);
    catalogFilter.set('all');
    catalogQuery.set('');
    catalogRevision.set(null);
    catalogAfter.set(null);
    needsYouCount.set(0);
    activeSession.set(null);
    draftWorkspace.set(null);
    activeRunId.set(null);
    activeGoal.set(null);
    resetQueue();
    resetLivePreview();

    if (!hasAgentEndpoint(active)) {
      return;
    }

    messages.set([]);
    permissions.set([]);
    questions.set([]);
    diffLines.set([]);
    diffTruncatedNotice.set(null);

    agentListProjects().then(
      (list) => {
        if (!isHostStillCurrent(gen, epoch)) return;
        projects.set(list);
      },
      () => {},
    );
    agentListDirectoryRoots().then(
      (roots) => {
        if (!isHostStillCurrent(gen, epoch)) return;
        directoryRoots.set(roots);
      },
      () => {},
    );
    reloadCatalog('all', '', gen, epoch);
  };

  const runParseTicket = (rawUri?: string) => {
    const uri = (rawUri ?? ticketUri()).trim();
    pairingError.set(null);
    if (!uri) {
      parsedTicket.set(null);
      pairingError.set('请粘贴或扫描 maka://pair/v1 配对码');
      return;
    }
    busy.set(true);
    parseTicket(uri).then(
      (info) => {
        parsedTicket.set(info);
        pairingError.set(null);
        busy.set(false);
      },
      (err: Error) => {
        parsedTicket.set(null);
        pairingError.set(err.message);
        busy.set(false);
      },
    );
  };

  const openIncomingPairUri = (uri: string) => {
    const trimmed = uri.trim();
    if (!trimmed.startsWith('maka://pair/v1')) return;
    if (route() === 'pairing' && ticketUri().trim() === trimmed && parsedTicket() !== null) {
      return;
    }
    ticketUri.set(trimmed);
    drawerOpen.set(false);
    route.set('pairing');
    runParseTicket(trimmed);
  };

  const refreshBootstrap = () => {
    bootstrap().then(
      (snap) => {
        hostState.set(snap);
        statusBanner.set(null);
        syncConnectedAgentHost(snap);
        if (snap.pendingPairUri) {
          openIncomingPairUri(snap.pendingPairUri);
        }
      },
      (err: Error) => statusBanner.set(err.message),
    );
  };

  refreshBootstrap();

  const offState = onHostState((snap) => {
    hostState.set(snap);
    syncConnectedAgentHost(snap);
  });
  const offLink = onPairingUri(openIncomingPairUri);
  const offScheme = UrlScheme.on('open', ({ url }: { url: string }) => {
    if (typeof url === 'string') {
      openIncomingPairUri(url);
    }
  });

  const matchesSubSlot = (slot: SubSlot | null, subId: string, generation: number) =>
    slot !== null &&
    !slot.ended &&
    slot.subscriptionId === subId &&
    (slot.generation === null || slot.generation === generation);

  const settleQueueReceipt = (pending: {
    revision: number;
    submitted: { messageId: string; text: string } | null;
  }) => {
    queueBusy.set(null);
    const edit = queueEdit();
    if (pending.submitted && edit?.messageId === pending.submitted.messageId) {
      if (edit.text === pending.submitted.text) {
        queueEdit.set(null);
        queueReview.set(null);
      } else {
        queueReview.set(null);
        queueError.set('已保存上次提交；新的编辑已保留，请查看当前版本。');
      }
    }
  };

  const handleWatchPage = (
    page: AgentDeliveryPage,
    gen: number,
    epoch: string,
    sGen: number,
    sessionId: string,
  ) => {
    if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;

    if (page.kind === 'room') {
      refreshSessionTranscript(sessionId, false, gen, epoch, sGen);
      return;
    }

    if (page.kind === 'events') {
      if (typeof page.nextAfter === 'number' && page.nextAfter > watchCursor) {
        watchCursor = page.nextAfter;
      }
      let needRefresh = false;
      let clearStreamOnRefresh = false;
      for (const delivery of page.events ?? []) {
        const fact = delivery.fact;
        if (!fact) continue;
        if (fact.kind === 'opened' || fact.kind === 'executor_started') {
          activeRunId.set(delivery.runId);
          awaitingReply.set(true);
        } else if (fact.kind === 'delta' && typeof fact.text === 'string') {
          activeRunId.set(delivery.runId);
          applyLivePreview(previewAccumulator.applyDelta(delivery.runId, fact.text));
        } else if (fact.kind === 'ended') {
          activeRunId.set(null);
          awaitingReply.set(false);
          needRefresh = true;
          clearStreamOnRefresh = true;
        } else if (
          fact.kind === 'transcript_changed' ||
          fact.kind === 'part_committed' ||
          fact.kind === 'step_ended' ||
          fact.kind === 'executor_text_changed' ||
          fact.kind === 'tool_dispatched' ||
          fact.kind === 'tool_settled'
        ) {
          needRefresh = true;
          if (fact.kind === 'part_committed' || fact.kind === 'step_ended') {
            if (previewAccumulator.snapshot().awaitingHistoryHandoff) {
              clearStreamOnRefresh = true;
            }
          }
        }
      }
      if (needRefresh) {
        refreshSessionTranscript(sessionId, clearStreamOnRefresh, gen, epoch, sGen);
      }
      return;
    }

    if (page.kind === 'preview') {
      const p = page.page;
      const snap = previewAccumulator.applyPreviewPage(p);
      if (p.kind === 'cut') {
        activeRunId.set(p.runId);
        applyLivePreview(snap);
      } else if (p.kind === 'empty') {
        applyLivePreview(snap);
        refreshSessionTranscript(sessionId, true, gen, epoch, sGen);
      }
      return;
    }

    if (page.kind === 'queue') {
      if (queue() !== null && page.queue.revision < queue()!.revision) return;
      queue.set(page.queue);
      queueFresh.set(true);
      const pending = queueBusy();
      if (pending !== null && pending !== 'request' && page.queue.revision >= pending.revision) {
        settleQueueReceipt(pending);
      }
      return;
    }

    if (page.kind === 'interactions') {
      loadSessionInteractions(sessionId, gen, epoch, sGen);
    }
  };

  const offSubItem = onSubscriptionItem((payload) => {
    if (
      matchesSubSlot(catalogSub, payload.subscriptionId, payload.generation) &&
      catalogSub &&
      isHostStillCurrent(catalogSub.hostGen, catalogSub.hostEpoch) &&
      catalogSub.queryGen === catalogQueryGen &&
      payload.item &&
      typeof payload.item === 'object'
    ) {
      if (catalogSub.generation === null) {
        catalogSub.generation = payload.generation;
      }
      const page = payload.item as Partial<AgentSessionPage>;
      if (Array.isArray(page.sessions)) {
        catalogSubReceivedForQuery = true;
        applyCatalogPage(page as AgentSessionPage, false);
      }
      return;
    }
    if (
      matchesSubSlot(goalSub, payload.subscriptionId, payload.generation) &&
      goalSub &&
      goalSub.sessionGen !== undefined &&
      goalSub.sessionId !== undefined &&
      isSessionStillCurrent(
        goalSub.hostGen,
        goalSub.hostEpoch,
        goalSub.sessionGen,
        goalSub.sessionId,
      ) &&
      payload.item &&
      typeof payload.item === 'object'
    ) {
      if (goalSub.generation === null) {
        goalSub.generation = payload.generation;
      }
      applyGoalView(payload.item as AgentGoalView, 'watch');
      return;
    }
    if (
      matchesSubSlot(watchSub, payload.subscriptionId, payload.generation) &&
      watchSub &&
      watchSub.sessionGen !== undefined &&
      watchSub.sessionId !== undefined &&
      payload.item &&
      typeof payload.item === 'object'
    ) {
      if (watchSub.generation === null) {
        watchSub.generation = payload.generation;
      }
      handleWatchPage(
        payload.item as AgentDeliveryPage,
        watchSub.hostGen,
        watchSub.hostEpoch,
        watchSub.sessionGen,
        watchSub.sessionId,
      );
    }
  });

  const offSubEnd = onSubscriptionEnded((payload) => {
    if (matchesSubSlot(catalogSub, payload.subscriptionId, payload.generation) && catalogSub) {
      const slot = catalogSub;
      slot.ended = true;
      catalogSub = null;
      if (isHostStillCurrent(slot.hostGen, slot.hostEpoch)) {
        catalogError.set('会话目录同步中断' + (payload.error ? ': ' + payload.error : ''));
      }
    }
    if (matchesSubSlot(goalSub, payload.subscriptionId, payload.generation) && goalSub) {
      goalSub.ended = true;
      goalSub = null;
    }
    if (matchesSubSlot(watchSub, payload.subscriptionId, payload.generation) && watchSub) {
      const slot = watchSub;
      slot.ended = true;
      watchSub = null;
      if (
        slot.sessionGen !== undefined &&
        slot.sessionId !== undefined &&
        isSessionStillCurrent(slot.hostGen, slot.hostEpoch, slot.sessionGen, slot.sessionId)
      ) {
        queueFresh.set(false);
        queueReview.set(null);
        watchError.set('会话流式订阅中断' + (payload.error ? ': ' + payload.error : ''));
      }
    }
  });

  cleanup(() => {
    stopWatchSubscription();
    stopGoalSubscription();
    stopCatalogSubscription();
    offState();
    offLink();
    offScheme();
    offSubItem();
    offSubEnd();
  });

  const runPairConfirm = () => {
    const uri = ticketUri().trim();
    if (!uri) return;
    busy.set(true);
    pairingError.set(null);
    pairHost(uri).then(
      (res) => {
        hostState.set(res.state);
        busy.set(false);
        ticketUri.set('');
        parsedTicket.set(null);
        statusBanner.set('已连接 ' + (res.state.active?.hostName ?? '远端 Host'));
        route.set('chat');
        syncConnectedAgentHost(res.state);
      },
      (err: Error) => {
        pairingError.set(err.message);
        busy.set(false);
      },
    );
  };

  const runConnectSaved = (hostItem: SavedHostItem) => {
    busy.set(true);
    statusBanner.set(null);
    connectHost(hostItem.rootId).then(
      (snap) => {
        hostState.set(snap);
        busy.set(false);
        syncConnectedAgentHost(snap);
        if (!hasAgentEndpoint(snap.active)) {
          drawerOpen.set(false);
          route.set('chat');
        }
      },
      (err: Error) => {
        statusBanner.set(err.message);
        busy.set(false);
      },
    );
  };

  const runSwitchFilter = () => {
    const cur = hostState().filter;
    const first = hostState().hosts[0];
    const nextFilter =
      cur.kind === 'all_computers' && first
        ? ({ kind: 'single_computer', root_id: first.rootId } as const)
        : ({ kind: 'all_computers' } as const);
    setFilter(nextFilter).then(
      (s) => {
        hostState.set(s);
        statusBanner.set(null);
      },
      (err: Error) => statusBanner.set(err.message),
    );
  };

  const runRenameSession = (sess: AgentSession, nextTitle: string) => {
    const active = hostState().active;
    if (!active) return;
    const gen = hostSyncGen;
    const epoch = active.epoch;
    agentUpdateMetadata({
      sessionId: sess.id,
      expectedRevision: sess.revision,
      title: nextTitle,
      labels: sess.labels ?? [],
    }).then(
      (res) => {
        if (!isHostStillCurrent(gen, epoch)) return;
        if (res.kind === 'committed') {
          upsertSessionInList(res.session);
          statusBanner.set(null);
        } else if (res.kind === 'revision_conflict') {
          statusBanner.set('会话已被其他端修改，已刷新列表，请重试重命名');
          reloadCatalog(catalogFilter(), catalogQuery(), gen, epoch);
        } else {
          statusBanner.set('重命名被拒绝: ' + JSON.stringify(res.reason));
        }
      },
      (err: Error) => {
        if (isHostStillCurrent(gen, epoch)) statusBanner.set('重命名失败: ' + err.message);
      },
    );
  };

  const runTogglePinSession = (sess: AgentSession) => {
    const active = hostState().active;
    if (!active) return;
    const gen = hostSyncGen;
    const epoch = active.epoch;
    agentUpdateMetadata({
      sessionId: sess.id,
      expectedRevision: sess.revision,
      title: sess.title,
      labels: sess.labels ?? [],
      pinned: !sess.pinned,
    }).then(
      (res) => {
        if (!isHostStillCurrent(gen, epoch)) return;
        if (res.kind === 'committed') {
          upsertSessionInList(res.session);
        } else if (res.kind === 'revision_conflict') {
          statusBanner.set('会话版本变化，已刷新，请重试');
          reloadCatalog(catalogFilter(), catalogQuery(), gen, epoch);
        } else {
          statusBanner.set('置顶操作失败: ' + JSON.stringify(res.reason));
        }
      },
      (err: Error) => {
        if (isHostStillCurrent(gen, epoch)) statusBanner.set('置顶失败: ' + err.message);
      },
    );
  };

  const runChangeSessionLifecycle = (
    sess: AgentSession,
    action: 'archive' | 'restore' | 'remove',
  ) => {
    const active = hostState().active;
    if (!active) return;
    const gen = hostSyncGen;
    const epoch = active.epoch;
    agentChangeSession(sess.id, sess.revision, action).then(
      (res) => {
        if (!isHostStillCurrent(gen, epoch)) return;
        if (res.kind === 'removed') {
          sessions.set(sessions().filter((s) => s.id !== sess.id));
          if (activeSession()?.id === sess.id) {
            stopWatchSubscription();
            stopGoalSubscription();
            activeSession.set(null);
            activeGoal.set(null);
            messages.set([]);
            route.set('home');
          }
        } else if (res.kind === 'changed') {
          if (
            (action === 'archive' && catalogFilter() !== 'archived') ||
            (action === 'restore' && catalogFilter() === 'archived')
          ) {
            sessions.set(sessions().filter((s) => s.id !== sess.id));
          } else {
            upsertSessionInList(res.session);
          }
        } else if (res.kind === 'revision_conflict') {
          statusBanner.set('会话版本变化，已刷新，请重试');
          reloadCatalog(catalogFilter(), catalogQuery(), gen, epoch);
        } else {
          statusBanner.set('操作被拒绝: ' + JSON.stringify(res.reason));
        }
      },
      (err: Error) => {
        if (isHostStillCurrent(gen, epoch)) statusBanner.set('会话操作失败: ' + err.message);
      },
    );
  };

  const runLoadModels = (query = '') => {
    const active = hostState().active;
    if (!active || !hasAgentEndpoint(active)) return;
    const gen = hostSyncGen;
    const epoch = active.epoch;
    modelsLoading.set(true);
    agentListModels(query).then(
      (list) => {
        if (!isHostStillCurrent(gen, epoch)) return;
        modelChoices.set(list);
        modelsLoading.set(false);
      },
      (err: Error) => {
        if (!isHostStillCurrent(gen, epoch)) return;
        modelsLoading.set(false);
        statusBanner.set('读取模型列表失败: ' + err.message);
      },
    );
  };

  const runOpenModelPicker = () => {
    route.set('model_picker');
    runLoadModels('');
  };

  const runSelectBackend = (backend: AgentBackendPreference) => {
    const sess = activeSession();
    const active = hostState().active;
    if (!sess) {
      draftBackend.set(backend);
      route.set('chat');
      return;
    }
    if (!active) return;
    const gen = hostSyncGen;
    const epoch = active.epoch;
    const sGen = sessionSyncGen;
    const sessionId = sess.id;
    agentSelectBackend(sessionId, backend).then(
      (res) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
        if (res.kind === 'committed' && res.session) {
          upsertSessionInList(res.session);
          route.set('chat');
        } else if (res.kind === 'rejected') {
          statusBanner.set(
            '切换模型被拒绝: ' +
              (typeof res.reason === 'string'
                ? res.reason
                : JSON.stringify(res.reason ?? 'rejected')),
          );
        } else {
          statusBanner.set('切换模型冲突，请重试');
        }
      },
      (err: Error) => {
        if (isSessionStillCurrent(gen, epoch, sGen, sessionId)) {
          statusBanner.set('切换模型失败: ' + err.message);
        }
      },
    );
  };

  const runGoalControl = (action: 'pause' | 'resume' | 'cancel' | 'dismiss') => {
    const sess = activeSession();
    const active = hostState().active;
    const g = activeGoal();
    if (!sess || !active || !g) return;
    const gen = hostSyncGen;
    const epoch = active.epoch;
    const sGen = sessionSyncGen;
    const sessionId = sess.id;
    busy.set(true);
    agentControlGoal(sessionId, g.id, g.revision, action).then(
      (res) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
        busy.set(false);
        if (res.kind === 'rejected') {
          statusBanner.set('目标操作被拒绝: ' + res.reason);
        } else if (res.kind === 'conflict') {
          statusBanner.set('目标状态已更新，正在刷新');
        }
        agentReadGoal(sessionId).then(
          (view) => {
            if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
            applyGoalView(view, 'read');
          },
          () => {},
        );
      },
      (err: Error) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
        busy.set(false);
        statusBanner.set('目标操作失败: ' + err.message);
      },
    );
  };

  const runOpenBot = () => {
    const active = hostState().active;
    if (hasAgentEndpoint(active)) {
      const gen = hostSyncGen;
      const epoch = active.epoch;
      busy.set(true);
      agentOpenBot().then(
        (res) => {
          busy.set(false);
          if (!isHostStillCurrent(gen, epoch)) return;
          if (res.kind === 'opened' && res.sessionId) {
            const existing = sessions().find((s) => s.id === res.sessionId);
            if (existing) {
              openAgentSession(existing);
            } else {
              openAgentSession({
                id: res.sessionId,
                title: 'Maka Bot',
                kind: 'agent',
                parentSessionId: null,
                labels: [],
                workspace: {},
                revision: 1,
                updatedAt: Date.now(),
                archived: false,
                pinned: true,
                hasUnread: false,
                activity: 'idle',
              });
            }
          } else {
            drawerOpen.set(false);
            route.set('chat');
          }
        },
        (err: Error) => {
          busy.set(false);
          statusBanner.set(err.message);
          drawerOpen.set(false);
          route.set('chat');
        },
      );
      return;
    }
    drawerOpen.set(false);
    route.set('chat');
  };

  const retrySubscriptions = () => {
    const active = hostState().active;
    if (!active || !hasAgentEndpoint(active)) return;
    if (catalogError() !== null && !catalogSub) {
      startCatalogSubscription(hostSyncGen, active.epoch);
    }
    const sess = activeSession();
    if (watchError() !== null && sess && !watchSub) {
      startWatchSubscription(sess.id, watchCursor, hostSyncGen, active.epoch, sessionSyncGen);
    }
  };

  const runVerifyLiveRpc = () => {
    const active = hostState().active;
    if (!active) {
      statusBanner.set('尚未连接远端 Host');
      return;
    }
    const gen = hostSyncGen;
    const epoch = active.epoch;
    if (hasAgentEndpoint(active)) {
      busy.set(true);
      if (!catalogSub) {
        startCatalogSubscription(gen, epoch);
      }
      const sess = activeSession();
      if (sess && !watchSub) {
        startWatchSubscription(sess.id, watchCursor, gen, epoch, sessionSyncGen);
      }
      const qGen = catalogQueryGen;
      const filter = catalogFilter();
      const query = catalogQuery();
      agentListSessions(filter, query).then(
        (page) => {
          busy.set(false);
          if (
            !isHostStillCurrent(gen, epoch) ||
            qGen !== catalogQueryGen ||
            catalogFilter() !== filter ||
            catalogQuery() !== query
          ) {
            return;
          }
          applyCatalogPage(page, false);
        },
        (err: Error) => {
          busy.set(false);
          if (isHostStillCurrent(gen, epoch) && qGen === catalogQueryGen) {
            statusBanner.set('同步失败: ' + err.message);
          }
        },
      );
      return;
    }
    const targetEndpoint = active.endpoints.includes('hostLogs') ? 'hostLogs' : active.endpoints[0];
    if (!targetEndpoint) {
      statusBanner.set('远端 Host 未暴露可用端点');
      return;
    }
    busy.set(true);
    hostCall(targetEndpoint, 'read', { position: { kind: 'tail' } }).then(
      (res) => {
        busy.set(false);
        if (!isHostStillCurrent(gen, epoch)) return;
        const msgId = 'm-rpc-' + String(Date.now());
        messages.set([
          ...messages(),
          {
            id: msgId,
            role: 'agent',
            author: active.hostName,
            text:
              '实时 RPC 校验通过 (' +
              targetEndpoint +
              '.read)，收到 ' +
              String(res.events.length) +
              ' 条远端响应帧。',
            turnSummary: '已通过 ' + active.hostName + ' · Root ' + active.rootId.slice(0, 8),
            reactions: [{ emoji: '👍', count: 1, mine: false, fromAgent: true }],
          },
        ]);
      },
      (err: Error) => {
        busy.set(false);
        if (isHostStillCurrent(gen, epoch)) {
          statusBanner.set('RPC 失败: ' + err.message);
        }
      },
    );
  };

  const runOpenDiff = (path?: string) => {
    const sess = activeSession();
    const active = hostState().active;
    if (sess && active && hasAgentEndpoint(active)) {
      const gen = hostSyncGen;
      const epoch = active.epoch;
      const sGen = sessionSyncGen;
      const sessionId = sess.id;
      diffTitle.set(path ?? sess.title + ' · Diff');
      diffLines.set([]);
      diffTruncatedNotice.set(null);
      route.set('diff');
      agentGitWorkspaceDiff(sessionId).then(
        (diff) => {
          if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
          if (!diff) {
            diffLines.set([]);
            diffTruncatedNotice.set(null);
            return;
          }
          diffLines.set(parseUnifiedWorkspacePatch(diff.patch, path));
          diffTruncatedNotice.set(
            diff.truncated
              ? 'Diff 已截断 · 跳过 ' + String(diff.skippedFiles ?? 0) + ' 个文件'
              : null,
          );
        },
        (err: Error) => {
          if (isSessionStillCurrent(gen, epoch, sGen, sessionId)) {
            statusBanner.set('读取 Diff 失败: ' + err.message);
          }
        },
      );
      return;
    }
    diffTitle.set(path ?? 'platform/remote-client/src/client.rs');
    diffLines.set(PREVIEW_DIFF_LINES);
    diffTruncatedNotice.set(null);
    route.set('diff');
  };

  const runOpenAutomations = () => {
    drawerOpen.set(false);
    route.set('automations');
    const active = hostState().active;
    if (active && hasAgentEndpoint(active)) {
      const gen = hostSyncGen;
      const epoch = active.epoch;
      schedulesLoading.set(true);
      agentListSchedules().then(
        (items) => {
          if (!isHostStillCurrent(gen, epoch)) return;
          schedules.set(items);
          schedulesLoading.set(false);
        },
        (err: Error) => {
          if (!isHostStillCurrent(gen, epoch)) return;
          schedulesLoading.set(false);
          statusBanner.set('读取定时任务失败: ' + err.message);
        },
      );
    }
  };

  const toggleReaction = (msgId: string, emoji: string) => {
    const next = messages().map((m) => {
      if (m.id !== msgId) return m;
      const existing = m.reactions.find((r) => r.emoji === emoji);
      let updated: ReactionEntry[];
      if (existing) {
        if (existing.mine) {
          updated =
            existing.count <= 1
              ? m.reactions.filter((r) => r.emoji !== emoji)
              : m.reactions.map((r) =>
                  r.emoji === emoji ? { ...r, count: r.count - 1, mine: false } : r,
                );
        } else {
          burst.trigger(emoji);
          updated = m.reactions.map((r) =>
            r.emoji === emoji ? { ...r, count: r.count + 1, mine: true } : r,
          );
        }
      } else {
        burst.trigger(emoji);
        updated = [...m.reactions, { emoji, count: 1, mine: true }];
      }
      return { ...m, reactions: updated };
    });
    messages.set(next);
    activeReactionMsgId.set(null);
  };

  const readQueuedMessage = (messageId: string, review: boolean) => {
    const sess = activeSession();
    const active = hostState().active;
    const snapshot = queue();
    if (
      !sess ||
      !active ||
      !snapshot ||
      !queueFresh() ||
      queueBusy() !== null ||
      (!review && queueEdit() !== null)
    )
      return;
    const gen = hostSyncGen,
      epoch = active.epoch,
      sGen = sessionSyncGen;
    queueBusy.set('request');
    queueError.set(null);
    agentQueueMessage(sess.id, messageId, snapshot.revision).then(
      (result) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sess.id)) return;
        queueBusy.set(null);
        if (
          result.kind !== 'ready' ||
          !queueFresh() ||
          queue()?.revision !== result.revision ||
          !queue()?.entries.some((e) => e.messageId === messageId)
        ) {
          queueError.set(
            result.kind === 'missing'
              ? '消息已不在队列中；编辑内容已保留。'
              : '队列已变化，请重新查看当前消息。',
          );
          return;
        }
        if (review) {
          queueReview.set(result);
        } else {
          queueEdit.set({
            messageId,
            revision: result.revision,
            text: result.message,
            hasAttachments: result.hasAttachments,
            quotes: result.quotes,
          });
          queueReview.set(null);
        }
      },
      (err: Error) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sess.id)) return;
        queueBusy.set(null);
        queueError.set('读取排队消息失败: ' + err.message);
      },
    );
  };

  const changeQueue = (
    revision: number,
    edit:
      | { kind: 'update'; messageId: string; message: string }
      | { kind: 'reorder'; messageIds: string[] },
  ) => {
    const sess = activeSession();
    const active = hostState().active;
    if (!sess || !active || !queueFresh() || queueBusy() !== null) return;
    if (queue()?.revision !== revision) {
      queueError.set('队列已变化，请查看当前消息；编辑内容已保留。');
      return;
    }
    const gen = hostSyncGen,
      epoch = active.epoch,
      sGen = sessionSyncGen;
    queueBusy.set('request');
    queueError.set(null);
    agentEditQueue(sess.id, revision, edit).then(
      (result) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sess.id)) return;
        if (result.kind === 'committed') {
          const pending = {
            revision: result.revision,
            submitted:
              edit.kind === 'update' ? { messageId: edit.messageId, text: edit.message } : null,
          };
          if (queueFresh() && (queue()?.revision ?? -1) >= result.revision) {
            settleQueueReceipt(pending);
          } else {
            queueBusy.set(pending);
          }
        } else {
          queueBusy.set(null);
          queueError.set(
            result.kind === 'revision_conflict'
              ? '队列已变化，请查看当前消息；编辑内容已保留。'
              : '队列修改被拒绝: ' + result.reason,
          );
        }
      },
      (err: Error) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sess.id)) return;
        queueBusy.set(null);
        queueError.set('修改队列失败: ' + err.message);
      },
    );
  };

  const canMoveQueuedMessage = (entry: AgentQueueEntry, direction: -1 | 1) => {
    if (!queueFresh() || queueEdit() !== null || queueBusy() !== null) return false;
    const neighbors = queueNeighbors().get(entry.messageId);
    return direction === -1 ? !!neighbors?.up : !!neighbors?.down;
  };

  const moveQueuedMessage = (entry: AgentQueueEntry, direction: -1 | 1) => {
    const snapshot = queue();
    if (!snapshot || entry.kind === 'in_flight' || queueEdit() !== null) return;
    const lane = snapshot.entries.filter((item) => item.kind === entry.kind);
    const index = lane.findIndex((item) => item.messageId === entry.messageId);
    const visible = lane.filter((item) => item.origin?.kind !== 'session_completion');
    const visibleIndex = visible.findIndex((item) => item.messageId === entry.messageId);
    const target = visible[visibleIndex + direction];
    if (index < 0 || visibleIndex < 0 || !target) return;
    const targetIndex = lane.findIndex((item) => item.messageId === target.messageId);
    const ids = lane.map((item) => item.messageId);
    [ids[index], ids[targetIndex]] = [ids[targetIndex], ids[index]];
    changeQueue(snapshot.revision, { kind: 'reorder', messageIds: ids });
  };

  const sendMessage = (overrideDelivery?: 'steer' | 'queue') => {
    const rawText = composerDraft().trim();
    if (!rawText || creatingDraft()) return;
    const savedQuote = quotedLine();
    const content = savedQuote ? '> ' + savedQuote + '\n' + rawText : rawText;

    const sess = activeSession();
    const active = hostState().active;
    if (active && hasAgentEndpoint(active)) {
      const gen = hostSyncGen;
      const epoch = active.epoch;
      const delivery = overrideDelivery ?? defaultDelivery();
      composerDraft.set('');
      quotedLine.set(null);
      sessionDrafts.delete(currentDraftKey);

      const restoreFailedDraft = () => {
        if (composerDraft().trim().length === 0) {
          composerDraft.set(rawText);
        }
        if (quotedLine() === null && savedQuote !== null) {
          quotedLine.set(savedQuote);
        }
      };

      const dispatchToSession = (targetSession: AgentSession, targetSGen: number) => {
        const targetSessionId = targetSession.id;
        const isRoom = targetSession.kind === 'room';
        const expectedRunId = delivery === 'steer' ? activeRunId() : null;
        stickToBottom = true;
        messages.set([
          ...messages(),
          {
            id: 'optimistic-' + String(Date.now()),
            role: 'user',
            text: content,
            reactions: [],
          },
        ]);
        if (!isRoom) {
          awaitingReply.set(true);
        }
        agentSend(targetSessionId, content, delivery, { expectedRunId }).then(
          (res) => {
            if (!isSessionStillCurrent(gen, epoch, targetSGen, targetSessionId)) return;
            if (res.kind === 'started' && res.runId) {
              activeRunId.set(res.runId);
            } else if (res.kind === 'posted') {
              awaitingReply.set(false);
            } else if (res.kind === 'rejected') {
              awaitingReply.set(false);
              restoreFailedDraft();
              const reasonText =
                typeof res.reason === 'string'
                  ? res.reason
                  : JSON.stringify(res.reason ?? 'unknown');
              statusBanner.set('消息被 Host 拒绝: ' + reasonText);
            } else if (res.kind === 'not_your_worker') {
              awaitingReply.set(false);
              restoreFailedDraft();
              statusBanner.set('当前会话不允许直接发送消息');
            }
            refreshSessionTranscript(targetSessionId, false, gen, epoch, targetSGen);
          },
          (err: Error) => {
            if (isSessionStillCurrent(gen, epoch, targetSGen, targetSessionId)) {
              awaitingReply.set(false);
              restoreFailedDraft();
              statusBanner.set('发送失败: ' + err.message);
            }
          },
        );
      };

      if (sess) {
        dispatchToSession(sess, sessionSyncGen);
      } else {
        const ws = draftWorkspace()?.selection ?? defaultDraftWorkspace().selection;
        const draftSGen = sessionSyncGen;
        const draftPartitionKey = draftKeyFor(active.rootId, null);
        const pendingEntry = { key: draftPartitionKey, text: rawText, quote: savedQuote };
        inFlightDraft = pendingEntry;
        const preserveUnsentDraft = () => {
          if (inFlightDraft === pendingEntry) inFlightDraft = null;
          if (!sessionDrafts.has(draftPartitionKey)) {
            sessionDrafts.set(draftPartitionKey, { text: rawText, quote: savedQuote });
          }
        };
        const isDraftStillCurrent = () =>
          isHostStillCurrent(gen, epoch) &&
          draftSGen === sessionSyncGen &&
          activeSession() === null;
        creatingDraft.set(true);
        agentCreateSession({
          title: 'New conversation',
          kind: 'agent',
          workspace: ws,
          automaticTitle: true,
          backend: draftBackend(),
        }).then(
          (created) => {
            if (!isHostStillCurrent(gen, epoch)) {
              preserveUnsentDraft();
              return;
            }
            upsertSessionInList(created);
            if (!isDraftStillCurrent()) {
              preserveUnsentDraft();
              return;
            }
            if (inFlightDraft === pendingEntry) inFlightDraft = null;
            creatingDraft.set(false);
            openAgentSession(created);
            dispatchToSession(created, sessionSyncGen);
          },
          (err: Error) => {
            if (isDraftStillCurrent()) {
              if (inFlightDraft === pendingEntry) inFlightDraft = null;
              creatingDraft.set(false);
              restoreFailedDraft();
              statusBanner.set('创建会话失败: ' + err.message);
            } else {
              preserveUnsentDraft();
            }
          },
        );
      }
      return;
    }

    composerDraft.set('');
    quotedLine.set(null);
    messages.set([
      ...messages(),
      {
        id: 'u-' + String(Date.now()),
        role: 'user',
        text: content,
        reactions: [{ emoji: '👀', count: 1, mine: false, fromAgent: true }],
      },
    ]);
    if (hostState().active) {
      runVerifyLiveRpc();
    }
  };

  const resolvePermission = (card: PermissionCardItem, action: PermissionAction) => {
    const label =
      action === 'deny'
        ? '已拒绝'
        : action === 'cancel_system_permission'
          ? '已取消等待'
          : action === 'run'
            ? '已本轮允许'
            : action === 'session'
              ? '已本会话允许'
              : action === 'always'
                ? '已始终允许'
                : '已允许本次';
    const allowed = action !== 'deny' && action !== 'cancel_system_permission';
    const sess = activeSession();
    const active = hostState().active;

    const markResolved = () => {
      permissions.set(
        permissions().map((p) => (p.id === card.id ? { ...p, resolved: { allowed, label } } : p)),
      );
    };

    if (sess && card.requestId && active && hasAgentEndpoint(active)) {
      const answer = buildInteractionAnswer(card, action);
      if (!answer) {
        statusBanner.set('当前交互请求缺少必需的原始权限字段，请在桌面端处理');
        return;
      }
      const gen = hostSyncGen;
      const epoch = active.epoch;
      const sGen = sessionSyncGen;
      const sessionId = sess.id;
      busy.set(true);
      agentRespondInteraction(sessionId, card.requestId, answer).then(
        (res) => {
          if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
          busy.set(false);
          if (res.kind !== 'recorded') {
            statusBanner.set(
              '权限回复被 Host 拒绝: ' +
                (typeof res.reason === 'string'
                  ? res.reason
                  : JSON.stringify(res.reason ?? 'rejected')),
            );
            return;
          }
          markResolved();
          refreshSessionTranscript(sessionId, false, gen, epoch, sGen);
        },
        (err: Error) => {
          if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
          busy.set(false);
          statusBanner.set('权限回复失败: ' + err.message);
        },
      );
      return;
    }

    markResolved();
    if (allowed && hostState().active) {
      runVerifyLiveRpc();
    }
  };

  const submitQuestion = (card: QuestionCardItem, answers: (string | null)[]) => {
    const sess = activeSession();
    const active = hostState().active;
    const markAnswered = () => {
      questions.set(questions().map((q) => (q.id === card.id ? { ...q, answered: answers } : q)));
    };

    if (sess && card.requestId && active && hasAgentEndpoint(active)) {
      const gen = hostSyncGen;
      const epoch = active.epoch;
      const sGen = sessionSyncGen;
      const sessionId = sess.id;
      busy.set(true);
      agentRespondInteraction(sessionId, card.requestId, {
        kind: 'question',
        answers,
      }).then(
        (res) => {
          if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
          busy.set(false);
          if (res.kind !== 'recorded') {
            statusBanner.set(
              '问题回复被 Host 拒绝: ' +
                (typeof res.reason === 'string'
                  ? res.reason
                  : JSON.stringify(res.reason ?? 'rejected')),
            );
            return;
          }
          markAnswered();
          refreshSessionTranscript(sessionId, false, gen, epoch, sGen);
        },
        (err: Error) => {
          if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
          busy.set(false);
          statusBanner.set('问题回复失败: ' + err.message);
        },
      );
      return;
    }

    markAnswered();
  };

  const pendingCount = () =>
    permissions().filter((p) => !p.resolved && p.mode !== 'unsupported').length +
    questions().filter((q) => !q.answered).length;

  const chatTitle = () => {
    const sess = activeSession();
    if (sess) return (sess.kind === 'room' ? '# ' : '') + sess.title;
    if (hasAgentEndpoint(hostState().active)) return '新对话';
    return hostState().active?.hostName ?? 'Maka Bot';
  };

  const chatSubtitle = () => {
    const active = hostState().active;
    if (!active) return '本地预览会话';
    if (creatingDraft()) return active.hostName + ' · 正在创建会话…';
    if (activeRunId()) return active.hostName + ' · 执行中';
    if (activeSession()) return active.hostName + ' · 实时同步';
    if (hasAgentEndpoint(active)) return active.hostName + ' · 草稿';
    return '远端 Host 已就绪';
  };

  const turnEntries = (): TurnRailEntry[] =>
    messages()
      .filter((m) => m.role === 'user')
      .map((m) => ({ id: m.id, preview: m.text }));

  const jumpToTurn = (turnId: string) => {
    const y = turnOffsets.get(turnId);
    if (typeof y === 'number') {
      stickToBottom = false;
      activeTurnId.set(turnId);
      chatScroll?.scrollTo({ y: Math.max(0, y - 12), animated: true });
    }
  };

  const currentBackend = (): AgentBackendPreference | null =>
    activeSession()?.backend ?? draftBackend();

  const topPad = () => Math.max(insets().top, 16);
  const bottomPad = () => Math.max(insets().bottom, 16);

  const drawerProps = {
    hostState,
    projects,
    sessions,
    catalogFilter,
    catalogQuery,
    needsYouCount,
    hasMoreSessions: () => catalogAfter() !== null,
    activeSessionId: () => activeSession()?.id ?? null,
    pendingCount,
    statusBanner,
    bottomPad,
    onSelectSession: openAgentSession,
    onStartDraft: startDraft,
    onOpenNewRoom: () => {
      drawerOpen.set(false);
      route.set('new_room');
    },
    onCatalogFilterChange: (nextFilter: CatalogFilterMode) => {
      catalogFilter.set(nextFilter);
      reloadCatalog(nextFilter, catalogQuery());
    },
    onCatalogQueryChange: (nextQuery: string) => {
      catalogQuery.set(nextQuery);
      reloadCatalog(catalogFilter(), nextQuery);
    },
    onLoadMoreSessions: () => {
      const active = hostState().active;
      const rev = catalogRevision();
      const after = catalogAfter();
      if (!active || !rev || !after || loadingMoreSessions) return;
      const gen = hostSyncGen;
      const epoch = active.epoch;
      const qGen = catalogQueryGen;
      const filter = catalogFilter();
      const query = catalogQuery();
      loadingMoreSessions = true;
      agentListSessions(filter, query, { revision: rev, cursor: after }).then(
        (page) => {
          if (
            !isHostStillCurrent(gen, epoch) ||
            qGen !== catalogQueryGen ||
            catalogFilter() !== filter ||
            catalogQuery() !== query
          ) {
            return;
          }
          loadingMoreSessions = false;
          applyCatalogPage(page, true);
        },
        (err: Error) => {
          if (isHostStillCurrent(gen, epoch) && qGen === catalogQueryGen) {
            loadingMoreSessions = false;
            statusBanner.set('加载更多失败: ' + err.message);
          }
        },
      );
    },
    onRenameSession: runRenameSession,
    onTogglePinSession: runTogglePinSession,
    onChangeSessionLifecycle: runChangeSessionLifecycle,
    onOpenBot: runOpenBot,
    onOpenActiveWorkspace: () => {
      drawerOpen.set(false);
      route.set('chat');
    },
    onConnectHost: runConnectSaved,
    onSwitchFilter: runSwitchFilter,
    onOpenPairing: () => {
      drawerOpen.set(false);
      route.set('pairing');
    },
    onOpenAutomations: runOpenAutomations,
    onOpenSettings: () => {
      drawerOpen.set(false);
      route.set('settings');
    },
  };

  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor: palette().bg,
        paddingTop: topPad(),
      }}
    >
      <If when={route() === 'home'}>
        <DrawerHome {...drawerProps} />
      </If>

      <If when={route() === 'chat'}>
        <View style={{ flex: 1, minHeight: 0 }}>
          {/* Top Navigation Bar */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 12,
              paddingVertical: 9,
              borderBottomWidth: 1,
              borderBottomColor: palette().line,
            }}
          >
            <View
              role="button"
              accessibilityLabel="Open drawer"
              onPress={() => drawerOpen.set(true)}
              style={{
                minWidth: 42,
                minHeight: 40,
                borderRadius: 20,
                backgroundColor: palette().rowHover,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 17, color: palette().ink }}>☰</Text>
            </View>

            <View
              role="button"
              accessibilityLabel="Rename active session title"
              onPress={() => {
                const sess = activeSession();
                if (sess && hasAgentEndpoint(hostState().active)) {
                  headerRenameDraft.set(sess.title);
                  headerRenaming.set(!headerRenaming());
                }
              }}
              style={{ flex: 1, alignItems: 'center', paddingHorizontal: 8 }}
            >
              <Text style={{ fontSize: 15.5, fontWeight: '600', color: palette().ink }}>
                {chatTitle()}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: hostState().active
                      ? activeRunId()
                        ? palette().working
                        : palette().online
                      : palette().ink3,
                  }}
                />
                <Text style={{ fontSize: 11.5, color: palette().ink2 }}>{chatSubtitle()}</Text>
              </View>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View
                role="button"
                accessibilityLabel="Open diff viewer"
                onPress={() => runOpenDiff()}
                style={{
                  minWidth: 40,
                  minHeight: 36,
                  paddingHorizontal: 9,
                  borderRadius: 18,
                  backgroundColor: palette().rowHover,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 12.5, fontWeight: '600', color: palette().ink2 }}>
                  Diff
                </Text>
              </View>

              <If when={catalogError() !== null || watchError() !== null}>
                <View
                  role="button"
                  accessibilityLabel="Retry subscriptions"
                  onPress={retrySubscriptions}
                  style={{
                    minWidth: 40,
                    minHeight: 36,
                    paddingHorizontal: 9,
                    borderRadius: 18,
                    backgroundColor: palette().rowHover,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 12.5, color: palette().ink2 }}>重试</Text>
                </View>
              </If>
            </View>
          </View>

          {/* Inline Header Session Rename Bar */}
          <If when={headerRenaming() && activeSession() !== null}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 14,
                paddingVertical: 8,
                backgroundColor: palette().surface,
                borderBottomWidth: 1,
                borderBottomColor: palette().line,
              }}
            >
              <Input
                accessibilityLabel="Inline rename active session input"
                value={headerRenameDraft()}
                onChange={({ value }: { value: string }) => headerRenameDraft.set(value)}
                placeholder="修改会话标题…"
                style={{
                  flex: 1,
                  minHeight: 34,
                  borderRadius: 9,
                  backgroundColor: palette().surface2,
                  paddingHorizontal: 10,
                  color: palette().ink,
                  fontSize: 13.5,
                }}
              />
              <View
                role="button"
                accessibilityLabel="Save inline session title"
                onPress={() => {
                  const sess = activeSession();
                  const next = headerRenameDraft().trim();
                  if (sess && next.length > 0) {
                    runRenameSession(sess, next);
                    headerRenaming.set(false);
                  }
                }}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  borderRadius: 9,
                  backgroundColor: palette().primaryBg,
                }}
              >
                <Text style={{ fontSize: 12.5, fontWeight: '600', color: palette().primaryText }}>
                  保存
                </Text>
              </View>
              <View
                role="button"
                accessibilityLabel="Cancel inline session rename"
                onPress={() => headerRenaming.set(false)}
                style={{ paddingHorizontal: 6, paddingVertical: 6 }}
              >
                <Text style={{ fontSize: 12.5, color: palette().ink3 }}>取消</Text>
              </View>
            </View>
          </If>

          <If when={statusBanner() !== null}>
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 8,
                backgroundColor: palette().accentSoft,
              }}
            >
              <Text style={{ fontSize: 12.5, color: palette().ink }}>{statusBanner()}</Text>
            </View>
          </If>

          <If when={catalogError() !== null}>
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 8,
                backgroundColor: palette().accentSoft,
              }}
            >
              <Text style={{ fontSize: 12.5, color: palette().ink }}>{catalogError()}</Text>
            </View>
          </If>
          <If when={watchError() !== null}>
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 8,
                backgroundColor: palette().accentSoft,
              }}
            >
              <Text style={{ fontSize: 12.5, color: palette().ink }}>{watchError()}</Text>
            </View>
          </If>

          {/* Scrollable Chat Viewport + Right-Edge Turn Navigation Rail */}
          <View style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <Scroll
              ref={(node) => {
                chatScroll = node;
              }}
              style={{ flex: 1, minHeight: 0 }}
              onScroll={(event) => {
                const maxY = Math.max(0, event.contentSize.height - event.size.height);
                stickToBottom = maxY <= 8 || event.offset.y >= maxY - 36;
                const y = event.offset.y + 40;
                let nearest: string | null = null;
                for (const turn of turnEntries()) {
                  const ty = turnOffsets.get(turn.id);
                  if (typeof ty === 'number' && ty <= y) {
                    nearest = turn.id;
                  }
                }
                if (nearest !== null && nearest !== activeTurnId()) {
                  activeTurnId.set(nearest);
                }
              }}
              contentStyle={{
                paddingLeft: 16,
                paddingRight: 28,
                paddingTop: 14,
                paddingBottom: 24,
              }}
            >
              <View
                style={{ width: '100%', gap: 16 }}
                onLayout={({ bounds }) => {
                  const h = bounds.size.height;
                  if (h > lastContentHeight && stickToBottom) {
                    chatScroll?.scrollToEnd({ animated: false });
                  }
                  lastContentHeight = h;
                }}
              >
                <If when={historyBefore() !== null}>
                  <View
                    role="button"
                    accessibilityLabel="Load earlier messages"
                    onPress={loadEarlierHistory}
                    style={{
                      alignSelf: 'center',
                      paddingHorizontal: 14,
                      paddingVertical: 7,
                      borderRadius: 14,
                      backgroundColor: palette().surface,
                      borderWidth: 1,
                      borderColor: palette().line,
                    }}
                  >
                    <Text style={{ fontSize: 12.5, color: palette().ink2 }}>
                      {loadingEarlier() ? '正在加载更早消息…' : '加载更早消息'}
                    </Text>
                  </View>
                </If>

                <If
                  when={
                    messages().length === 0 &&
                    streamingText().length === 0 &&
                    streamingThinking().length === 0 &&
                    !awaitingReply()
                  }
                >
                  <View style={{ paddingVertical: 32, alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 15.5, fontWeight: '600', color: palette().ink }}>
                      {chatTitle()}
                    </Text>
                    <Text style={{ fontSize: 13, color: palette().ink3 }}>
                      {activeSession() === null && hasAgentEndpoint(hostState().active)
                        ? '直接发第一条消息即可自动创建会话并生成标题'
                        : '发一条消息开始对话，Maka 会实时同步执行过程'}
                    </Text>
                  </View>
                </If>

                <Each of={messages()} key={(m) => m.id}>
                  {(msg) => (
                    <View
                      onLayout={({ bounds }) => {
                        if (msg().role === 'user') {
                          turnOffsets.set(msg().id, bounds.origin.y);
                        }
                      }}
                      style={{
                        alignItems: msg().role === 'user' ? 'flex-end' : 'flex-start',
                        gap: 6,
                      }}
                    >
                      <If when={msg().role === 'user'}>
                        <View
                          style={{
                            maxWidth: '84%',
                            paddingHorizontal: 14,
                            paddingVertical: 10,
                            borderRadius: 18,
                            backgroundColor: palette().userBubble,
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 15.5,
                              lineHeight: 22,
                              color: palette().userBubbleText,
                            }}
                          >
                            {msg().text}
                          </Text>
                        </View>
                      </If>

                      <If when={msg().role === 'agent'}>
                        <View style={{ width: '100%', gap: 6 }}>
                          <If when={activeSession()?.kind === 'room'}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                              <View
                                style={{
                                  width: 20,
                                  height: 20,
                                  borderRadius: 5,
                                  backgroundColor: palette().surface2,
                                  borderWidth: 1,
                                  borderColor: palette().line,
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                <Text
                                  style={{ fontSize: 10, fontWeight: '700', color: palette().ink }}
                                >
                                  A
                                </Text>
                              </View>
                              <Text
                                style={{ fontSize: 12.5, fontWeight: '600', color: palette().ink2 }}
                              >
                                {msg().author ?? 'Maka'}
                              </Text>
                            </View>
                          </If>

                          <If when={!!msg().turnSummary && (msg().steps?.length ?? 0) > 0}>
                            <TurnPanel
                              id={msg().id}
                              summary={() => msg().turnSummary ?? ''}
                              steps={() => msg().steps ?? []}
                              onOpenDiff={(p) => runOpenDiff(p)}
                            />
                          </If>

                          {/* Pure scrollable text without a full-body press overlay blocking pan gestures */}
                          <Text style={{ fontSize: 15.5, lineHeight: 23.5, color: palette().ink }}>
                            {msg().text}
                          </Text>

                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            <View
                              role="button"
                              accessibilityLabel={'Agent message ' + msg().id}
                              onPress={() =>
                                activeReactionMsgId.set(
                                  activeReactionMsgId() === msg().id ? null : msg().id,
                                )
                              }
                              style={{
                                paddingHorizontal: 8,
                                paddingVertical: 3,
                                borderRadius: 10,
                                backgroundColor: palette().rowHover,
                              }}
                            >
                              <Text style={{ fontSize: 11.5, color: palette().ink3 }}>☺</Text>
                            </View>
                          </View>
                        </View>
                      </If>

                      <If when={activeReactionMsgId() === msg().id}>
                        <ReactionPickerBar
                          onPick={(emoji) => toggleReaction(msg().id, emoji)}
                          onDismiss={() => activeReactionMsgId.set(null)}
                        />
                      </If>

                      <ReactionPillsRow
                        reactions={msg().reactions}
                        onToggle={(emoji) => toggleReaction(msg().id, emoji)}
                        onRetryWithNewIdea={() => {
                          composerDraft.set('换一个更直接的思路重新处理');
                        }}
                      />
                    </View>
                  )}
                </Each>

                <If
                  when={
                    awaitingReply() &&
                    streamingThinking().length === 0 &&
                    streamingText().length === 0 &&
                    streamingTools().length === 0
                  }
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      paddingVertical: 4,
                    }}
                  >
                    <View
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 4,
                        backgroundColor: palette().working,
                      }}
                    />
                    <Text style={{ fontSize: 13, color: palette().ink3 }}>Maka 正在思考…</Text>
                  </View>
                </If>

                <If when={streamingThinking().length > 0}>
                  <View
                    style={{
                      width: '100%',
                      borderRadius: 14,
                      backgroundColor: palette().surface,
                      borderWidth: 1,
                      borderColor: palette().line,
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      gap: 6,
                    }}
                  >
                    <View
                      role="button"
                      accessibilityLabel="Toggle live thinking"
                      onPress={() => streamingThinkingExpanded.set(!streamingThinkingExpanded())}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                        <View
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            backgroundColor: palette().working,
                          }}
                        />
                        <Text style={{ fontSize: 12.5, fontWeight: '600', color: palette().ink2 }}>
                          {streamingText().length > 0 ? '思考过程' : '正在思考…'}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 11.5, color: palette().ink3 }}>
                        {streamingThinkingExpanded() ? '收起 ▾' : '展开 ▸'}
                      </Text>
                    </View>
                    <If when={streamingThinkingExpanded()}>
                      <Text style={{ fontSize: 13, lineHeight: 19.5, color: palette().ink2 }}>
                        {streamingThinking()}
                      </Text>
                    </If>
                  </View>
                </If>

                <Each of={streamingTools()} key={(t) => t.toolUseId}>
                  {(tool) => (
                    <View
                      style={{
                        width: '100%',
                        borderRadius: 12,
                        backgroundColor: palette().surface,
                        borderWidth: 1,
                        borderColor: palette().line,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        gap: 3,
                      }}
                    >
                      <Text style={{ fontSize: 12.5, fontWeight: '600', color: palette().ink2 }}>
                        {'准备调用工具 · ' + tool().name}
                      </Text>
                      <If when={tool().inputPreview.length > 0}>
                        <Text style={{ fontSize: 12, color: palette().ink3 }}>
                          {tool().inputPreview}
                        </Text>
                      </If>
                    </View>
                  )}
                </Each>

                <If when={streamingText().length > 0}>
                  <View style={{ width: '100%', gap: 4 }}>
                    <Text style={{ fontSize: 15.5, lineHeight: 23.5, color: palette().ink }}>
                      {streamingText()}
                    </Text>
                    <If when={activeRunId() !== null}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <View
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            backgroundColor: palette().working,
                          }}
                        />
                        <Text style={{ fontSize: 11.5, color: palette().ink3 }}>正在输出…</Text>
                      </View>
                    </If>
                  </View>
                </If>

                <Each of={permissions()} key={(p) => p.id}>
                  {(perm) => (
                    <ApplePermissionCard
                      item={perm}
                      busy={busy}
                      onDecide={(action) => resolvePermission(perm(), action)}
                    />
                  )}
                </Each>

                <Each of={questions()} key={(q) => q.id}>
                  {(q) => (
                    <AppleQuestionCard
                      item={q}
                      busy={busy}
                      onSubmit={(answers) => submitQuestion(q(), answers)}
                    />
                  )}
                </Each>
              </View>
            </Scroll>

            <TurnRail
              turns={turnEntries}
              activeId={() => activeTurnId() ?? turnEntries()[turnEntries().length - 1]?.id ?? null}
              onJump={jumpToTurn}
            />
          </View>

          <ReactionBurstLayer burst={burst} />

          {/* Docked Goal Status & Controls Bar (Desktop Parity) */}
          <GoalBar goal={activeGoal} busy={busy} onControl={runGoalControl} />

          <If when={queuedMessages().length > 0 || queueEdit() !== null}>
            <View
              style={{
                marginHorizontal: 14,
                marginBottom: 6,
                borderRadius: 13,
                backgroundColor: palette().surface,
                borderWidth: 1,
                borderColor: palette().line,
              }}
            >
              <View
                role="button"
                accessibilityLabel="Open queued messages"
                onPress={() => queueOpen.set(!queueOpen())}
                style={{ paddingHorizontal: 12, paddingVertical: 8 }}
              >
                <Text style={{ fontSize: 12, color: palette().ink2 }}>
                  {queuedMessages().length > 0
                    ? '已排队 ' + String(queuedMessages().length) + ' 条消息 ▾'
                    : '消息已不在队列 · 编辑保留 ▾'}
                </Text>
              </View>
              <If when={queueOpen()}>
                <Scroll style={{ maxHeight: 280 }}>
                  <Each of={queuedMessages()} key={(entry) => entry.messageId}>
                    {(entry) => (
                      <View
                        style={{
                          paddingHorizontal: 12,
                          paddingVertical: 6,
                          borderTopWidth: 1,
                          borderColor: palette().line,
                        }}
                      >
                        <Text style={{ fontSize: 12, color: palette().ink }}>
                          {entry().preview}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 14, paddingVertical: 5 }}>
                          <If when={queueFresh() && queueEdit() === null && queueBusy() === null}>
                            <View
                              role="button"
                              accessibilityLabel={'Edit queued ' + entry().messageId}
                              onPress={() => readQueuedMessage(entry().messageId, false)}
                            >
                              <Text style={{ color: palette().ink2 }}>编辑</Text>
                            </View>
                          </If>
                          <If when={canMoveQueuedMessage(entry(), -1)}>
                            <View
                              role="button"
                              accessibilityLabel={'Move queued up ' + entry().messageId}
                              onPress={() => moveQueuedMessage(entry(), -1)}
                            >
                              <Text style={{ color: palette().ink2 }}>上移</Text>
                            </View>
                          </If>
                          <If when={canMoveQueuedMessage(entry(), 1)}>
                            <View
                              role="button"
                              accessibilityLabel={'Move queued down ' + entry().messageId}
                              onPress={() => moveQueuedMessage(entry(), 1)}
                            >
                              <Text style={{ color: palette().ink2 }}>下移</Text>
                            </View>
                          </If>
                        </View>
                      </View>
                    )}
                  </Each>
                  <If when={queueEdit() !== null}>
                    <View style={{ padding: 12, gap: 8 }}>
                      <Input
                        accessibilityLabel="Queued message editor"
                        multiline
                        value={queueEdit()?.text ?? ''}
                        onChange={({ value }: { value: string }) => {
                          const edit = queueEdit();
                          if (edit) queueEdit.set({ ...edit, text: value });
                        }}
                        style={{
                          height: 100,
                          color: palette().ink,
                          backgroundColor: palette().surface2,
                        }}
                      />
                      <If
                        when={queueEdit()?.hasAttachments || (queueEdit()?.quotes.length ?? 0) > 0}
                      >
                        <Text style={{ color: palette().ink2 }}>附件与引用将保留</Text>
                      </If>
                      <If when={queueReview() !== null}>
                        <Text style={{ color: palette().ink2 }}>
                          {'当前消息: ' + (queueReview()?.message ?? '')}
                        </Text>
                      </If>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
                        <View
                          role="button"
                          accessibilityLabel="Save queued message"
                          onPress={() => {
                            const edit = queueEdit();
                            if (
                              edit &&
                              (edit.text.trim() || edit.hasAttachments || edit.quotes.length)
                            )
                              changeQueue(edit.revision, {
                                kind: 'update',
                                messageId: edit.messageId,
                                message: edit.text,
                              });
                          }}
                        >
                          <Text style={{ color: palette().ink }}>保存</Text>
                        </View>
                        <View
                          role="button"
                          accessibilityLabel="Review queued message"
                          onPress={() => {
                            const edit = queueEdit();
                            if (edit) readQueuedMessage(edit.messageId, true);
                          }}
                        >
                          <Text style={{ color: palette().ink }}>查看当前版本</Text>
                        </View>
                        <If when={queueReview() !== null}>
                          <View
                            role="button"
                            accessibilityLabel="Keep queued edit"
                            onPress={() => {
                              const edit = queueEdit(),
                                review = queueReview();
                              if (
                                !queueFresh() ||
                                !edit ||
                                !review ||
                                queue()?.revision !== review.revision
                              ) {
                                queueError.set('队列再次变化，请重新查看。');
                                return;
                              }
                              queueEdit.set({
                                ...edit,
                                revision: review.revision,
                                hasAttachments: review.hasAttachments,
                                quotes: review.quotes,
                              });
                              queueReview.set(null);
                              queueError.set(null);
                            }}
                          >
                            <Text style={{ color: palette().ink }}>保留我的编辑</Text>
                          </View>
                        </If>
                        <View
                          role="button"
                          accessibilityLabel="Cancel queued edit"
                          onPress={() => {
                            if (queueBusy() !== 'request' || !queueFresh()) {
                              queueEdit.set(null);
                              queueReview.set(null);
                              queueError.set(null);
                            }
                          }}
                        >
                          <Text style={{ color: palette().ink }}>取消</Text>
                        </View>
                      </View>
                    </View>
                  </If>
                  <If when={queueError() !== null}>
                    <Text style={{ padding: 12, color: palette().danger }}>{queueError()}</Text>
                  </If>
                  <If when={!queueFresh()}>
                    <Text style={{ padding: 12, color: palette().ink2 }}>
                      队列同步已中断，请重试后再修改。
                    </Text>
                  </If>
                  <If when={queueBusy() !== null}>
                    <Text style={{ padding: 12, color: palette().ink2 }}>
                      {queueBusy() === 'request' ? '正在更新队列…' : '等待队列同步…'}
                    </Text>
                  </If>
                </Scroll>
              </If>
            </View>
          </If>

          <If when={quotedLine() !== null}>
            <View
              style={{
                marginHorizontal: 14,
                marginBottom: 6,
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: 13,
                backgroundColor: palette().surface,
                borderWidth: 1,
                borderColor: palette().line,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text style={{ flex: 1, fontSize: 12, color: palette().ink2 }}>
                {'引用: ' + (quotedLine() ?? '')}
              </Text>
              <View
                role="button"
                accessibilityLabel="Remove quote"
                onPress={() => quotedLine.set(null)}
                style={{ paddingLeft: 8 }}
              >
                <Text style={{ fontSize: 12, color: palette().ink3 }}>✕</Text>
              </View>
            </View>
          </If>

          {/* Compact Context Row Above Composer: Draft Workspace Chip + Model/Thinking Chip */}
          <If when={hasAgentEndpoint(hostState().active) && activeSession()?.kind !== 'room'}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 14,
                paddingBottom: 6,
              }}
            >
              <If when={activeSession() === null}>
                <View
                  role="button"
                  accessibilityLabel="Pick draft workspace"
                  onPress={() => route.set('workspace_picker')}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 5,
                    borderRadius: 12,
                    backgroundColor: palette().surface,
                    borderWidth: 1,
                    borderColor: palette().line,
                  }}
                >
                  <Text style={{ fontSize: 12, color: palette().ink2 }}>
                    {'工作区 · ' +
                      (draftWorkspace()?.label ?? defaultDraftWorkspace().label) +
                      ' ▾'}
                  </Text>
                </View>
              </If>

              <View
                role="button"
                accessibilityLabel="Select model and thinking"
                onPress={runOpenModelPicker}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  borderRadius: 12,
                  backgroundColor: palette().surface,
                  borderWidth: 1,
                  borderColor: palette().line,
                }}
              >
                <Text style={{ fontSize: 12, color: palette().ink2 }}>
                  {formatBackendPill(currentBackend()) + ' ▾'}
                </Text>
              </View>
            </View>
          </If>

          {/* Composer */}
          <View
            style={{
              paddingHorizontal: 12,
              paddingTop: 4,
              paddingBottom: bottomPad(),
            }}
          >
            <View
              style={{
                borderRadius: 26,
                backgroundColor: palette().glassBg,
                borderWidth: 1,
                borderColor: palette().glassBorder,
                paddingLeft: 14,
                paddingRight: 6,
                paddingVertical: 6,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Input
                accessibilityLabel="Chat composer input"
                value={composerDraft()}
                onChange={({ value }: { value: string }) => composerDraft.set(value)}
                placeholder={
                  activeSession()?.kind === 'room'
                    ? '在 Room 中发言，或 @ 提及 Agent…'
                    : activeRunId() !== null && defaultDelivery() === 'queue'
                      ? '输入消息（排队发送）…'
                      : '发送消息，或开始一项任务…'
                }
                style={{
                  flex: 1,
                  minHeight: 36,
                  color: palette().ink,
                  fontSize: 15,
                }}
              />

              <If when={activeRunId() !== null}>
                <View
                  role="button"
                  accessibilityLabel="Stop active run"
                  onPress={() => {
                    const sess = activeSession();
                    const active = hostState().active;
                    const runId = activeRunId();
                    if (sess && active && runId) {
                      const gen = hostSyncGen;
                      const epoch = active.epoch;
                      const sGen = sessionSyncGen;
                      const sessionId = sess.id;
                      agentStop(sessionId, runId).then(
                        (res) => {
                          if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
                          if (res && res.requested === false) {
                            statusBanner.set('当前运行已结束或不支持中断');
                          }
                          refreshSessionTranscript(sessionId, false, gen, epoch, sGen);
                        },
                        (err: Error) => {
                          if (isSessionStillCurrent(gen, epoch, sGen, sessionId)) {
                            statusBanner.set('停止失败: ' + err.message);
                          }
                        },
                      );
                    }
                  }}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    backgroundColor: palette().dangerSoft,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '700', color: palette().danger }}>
                    ■
                  </Text>
                </View>
              </If>

              <View
                role="button"
                accessibilityLabel="Send message"
                onPress={() => sendMessage()}
                style={{
                  minWidth: 36,
                  height: 36,
                  paddingHorizontal: 12,
                  borderRadius: 18,
                  backgroundColor:
                    composerDraft().trim().length > 0 && !creatingDraft()
                      ? palette().primaryBg
                      : palette().surface2,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: '700',
                    color:
                      composerDraft().trim().length > 0 && !creatingDraft()
                        ? palette().primaryText
                        : palette().ink3,
                  }}
                >
                  ↑
                </Text>
              </View>
            </View>
          </View>

          <If when={drawerOpen()}>
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                flexDirection: 'row',
              }}
            >
              <View
                style={{
                  width: '78%',
                  height: '100%',
                  backgroundColor: palette().drawerBg,
                  borderRightWidth: 1,
                  borderRightColor: palette().line,
                }}
              >
                <DrawerHome {...drawerProps} onCloseDrawer={() => drawerOpen.set(false)} />
              </View>

              <View
                role="button"
                accessibilityLabel="Close drawer backdrop"
                onPress={() => drawerOpen.set(false)}
                style={{
                  flex: 1,
                  height: '100%',
                  backgroundColor: palette().scrim,
                }}
              />
            </View>
          </If>
        </View>
      </If>

      <If when={route() === 'pairing'}>
        <PairingOverlay
          ticketUri={ticketUri}
          onChangeUri={(v) => ticketUri.set(v)}
          parsedTicket={parsedTicket}
          pairingError={pairingError}
          busy={busy}
          onParse={() => runParseTicket()}
          onConfirm={runPairConfirm}
          onBack={() => route.set(hostState().active ? 'chat' : 'home')}
        />
      </If>

      <If when={route() === 'diff'}>
        <DiffOverlay
          title={diffTitle}
          lines={diffLines}
          truncatedNotice={diffTruncatedNotice}
          onQuoteLine={(line) => {
            const shortFile = line.file.split('/').pop() ?? line.file;
            quotedLine.set(shortFile + ':' + line.num + ' ' + line.text.trim());
            route.set('chat');
          }}
          onBack={() => route.set('chat')}
        />
      </If>

      <If when={route() === 'automations'}>
        <AutomationsOverlay
          schedules={schedules}
          loading={schedulesLoading}
          onRefresh={runOpenAutomations}
          onBack={() => route.set(hostState().active ? 'chat' : 'home')}
        />
      </If>

      <If when={route() === 'new_room'}>
        <NewRoomOverlay
          projects={projects}
          roots={directoryRoots}
          defaultWorkspace={() => draftWorkspace() ?? defaultDraftWorkspace()}
          busy={busy}
          onCreateRoom={(title, workspace) => {
            const active = hostState().active;
            if (!active) return;
            const gen = hostSyncGen;
            const epoch = active.epoch;
            busy.set(true);
            agentCreateSession({
              title,
              kind: 'room',
              workspace,
              automaticTitle: false,
            }).then(
              (created) => {
                busy.set(false);
                if (!isHostStillCurrent(gen, epoch)) return;
                upsertSessionInList(created);
                openAgentSession(created);
              },
              (err: Error) => {
                busy.set(false);
                if (isHostStillCurrent(gen, epoch)) {
                  statusBanner.set('创建 Room 失败: ' + err.message);
                }
              },
            );
          }}
          onBack={() => route.set(hostState().active ? 'chat' : 'home')}
        />
      </If>

      <If when={route() === 'workspace_picker'}>
        <WorkspacePickerOverlay
          projects={projects}
          roots={directoryRoots}
          onSelect={(selection, label) => {
            draftWorkspace.set({ selection, label });
            route.set('chat');
          }}
          onBack={() => route.set('chat')}
        />
      </If>

      <If when={route() === 'model_picker'}>
        <ModelPickerOverlay
          choices={modelChoices}
          loading={modelsLoading}
          currentBackend={currentBackend}
          onSearch={(q) => runLoadModels(q)}
          onSelect={runSelectBackend}
          onBack={() => route.set('chat')}
        />
      </If>

      <If when={route() === 'settings'}>
        <SettingsOverlay
          hostState={hostState}
          defaultDelivery={defaultDelivery}
          onToggleDelivery={() =>
            defaultDelivery.set(defaultDelivery() === 'steer' ? 'queue' : 'steer')
          }
          onConnectHost={runConnectSaved}
          onDisconnect={() => {
            disconnectHost().then(
              (snap) => {
                hostState.set(snap);
                syncConnectedAgentHost(snap);
                statusBanner.set('已断开远端 Host');
              },
              (err: Error) => statusBanner.set(err.message),
            );
          }}
          onRemoveHost={(rootId) => {
            removeHost(rootId).then(
              (snap) => {
                hostState.set(snap);
                syncConnectedAgentHost(snap);
                statusBanner.set('已移除电脑');
              },
              (err: Error) => statusBanner.set(err.message),
            );
          }}
          onOpenPairing={() => route.set('pairing')}
          onBack={() => route.set(hostState().active ? 'chat' : 'home')}
        />
      </If>
    </View>
  );
}

mount(App);
