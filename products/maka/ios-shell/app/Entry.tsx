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

import { cleanup, mount, safeAreaInsets, Scroll, signal, Text, UrlScheme, View } from 'nsh';
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
  agentCreateSession,
  agentGitWorkspaceDiff,
  agentHistory,
  agentListDirectoryRoots,
  agentListProjects,
  agentListSchedules,
  agentListSessions,
  agentObserve,
  agentOpenBot,
  agentPendingInteractions,
  agentReadInteraction,
  agentRespondInteraction,
  agentSend,
  agentStop,
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
  type AgentDeliveryPage,
  type AgentHistoryChunk,
  type AgentHistoryPage,
  type AgentInteractionRecord,
  type AgentProject,
  type AgentRoomMessage,
  type AgentScheduledSummary,
  type AgentSession,
  type AgentSessionPage,
  type HostStateSnapshot,
  type ParsedTicketInfo,
  type SavedHostItem,
} from './bridge';
import { DrawerHome } from './DrawerHome';
import {
  AutomationsOverlay,
  DiffOverlay,
  NewSessionOverlay,
  PairingOverlay,
  parseUnifiedWorkspacePatch,
  SettingsOverlay,
  type DiffLineItem,
} from './Overlays';
import {
  createBurstController,
  ReactionBurstLayer,
  ReactionPickerBar,
  ReactionPillsRow,
  type ReactionEntry,
} from './Reactions';
import { palette } from './theme';

type Route = 'home' | 'chat' | 'pairing' | 'diff' | 'automations' | 'settings' | 'new_session';

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

    // Unsupported interactive types (form / system_permission) must NEVER masquerade
    // as generic permission cards or send invalid PermissionDecision answers.
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
      unsupportedNotice: '此请求 (' + req.kind + ') 需在桌面端 Maka 处理',
    });
  }
  return { permissions, questions };
}

