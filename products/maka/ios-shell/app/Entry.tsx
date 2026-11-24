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

import { copy } from './copy';
import { describeChildDecision, describePermissions } from './approval';
import {
  cleanup,
  Clipboard,
  LayoutAnimation,
  reduceMotion,
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
import { ContextMenu, Input, Menu } from 'nsh/base';
import { Haptics } from 'nsh/mobile';
import { PairingOverlay } from './Pairing';
import { Action, Command, Feedback, Panel, confirmDestructive, glass } from './ui';
import { installTheme, motion } from './theme';
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
  agentSetRoomReaction,
  agentSend,
  agentStop,
  agentUpdateMetadata,
  bootstrap,
  beginPairing,
  cancelPairing,
  confirmPairing,
  hostQuery,
  pathLabel,
  connectHost,
  disconnectHost,
  hasAgentEndpoint,
  onHostState,
  setAnchorSession,
  onOperationRecovery,
  onSubscriptionEnded,
  onSubscriptionItem,
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
  parseUnifiedWorkspacePatch,
  SettingsOverlay,
  WorkspacePickerOverlay,
  type DiffLineItem,
} from './Overlays';
import { ReactionPickerBar, ReactionPillsRow, type ReactionEntry } from './Reactions';
import {
  LivePreviewAccumulator,
  type LivePreviewSnapshot,
  type LiveToolPreview,
} from './streaming';
import { token } from 'nsh';
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
  sourceMessageId?: string | null;
  author?: string;
  text: string;
  turnSummary?: string;
  steps?: TurnStepItem[];
  reactions?: ReactionEntry[];
}

function formatBackendPill(backend: AgentBackendPreference | null | undefined): string {
  if (!backend) return copy('Default model', '默认模型', '預設模型');
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

function historyRowKey({ position: p, field }: AgentHistoryChunk): string {
  switch (p.kind) {
    case 'live':
      return JSON.stringify([p.kind, p.sequence, p.fact, p.itemIndex, field]);
    case 'snapshot':
      return JSON.stringify([p.kind, p.path, p.snapshot, p.sequence, p.fact, p.itemIndex, field]);
    case 'imported':
      return JSON.stringify([p.kind, p.path, p.snapshot, p.messageOrdinal, p.partOrdinal, field]);
  }
}

function compareHistoryRows(first: AgentHistoryChunk, second: AgentHistoryChunk): number {
  const left = first.order;
  const right = second.order;
  for (let i = 0; i < Math.min(left.path.length, right.path.length); i++) {
    const order = left.path[i] - right.path[i];
    if (order !== 0) return order;
  }
  return (
    left.path.length - right.path.length ||
    left.itemIndex - right.itemIndex ||
    Number(first.field === 'body') - Number(second.field === 'body')
  );
}

function mergeHistoryChunks(
  previous: AgentHistoryChunk[],
  fresh: AgentHistoryChunk[],
): AgentHistoryChunk[] {
  const byFragment = new Map<string, AgentHistoryChunk>();
  for (const chunk of [...previous, ...fresh]) {
    const key = historyRowKey(chunk) + ':' + chunk.offset;
    const prior = byFragment.get(key);
    if (!prior || chunk.text.length >= prior.text.length) byFragment.set(key, chunk);
  }
  return [...byFragment.values()];
}

function historyRows(chunks: AgentHistoryChunk[]): AgentHistoryChunk[] {
  const rows = new Map<string, Map<number, AgentHistoryChunk>>();
  for (const chunk of chunks) {
    const key = historyRowKey(chunk);
    let fragments = rows.get(key);
    if (!fragments) {
      fragments = new Map();
      rows.set(key, fragments);
    }
    const previous = fragments.get(chunk.offset);
    if (!previous || chunk.text.length >= previous.text.length) fragments.set(chunk.offset, chunk);
  }
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return Array.from(rows.values(), (fragments) => {
    const ordered = [...fragments.values()].sort((first, second) => first.offset - second.offset);
    if (ordered.length === 1) return ordered[0];
    let end = 0;
    const text = ordered
      .map((chunk) => {
        const bytes = encoder.encode(chunk.text);
        const overlap = Math.max(0, end - chunk.offset);
        end = Math.max(end, chunk.offset + bytes.length);
        return overlap === 0 ? chunk.text : decoder.decode(bytes.subarray(overlap));
      })
      .join('');
    return { ...ordered[0], text };
  }).sort(compareHistoryRows);
}

function mapHistoryPageToMessages(
  page: AgentHistoryPage,
  knownSessions: AgentSession[] = [],
): ChatMessage[] {
  if (page.kind === 'room') {
    return page.page.items.map((item: AgentRoomMessage) => {
      const reactions =
        item.deletedAt === undefined
          ? item.reactions.map((reaction) => ({
              emoji: reaction.emoji,
              count: reaction.actors.length,
              mine: reaction.actors.some((actor) => actor.kind === 'human'),
            }))
          : undefined;
      if (item.author.kind === 'human') {
        return {
          id: item.id,
          sourceMessageId: item.id,
          role: 'user',
          author: '你',
          text: item.content.text,
          reactions,
        };
      }
      const sessionId = item.author.execution.sessionId;
      const authorLabel = knownSessions.find((s) => s.id === sessionId)?.title ?? sessionId;
      return {
        id: item.id,
        sourceMessageId: item.id,
        role: 'agent',
        author: authorLabel,
        text: item.content.text,
        reactions,
      };
    });
  }

  const chunks = historyRows(page.chunks);
  const out: ChatMessage[] = [];
  let pendingSteps: TurnStepItem[] = [];
  let stepCounter = 0;

  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i];
    const id = 'chunk-' + historyRowKey(ch);
    const role = (ch.role ?? '').toLowerCase();

    if (role === 'user') {
      if (ch.text.trim().length > 0) {
        out.push({
          id,
          sourceMessageId: ch.messageId,
          role: 'user',
          text: ch.text,
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
        sourceMessageId: ch.messageId,
        role: 'agent',
        author: 'Maka',
        text: ch.text,
        turnSummary: steps ? '执行过程 · ' + String(steps.length) + ' 步' : undefined,
        steps,
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
      const grantDetails = describePermissions(req.request.permissions);
      const cmd = req.request.command?.command ?? req.request.reason;
      const cwd = req.request.command?.cwd ? ' · ' + req.request.command.cwd : '';
      permissions.push({
        id: rec.requestId,
        requestId: rec.requestId,
        interactionKind: 'permissions',
        mode: 'permissions',
        canAllowOnce: req.toolUseId !== null && req.toolUseId !== undefined,
        title: copy(
          'Additional workspace permissions requested',
          '请求工作区额外权限',
          '要求額外工作區權限',
        ),
        subtitle: req.request.reason + cwd,
        command:
          cmd +
          '\n' +
          (grantDetails ??
            copy(
              'This permission shape must be reviewed on Desktop.',
              '请在桌面端审核这项权限。',
              '請在桌面端審核這項權限。',
            )),
        allowBlocked: grantDetails === null,
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
        title: copy(
          `Allow control of ${req.display.name}?`,
          `允许控制桌面应用 ${req.display.name}？`,
          `允許控制桌面應用程式 ${req.display.name}？`,
        ),
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
        title: copy(
          `Allow service call ${req.toolName}?`,
          `允许调用服务 ${req.toolName}？`,
          `允許呼叫服務 ${req.toolName}？`,
        ),
        subtitle: req.service + '.' + req.method,
        command: req.binding + ' → ' + req.service + '.' + req.method,
      });
      continue;
    }

    if (req.kind === 'session_approval') {
      const decision = describeChildDecision(req.answer);
      permissions.push({
        id: rec.requestId,
        requestId: rec.requestId,
        interactionKind: 'session_approval',
        mode: 'binary',
        title: copy(
          'Allow this child conversation decision?',
          '允许子会话审批决策？',
          '允許這項子對話的審批決定？',
        ),
        subtitle: copy('Child conversation ', '子会话 ', '子對話 ') + req.sessionId,
        command:
          copy('Request ', '请求 ', '要求 ') +
          req.requestId +
          '\n' +
          (decision ??
            copy(
              'Review this decision on Desktop.',
              '请在桌面端审核此决定。',
              '請在桌面端審核此決定。',
            )) +
          '\n' +
          JSON.stringify(req.answer, null, 2) +
          '\n' +
          JSON.stringify(req.basis, null, 2),
        allowBlocked: decision === null,
      });
      continue;
    }

    if (req.kind === 'client_capability') {
      permissions.push({
        id: rec.requestId,
        requestId: rec.requestId,
        interactionKind: 'client_capability',
        mode: 'binary',
        title: copy(
          'Allow access to the client capability?',
          '允许访问客户端能力？',
          '允許存取用戶端功能？',
        ),
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
      title:
        req.kind === 'system_permission'
          ? copy('Desktop system permission required', '需要桌面端系统权限', '需要桌面端系統權限')
          : copy('Complete this form on Desktop', '需在桌面端完成表单', '請在桌面端完成表單'),
      subtitle: copy(
        'This request cannot be submitted on mobile',
        '移动端暂不直接提交此类请求',
        '無法在行動裝置上提交這項要求',
      ),
      command: detail,
      unsupportedNotice:
        req.kind === 'system_permission'
          ? copy(
              'Grant system permission on Desktop, or stop waiting here',
              '系统授权需在桌面端完成，或在此取消等待',
              '請在桌面端授予系統權限，或在此取消等待',
            )
          : copy(
              `Review this request (${req.kind}) in Maka Desktop`,
              `请在桌面端 Maka 处理此请求（${req.kind}）`,
              `請在桌面端 Maka 審核這項要求（${req.kind}）`,
            ),
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
  if (card.mode === 'unsupported' || (card.allowBlocked && action !== 'deny')) return null;

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
    revision: 0,
    devicePeerId: '',
    filter: { kind: 'all_computers' },
    hosts: [],
    active: null,
  });
  const applyHostState = (snap: HostStateSnapshot): boolean => {
    if (snap.revision <= hostState().revision) return false;
    setAnchorSession(snap.active?.session);
    hostState.set(snap);
    return true;
  };
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
  const messages = signal<ChatMessage[]>([]);
  let historyWindow: AgentHistoryPage | null = null;
  let historyExpanded = false;
  const historyBefore = signal<unknown | null>(null);
  const historyThrough = signal<number | null>(null);
  const loadingEarlier = signal(false);
  const permissions = signal<PermissionCardItem[]>([]);
  const questions = signal<QuestionCardItem[]>([]);
  const activeReactionMsgId = signal<string | null>(null);
  const reactionPending = signal(false);
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
  const diffTitle = signal(copy('Workspace changes', '工作区变更', '工作區變更'));
  const diffLines = signal<DiffLineItem[]>([]);
  const diffTruncatedNotice = signal<string | null>(null);
  const activeTurnId = signal<string | null>(null);

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
    gen === hostSyncGen && hostState().active?.session === epoch;

  const isSessionStillCurrent = (gen: number, epoch: string, sGen: number, sessionId: string) =>
    isHostStillCurrent(gen, epoch) && sGen === sessionSyncGen && activeSession()?.id === sessionId;

  const stopWatchSubscription = (clearError = true) => {
    queueFresh.set(false);
    queueReview.set(null);
    if (clearError) watchError.set(null);
    if (watchSub) {
      const id = watchSub.subscriptionId;
      watchSub = null;
      unsubscribe(id).catch((err) => console.warn('unsubscribe:', err));
    }
  };

  const stopGoalSubscription = () => {
    if (goalSub) {
      const id = goalSub.subscriptionId;
      goalSub = null;
      unsubscribe(id).catch((err) => console.warn('unsubscribe:', err));
    }
  };

  const stopCatalogSubscription = (clearError = true) => {
    if (clearError) catalogError.set(null);
    if (catalogSub) {
      const id = catalogSub.subscriptionId;
      catalogSub = null;
      unsubscribe(id).catch((err) => console.warn('unsubscribe:', err));
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
    return {
      selection: { kind: 'directory', path: '~' },
      label: copy('Default workspace', '默认工作区', '預設工作區'),
    };
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
    const msgId = sess.tailMessageId ?? mapped[mapped.length - 1]?.sourceMessageId;
    if (!msgId) return;
    agentMarkRead(sess.id, msgId).then(
      (res) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sess.id)) return;
        if (res.kind === 'observed' && res.session) {
          upsertSessionInList(res.session);
        }
      },
      (err) => console.warn('Host sync:', err),
    );
  };

  const loadSessionInteractions = (
    sessionId: string,
    gen: number,
    anchorSession: string,
    sGen: number,
  ) => {
    agentPendingInteractions(sessionId).then(
      async (pending) => {
        if (!isSessionStillCurrent(gen, anchorSession, sGen, sessionId)) return;
        const records: AgentInteractionRecord[] = [];
        for (const entry of pending.entries ?? []) {
          if (!isSessionStillCurrent(gen, anchorSession, sGen, sessionId)) return;
          try {
            const rec = await agentReadInteraction(sessionId, entry.requestId, anchorSession);
            if (rec) records.push(rec);
          } catch (err) {
            if (isSessionStillCurrent(gen, anchorSession, sGen, sessionId))
              console.warn('Read interaction:', err);
          }
        }
        if (!isSessionStillCurrent(gen, anchorSession, sGen, sessionId)) return;
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
      (err) => console.warn('Host sync:', err),
    );
  };

  const applyHistory = (page: AgentHistoryPage, position: 'tail' | 'earlier' | 'around') => {
    const keepWindow = position !== 'tail' || historyExpanded || loadingEarlier();
    if (keepWindow && historyWindow?.kind === 'ready' && page.kind === 'ready') {
      historyWindow = { ...page, chunks: mergeHistoryChunks(historyWindow.chunks, page.chunks) };
    } else if (keepWindow && historyWindow?.kind === 'room' && page.kind === 'room') {
      const items = new Map(historyWindow.page.items.map((item) => [item.id, item]));
      for (const item of page.page.items) {
        if (position !== 'earlier' || !items.has(item.id)) items.set(item.id, item);
      }
      historyWindow = {
        ...page,
        page: { ...page.page, items: [...items.values()].sort((a, b) => a.sequence - b.sequence) },
      };
    } else {
      historyWindow = page;
    }
    // A before cursor stays tied to the cut that produced it, not the latest tail.
    const before = page.kind === 'ready' ? page.before : page.page.before;
    if (position === 'earlier') {
      historyExpanded = true;
      historyBefore.set(before ?? null);
    } else if (!keepWindow) {
      historyBefore.set(before ?? null);
      historyThrough.set(page.kind === 'ready' ? page.through : page.page.through);
    }
    const mapped = mapHistoryPageToMessages(historyWindow, sessions());
    messages.set(
      position === 'tail'
        ? mapped
        : [...mapped, ...messages().filter((message) => message.id.startsWith('optimistic-'))],
    );
    return mapped;
  };

  const refreshSessionTranscript = (
    sessionId: string,
    clearStream = false,
    gen = hostSyncGen,
    epoch = hostState().active?.session ?? '',
    sGen = sessionSyncGen,
  ) => {
    const streamGenAtStart = streamGen;
    agentObserve(sessionId).then(
      (obs) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
        activeSession.set(obs.session);
        activeRunId.set(obs.run?.runId ?? null);
      },
      (err) => console.warn('Host sync:', err),
    );
    agentHistory(sessionId).then(
      (page) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
        const mapped = applyHistory(page, 'tail');
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
    const epoch = active.session;
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
        applyHistory(page, 'earlier');
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
          unsubscribe(handle.subscriptionId).catch((err) => console.warn('unsubscribe:', err));
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
      (err) => console.warn('Host sync:', err),
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
          unsubscribe(handle.subscriptionId).catch((err) => console.warn('unsubscribe:', err));
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
          unsubscribe(handle.subscriptionId).catch((err) => console.warn('unsubscribe:', err));
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
    epoch = hostState().active?.session ?? '',
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

  let resume: { rootId: string; session: AgentSession; after: number } | null = null;
  const reconnectHost = signal<string | null>(null);

  const resetHistoryPagination = () => {
    historyWindow = null;
    historyExpanded = false;
    activeReactionMsgId.set(null);
    reactionPending.set(false);
    historyBefore.set(null);
    historyThrough.set(null);
    loadingEarlier.set(false);
  };

  const openAgentSession = (session: AgentSession, after?: number) => {
    const active = hostState().active;
    if (!active) return;
    const gen = hostSyncGen;
    const epoch = active.session;
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
    watchCursor = after ?? 0;
    streamingThinkingExpanded.set(true);
    resetLivePreview();
    resetQueue();
    messages.set([]);
    resetHistoryPagination();
    permissions.set([]);
    questions.set([]);
    drawerOpen.set(false);
    route.set('chat');

    agentObserve(session.id).then(
      (obs) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, session.id)) return;
        activeSession.set(obs.session);
        activeRunId.set(obs.run?.runId ?? null);
        watchCursor = after ?? obs.through ?? 0;
        startWatchSubscription(session.id, watchCursor, gen, epoch, sGen);
      },
      (err: Error) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, session.id)) return;
        statusBanner.set('观察会话状态失败: ' + err.message);
        startWatchSubscription(session.id, watchCursor, gen, epoch, sGen);
      },
    );

    agentHistory(session.id).then(
      (page) => {
        if (!isSessionStillCurrent(gen, epoch, sGen, session.id)) return;
        const mapped = applyHistory(page, 'tail');
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
    resetHistoryPagination();
    permissions.set([]);
    questions.set([]);
    draftWorkspace.set(workspace ?? defaultDraftWorkspace());
    switchDraftPartition(draftKeyFor(active.rootId, null));
    drawerOpen.set(false);
    route.set('chat');
  };

  const syncConnectedAgentHost = (snap: HostStateSnapshot) => {
    const active = snap.active;
    if (lastHostEpoch === (active?.session ?? null)) return;
    draftBackend.set(null);
    modelChoices.set([]);
    modelsLoading.set(false);
    schedules.set([]);
    schedulesLoading.set(false);
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
      activeRunId.set(null);
      activeGoal.set(null);
      resetQueue();
      resetLivePreview();
      resetHistoryPagination();
      messages.set([]);
      permissions.set([]);
      questions.set([]);
      diffLines.set([]);
      diffTruncatedNotice.set(null);

      return;
    }
    lastHostEpoch = active.session;
    hostSyncGen += 1;
    catalogQueryGen += 1;
    loadingMoreSessions = false;
    goalWatchReceived = false;
    sessionSyncGen += 1;
    const gen = hostSyncGen;
    const epoch = active.session;

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

    resetHistoryPagination();
    messages.set([]);
    permissions.set([]);
    questions.set([]);
    diffLines.set([]);
    diffTruncatedNotice.set(null);

    if (!hasAgentEndpoint(active)) {
      return;
    }

    agentListProjects().then(
      (list) => {
        if (!isHostStillCurrent(gen, epoch)) return;
        projects.set(list);
      },
      (err) => console.warn('Host sync:', err),
    );
    agentListDirectoryRoots().then(
      (roots) => {
        if (!isHostStillCurrent(gen, epoch)) return;
        directoryRoots.set(roots);
      },
      (err) => console.warn('Host sync:', err),
    );
    if (resume?.rootId === active.rootId) {
      const { session, after } = resume;
      resume = null;
      openAgentSession(session, after);
    }
    reconnectHost.set(null);
    reloadCatalog('all', '', gen, epoch);
  };

  let pairGeneration = 0;
  const cancelPendingPairing = () => {
    pairGeneration++;
    parsedTicket.set(null);
    busy.set(false);
    cancelPairing().catch((err) => statusBanner.set(String(err)));
  };

  const runParseTicket = (relayUrl?: string, relayToken?: string) => {
    const uri = ticketUri().trim();
    if (!uri || busy()) return;
    const generation = ++pairGeneration;
    pairingError.set(null);
    busy.set(true);
    beginPairing(uri, relayUrl, relayToken).then(
      (info) => {
        if (generation !== pairGeneration) return;
        parsedTicket.set(info);
        busy.set(false);
      },
      (err: Error) => {
        if (generation !== pairGeneration) return;
        Haptics.notification('error');
        pairingError.set(err.message);
        busy.set(false);
      },
    );
  };

  const openIncomingPairUri = (uri: string) => {
    const trimmed = uri.trim();
    if (!trimmed.startsWith('maka://pair/v1?payload=')) return;
    if (route() === 'pairing' && ticketUri() === trimmed) return;
    if (route() === 'pairing') cancelPendingPairing();
    ticketUri.set(trimmed);
    pairingError.set(null);
    drawerOpen.set(false);
    route.set('pairing');
  };

  const refreshBootstrap = () => {
    bootstrap().then(
      (snap) => {
        if (applyHostState(snap)) {
          statusBanner.set(null);
          syncConnectedAgentHost(snap);
        }
        if (snap.pendingPairUri) {
          openIncomingPairUri(snap.pendingPairUri);
        }
      },
      (err: Error) => statusBanner.set(err.message),
    );
  };

  refreshBootstrap();

  const offState = onHostState((snap) => {
    if (!applyHostState(snap)) return;
    if (snap.disconnectReason && snap.disconnectedRootId) {
      const session = activeSession();
      if (session) resume = { rootId: snap.disconnectedRootId, session, after: watchCursor };
      const revoked = snap.disconnectReason.includes('peer access revoked');
      reconnectHost.set(
        !revoked && snap.hosts.some((item) => item.rootId === snap.disconnectedRootId)
          ? snap.disconnectedRootId
          : null,
      );
      Haptics.notification('warning');
      statusBanner.set(snap.disconnectReason);
    }
    syncConnectedAgentHost(snap);
  });
  const recoveryStatus = signal<{ session: string; settled: number; pending: number } | null>(null);
  const offRecovery = onOperationRecovery(recoveryStatus.set);
  const receiptMessage = () => {
    const status = recoveryStatus();
    if (!status || hostState().active?.session !== status.session) return null;
    return status.pending > 0
      ? `已查到 ${status.settled} 项操作结果，${status.pending} 项尚未确认。不会自动重发。`
      : `已查到 ${status.settled} 项操作结果。请查看同步后的会话。`;
  };
  const launchUri = UrlScheme.url();
  if (launchUri) openIncomingPairUri(launchUri);
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
      const consumedThrough = watchCursor;
      let needRefresh = false;
      let clearStreamOnRefresh = false;
      for (const delivery of page.events) {
        if (delivery.sequence <= consumedThrough) continue;
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
      watchCursor = Math.max(consumedThrough, page.nextAfter);
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
    offRecovery();
    offScheme();
    offSubItem();
    offSubEnd();
  });

  const finishConnection = (state: HostStateSnapshot) => {
    if (route() !== 'pairing') return;
    if (!applyHostState(state) && hostState().active?.session !== state.active?.session) return;
    busy.set(false);
    ticketUri.set('');
    parsedTicket.set(null);
    route.set('chat');
    syncConnectedAgentHost(hostState());
  };

  const closePairing = () => {
    cancelPendingPairing();
    ticketUri.set('');
    pairingError.set(null);
    route.set(hostState().active ? 'chat' : 'home');
  };

  const runPairConfirm = () => {
    const info = parsedTicket();
    if (!info || busy()) return;
    const generation = ++pairGeneration;
    Haptics.impact('light');
    busy.set(true);
    pairingError.set(null);
    confirmPairing(info.pairingId, info.sasCode).then(
      (state) => {
        if (generation !== pairGeneration) return;
        Haptics.notification('success');
        finishConnection(state);
      },
      (err: Error) => {
        if (generation !== pairGeneration) return;
        Haptics.notification('error');
        pairingError.set(err.message);
        parsedTicket.set(null);
        busy.set(false);
      },
    );
  };

  let savedConnectionGeneration = 0;
  const connectingSavedHost = signal(false);
  const cancelSavedConnection = () => {
    if (!connectingSavedHost()) return;
    savedConnectionGeneration++;
    connectingSavedHost.set(false);
    busy.set(false);
    cancelPairing().catch((err) => statusBanner.set(String(err)));
  };
  const relayHost = signal<SavedHostItem | null>(null);
  const savedRelayUrl = signal('');
  const savedRelayToken = signal('');
  const openRelayPrompt = (host: SavedHostItem) => {
    savedRelayUrl.set(host.relayUrls?.[0] ?? '');
    savedRelayToken.set('');
    relayHost.set(host);
  };
  const closeRelayPrompt = () => {
    cancelSavedConnection();
    relayHost.set(null);
    savedRelayToken.set('');
  };
  const runConnectSaved = (hostItem: SavedHostItem, relayUrl?: string, relayToken?: string) => {
    const generation = ++savedConnectionGeneration;
    connectingSavedHost.set(true);
    busy.set(true);
    statusBanner.set(null);
    connectHost(hostItem.rootId, relayUrl, relayToken).then(
      (snap) => {
        if (generation !== savedConnectionGeneration) return;
        connectingSavedHost.set(false);
        const applied = applyHostState(snap);
        busy.set(false);
        closeRelayPrompt();
        if (!applied) return;
        syncConnectedAgentHost(snap);
        if (!hasAgentEndpoint(snap.active)) {
          drawerOpen.set(false);
          route.set('chat');
        }
      },
      (err: Error) => {
        if (generation !== savedConnectionGeneration) return;
        connectingSavedHost.set(false);
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
        if (!applyHostState(s)) return;
        syncConnectedAgentHost(s);
        statusBanner.set(null);
      },
      (err: Error) => statusBanner.set(err.message),
    );
  };

  const runRenameSession = (sess: AgentSession, nextTitle: string) => {
    const active = hostState().active;
    if (!active) return;
    const gen = hostSyncGen;
    const epoch = active.session;
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
    const epoch = active.session;
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
    const epoch = active.session;
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
    const epoch = active.session;
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
    const epoch = active.session;
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
    const epoch = active.session;
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
          (err) => console.warn('Host sync:', err),
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
      const epoch = active.session;
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
      startCatalogSubscription(hostSyncGen, active.session);
    }
    const sess = activeSession();
    if (watchError() !== null && sess && !watchSub) {
      startWatchSubscription(sess.id, watchCursor, hostSyncGen, active.session, sessionSyncGen);
    }
  };

  const runVerifyLiveRpc = () => {
    const active = hostState().active;
    if (!active) {
      statusBanner.set('尚未连接远端 Host');
      return;
    }
    const gen = hostSyncGen;
    const epoch = active.session;
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
    hostQuery(targetEndpoint, 'read', { position: { kind: 'tail' } }).then(
      () => {
        busy.set(false);
        if (!isHostStillCurrent(gen, epoch)) return;
        statusBanner.set(copy('Host responded', '已收到 Host 响应', '已收到 Host 回應'));
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
      const epoch = active.session;
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
    statusBanner.set('先打开一个会话，再查看工作区变更。');
  };

  const runOpenAutomations = () => {
    drawerOpen.set(false);
    route.set('automations');
    const active = hostState().active;
    if (active && hasAgentEndpoint(active)) {
      const gen = hostSyncGen;
      const epoch = active.session;
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

  const toggleReaction = async (message: ChatMessage, emoji: string) => {
    const session = activeSession();
    const anchorSession = hostState().active?.session;
    if (session?.kind !== 'room' || !anchorSession || !message.reactions || reactionPending())
      return;
    const gen = hostSyncGen;
    const sGen = sessionSyncGen;
    const current = () => isSessionStillCurrent(gen, anchorSession, sGen, session.id);
    const add = !message.reactions.some((reaction) => reaction.emoji === emoji && reaction.mine);
    reactionPending.set(true);
    activeReactionMsgId.set(null);
    try {
      const result = await agentSetRoomReaction(session.id, message.id, emoji, add);
      if (!current()) return;
      if (result.kind !== 'reaction_updated')
        throw new Error('Host did not return a Room reaction result');
      const page = await agentHistory(session.id, {
        position: { kind: 'around_message', messageId: message.id },
      });
      if (current()) applyHistory(page, 'around');
    } catch (err) {
      if (current())
        statusBanner.set(
          copy('Could not update reaction: ', '无法更新回应：', '無法更新回應：') + String(err),
        );
    } finally {
      if (current()) reactionPending.set(false);
    }
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
      epoch = active.session,
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
      epoch = active.session,
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
      const epoch = active.session;
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
          },
        ]);
        if (!isRoom) {
          awaitingReply.set(true);
        }
        Haptics.impact('light');
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
              statusBanner.set(
                '未收到发送结果。请先查看同步后的会话，再决定是否重发：' + err.message,
              );
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

    statusBanner.set('连接支持 Agent 的 Host 后再发送。');
  };

  const resolvePermission = (card: PermissionCardItem, action: PermissionAction) => {
    const label =
      action === 'deny'
        ? copy('Denied', '已拒绝', '已拒絕')
        : action === 'cancel_system_permission'
          ? copy('Stopped waiting', '已取消等待', '已取消等待')
          : action === 'run'
            ? copy('Allowed for this turn', '已本轮允许', '已允許這個輪次')
            : action === 'session'
              ? copy('Allowed for this conversation', '已本会话允许', '已允許這段對話')
              : action === 'always'
                ? copy('Always allowed', '已始终允许', '已設為一律允許')
                : card.mode === 'binary'
                  ? copy('Allowed', '已允许', '已允許')
                  : copy('Allowed once', '已允许本次', '已允許這次');
    Haptics.impact('light');
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
        statusBanner.set(
          copy(
            'Required permission details are missing. Review this request on Desktop.',
            '当前交互请求缺少必需的原始权限字段，请在桌面端处理',
            '缺少必要的權限資訊。請在桌面端審核這項要求。',
          ),
        );
        return;
      }
      const gen = hostSyncGen;
      const epoch = active.session;
      const sGen = sessionSyncGen;
      const sessionId = sess.id;
      busy.set(true);
      agentRespondInteraction(sessionId, card.requestId, answer).then(
        (res) => {
          if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
          busy.set(false);
          if (res.kind !== 'recorded') {
            statusBanner.set(
              copy(
                'Host denied the approval response: ',
                '权限回复被 Host 拒绝：',
                '權限回覆遭 Host 拒絕：',
              ) +
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
          statusBanner.set(
            copy('Could not respond to approval: ', '权限回复失败：', '權限回覆失敗：') +
              err.message,
          );
        },
      );
      return;
    }

    statusBanner.set(
      copy(
        "This approval's Host session is no longer available.",
        '此审批的 Host 会话已不可用。',
        '這項審批的 Host 對話已無法使用。',
      ),
    );
  };

  const submitQuestion = (card: QuestionCardItem, answers: (string | null)[]) => {
    const sess = activeSession();
    const active = hostState().active;
    const markAnswered = () => {
      questions.set(questions().map((q) => (q.id === card.id ? { ...q, answered: answers } : q)));
    };

    if (sess && card.requestId && active && hasAgentEndpoint(active)) {
      const gen = hostSyncGen;
      const epoch = active.session;
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

    statusBanner.set('此提问的 Host 会话已不可用。');
  };

  const pendingCount = () =>
    permissions().filter((p) => !p.resolved && p.mode !== 'unsupported').length +
    questions().filter((q) => !q.answered).length;

  const chatTitle = () => {
    const sess = activeSession();
    if (sess) return (sess.kind === 'room' ? '# ' : '') + sess.title;
    if (hasAgentEndpoint(hostState().active)) return copy('New chat', '新对话', '新對話');
    return hostState().active?.hostName ?? 'Maka Bot';
  };

  const chatSubtitle = () => {
    const active = hostState().active;
    if (!active) return copy('Disconnected', '未连接', '未連線');
    if (creatingDraft()) return active.hostName + ' · 正在创建会话…';
    if (activeRunId()) return active.hostName + ' · 执行中';
    if (activeSession()) return active.hostName + ' · 实时同步';
    if (hasAgentEndpoint(active)) return active.hostName + ' · 草稿';
    return copy('Remote Host ready', '远端 Host 已就绪', '遠端 Host 已就緒');
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
      const epoch = active.session;
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
        backgroundColor: token('background'),
        paddingTop: topPad(),
      }}
    >
      <If when={route() === 'home' || (route() !== 'chat' && !hostState().active)}>
        <DrawerHome {...drawerProps} />
      </If>

      <If when={route() !== 'home' && (route() === 'chat' || !!hostState().active)}>
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
              borderBottomColor: token('border'),
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
                backgroundColor: token('hover'),
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 17, color: token('foreground') }}>☰</Text>
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
              <Text style={{ fontSize: 15.5, fontWeight: '600', color: token('foreground') }}>
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
                        ? token('working')
                        : token('success')
                      : token('subdued'),
                  }}
                />
                <Text style={{ fontSize: 11.5, color: token('muted-foreground') }}>
                  {chatSubtitle()}
                </Text>
                <If when={hostState().active}>
                  <Text class="text-xs text-muted-foreground">
                    {pathLabel(hostState().active?.pathSummary, hostState().active?.transport)}
                  </Text>
                </If>
              </View>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Menu
                popupClass="bg-card rounded-xl p-1"
                trigger={
                  <View
                    accessibilityLabel="Host actions"
                    style={glass}
                    class="min-h-11 px-3 justify-center"
                  >
                    <Text class="text-foreground">•••</Text>
                  </View>
                }
              >
                <Command
                  title={copy('Workspace changes', '工作区变更', '工作區變更')}
                  select={() => runOpenDiff()}
                />
                <Command
                  title={copy('Connection settings', '连接设置', '連線設定')}
                  select={() => route.set('settings')}
                />
                <If when={!!hostState().active && !hasAgentEndpoint(hostState().active)}>
                  <Command
                    title={copy('Check connection', '检查连接', '檢查連線')}
                    select={runVerifyLiveRpc}
                  />
                </If>
                <Command
                  title={copy('Copy device Peer ID', '复制设备 Peer ID', '複製裝置 Peer ID')}
                  select={() =>
                    Clipboard.writeText(hostState().devicePeerId).catch((err) =>
                      statusBanner.set(String(err)),
                    )
                  }
                />
              </Menu>

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
                    backgroundColor: token('hover'),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 12.5, color: token('muted-foreground') }}>
                    {copy('Retry', '重试', '重試')}
                  </Text>
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
                backgroundColor: token('card'),
                borderBottomWidth: 1,
                borderBottomColor: token('border'),
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
                  backgroundColor: token('muted'),
                  paddingHorizontal: 10,
                  color: token('foreground'),
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
                  backgroundColor: token('primary'),
                }}
              >
                <Text
                  style={{ fontSize: 12.5, fontWeight: '600', color: token('primary-foreground') }}
                >
                  {copy('Save', '保存', '儲存')}
                </Text>
              </View>
              <View
                role="button"
                accessibilityLabel="Cancel inline session rename"
                onPress={() => headerRenaming.set(false)}
                style={{ paddingHorizontal: 6, paddingVertical: 6 }}
              >
                <Text style={{ fontSize: 12.5, color: token('subdued') }}>
                  {copy('Cancel', '取消', '取消')}
                </Text>
              </View>
            </View>
          </If>

          <If when={reconnectHost()}>
            <Action
              title={copy('Reconnect', '重新连接', '重新連接')}
              disabled={busy()}
              onPress={() => {
                const item = hostState().hosts.find((host) => host.rootId === reconnectHost());
                if (item) runConnectSaved(item);
              }}
            />
          </If>

          <If when={catalogError() !== null}>
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 8,
                backgroundColor: token('accent-soft'),
              }}
            >
              <Text style={{ fontSize: 12.5, color: token('foreground') }}>{catalogError()}</Text>
            </View>
          </If>
          <If when={watchError() !== null}>
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 8,
                backgroundColor: token('accent-soft'),
              }}
            >
              <Text style={{ fontSize: 12.5, color: token('foreground') }}>{watchError()}</Text>
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
                      backgroundColor: token('card'),
                      borderWidth: 1,
                      borderColor: token('border'),
                    }}
                  >
                    <Text style={{ fontSize: 12.5, color: token('muted-foreground') }}>
                      {loadingEarlier()
                        ? copy(
                            'Loading earlier messages…',
                            '正在加载更早消息…',
                            '正在載入更早的訊息…',
                          )
                        : copy('Load earlier messages', '加载更早消息', '載入更早的訊息')}
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
                    <Text style={{ fontSize: 15.5, fontWeight: '600', color: token('foreground') }}>
                      {chatTitle()}
                    </Text>
                    <Text style={{ fontSize: 13, color: token('subdued') }}>
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
                            backgroundColor: token('user-bubble'),
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 15.5,
                              lineHeight: 22,
                              color: token('user-bubble-foreground'),
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
                                  backgroundColor: token('muted'),
                                  borderWidth: 1,
                                  borderColor: token('border'),
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                <Text
                                  style={{
                                    fontSize: 10,
                                    fontWeight: '700',
                                    color: token('foreground'),
                                  }}
                                >
                                  A
                                </Text>
                              </View>
                              <Text
                                style={{
                                  fontSize: 12.5,
                                  fontWeight: '600',
                                  color: token('muted-foreground'),
                                }}
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

                          <ContextMenu
                            items={[
                              {
                                id: 'copy',
                                label: copy('Copy message', '复制消息', '複製訊息'),
                                icon: 'doc.on.doc',
                              },
                            ]}
                            onSelect={() =>
                              Clipboard.writeText(msg().text).catch((err) =>
                                statusBanner.set(String(err)),
                              )
                            }
                            trigger={
                              <Text
                                class="text-foreground"
                                style={{ fontSize: 15.5, lineHeight: 23.5 }}
                              >
                                {msg().text}
                              </Text>
                            }
                          />
                        </View>
                      </If>

                      <If when={activeSession()?.kind === 'room' && msg().reactions !== undefined}>
                        <View
                          role="button"
                          accessibilityLabel={'Add reaction to ' + msg().id}
                          class="min-h-11 min-w-11 items-center justify-center"
                          onPress={() =>
                            activeReactionMsgId.set(
                              activeReactionMsgId() === msg().id ? null : msg().id,
                            )
                          }
                        >
                          <Text class="text-muted-foreground">☺</Text>
                        </View>
                        <If when={activeReactionMsgId() === msg().id}>
                          <ReactionPickerBar
                            onPick={(emoji) => void toggleReaction(msg(), emoji)}
                            onDismiss={() => activeReactionMsgId.set(null)}
                          />
                        </If>
                        <ReactionPillsRow
                          reactions={msg().reactions ?? []}
                          onToggle={(emoji) => void toggleReaction(msg(), emoji)}
                        />
                      </If>
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
                        backgroundColor: token('working'),
                      }}
                    />
                    <Text style={{ fontSize: 13, color: token('subdued') }}>Maka 正在思考…</Text>
                  </View>
                </If>

                <If when={streamingThinking().length > 0}>
                  <View
                    style={{
                      width: '100%',
                      borderRadius: 14,
                      backgroundColor: token('card'),
                      borderWidth: 1,
                      borderColor: token('border'),
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
                            backgroundColor: token('working'),
                          }}
                        />
                        <Text
                          style={{
                            fontSize: 12.5,
                            fontWeight: '600',
                            color: token('muted-foreground'),
                          }}
                        >
                          {streamingText().length > 0 ? '思考过程' : '正在思考…'}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 11.5, color: token('subdued') }}>
                        {streamingThinkingExpanded() ? '收起 ▾' : '展开 ▸'}
                      </Text>
                    </View>
                    <If when={streamingThinkingExpanded()}>
                      <Text
                        style={{ fontSize: 13, lineHeight: 19.5, color: token('muted-foreground') }}
                      >
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
                        backgroundColor: token('card'),
                        borderWidth: 1,
                        borderColor: token('border'),
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        gap: 3,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 12.5,
                          fontWeight: '600',
                          color: token('muted-foreground'),
                        }}
                      >
                        {'准备调用工具 · ' + tool().name}
                      </Text>
                      <If when={tool().inputPreview.length > 0}>
                        <Text style={{ fontSize: 12, color: token('subdued') }}>
                          {tool().inputPreview}
                        </Text>
                      </If>
                    </View>
                  )}
                </Each>

                <If when={streamingText().length > 0}>
                  <View style={{ width: '100%', gap: 4 }}>
                    <Text style={{ fontSize: 15.5, lineHeight: 23.5, color: token('foreground') }}>
                      {streamingText()}
                    </Text>
                    <If when={activeRunId() !== null}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <View
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            backgroundColor: token('working'),
                          }}
                        />
                        <Text style={{ fontSize: 11.5, color: token('subdued') }}>正在输出…</Text>
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

          {/* Docked Goal Status & Controls Bar (Desktop Parity) */}
          <GoalBar goal={activeGoal} busy={busy} onControl={runGoalControl} />

          <If when={queuedMessages().length > 0 || queueEdit() !== null}>
            <View
              style={{
                marginHorizontal: 14,
                marginBottom: 6,
                borderRadius: 13,
                backgroundColor: token('card'),
                borderWidth: 1,
                borderColor: token('border'),
              }}
            >
              <View
                role="button"
                accessibilityLabel="Open queued messages"
                onPress={() => {
                  if (!reduceMotion())
                    LayoutAnimation.configureNext(
                      LayoutAnimation.create(motion.layout, 'easeInEaseOut', 'opacity'),
                    );
                  queueOpen.set(!queueOpen());
                }}
                style={{ paddingHorizontal: 12, paddingVertical: 8 }}
              >
                <Text style={{ fontSize: 12, color: token('muted-foreground') }}>
                  {queuedMessages().length > 0
                    ? '已排队 ' + String(queuedMessages().length) + ' 条消息 ▾'
                    : '消息已不在队列 · 编辑保留 ▾'}
                </Text>
              </View>
              <If when={queueOpen()}>
                <Scroll style={{ maxHeight: 280 }}>
                  <Each of={queuedMessages()} key={(entry) => entry.messageId}>
                    {(entry) => {
                      const actions = () => [
                        {
                          id: 'edit',
                          label: copy('Edit', '编辑', '編輯'),
                          icon: 'pencil',
                          disabled: !queueFresh() || !!queueEdit() || !!queueBusy(),
                        },
                        {
                          id: 'up',
                          label: copy('Move up', '上移', '上移'),
                          icon: 'arrow.up',
                          disabled: !canMoveQueuedMessage(entry(), -1),
                        },
                        {
                          id: 'down',
                          label: copy('Move down', '下移', '下移'),
                          icon: 'arrow.down',
                          disabled: !canMoveQueuedMessage(entry(), 1),
                        },
                      ];
                      const select = (id: string) => {
                        if (id === 'edit') readQueuedMessage(entry().messageId, false);
                        if (id === 'up') moveQueuedMessage(entry(), -1);
                        if (id === 'down') moveQueuedMessage(entry(), 1);
                      };
                      return (
                        <View class="flex-row items-center border-t border-border pl-3">
                          <ContextMenu
                            items={actions()}
                            onSelect={({ id }) => select(id)}
                            trigger={
                              <View class="min-h-11 flex-1 justify-center">
                                <Text class="text-sm text-foreground">{entry().preview}</Text>
                              </View>
                            }
                          />
                          <Menu
                            popupClass="bg-card rounded-xl p-1"
                            trigger={
                              <View
                                accessibilityLabel={'Queued message actions ' + entry().messageId}
                                class="min-h-11 min-w-11 items-center justify-center"
                              >
                                <Text class="text-muted-foreground">•••</Text>
                              </View>
                            }
                          >
                            <Each
                              of={actions().filter((action) => !action.disabled)}
                              key={(action) => action.id}
                            >
                              {(action) => (
                                <Command
                                  title={action().label}
                                  select={() => select(action().id)}
                                />
                              )}
                            </Each>
                          </Menu>
                        </View>
                      );
                    }}
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
                          color: token('foreground'),
                          backgroundColor: token('muted'),
                        }}
                      />
                      <If
                        when={queueEdit()?.hasAttachments || (queueEdit()?.quotes.length ?? 0) > 0}
                      >
                        <Text style={{ color: token('muted-foreground') }}>附件与引用将保留</Text>
                      </If>
                      <If when={queueReview() !== null}>
                        <Text style={{ color: token('muted-foreground') }}>
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
                          <Text style={{ color: token('foreground') }}>
                            {copy('Save', '保存', '儲存')}
                          </Text>
                        </View>
                        <View
                          role="button"
                          accessibilityLabel="Review queued message"
                          onPress={() => {
                            const edit = queueEdit();
                            if (edit) readQueuedMessage(edit.messageId, true);
                          }}
                        >
                          <Text style={{ color: token('foreground') }}>查看当前版本</Text>
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
                            <Text style={{ color: token('foreground') }}>保留我的编辑</Text>
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
                          <Text style={{ color: token('foreground') }}>
                            {copy('Cancel', '取消', '取消')}
                          </Text>
                        </View>
                      </View>
                    </View>
                  </If>
                  <If when={queueError() !== null}>
                    <Text style={{ padding: 12, color: token('destructive') }}>{queueError()}</Text>
                  </If>
                  <If when={!queueFresh()}>
                    <Text style={{ padding: 12, color: token('muted-foreground') }}>
                      队列同步已中断，请重试后再修改。
                    </Text>
                  </If>
                  <If when={queueBusy() !== null}>
                    <Text style={{ padding: 12, color: token('muted-foreground') }}>
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
                backgroundColor: token('card'),
                borderWidth: 1,
                borderColor: token('border'),
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text style={{ flex: 1, fontSize: 12, color: token('muted-foreground') }}>
                {'引用: ' + (quotedLine() ?? '')}
              </Text>
              <View
                role="button"
                accessibilityLabel="Remove quote"
                onPress={() => quotedLine.set(null)}
                style={{ paddingLeft: 8 }}
              >
                <Text style={{ fontSize: 12, color: token('subdued') }}>✕</Text>
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
                    backgroundColor: token('card'),
                    borderWidth: 1,
                    borderColor: token('border'),
                  }}
                >
                  <Text style={{ fontSize: 12, color: token('muted-foreground') }}>
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
                  backgroundColor: token('card'),
                  borderWidth: 1,
                  borderColor: token('border'),
                }}
              >
                <Text style={{ fontSize: 12, color: token('muted-foreground') }}>
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
                ...glass,
                borderWidth: 1,
                borderColor: token('glass-border'),
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
                    ? copy(
                        'Message the Room or @mention an Agent…',
                        '在 Room 中发言，或 @ 提及 Agent…',
                        '在 Room 中發言或 @ 提及 Agent…',
                      )
                    : activeRunId() !== null && defaultDelivery() === 'queue'
                      ? copy('Queue a message…', '输入消息（排队发送）…', '將訊息排入佇列…')
                      : copy(
                          'Send a message or start a task…',
                          '发送消息，或开始一项任务…',
                          '傳送訊息或開始一項任務…',
                        )
                }
                style={{
                  flex: 1,
                  minHeight: 36,
                  color: token('foreground'),
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
                      const epoch = active.session;
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
                    backgroundColor: token('destructive-soft'),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '700', color: token('destructive') }}>
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
                      ? token('primary')
                      : token('muted'),
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
                        ? token('primary-foreground')
                        : token('subdued'),
                  }}
                >
                  ↑
                </Text>
              </View>
            </View>
          </View>

          <Panel open={drawerOpen()} close={() => drawerOpen.set(false)}>
            <DrawerHome {...drawerProps} onCloseDrawer={() => drawerOpen.set(false)} />
          </Panel>
        </View>
      </If>

      <Panel open={route() === 'pairing'} close={closePairing}>
        <PairingOverlay
          ticketUri={ticketUri}
          onChangeUri={(v) => ticketUri.set(v)}
          parsedTicket={parsedTicket}
          pairingError={pairingError}
          busy={busy}
          onParse={runParseTicket}
          onConfirm={runPairConfirm}
          connectionGeneration={() => pairGeneration}
          onDirectConnect={finishConnection}
          onBack={closePairing}
        />
      </Panel>

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
            const epoch = active.session;
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

      <Panel
        open={route() === 'workspace_picker'}
        close={() => route.set(hostState().active ? 'chat' : 'home')}
      >
        <WorkspacePickerOverlay
          projects={projects}
          roots={directoryRoots}
          onSelect={(selection, label) => {
            draftWorkspace.set({ selection, label });
            route.set('chat');
          }}
          onBack={() => route.set('chat')}
        />
      </Panel>

      <Panel
        open={route() === 'model_picker'}
        close={() => route.set(hostState().active ? 'chat' : 'home')}
      >
        <ModelPickerOverlay
          choices={modelChoices}
          loading={modelsLoading}
          currentBackend={currentBackend}
          onSearch={(q) => runLoadModels(q)}
          onSelect={runSelectBackend}
          onBack={() => route.set('chat')}
        />
      </Panel>

      <Panel
        open={route() === 'settings'}
        close={() => route.set(hostState().active ? 'chat' : 'home')}
      >
        <SettingsOverlay
          hostState={hostState}
          defaultDelivery={defaultDelivery}
          onToggleDelivery={() =>
            defaultDelivery.set(defaultDelivery() === 'steer' ? 'queue' : 'steer')
          }
          onConnectHost={runConnectSaved}
          onRelayAuthorization={openRelayPrompt}
          onDisconnect={() => {
            disconnectHost().then(
              (snap) => {
                if (!applyHostState(snap)) return;
                syncConnectedAgentHost(snap);
                statusBanner.set(
                  copy('Disconnected from Host', '已断开远端 Host', '已中斷遠端 Host 連線'),
                );
              },
              (err: Error) => statusBanner.set(err.message),
            );
          }}
          onRemoveHost={async (rootId) => {
            const anchorSession = hostState().active?.session;
            if (
              !(await confirmDestructive(
                copy('Remove this Host?', '移除此 Host？', '移除此 Host？'),
                copy('Remove', '移除', '移除'),
              ))
            )
              return;
            if (hostState().active?.session !== anchorSession) return;
            removeHost(rootId).then(
              (snap) => {
                if (!applyHostState(snap)) return;
                syncConnectedAgentHost(snap);
                statusBanner.set(copy('Host removed', '已移除电脑', '已移除電腦'));
              },
              (err: Error) => statusBanner.set(err.message),
            );
          }}
          onOpenPairing={() => route.set('pairing')}
          onBack={() => route.set(hostState().active ? 'chat' : 'home')}
        />
      </Panel>
      <If when={connectingSavedHost() && !relayHost()}>
        <Action
          title={copy('Cancel connection', '取消连接', '取消連線')}
          onPress={cancelSavedConnection}
        />
      </If>
      <Panel open={relayHost() !== null} close={closeRelayPrompt}>
        <View class="gap-4 p-5">
          <Text class="text-lg font-semibold text-foreground">
            Relay Bearer · {relayHost()?.hostName}
          </Text>
          <Input
            accessibilityLabel="Saved Host relay URL"
            class="min-h-11 bg-card px-3 text-foreground"
            value={savedRelayUrl()}
            onChange={({ value }) => savedRelayUrl.set(value)}
          />
          <Input
            accessibilityLabel="Saved Host relay Bearer"
            class="min-h-11 bg-card px-3 text-foreground"
            masked
            value={savedRelayToken()}
            onChange={({ value }) => savedRelayToken.set(value)}
          />
          <Action
            title="Connect with Bearer"
            primary
            disabled={busy() || !savedRelayToken() || !savedRelayUrl()}
            onPress={() => {
              const target = relayHost();
              if (target) runConnectSaved(target, savedRelayUrl().trim(), savedRelayToken());
            }}
          />
          <Action title="Cancel" onPress={closeRelayPrompt} />
        </View>
      </Panel>
      <Feedback
        message={statusBanner() ?? receiptMessage()}
        dismiss={() => {
          if (statusBanner()) statusBanner.set(null);
          else recoveryStatus.set(null);
        }}
      />
    </View>
  );
}

installTheme();
mount(App);