function buildInteractionAnswer(
  card: PermissionCardItem,
  action: PermissionAction,
): Record<string, unknown> | null {
  if (card.mode === 'unsupported') return null;

  if (card.interactionKind === 'permissions') {
    if (action === 'deny') {
      return { kind: 'permissions', decision: { decision: 'deny' } };
    }
    if (!card.requestedPermissions) {
      return null;
    }
    const scope = action === 'session' || action === 'always' ? 'session' : 'once';
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

  // Real Host Agent state
  const projects = signal<AgentProject[]>([]);
  const sessions = signal<AgentSession[]>([]);
  const directoryRoots = signal<{ name: string; path: string }[]>([]);
  const activeSession = signal<AgentSession | null>(null);
  const activeRunId = signal<string | null>(null);
  const streamingText = signal<string>('');
  const schedules = signal<AgentScheduledSummary[]>([]);
  const schedulesLoading = signal(false);

  // Pairing state
  const ticketUri = signal('');
  const parsedTicket = signal<ParsedTicketInfo | null>(null);
  const pairingError = signal<string | null>(null);

  // Chat & interaction state
  const messages = signal<ChatMessage[]>(PREVIEW_MESSAGES);
  const permissions = signal<PermissionCardItem[]>([PREVIEW_PERMISSION]);
  const questions = signal<QuestionCardItem[]>([PREVIEW_QUESTION]);
  const activeReactionMsgId = signal<string | null>(null);
  const composerDraft = signal('');
  const quotedLine = signal<string | null>(null);
  const defaultDelivery = signal<'steer' | 'queue'>('steer');
  const queuedMessages = signal<string[]>([]);
  const diffTitle = signal('platform/remote-client/src/client.rs');
  const diffLines = signal<DiffLineItem[]>(PREVIEW_DIFF_LINES);
  const diffTruncatedNotice = signal<string | null>(null);
  const burst = createBurstController();

  interface SubSlot {
    subscriptionId: string;
    generation: number | null;
    ended: boolean;
    hostGen: number;
    hostEpoch: string;
    sessionGen?: number;
    sessionId?: string;
  }

  // Monotonic fencing generations preventing stale Host or Session async responses
  // from overwriting newly selected Host/Session state.
  let hostSyncGen = 0;
  let sessionSyncGen = 0;
  let streamGen = 0;
  let subOpenSeq = 0;
  let watchCursor = 0;
  let lastHostEpoch: string | null = null;
  let catalogSub: SubSlot | null = null;
  let watchSub: SubSlot | null = null;

  const isHostStillCurrent = (gen: number, epoch: string) =>
    gen === hostSyncGen && hostState().active?.epoch === epoch;

  const isSessionStillCurrent = (gen: number, epoch: string, sGen: number, sessionId: string) =>
    isHostStillCurrent(gen, epoch) && sGen === sessionSyncGen && activeSession()?.id === sessionId;

  const stopWatchSubscription = () => {
    if (watchSub) {
      const id = watchSub.subscriptionId;
      watchSub = null;
      unsubscribe(id).catch(() => {});
    }
  };

  const stopCatalogSubscription = () => {
    if (catalogSub) {
      const id = catalogSub.subscriptionId;
      catalogSub = null;
      unsubscribe(id).catch(() => {});
    }
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
        messages.set(mapHistoryPageToMessages(page, sessions()));
        if (clearStream && streamGen === streamGenAtStart) {
          streamingText.set('');
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

  const startWatchSubscription = (
    sessionId: string,
    after: number,
    gen: number,
    epoch: string,
    sGen: number,
  ) => {
    stopWatchSubscription();
    subOpenSeq += 1;
    const subId = 'watch:' + sessionId + ':' + String(sGen) + ':' + String(subOpenSeq);
    // Register the unique subscription slot synchronously BEFORE calling subscribe()
    // so early item/ended frames arriving before Promise settlement are never dropped.
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
          if (watchSub === slot) {
            watchSub = null;
          }
          unsubscribe(handle.subscriptionId).catch(() => {});
          return;
        }
        slot.generation = handle.generation;
      },
      (err: Error) => {
        if (watchSub === slot) {
          watchSub = null;
        }
        if (isSessionStillCurrent(gen, epoch, sGen, sessionId)) {
          statusBanner.set('实时会话订阅失败（可点右上角“同步”重试）: ' + err.message);
        }
      },
    );
  };

  const startCatalogSubscription = (gen: number, epoch: string) => {
    stopCatalogSubscription();
    subOpenSeq += 1;
    const subId = 'catalog:' + epoch + ':' + String(gen) + ':' + String(subOpenSeq);
    const slot: SubSlot = {
      subscriptionId: subId,
      generation: null,
      ended: false,
      hostGen: gen,
      hostEpoch: epoch,
    };
    catalogSub = slot;
    subscribe(subId, 'agent', 'catalog', {
      kind: null,
      filter: 'all',
      includeArchived: false,
      rootsOnly: false,
      position: { kind: 'start' },
      scope: { kind: 'all' },
      titleQuery: '',
    }).then(
      (handle) => {
        if (catalogSub !== slot || slot.ended || !isHostStillCurrent(gen, epoch)) {
          if (catalogSub === slot) {
            catalogSub = null;
          }
          unsubscribe(handle.subscriptionId).catch(() => {});
          return;
        }
        slot.generation = handle.generation;
      },
      (err: Error) => {
        if (catalogSub === slot) {
          catalogSub = null;
        }
        if (isHostStillCurrent(gen, epoch)) {
          statusBanner.set('会话目录订阅失败（可点“同步”重试）: ' + err.message);
        }
      },
    );
  };

  const openAgentSession = (session: AgentSession) => {
    const active = hostState().active;
    if (!active) return;
    const gen = hostSyncGen;
    const epoch = active.epoch;
    sessionSyncGen += 1;
    const sGen = sessionSyncGen;

    stopWatchSubscription();
    busy.set(false);
    activeSession.set(session);
    activeRunId.set(null);
    watchCursor = 0;
    streamGen += 1;
    streamingText.set('');
    queuedMessages.set([]);
    messages.set([]);
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
        messages.set(mapHistoryPageToMessages(page, sessions()));
      },
      (err: Error) => {
        if (isSessionStillCurrent(gen, epoch, sGen, session.id)) {
          statusBanner.set('读取历史失败: ' + err.message);
        }
      },
    );
    loadSessionInteractions(session.id, gen, epoch, sGen);
  };

  const syncConnectedAgentHost = (snap: HostStateSnapshot) => {
    const active = snap.active;
    if (!active) {
      hostSyncGen += 1;
      sessionSyncGen += 1;
      stopWatchSubscription();
      stopCatalogSubscription();
      lastHostEpoch = null;
      projects.set([]);
      sessions.set([]);
      directoryRoots.set([]);
      activeSession.set(null);
      activeRunId.set(null);
      queuedMessages.set([]);
      streamingText.set('');
      return;
    }
    if (lastHostEpoch === active.epoch) return;
    lastHostEpoch = active.epoch;
    hostSyncGen += 1;
    sessionSyncGen += 1;
    const gen = hostSyncGen;
    const epoch = active.epoch;

    stopWatchSubscription();
    stopCatalogSubscription();
    projects.set([]);
    sessions.set([]);
    directoryRoots.set([]);
    activeSession.set(null);
    activeRunId.set(null);
    queuedMessages.set([]);
    streamingText.set('');

    if (!hasAgentEndpoint(active)) {
      return;
    }

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
    agentListSessions('all').then(
      (page) => {
        if (!isHostStillCurrent(gen, epoch)) return;
        const list = page.sessions ?? [];
        sessions.set(list);
      },
      (err: Error) => {
        if (isHostStillCurrent(gen, epoch)) {
          statusBanner.set('读取会话列表失败: ' + err.message);
        }
      },
    );

    startCatalogSubscription(gen, epoch);
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
        } else if (fact.kind === 'delta' && typeof fact.text === 'string') {
          activeRunId.set(delivery.runId);
          streamGen += 1;
          streamingText.set(streamingText() + fact.text);
        } else if (fact.kind === 'ended') {
          activeRunId.set(null);
          needRefresh = true;
          clearStreamOnRefresh = true;
        } else if (
          fact.kind === 'transcript_changed' ||
          fact.kind === 'part_committed' ||
          fact.kind === 'executor_text_changed' ||
          fact.kind === 'tool_dispatched' ||
          fact.kind === 'tool_settled'
        ) {
          needRefresh = true;
          if (fact.kind === 'transcript_changed') {
            clearStreamOnRefresh = true;
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
      if (p.kind === 'empty') {
        streamGen += 1;
        streamingText.set('');
      } else if (p.kind === 'cut') {
        activeRunId.set(p.runId);
        const body = (p.parts ?? [])
          .filter((part) => part.field?.kind === 'text' && part.field.textKind === 'text')
          .map((part) => part.text)
          .join('');
        if (body.length > 0) {
          streamGen += 1;
          streamingText.set(body);
        }
      }
      return;
    }

    if (page.kind === 'queue') {
      const previews = (page.queue?.entries ?? [])
        .filter((e) => e.kind !== 'in_flight')
        .map((e) => e.preview);
      queuedMessages.set(previews);
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
      payload.item &&
      typeof payload.item === 'object'
    ) {
      if (catalogSub.generation === null) {
        catalogSub.generation = payload.generation;
      }
      const page = payload.item as Partial<AgentSessionPage>;
      if (Array.isArray(page.sessions)) {
        sessions.set(page.sessions);
      }
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
      if (payload.error && isHostStillCurrent(slot.hostGen, slot.hostEpoch)) {
        statusBanner.set('会话目录同步中断: ' + payload.error);
      }
    }
    if (matchesSubSlot(watchSub, payload.subscriptionId, payload.generation) && watchSub) {
      const slot = watchSub;
      slot.ended = true;
      watchSub = null;
      if (
        payload.error &&
        slot.sessionGen !== undefined &&
        slot.sessionId !== undefined &&
        isSessionStillCurrent(slot.hostGen, slot.hostEpoch, slot.sessionGen, slot.sessionId)
      ) {
        statusBanner.set('会话流式订阅中断: ' + payload.error);
      }
    }
  });

  cleanup(() => {
    stopWatchSubscription();
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
        syncConnectedAgentHost(res.state);
        route.set('chat');
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
      agentListSessions('all').then(
        (page) => {
          busy.set(false);
          if (!isHostStillCurrent(gen, epoch)) return;
          sessions.set(page.sessions ?? []);
          statusBanner.set('实时同步完成 · ' + String((page.sessions ?? []).length) + ' 个会话');
        },
        (err: Error) => {
          busy.set(false);
          if (isHostStillCurrent(gen, epoch)) {
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

  const sendMessage = () => {
    const text = composerDraft().trim();
    if (!text) return;
    const quote = quotedLine();
    const content = quote ? '> ' + quote + '\n' + text : text;
    composerDraft.set('');
    quotedLine.set(null);

    const sess = activeSession();
    const active = hostState().active;
    if (sess && active && hasAgentEndpoint(active)) {
      const gen = hostSyncGen;
      const epoch = active.epoch;
      const sGen = sessionSyncGen;
      const sessionId = sess.id;
      const delivery = defaultDelivery();
      agentSend(sessionId, content, delivery).then(
        (res) => {
          if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
          if (res.kind === 'queued') {
            queuedMessages.set([...queuedMessages(), content]);
          } else if (res.kind === 'started' && res.runId) {
            activeRunId.set(res.runId);
          } else if (res.kind === 'rejected') {
            statusBanner.set('消息被 Host 拒绝: ' + (res.reason ?? 'unknown'));
          }
          refreshSessionTranscript(sessionId, false, gen, epoch, sGen);
        },
        (err: Error) => {
          if (isSessionStillCurrent(gen, epoch, sGen, sessionId)) {
            statusBanner.set('发送失败: ' + err.message);
          }
        },
      );
      return;
    }

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
        : action === 'session'
          ? '已本会话允许'
          : action === 'always'
            ? '已始终允许'
            : '已允许本次';
    const allowed = action !== 'deny';
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
        () => {
          if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
          busy.set(false);
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

  const submitQuestion = (card: QuestionCardItem, answers: string[]) => {
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
        () => {
          if (!isSessionStillCurrent(gen, epoch, sGen, sessionId)) return;
          busy.set(false);
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
    return hostState().active?.hostName ?? 'Maka Bot';
  };

  const chatSubtitle = () => {
    const active = hostState().active;
    if (!active) return '本地预览会话';
    if (activeRunId()) return active.hostName + ' · 执行中';
    return activeSession() ? active.hostName + ' · 实时同步' : '远端 Host 已就绪';
  };

  const topPad = () => Math.max(insets().top, 16);
  const bottomPad = () => Math.max(insets().bottom, 16);

  const drawerProps = {
    hostState,
    projects,
    sessions,
    activeSessionId: () => activeSession()?.id ?? null,
    pendingCount,
    statusBanner,
    bottomPad,
    onSelectSession: openAgentSession,
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
    onOpenNewSession: () => {
      drawerOpen.set(false);
      route.set('new_session');
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
        backgroundColor: palette().bg,
        paddingTop: topPad(),
      }}
    >
      <If when={route() === 'home'}>
        <DrawerHome {...drawerProps} />
      </If>

      <If when={route() === 'chat'}>
        <View style={{ flex: 1 }}>
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

            <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: 8 }}>
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

              <View
                role="button"
                accessibilityLabel="Verify live Host RPC"
                onPress={runVerifyLiveRpc}
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
                <Text style={{ fontSize: 12.5, color: palette().ink2 }}>同步</Text>
              </View>
            </View>
          </View>

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

          <Scroll style={{ flex: 1 }} contentStyle={{ padding: 16, gap: 16, paddingBottom: 24 }}>
            <If when={messages().length === 0 && streamingText().length === 0}>
              <View style={{ paddingVertical: 32, alignItems: 'center', gap: 6 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>
                  {chatTitle()}
                </Text>
                <Text style={{ fontSize: 13, color: palette().ink3 }}>
                  发一条消息开始对话，Maka 会实时同步执行过程
                </Text>
              </View>
            </If>

            <Each of={messages()} key={(m) => m.id}>
              {(msg) => (
                <View
                  style={{
                    alignItems: msg().role === 'user' ? 'flex-end' : 'flex-start',
                    gap: 6,
                  }}
                >
                  <If when={msg().role === 'user'}>
                    <View
                      role="button"
                      accessibilityLabel={'Message ' + msg().id}
                      onPress={() => activeReactionMsgId.set(msg().id)}
                      style={{
                        maxWidth: '84%',
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        borderRadius: 18,
                        backgroundColor: palette().userBubble,
                      }}
                    >
                      <Text
                        style={{ fontSize: 15.5, lineHeight: 22, color: palette().userBubbleText }}
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
                            <Text style={{ fontSize: 10, fontWeight: '700', color: palette().ink }}>
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

                      <View
                        role="button"
                        accessibilityLabel={'Agent message ' + msg().id}
                        onPress={() => activeReactionMsgId.set(msg().id)}
                        style={{ gap: 4 }}
                      >
                        <Text style={{ fontSize: 15.5, lineHeight: 23.5, color: palette().ink }}>
                          {msg().text}
                        </Text>
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

            <If when={streamingText().length > 0}>
              <View style={{ width: '100%', gap: 4 }}>
                <Text style={{ fontSize: 15.5, lineHeight: 23.5, color: palette().ink }}>
                  {streamingText()}
                </Text>
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
          </Scroll>

          <ReactionBurstLayer burst={burst} />

          <If when={queuedMessages().length > 0}>
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
              <Text style={{ fontSize: 12, color: palette().ink2 }}>
                {'已排队 ' + String(queuedMessages().length) + ' 条消息: ' + queuedMessages()[0]}
              </Text>
              <View
                role="button"
                accessibilityLabel="Clear queued indicator"
                onPress={() => queuedMessages.set([])}
              >
                <Text style={{ fontSize: 12, color: palette().ink3 }}>收起</Text>
              </View>
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

          <View
            style={{
              paddingHorizontal: 12,
              paddingTop: 6,
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
                    : defaultDelivery() === 'steer'
                      ? '告诉 Maka 下一步…'
                      : '输入消息（排队发送）…'
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
                        () => {
                          if (
                            isSessionStillCurrent(gen, epoch, sGen, sessionId) &&
                            activeRunId() === runId
                          ) {
                            activeRunId.set(null);
                          }
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
                onPress={sendMessage}
                style={{
                  minWidth: 36,
                  height: 36,
                  paddingHorizontal: 12,
                  borderRadius: 18,
                  backgroundColor:
                    composerDraft().trim().length > 0 ? palette().primaryBg : palette().surface2,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{
                    fontSize: 15,
                    fontWeight: '700',
                    color:
                      composerDraft().trim().length > 0 ? palette().primaryText : palette().ink3,
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

      <If when={route() === 'new_session'}>
        <NewSessionOverlay
          roots={directoryRoots}
          busy={busy}
          onCreate={(title, kind, ws) => {
            const active = hostState().active;
            if (!active) return;
            const gen = hostSyncGen;
            const epoch = active.epoch;
            busy.set(true);
            agentCreateSession(title, kind, ws).then(
              (created) => {
                busy.set(false);
                if (!isHostStillCurrent(gen, epoch)) return;
                sessions.set([created, ...sessions()]);
                openAgentSession(created);
              },
              (err: Error) => {
                busy.set(false);
                if (isHostStillCurrent(gen, epoch)) {
                  statusBanner.set('创建会话失败: ' + err.message);
                }
              },
            );
          }}
          onBack={() => route.set(hostState().active ? 'chat' : 'home')}
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
