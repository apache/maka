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
  createText,
  UiError,
  errorText,
  type UiText,
  message as uiMessage,
} from '../../../../products/maka/workbench/app/text';
import { tr } from '../../../../products/maka/workbench/app/locale';
import {
  batch,
  cleanup,
  computed,
  effect,
  inputAction,
  signal,
  Text,
  untracked,
  View,
  List,
} from 'nsh';
import type { ListRef, ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { keymap, platform } from 'nsh';
import { AnimatedValue } from 'nsh';
import {
  useHost,
  loadDraft,
  saveDraft,
  reserveSend,
  confirmSend,
  pendingSends,
  recoverSend,
  abandonSend,
  type ScopedHost,
} from '../../../../products/maka/workbench/app/host';
import {
  C,
  Header,
  captionTextStyle,
  controlStyle,
  type BrowserHeader,
} from '../../../../products/maka/workbench/app/ui';
import {
  acceptedSend,
  mergeChunks,
  replayStartCursor,
  updateHistoryMetadata,
} from '../../../../products/maka/workbench/app/history';
import type { Row, Position, Subscription } from '../../../../products/maka/workbench/app/history';
import { thinkingSummary } from '../../../../products/maka/workbench/app/thinkingSummary';
import type {
  ComposerSession,
  ComposerSendAction as SendAction,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { AttachmentDraft } from '../../../../products/maka/workbench/app/attachmentDraft';
import type { QueueSession } from '../../../../products/maka/workbench/app/QueueDock';
import { sameRoute } from '../../../../products/maka/workbench/app/modelSelection';
import type {
  BackendIdentity,
  ModelDetails,
} from '../../../../products/maka/workbench/app/modelSelection';
import { CompactionDivider } from '../../../../products/maka/workbench/app/CompactionDivider';
import {
  MessageRow,
  type MessageViewState,
} from '../../../../products/maka/workbench/app/MessageRow';
import { FinalActions } from '../../../../products/maka/workbench/app/FinalActions';
import type { SessionAction } from '../../../../products/maka/workbench/app/sessionLifecycle';
import { createProjectMcp } from '../../../../products/maka/workbench/app/projectMcp';
import { createSessionPermissions } from '../../../../products/maka/workbench/app/sessionPermissions';
import {
  TurnPanel,
  TurnSummary,
  turnOutcome,
} from '../../../../products/maka/workbench/app/TurnPanel';
import type {
  GroupViewState,
  LiveActivity,
  TurnViewState,
} from '../../../../products/maka/workbench/app/TurnPanel';
import {
  projectProcessGroups,
  sameProcessActivity,
  sameProcessRows,
  sourceSequence,
  stableRowId,
} from '../../../../products/maka/workbench/app/processGroups';
import type {
  ProcessActivity,
  ProcessEntry,
  ProcessGroup,
  ProcessRow,
  TurnPresentation,
} from '../../../../products/maka/workbench/app/processGroups';
import {
  railWidth,
  ReturnToLatest,
  TurnNavigation,
} from '../../../../products/maka/workbench/app/TurnNavigation';
import type { TurnNavigationItem } from '../../../../products/maka/workbench/app/TurnNavigation';
import type { ConversationStatus } from '../../../../products/maka/workbench/app/sessionStatus';
import type { ImagePreview } from '../../../../products/maka/workbench/app/ImageThumbnail';
import {
  latestToolActivity,
  updateToolActivity,
} from '../../../../products/maka/workbench/app/toolActivity';
import type { ToolActivity } from '../../../../products/maka/workbench/app/toolActivity';
import type {
  AgentHistoryAttachment,
  AgentHistoryChunk,
  AgentHistoryLandmark,
  AgentHistoryPage,
  AgentMarkReadResult,
  AgentSession,
  HistoryPosition,
  OperationReply,
  AgentPendingInteractions,
  AgentQueue,
  AgentComputerApps,
  AgentCompactionProgress,
} from '../../../../packages/plugin-sdk/src/index.js';
import {
  createAttachmentDraft,
  type AttachmentEdit,
  type DraftAttachment,
} from '../../../../products/maka/workbench/app/attachmentDraft';

export type ConversationAnchor = { messageId: string; position: Position };
type HistoryNavigation =
  | { kind: 'start' | 'tail' }
  | { kind: 'turn'; item: TurnNavigationItem }
  | { kind: 'message'; anchor: ConversationAnchor };
type HistoryWindow = Pick<AgentHistoryPage, 'through' | 'before' | 'after'> & { identity: object };

export type Control = (method: string, input: any) => Promise<any>;
export type ConversationHandle = Omit<
  ComposerSession,
  'attachments' | 'modelDetails' | 'permissions' | 'projectMcp' | 'completion' | 'checklist'
> & {
  attachments: AttachmentDraft;
  modelDetails(): ModelDetails;
  permissions: ReturnType<typeof createSessionPermissions>;
  projectMcp: ReturnType<typeof createProjectMcp>;
  compact(prompt?: string): Promise<void>;
  interactions(): AgentPendingInteractions;
  computerApps(): AgentComputerApps;
  activeTurn(): string | null;
  activityTurn(): string | null;
  flushDraft(): Promise<boolean>;
  focus(): void;
  /** A null target follows the current live turn. */
  jumpLatest(turnId: string | null): void;
  refresh(): Promise<any>;
  reveal(anchor: ConversationAnchor, current: () => boolean): Promise<void>;
  focusHistory(): void;
  focusActivity(turnId: string | null): void;
  /** The title its header shows. */
  title(): string;
};
type ConversationProps = {
  client: ScopedHost;
  control: Control;
  fork(action: Extract<SessionAction, { kind: 'fork' }>): Promise<void>;
  commands(): void;
  visible(): boolean;
  foreground(): boolean;
  browser(): BrowserHeader;
  files?(): void;
  filesOpener(node: ViewRef): void;
  previewImage(image: ImagePreview): void;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  attach(handle: ConversationHandle): void;
  detach(handle: ConversationHandle): void;
  focusComposer(): void;
  stopAction(): () => void;
};
type LivePart = {
  invocationId: string | null;
  stepId: string;
  partId: string;
  messageId: string;
  field: 'thinking' | 'body';
  startSequence: number;
};
function comparePosition(left: Position, right: Position): number {
  return left.sourceSequence - right.sourceSequence || left.itemIndex - right.itemIndex;
}
function indexRows(items: readonly Row[]) {
  const byId = new Map<string, Row>();
  const byMessage = new Map<string, Row>();
  for (const row of items) {
    const id = stableRowId(row);
    // The result supplies current content at the original tool call's seat.
    if (!byId.has(id) || !row.tool?.call || row.tool.result) byId.set(id, row);
    const message = `${row.messageId}/${row.field}`;
    if (!byMessage.has(message)) byMessage.set(message, row);
  }
  return { byId, byMessage };
}
function receiptMessage(reply: any): UiText {
  const receipt = reply?.receipt;
  if (receipt?.kind === 'recorded' && receipt.outcome?.kind === 'returned') {
    const value = receipt.outcome.value;
    return value?.kind === 'rejected'
      ? uiMessage('Send rejected: {reason}', { reason: value.reason })
      : uiMessage('Host returned an unexpected send result.');
  }
  return uiMessage(
    'The original send has no confirmed result. Recover its receipt before sending again.',
  );
}

export function Conversation(props: ConversationProps) {
  const host = useHost();
  const root = signal<ViewRef | null>(null);
  effect(() => {
    const stop = props.stopAction();
    const node = root();
    if (node) return keymap.bind('escape', stop, { when: 'always', within: node });
  });
  const client = props.client;
  const sessionId = client.sessionId;
  const rows = signal<Row[]>([]);
  const live = signal<Row[]>([]);
  const toolActivity = signal<ToolActivity[]>([]);
  const parts = signal<LivePart[]>([]);
  const pendingMessages = signal<Row[]>([]);
  const queued = signal<AgentQueue | null>(null);
  const title = signal(sessionId);
  const archived = signal(false);
  const run = signal<ConversationStatus>('loading');
  const invocation = signal<string | null>(null);
  const compacting = signal<AgentCompactionProgress | null>(null);
  const stoppingRun = signal<string | null>(null);
  const stopping = () => invocation() !== null && stoppingRun() === invocation();
  const workspace = signal('');
  const permissions = createSessionPermissions(host, sessionId, props.control);
  const projectMcp = createProjectMcp(host, sessionId, props.control);
  const runTurn = signal<string | null>(null);
  const backend = signal<any>(null);
  const interactions = signal<AgentPendingInteractions>({ revision: -1, entries: [] });
  const computerApps = signal<AgentComputerApps>({ entries: [] });
  let interactionsFromStream = false;
  const error = createText();
  const ready = signal(false);
  const transcriptStatus = signal<'loading' | 'live' | 'closing' | 'failed'>('loading');
  const historyWindow = signal<HistoryWindow | null>(null);
  const atHistoryTail = () => historyWindow()?.after === null;
  const visibleRows = signal<ReadonlySet<string>>(new Set());
  const readState = signal<{
    revision: number;
    through: number;
    hasUnread: boolean;
    tailMessageId: string | null;
  }>({ revision: -1, through: 0, hasUnread: false, tailMessageId: null });
  const readExposure = signal<object>({});
  const changedReadExposure = () => {
    if (readState().hasUnread) readExposure.set({});
  };
  const acknowledging = signal(false);
  const landmarks = signal<{ through: number; items: AgentHistoryLandmark[] }>({
    through: 0,
    items: [],
  });
  const awayFromLatest = signal(false);
  const visibleTurn = signal<string | null>(null);
  const navigation = signal<HistoryNavigation | null>(null);
  const navigatingTurn = computed(() => {
    const target = navigation();
    return target?.kind === 'turn' ? target.item.turnId : null;
  });
  const attachmentMetadataFailed = signal(false);
  const attachmentMetadataReads = new Set<string>();
  const draft = signal('');
  const draftReady = signal(false);
  const savingFailed = signal(false);
  const sending = signal(false);
  const unresolved = signal<any[]>([]);
  const receiptsKnown = signal(false);
  const recovering = signal(false);
  const notice = createText();
  const reading = signal<'chat' | 'trajectory'>('chat');
  const readingSize = signal({ width: 640, height: 192 });
  const innerReader = signal<string | null>(null);
  const metrics = signal<any>(null);
  const turnStates = new Map<string, TurnViewState>();
  const groupStates = new Map<string, GroupViewState>();
  const rowStates = new Map<string, MessageViewState>();
  const turnState = (id: string) => {
    let state = turnStates.get(id);
    if (!state) {
      state = {
        expanded: signal<{
          open: boolean;
          answerKey: string | undefined;
        } | null>(null),
      };
      turnStates.set(id, state);
    }
    return state;
  };
  const groupState = (key: string) => {
    let state = groupStates.get(key);
    if (!state) {
      state = {
        open: signal(false),
        following: signal(false),
        offset: new AnimatedValue(0),
        measured: new Map(),
        lease: 0,
        visibleRows: signal<ReadonlySet<string>>(new Set()),
        rowNodes: new Map<string, ViewRef>(),
      };
      groupStates.set(key, state);
    }
    return state;
  };
  const rowState = (id: string) => {
    let state = rowStates.get(id);
    if (!state) {
      state = { expanded: signal(false), sourceMode: signal(false) };
      rowStates.set(id, state);
    }
    return state;
  };
  const canonicalRows = computed(() => indexRows(rows()));
  const liveRows = computed(() => indexRows(live()));
  const currentRow = (id: string) =>
    canonicalRows().byId.get(id) ??
    liveRows().byId.get(id) ??
    pendingMessages().find((row) => stableRowId(row) === id);
  const processLive = computed<readonly ProcessRow[]>(() => (atHistoryTail() ? live() : []), {
    equals: sameProcessRows,
  });
  const processActivity = computed<readonly ProcessActivity[]>(
    () => (atHistoryTail() ? toolActivity() : []),
    {
      equals: sameProcessActivity,
    },
  );
  const activity = computed<LiveActivity>(
    () => {
      if (run() === 'waiting_for_user') return { kind: 'waiting', detail: '' };
      let latest: { part: LivePart; row: Row; sequence: number } | undefined;
      for (const part of parts()) {
        if (part.invocationId !== invocation()) continue;
        const message = `${part.messageId}/${part.field}`;
        const row = liveRows().byMessage.get(message) ?? canonicalRows().byMessage.get(message);
        if (!row || row.closedAt != null) continue;
        const sequence = Math.max(part.startSequence, row.sequence ?? 0);
        if (!latest || sequence > latest.sequence) latest = { part, row, sequence };
      }
      if (!latest) return { kind: 'working', detail: '' };
      if (latest.part.field === 'body')
        return { kind: 'response', detail: '', rowId: stableRowId(latest.row) };
      return {
        kind: 'thinking',
        rowId: stableRowId(latest.row),
        detail: thinkingSummary(latest.row.text),
      };
    },
    {
      equals: (left, right) =>
        left.kind === right.kind && left.detail === right.detail && left.rowId === right.rowId,
    },
  );
  let previousGroups: ProcessEntry[] = [];
  const projection = computed(() => {
    // Canonical position and live PartStarted sequence are source order. A send
    // echo has no source position yet and stays at the local tail until admitted.
    const ordered = [...rows(), ...processLive()].sort((left, right) => {
      return (
        (sourceSequence(left) ?? 0) - (sourceSequence(right) ?? 0) ||
        (left.position?.itemIndex ?? 0) - (right.position?.itemIndex ?? 0) ||
        Number(left.field === 'body') - Number(right.field === 'body')
      );
    });
    const next = projectProcessGroups({
      rows: [...ordered, ...(atHistoryTail() ? pendingMessages() : [])],
      toolActivity: processActivity(),
      activeTurnId: invocation() === null ? null : runTurn(),
      previous: previousGroups,
    });
    previousGroups = next.entries;
    return next;
  });
  const canFoldTurn = (turn: TurnPresentation) =>
    turnOutcome(turn) === 'completed' && !turn.active && !turn.interleavedInput;
  const turnExpanded = (turn: TurnPresentation) => {
    if (!canFoldTurn(turn)) return true;
    const stored = turnState(turn.turnId).expanded();
    if (stored && stored.answerKey === turn.answerKey) return stored.open;
    return false;
  };
  type DisplayEntry =
    | { kind: 'summary'; key: string; turnId: string }
    | { kind: 'process'; key: string; group: ProcessGroup }
    | { kind: 'row'; key: string; rowId: string; repeats?: number };
  const display = computed<DisplayEntry[]>(() => {
    const result: DisplayEntry[] = [];
    const summaries = new Set<string>();
    for (const entry of projection().entries) {
      const row = entry.kind === 'message' ? projection().rowsById.get(entry.rowId) : undefined;
      const turnId = entry.kind === 'process' ? entry.turnId : row?.turnId;
      const turn = turnId ? projection().turns.get(turnId) : undefined;
      if (
        turn &&
        (entry.kind === 'process' ||
          row?.role === 'assistant' ||
          // Recovered failures sit under the summary that folds them.
          (row?.role === 'failure' && turnOutcome(turn) === 'completed')) &&
        !summaries.has(turn.turnId) &&
        turnOutcome(turn) !== null
      ) {
        summaries.add(turn.turnId);
        result.push({
          kind: 'summary',
          key: `turn/${turn.turnId}`,
          turnId: turn.turnId,
        });
      }
      if (entry.kind === 'process') {
        if (!turn || !turnExpanded(turn)) continue;
        result.push({ kind: 'process', key: entry.key, group: entry });
      } else if (row) {
        if (entry.processTurnId && turn && !turnExpanded(turn)) continue;
        // A completed turn recovered from its failures (retries that later
        // succeeded); they fold away with the rest of its work.
        if (row.role === 'failure' && turn && !turnExpanded(turn)) continue;
        if (
          reading() === 'trajectory' &&
          (row.role === 'user' ||
            row.finalOutput ||
            row.role === 'compaction' ||
            (!row.turnId && row.role !== 'failure'))
        )
          continue;
        result.push({ kind: 'row', key: entry.key, rowId: entry.rowId, repeats: entry.repeats });
      }
    }
    return result;
  });
  let previouslyVisible = new Set<string>();
  effect(() => {
    const visible = new Set<string>();
    for (const turn of projection().turns.values()) {
      if (turnExpanded(turn)) visible.add(turn.turnId);
      else if (previouslyVisible.has(turn.turnId)) {
        for (const entry of projection().entries) {
          if (entry.kind === 'process' && entry.turnId === turn.turnId)
            groupStates.get(entry.key)?.open.set(false);
        }
      }
    }
    previouslyVisible = visible;
  });
  const displayByKey = computed(() => new Map(display().map((item) => [item.key, item])));
  const displayKeys = computed(() => display().map((item) => item.key));
  const navigationItems = computed<TurnNavigationItem[]>(() => {
    const items = new Map<string, TurnNavigationItem>();
    for (const item of landmarks().items) {
      items.set(item.turnId, {
        turnId: item.turnId,
        label: item.label,
        anchor: {
          kind: 'landmark',
          through: landmarks().through,
          position: item.position,
          lastPosition: item.lastPosition,
        },
      });
    }
    for (const row of rows()) {
      if (!row.turnId || !row.position || row.role === 'compaction') continue;
      const previous = items.get(row.turnId);
      const label =
        row.role === 'user'
          ? Array.from(row.text.replace(/\s+/g, ' ').trim()).slice(0, 96).join('')
          : '';
      if (!previous)
        items.set(row.turnId, {
          turnId: row.turnId,
          label,
          anchor: { kind: 'loaded', position: row.position },
        });
      else if (!previous.label && label) items.set(row.turnId, { ...previous, label });
    }
    return [...items.values()].sort((left, right) =>
      comparePosition(left.anchor.position, right.anchor.position),
    );
  });
  const entryTurn = (key: string) => {
    const entry = displayByKey().get(key);
    if (entry?.kind === 'summary') return entry.turnId;
    if (entry?.kind === 'process') return entry.group.turnId;
    return entry?.kind === 'row' ? (projection().rowsById.get(entry.rowId)?.turnId ?? null) : null;
  };
  let list: ListRef | undefined;
  let alive = true;
  let subscription: Subscription | null = null;
  let transcriptTask: Promise<void> | null = null;
  let wakeReconnect: (() => void) | null = null;
  let readFailure: { stream: Subscription; reason: unknown } | null = null;
  let refreshFrom: { position: Position; field: string } | null = null;
  let latestKnown = 0;
  let watchLast = 0;
  let runThrough = 0;
  let followTask: Promise<void> | null = null;
  let followAgain = false;
  let historyIdentity: object = {};
  let windowTask: Promise<boolean> | null = null;
  let historyDestination: { position: HistoryPosition; explicit: boolean; failed: boolean } = {
    position: { kind: 'tail' },
    explicit: false,
    failed: false,
  };
  let olderTask: Promise<boolean> | null = null;
  let newerTask: Promise<boolean> | null = null;
  let attemptedRead: { revision: number; messageId: string; exposure: object } | null = null;
  let landmarksReadingThrough = -1;
  let draftRevision = 0;
  let editEpoch = 0;
  let pendingDraft: (AttachmentEdit & { text: string }) | null = null;
  let saveTask: Promise<void> | null = null;
  // From Enter until the send is reserved, the saved draft must stay the
  // revision being sent. Edits made meanwhile show at once and are saved after.
  let holding = false;
  let heldDraft: (AttachmentEdit & { text: string }) | null = null;
  const attachments = createAttachmentDraft({
    sessionId,
    client,
    focus: props.focusComposer,
    changed() {
      if (!alive || !draftReady()) return;
      editEpoch += 1;
      queueDraft({ text: draft(), ...attachments.snapshot() });
    },
  });

  const report = (reason: unknown) => {
    if (alive) error.set(errorText(reason));
  };
  const publishHistory = (chunks: any[], through: number, older = false) => {
    batch(() => {
      rows.set(mergeChunks(rows(), chunks, older, through));
      const canonical = canonicalRows().byMessage;
      const currentLive = live();
      const nextLive = currentLive.filter((row) => !canonical.has(`${row.messageId}/${row.field}`));
      if (nextLive.length !== currentLive.length) live.set(nextLive);
      const currentPending = pendingMessages();
      const nextPending = currentPending.filter(
        (row) => !canonical.has(`${row.messageId}/${row.field}`),
      );
      if (nextPending.length !== currentPending.length) pendingMessages.set(nextPending);
    });
    hydrateAttachmentMetadata();
  };
  const requestMetadata = (row: { position?: Position; field: string } | undefined) => {
    if (!row?.position) return;
    const next = { position: row.position, field: row.field };
    const order = (a: typeof next, b: typeof next) =>
      a.position.sourceSequence - b.position.sourceSequence ||
      a.position.itemIndex - b.position.itemIndex ||
      Number(a.field === 'body') - Number(b.field === 'body');
    if (refreshFrom === null || order(next, refreshFrom) < 0) refreshFrom = next;
    followAgain = true;
  };
  const publishMetadata = (chunks: any[], through: number) => {
    rows.set(updateHistoryMetadata(rows(), chunks, through));
    if (!rows().some((row) => row.role === 'user' && row.attachments === undefined))
      attachmentMetadataFailed.set(false);
    hydrateAttachmentMetadata();
  };
  const history = async (through: number, position: HistoryPosition) => {
    const page = await host.query('agent', 'history', {
      sessionId,
      through,
      position,
      includeThinking: true,
      view: 'conversation',
    });
    if (page.through !== through) throw new UiError('History changed its requested fence.');
    return page;
  };
  const ownsWindow = (identity: object) => alive && historyIdentity === identity;
  // Tail, recall, Home and turn navigation open the same bidirectional window.
  // Superseded reads can finish, but never publish into its replacement.
  const resetHistory = (
    position: HistoryPosition,
    through: number,
    verify?: (page: AgentHistoryPage) => void,
    current: () => boolean = () => true,
  ): Promise<boolean> => {
    if (!current()) return Promise.resolve(false);
    const identity = {};
    const destination = historyDestination;
    const canPublish = () => {
      if (!ownsWindow(identity)) return false;
      // Focus can cancel navigation before the reader has its first page.
      // Keep that initial hydration; its cleared target cannot restore focus.
      if (historyDestination === destination && (current() || historyWindow() === null))
        return true;
      const previous = historyWindow();
      if (previous) historyWindow.set({ ...previous, identity });
      return false;
    };
    historyIdentity = identity;
    for (const state of groupStates.values()) {
      if (state.revealRow !== undefined) {
        state.revealRow = undefined;
        state.requestFocus = false;
      }
    }
    olderTask = null;
    newerTask = null;
    followTask = null;
    followAgain = false;
    refreshFrom = null;
    const task = (async () => {
      let location = position;
      let page: AgentHistoryPage;
      for (;;) {
        page = await history(through, location);
        if (!canPublish()) return false;
        verify?.(page);
        if (page.chunks.length) break;
        const reverse = location.kind === 'tail' || location.kind === 'before';
        const cursor = reverse ? page.before : page.after;
        if (!cursor) break;
        location = reverse ? { kind: 'before', cursor } : { kind: 'after', cursor };
      }
      if (!canPublish()) return false;
      batch(() => {
        rows.set(mergeChunks([], page.chunks, false, page.through));
        historyWindow.set({
          identity,
          through: page.through,
          before: page.before,
          after: page.after,
        });
        ready.set(true);
        awayFromLatest.set(position.kind !== 'tail');
        innerReader.set(null);
      });
      hydrateAttachmentMetadata();
      if (page.after === null && latestKnown > through) void follow().catch(report);
      return true;
    })()
      .catch((reason) => {
        if (!canPublish()) return false;
        if (historyDestination === destination) destination.failed = true;
        // Keep the existing viewport usable after a failed exact lookup.
        // Its old in-flight requests stay revoked.
        const previous = historyWindow();
        if (previous) historyWindow.set({ ...previous, identity });
        throw reason;
      })
      .finally(() => {
        if (windowTask === task) windowTask = null;
      });
    windowTask = task;
    return task;
  };
  const hydrateAttachmentMetadata = () => {
    for (const row of rows()) {
      if (
        row.role !== 'user' ||
        row.field !== 'body' ||
        !row.position ||
        row.attachments !== undefined
      )
        continue;
      const through = row.metadataThrough!;
      const key = `${row.key}/${through}`;
      if (attachmentMetadataReads.has(key)) continue;
      attachmentMetadataReads.add(key);
      const position = { ...row.position };
      // A tail fragment can omit the first-fragment metadata. Read just that
      // row's first page; its text never changes the loaded window or anchor.
      void history(through, { kind: 'row', position, field: 'body' })
        .then((page) => {
          if (!alive) return;
          const current = rows().find((candidate) => candidate.key === row.key);
          if (
            !current ||
            current.messageId !== row.messageId ||
            current.metadataThrough !== through
          )
            return;
          const first = page.chunks.find(
            (chunk: any) =>
              chunk.position.sourceSequence === position.sourceSequence &&
              chunk.position.itemIndex === position.itemIndex &&
              chunk.field === 'body',
          );
          if (
            !first ||
            first.offset !== 0 ||
            first.messageId !== row.messageId ||
            first.role !== 'user'
          )
            throw new UiError('The original attachment metadata could not be verified.');
          publishMetadata([first], through);
        })
        .catch((reason) => {
          if (
            alive &&
            rows().some(
              (current) =>
                current.key === row.key &&
                current.messageId === row.messageId &&
                current.metadataThrough === through &&
                current.attachments === undefined,
            )
          ) {
            attachmentMetadataFailed.set(true);
            report(reason);
          }
        })
        .finally(() => attachmentMetadataReads.delete(key));
    }
  };
  const retryAttachmentMetadata = (owner: string) => {
    if (!alive || owner !== sessionId) return;
    attachmentMetadataFailed.set(false);
    hydrateAttachmentMetadata();
  };
  const readLandmarks = (through: number) => {
    if (through <= landmarksReadingThrough) return;
    landmarksReadingThrough = through;
    void host
      .query('agent', 'historyLandmarks', { sessionId, through })
      .then((page) => {
        if (page.through !== through)
          throw new UiError('Turn landmarks changed their requested fence.');
        if (alive && page.through >= landmarks().through)
          landmarks.set({ through: page.through, items: page.landmarks });
      })
      .catch((reason) => {
        if (!alive || through < landmarks().through) return;
        if (landmarksReadingThrough === through) landmarksReadingThrough = -1;
        report(reason);
      });
  };
  const acceptReadState = (session: AgentSession, through = readState().through) => {
    if (session.id !== sessionId) throw new UiError('The Host observed a different conversation.');
    if (session.revision >= readState().revision)
      readState.set({
        revision: session.revision,
        through,
        hasUnread: session.hasUnread,
        tailMessageId: session.tailMessageId,
      });
  };
  const observe = async () => {
    const observed = await host.query('agent', 'observe', { sessionId });
    if (!alive) return observed;
    if (observed.session.id !== sessionId) throw new UiError('Host observed a different session.');
    acceptReadState(observed.session, observed.through);
    latestKnown = Math.max(latestKnown, observed.through);
    readLandmarks(observed.through);
    title.set(observed.session.title);
    archived.set(observed.session.archived);
    workspace.set(observed.session.workspace.path);
    permissions.observe(observed.session);
    backend.set(observed.session.backend ?? observed.rememberedBackend ?? null);
    if (observed.through >= runThrough) {
      metrics.set(observed.metrics ?? null);
      run.set(observed.run?.state ?? 'idle');
      compacting.set(observed.compacting);
      invocation.set(observed.run?.invocationId ?? null);
      runTurn.set(observed.run?.turnId ?? null);
      if (!observed.run) stoppingRun.set(null);
      runThrough = observed.through;
    }
    return observed;
  };

  // Only a window already at its fence's tail follows newly appended text.
  // A recall window retains its native forward cursor instead of reading the gap.
  const follow = (): Promise<void> => {
    followAgain = true;
    if (followTask) return followTask;
    const owner = historyWindow();
    if (!owner || !ownsWindow(owner.identity)) return Promise.resolve();
    const stream = subscription;
    const task = (async () => {
      do {
        followAgain = false;
        const fence = latestKnown;
        if (historyWindow()?.after === null) {
          const last = rows().at(-1);
          let position: HistoryPosition = last
            ? {
                kind: 'after',
                cursor: {
                  position: last.position!,
                  field: last.field as 'body' | 'thinking',
                  offset: last.fragments!.at(-1)!.offset,
                },
              }
            : { kind: 'start' };
          const chunks: AgentHistoryChunk[] = [];
          for (;;) {
            const page = await history(fence, position);
            if (!ownsWindow(owner.identity)) return;
            chunks.push(...page.chunks);
            if (page.after === null) break;
            position = { kind: 'after', cursor: page.after };
          }
          publishHistory(chunks, fence);
          const current = historyWindow()!;
          historyWindow.set({ ...current, through: fence, after: null });
        }
        const currentLive = live();
        const nextLive = currentLive.filter(
          (row) => row.closedAt === null || row.closedAt! > fence,
        );
        if (nextLive.length !== currentLive.length) live.set(nextLive);
        const refresh = refreshFrom;
        refreshFrom = null;
        const last = rows().at(-1);
        if (refresh !== null && last?.position) {
          let cursor: HistoryPosition = {
            kind: 'row',
            position: refresh.position,
            field: refresh.field as 'body' | 'thinking',
          };
          try {
            for (;;) {
              const page = await history(fence, cursor);
              if (!ownsWindow(owner.identity)) return;
              publishMetadata(page.chunks, page.through);
              // Metadata beyond the loaded viewport grants no reason to fetch
              // the rest of an anchored history window.
              if (
                page.after === null ||
                page.chunks.some((chunk) => {
                  const order = comparePosition(chunk.position, last.position!);
                  return (
                    order > 0 ||
                    (order === 0 && (chunk.field === 'body' || last.field === 'thinking'))
                  );
                })
              )
                break;
              cursor = { kind: 'after', cursor: page.after };
            }
          } catch (reason) {
            requestMetadata(refresh);
            throw reason;
          }
        }
      } while (ownsWindow(owner.identity) && followAgain);
    })()
      .catch((reason) => {
        if (!ownsWindow(owner.identity)) return;
        followAgain = false;
        if (stream !== null && subscription === stream) {
          readFailure = { stream, reason };
          transcriptStatus.set('closing');
          void stream.close().catch(report);
        }
        throw reason;
      })
      .finally(() => {
        if (followTask !== task) return;
        followTask = null;
        if (alive && followAgain) void follow().catch(report);
      });
    followTask = task;
    return task;
  };

  const openParts = (started: LivePart[]) => {
    const same = (a: LivePart, b: LivePart) =>
      a.invocationId === b.invocationId && a.stepId === b.stepId && a.partId === b.partId;
    parts.set([
      ...parts().filter((part) => !started.some((other) => same(part, other))),
      ...started,
    ]);
  };
  const closeLive = (sequence: number, invocationId: string, stepId?: string) => {
    live.set(
      live().map((row) =>
        row.invocationId === invocationId && (stepId === undefined || row.stepId === stepId)
          ? { ...row, closedAt: sequence }
          : row,
      ),
    );
  };
  const deliver = (page: any) => {
    if (page.kind === 'queue') {
      if (page.queue.revision >= (queued()?.revision ?? -1)) queued.set(page.queue);
      return;
    }
    if (page.kind === 'interactions') {
      interactionsFromStream = true;
      if (page.pending.revision >= interactions().revision) interactions.set(page.pending);
      return;
    }
    if (page.kind === 'computer_apps') {
      computerApps.set(page.apps);
      return;
    }
    if (page.kind !== 'events') return;
    latestKnown = Math.max(latestKnown, page.through);
    let changed = false;
    for (const event of page.events) {
      if (event.sequence <= watchLast) continue;
      const fact = event.fact;
      const nextTools = updateToolActivity(toolActivity(), event);
      if (nextTools !== toolActivity()) toolActivity.set(nextTools);
      const field = (kind: string) => (kind === 'thinking' ? 'thinking' : 'body');
      switch (fact.kind) {
        case 'opened':
          if (event.sequence > runThrough) {
            run.set('running');
            invocation.set(event.invocationId);
            runTurn.set(event.turnId);
            requestMetadata(rows().find((row) => row.turnId === event.turnId));
            void observe().catch(report);
            runThrough = event.sequence;
          }
          changed = true;
          break;
        case 'executor_started':
          openParts(
            ['text', 'thinking'].map((textKind) => ({
              invocationId: event.invocationId,
              stepId: event.invocationId,
              partId: textKind,
              messageId: fact.messageId,
              field: field(textKind),
              startSequence: event.sequence,
            })),
          );
          changed = true;
          break;
        case 'part_started':
          openParts([
            {
              invocationId: event.invocationId,
              stepId: fact.stepId,
              partId: fact.partId,
              messageId: fact.messageId,
              field: field(fact.textKind),
              startSequence: event.sequence,
            },
          ]);
          break;
        case 'delta': {
          const part = parts().find(
            (part) =>
              part.invocationId === event.invocationId &&
              part.stepId === fact.stepId &&
              part.partId === fact.partId,
          );
          if (!part || canonicalRows().byMessage.has(`${part.messageId}/${part.field}`)) break;
          const key = `live/${part.messageId}/${part.field}`;
          const previous = live().find((row) => row.key === key);
          if (previous?.sequence !== undefined && event.sequence <= previous.sequence) break;
          const next = {
            ...part,
            invocationId: part.invocationId ?? undefined,
            key,
            role: part.field === 'thinking' ? 'thinking' : 'assistant',
            turnId: event.turnId,
            text: (previous?.text ?? '') + fact.text,
            sequence: event.sequence,
            closedAt: null,
          };
          live.set(
            previous ? live().map((row) => (row.key === key ? next : row)) : [...live(), next],
          );
          break;
        }
        case 'part_finished':
          parts.set(
            parts().filter(
              (part) =>
                part.invocationId !== event.invocationId ||
                part.stepId !== fact.stepId ||
                part.partId !== fact.partId,
            ),
          );
          changed = true;
          break;
        case 'step_ended':
          closeLive(event.sequence, event.invocationId, fact.stepId);
          parts.set(
            parts().filter(
              (part) => part.invocationId !== event.invocationId || part.stepId !== fact.stepId,
            ),
          );
          void observe().catch(report);
          changed = true;
          break;
        case 'ended':
          requestMetadata(rows().find((row) => row.turnId === event.turnId));
          closeLive(event.sequence, event.invocationId);
          parts.set(parts().filter((part) => part.invocationId !== event.invocationId));
          if (event.sequence > runThrough) {
            run.set(fact.failed ? 'failed' : 'idle');
            invocation.set(null);
            compacting.set(null);
            runTurn.set(null);
            stoppingRun.set(null);
            void observe().catch(report);
            runThrough = event.sequence;
          }
          changed = true;
          break;
        case 'tool_input_ready':
        case 'tool_dispatched':
        case 'tool_rejected':
        case 'tool_settled':
        case 'provider_tool_result':
        case 'executor_tool_start':
        case 'executor_tool_result':
          changed = true;
          break;
        case 'transcript_changed':
          void observe().catch(report);
          changed = true;
          break;
      }
    }
    watchLast = Math.max(watchLast, page.nextAfter);
    if (changed) void follow().catch(report);
  };

  const openTranscript = async () => {
    if (followTask) await followTask.catch(() => {});
    if (!alive) return;
    // A turn may have ended while its watch was offline. Earlier accepted
    // fragments need the same completion metadata refresh as an ended event.
    const previousTurn = runTurn();
    if (previousTurn !== null) requestMetadata(rows().find((row) => row.turnId === previousTurn));
    const observed = await observe();
    if (!alive) return;
    parts.set(
      observed.parts.map((part: any) => ({
        ...part,
        invocationId: observed.run?.invocationId ?? null,
        field: part.textKind === 'thinking' ? 'thinking' : 'body',
      })),
    );
    const after = replayStartCursor(observed.through, observed.parts, observed.toolSeeds);
    const stream = await host.subscribe('agent', 'watch', { sessionId, after });
    if (!alive) {
      await stream.close();
      return;
    }
    subscription = stream;
    watchLast = after;
    let failure: { reason: unknown } | null = null;
    try {
      // Recall may have opened its exact window before initial history arrived.
      while (windowTask !== null) await windowTask;
      if (!alive) return;
      if (ready()) await follow();
      else if (
        !historyDestination.explicit &&
        (await resetHistory(historyDestination.position, observed.through))
      )
        list?.scrollToEnd({ animated: false });
      if (!alive) return;
      transcriptStatus.set('live');
      if (!historyDestination.failed) error.set('');
      // Subscribe before reading history so facts cannot fall between fences.
      // The snapshot is sufficient for readiness; no new event is required.
      for (;;) {
        const page = await stream.next();
        if (!alive) return;
        if (page === null) throw new UiError('Live updates ended.');
        batch(() => deliver(page));
      }
    } catch (reason) {
      failure = {
        reason: readFailure?.stream === stream ? readFailure.reason : reason,
      };
      throw failure.reason;
    } finally {
      if (alive) transcriptStatus.set('closing');
      try {
        await stream.close();
      } catch (reason) {
        throw new UiError(
          '{observation}; original observation cleanup remains unconfirmed: {reason}',
          {
            observation: failure ? errorText(failure.reason) : uiMessage('Observation stopped'),
            reason: errorText(reason),
          },
        );
      } finally {
        // This replaces only the read-only JS observer. Native Client retains
        // unconfirmed Request custody, within its existing limit, until the
        // original session close acknowledges cleanup. No mutation is replayed.
        if (subscription === stream) subscription = null;
        if (readFailure?.stream === stream) readFailure = null;
      }
    }
  };
  const startTranscript = () => {
    if (!alive || transcriptTask !== null) return;
    transcriptStatus.set('loading');
    error.set('');
    const task: Promise<void> = (async () => {
      for (;;) {
        if (!alive) return;
        transcriptStatus.set('loading');
        try {
          await openTranscript();
          return;
        } catch (reason) {
          if (!alive) return;
          toolActivity.set([]);
          report(reason);
          // Match the desktop catalog's quiet two-second reconnect pause.
          // Only observations repeat; original mutations remain in the journal.
          transcriptStatus.set('failed');
          await new Promise<void>((resolve) => {
            const done = () => {
              wakeReconnect = null;
              resolve();
            };
            const timer = setTimeout(done, 2000);
            wakeReconnect = () => {
              clearTimeout(timer);
              done();
            };
          });
          if (!alive) return;
        }
      }
    })().finally(() => {
      if (transcriptTask !== task) return;
      transcriptTask = null;
      if (alive) transcriptStatus.set('failed');
    });
    transcriptTask = task;
  };
  const retryTranscript = (owner: string) => {
    if (!alive || owner !== sessionId || transcriptStatus() !== 'failed') return;
    // Retry wakes the sole observer task; it never starts a parallel loop.
    if (wakeReconnect) wakeReconnect();
    else if (transcriptTask === null) startTranscript();
  };

  const extendHistory = (direction: 'before' | 'after'): Promise<boolean> => {
    const pending = direction === 'before' ? olderTask : newerTask;
    if (pending) return pending;
    const owner = historyWindow();
    const edge = owner?.[direction];
    if (!owner || !edge || !ownsWindow(owner.identity)) return Promise.resolve(false);
    const task = (async () => {
      let position: HistoryPosition = { kind: direction, cursor: edge };
      for (;;) {
        const page = await history(owner.through, position);
        if (!ownsWindow(owner.identity)) return false;
        const current = historyWindow()!;
        historyWindow.set({ ...current, [direction]: page[direction] });
        if (page.chunks.length || page[direction] === null) {
          publishHistory(page.chunks, page.through, direction === 'before');
          if (historyWindow()?.after === null && latestKnown > page.through)
            void follow().catch(report);
          return true;
        }
        position = { kind: direction, cursor: page[direction]! };
      }
    })()
      .catch((reason) => {
        if (ownsWindow(owner.identity)) report(reason);
        return false;
      })
      .finally(() => {
        if (direction === 'before' && olderTask === task) olderTask = null;
        if (direction === 'after' && newerTask === task) newerTask = null;
      });
    if (direction === 'before') olderTask = task;
    else newerTask = task;
    return task;
  };
  const loadOlder = () => extendHistory('before');
  const loadNewer = () => extendHistory('after');
  const cancelNavigation = (turnId = navigatingTurn()) => {
    if (!alive || turnId !== navigatingTurn()) return;
    navigation.set(null);
    if (windowTask !== null && historyWindow() !== null) {
      // A user scroll/focus change also revokes a pending replacement page.
      // Preserve the displayed window, never revive its earlier requests.
      historyIdentity = {};
      const current = historyWindow();
      if (current) historyWindow.set({ ...current, identity: historyIdentity });
      windowTask = null;
      olderTask = null;
      newerTask = null;
      followTask = null;
      followAgain = false;
    }
  };
  const navigateStart = async () => {
    if (!alive) return;
    const target: HistoryNavigation = { kind: 'start' };
    historyDestination = { position: { kind: 'start' }, explicit: true, failed: false };
    navigation.set(target);
    try {
      const observed = await observe();
      if (!alive || navigation() !== target) return;
      if (
        !(await resetHistory(
          { kind: 'start' },
          observed.through,
          undefined,
          () => navigation() === target,
        ))
      )
        return;
      if (navigation() === target)
        list?.scrollToIndex({ index: 0, viewPosition: 0, animated: false });
    } finally {
      if (navigation() === target) navigation.set(null);
    }
  };
  const revealRow = (row: Row) => {
    reading.set('chat');
    if (row.turnId) {
      const turn = projection().turns.get(row.turnId);
      if (turn) turnState(turn.turnId).expanded.set({ open: true, answerKey: turn.answerKey });
    }
    const id = stableRowId(row);
    const entry = display().find((item) =>
      item.kind === 'row'
        ? item.rowId === id
        : item.kind === 'process' && item.group.rowIds.includes(id),
    );
    if (!entry) throw new UiError('The original message is not available in this conversation.');
    if (entry.kind === 'process') {
      const state = groupState(entry.key);
      state.following.set(false);
      state.opening = undefined;
      state.revealRow = id;
      state.open.set(true);
      state.requestFocus = true;
      innerReader.set(entry.key);
      if (state.list) {
        state.list.scrollToIndex({
          index: entry.group.rowIds.indexOf(id),
          viewPosition: 0,
          animated: false,
        });
        state.list.focus();
        state.revealRow = undefined;
        state.requestFocus = false;
      }
    } else {
      innerReader.set(null);
      list?.focus();
    }
    awayFromLatest.set(true);
    list?.scrollToIndex({
      index: displayKeys().indexOf(entry.key),
      viewPosition: 0,
      animated: false,
    });
  };
  const reveal = async (anchor: ConversationAnchor, current: () => boolean) => {
    if (!alive) throw new UiError('This conversation is closed.');
    if (!current()) throw new UiError('History navigation was cancelled.');
    const target: HistoryNavigation = { kind: 'message', anchor };
    const destination = {
      position: { kind: 'row' as const, position: anchor.position, field: 'body' as const },
      explicit: true,
      failed: false,
    };
    historyDestination = destination;
    navigation.set(target);
    try {
      const observed = await observe();
      if (!alive || navigation() !== target || !current())
        throw new UiError('History navigation was cancelled.');
      const opened = await resetHistory(
        { kind: 'row', position: anchor.position, field: 'body' },
        observed.through,
        (page) => {
          if (
            !page.chunks.some(
              (chunk) =>
                chunk.messageId === anchor.messageId &&
                chunk.field === 'body' &&
                chunk.offset === 0 &&
                comparePosition(chunk.position, anchor.position) === 0,
            )
          )
            throw new UiError('The original message could not be verified.');
        },
        () => navigation() === target && current(),
      );
      if (!opened || !alive || navigation() !== target || !current())
        throw new UiError('History navigation was cancelled.');
      const row = rows().find(
        (candidate) =>
          candidate.messageId === anchor.messageId &&
          candidate.field === 'body' &&
          candidate.position &&
          comparePosition(candidate.position, anchor.position) === 0,
      );
      if (!row) throw new UiError('The original message is no longer available.');
      if (!current()) throw new UiError('History navigation was cancelled.');
      revealRow(row);
    } catch (reason) {
      if (historyDestination === destination) destination.failed = true;
      if (alive && current() && navigation() === target) report(reason);
      throw reason;
    } finally {
      if (navigation() === target) navigation.set(null);
    }
  };
  const navigateTurn = async (item: TurnNavigationItem) => {
    if (!alive) return;
    const target: HistoryNavigation = { kind: 'turn', item };
    historyDestination = {
      position: { kind: 'event', sequence: item.anchor.position.sourceSequence },
      explicit: true,
      failed: false,
    };
    navigation.set(target);
    try {
      const observed = await observe();
      if (!alive || navigation() !== target) return;
      if (
        !(await resetHistory(
          { kind: 'event', sequence: item.anchor.position.sourceSequence },
          observed.through,
          (page) => {
            if (!page.chunks.some((chunk) => chunk.turnId === item.turnId))
              throw new UiError('This turn is no longer available.');
          },
          () => navigation() === target,
        ))
      )
        return;
      if (navigation() !== target) return;
      const row = rows().find((candidate) => candidate.turnId === item.turnId);
      if (!row) throw new UiError('This turn is no longer available.');
      revealRow(row);
    } finally {
      if (navigation() === target) navigation.set(null);
    }
  };

  // A slow disk retains one in-flight snapshot and one replaceable latest
  // edit, rather than one complete draft and Promise closure per keystroke.
  const startSave = () => {
    if (saveTask || pendingDraft === null || !alive || savingFailed()) return;
    saveTask = (async () => {
      while (alive && pendingDraft !== null) {
        const edit = pendingDraft;
        pendingDraft = null;
        const saved = await saveDraft(client, draftRevision, edit);
        if (!alive) return;
        draftRevision = saved.revision;
        attachments.saved(edit);
      }
    })()
      .catch((reason) => {
        if (alive) savingFailed.set(true);
        report(reason);
      })
      .finally(() => {
        saveTask = null;
        if (alive && pendingDraft !== null) startSave();
      });
  };
  const flushDraft = async () => {
    while (alive && !savingFailed() && (saveTask || pendingDraft !== null)) {
      startSave();
      await saveTask;
    }
  };
  const queueDraft = (edit: AttachmentEdit & { text: string }) => {
    if (holding) {
      heldDraft = edit;
      return;
    }
    pendingDraft = edit;
    startSave();
  };
  const changeDraft = (text: string) => {
    if (!alive || !draftReady()) return;
    editEpoch += 1;
    draft.set(text);
    queueDraft({ text, ...attachments.snapshot() });
  };
  // Saves what was edited while a send was being reserved; whether there was any.
  const releaseHeld = () => {
    holding = false;
    const edit = heldDraft;
    heldDraft = null;
    if (edit === null || !alive) return false;
    pendingDraft = edit;
    startSave();
    return true;
  };
  const acceptRecoveredDraft = (
    stored: { revision: number; text: string; attachments: DraftAttachment[] },
    epoch: number,
  ) => {
    if (
      editEpoch === epoch &&
      draftRevision === stored.revision &&
      !savingFailed() &&
      pendingDraft === null &&
      saveTask === null
    ) {
      draft.set(stored.text);
      attachments.restore(stored.attachments);
    }
  };

  const backendIdentity = (value: any): BackendIdentity =>
    value?.kind === 'model'
      ? {
          connectionId: value.connectionId,
          modelId: value.modelId,
          thinkingLevel: value.thinkingLevel ?? null,
        }
      : null;
  const sameBackend = (left: BackendIdentity, right: BackendIdentity) =>
    left === null || right === null
      ? left === right
      : left.connectionId === right.connectionId &&
        left.modelId === right.modelId &&
        left.thinkingLevel === right.thinkingLevel;
  // Metadata follows the route's value, not observe()'s newly allocated backend
  // objects or live stream state. The durable backend remains the only choice.
  const modelRoute = computed(() => {
    const value = backendIdentity(backend());
    return value === null ? null : JSON.stringify([value.connectionId, value.modelId]);
  });
  const modelProjection = signal<{
    route: string | null;
    details: ModelDetails;
  }>({
    route: null,
    details: { kind: 'unavailable', message: uiMessage('Choose a model.') },
  });
  let modelGeneration = 0;
  let modelRead: {
    route: string;
    generation: number;
    task: Promise<void>;
  } | null = null;
  const modelDetails = (): ModelDetails => {
    const value = modelProjection();
    return value.route === modelRoute() ? value.details : { kind: 'loading' };
  };
  const refreshModel = (): Promise<void> => {
    if (!alive) return Promise.resolve();
    const route = modelRoute();
    const captured = backendIdentity(backend());
    if (route === null || captured === null) {
      modelGeneration += 1;
      modelRead = null;
      modelProjection.set({
        route: null,
        details: { kind: 'unavailable', message: uiMessage('Choose a model.') },
      });
      return Promise.resolve();
    }
    if (modelRead?.route === route) return modelRead.task;
    const generation = ++modelGeneration;
    modelProjection.set({ route, details: { kind: 'loading' } });
    const current = () => alive && generation === modelGeneration && modelRoute() === route;
    const task = Promise.resolve().then(async () => {
      try {
        if (!current()) return;
        const result = await host.query('settings', 'resolveModel', {
          connectionId: captured.connectionId,
          modelId: captured.modelId,
        });
        if (!current()) return;
        modelProjection.set({
          route,
          details:
            result.kind === 'ready' && sameRoute(captured, result.choice.selection)
              ? { kind: 'ready', choice: result.choice }
              : {
                  kind: 'unavailable',
                  message: uiMessage('Model unavailable: {model}.', { model: captured.modelId }),
                },
        });
      } catch (reason) {
        if (current())
          modelProjection.set({
            route,
            details: { kind: 'unavailable', message: errorText(reason) },
          });
      } finally {
        if (modelRead?.generation === generation) modelRead = null;
      }
    });
    modelRead = { route, generation, task };
    return task;
  };
  effect(() => {
    modelRoute();
    untracked(() => void refreshModel());
  });
  const selection = async (expectedBackend?: BackendIdentity) => {
    const observed = await observe();
    if (!alive) return null;
    const backend = observed.session.backend ?? observed.rememberedBackend;
    if (expectedBackend !== undefined && !sameBackend(backendIdentity(backend), expectedBackend))
      throw new UiError('The model changed before confirmation. Send again to confirm it.');
    if (backend?.kind !== 'model') throw new UiError('Choose a model before sending.');
    const resolved = await host.query('settings', 'resolveModel', {
      connectionId: backend.connectionId,
      modelId: backend.modelId,
    });
    if (!alive) return null;
    if (resolved.kind !== 'ready')
      throw new UiError('Model unavailable: {model}. Choose another model.', {
        model: backend.modelId,
      });
    return { model: resolved.choice.selection, thinkingLevel: backend.thinkingLevel ?? null };
  };

  const settleReply = (
    reply: any,
    text?: string,
    epoch?: number,
    files: DraftAttachment[] = [],
  ) => {
    const accepted = acceptedSend(reply, sessionId);
    if (!accepted) {
      notice.set(receiptMessage(reply));
      return;
    }
    if (
      accepted.kind === 'started' &&
      text !== undefined &&
      !canonicalRows().byMessage.has(`${accepted.messageId}/body`)
    ) {
      pendingMessages.set([
        ...pendingMessages().filter((row) => row.messageId !== accepted.messageId),
        {
          key: `pending/${accepted.messageId}`,
          messageId: accepted.messageId,
          field: 'body',
          role: 'user',
          text,
          attachments: files.map(
            (file): AgentHistoryAttachment => ({
              name: file.name,
              mimeType: file.mimeType,
              bytes: file.bytes,
              kind: file.mimeType.startsWith('image/') ? 'image' : 'other',
            }),
          ),
        },
      ]);
    }
    if (text !== undefined && editEpoch === epoch && draft() === text) draft.set('');
    if (text !== undefined) attachments.sent(files.map((file) => file.id));
    notice.set(
      accepted.kind === 'started' && text === undefined ? uiMessage('Message accepted.') : '',
    );
    if (accepted.kind === 'queued') return;
    cancelNavigation();
    awayFromLatest.set(false);
    innerReader.set(null);
    list?.scrollToEnd({ animated: false });
  };

  const sendBlockedReason = () => {
    if (transcriptStatus() === 'closing')
      return tr('Closing disconnected updates… Your draft is kept.');
    if (transcriptStatus() === 'failed')
      return ready()
        ? tr('Updates disconnected. Reconnecting automatically; your draft is kept.')
        : tr('History unavailable. Retrying automatically; your draft is kept.');
    if (ready() && transcriptStatus() !== 'live')
      return tr('Reconnecting updates… Your draft is kept.');
    if (!ready()) return tr('Loading session history… Your draft is kept.');
    if (archived())
      return tr(
        'This conversation is archived. Restore it in Sessions to send; your draft is kept.',
      );
    if (!draftReady()) return tr('Loading the saved draft…');
    if (savingFailed()) return tr('The draft could not be saved. Sending is unavailable.');
    if (attachments.blocked()) return attachments.blocked();
    if (sending()) return tr('Confirming send… New typing is kept.');
    if (recovering()) return tr('Reading original receipts… New typing is kept.');
    if (!receiptsKnown() || unresolved().length)
      return tr('Sending waits for the original receipt; it will not be replayed.');
    return '';
  };
  const send = async (text: string, expectedBackend?: BackendIdentity) => {
    if (!alive || (!text.trim() && attachments.files().length === 0)) return;
    if (sendBlockedReason()) {
      notice.set(
        uiMessage(
          'This message was not sent. Your draft is kept; check the status below before trying again.',
        ),
      );
      return;
    }
    if (draft() !== text) changeDraft(text);
    const epoch = editEpoch;
    const files = [...attachments.files()];
    sending.set(true);
    error.set('');
    holding = true;
    try {
      const model = await selection(expectedBackend);
      if (!alive || model === null) return;
      if (!(await projectMcp.check()) || !alive) return;
      await flushDraft();
      if (!alive) return;
      if (savingFailed()) throw new UiError('The draft could not be saved; it has not been sent.');
      if (editEpoch !== epoch && heldDraft === null)
        throw new UiError('The draft changed before confirmation. Send again to confirm it.');
      if (
        expectedBackend !== undefined &&
        !sameBackend(backendIdentity(backend()), expectedBackend)
      )
        throw new UiError('The model changed before confirmation. Send again to confirm it.');
      // The native journal consumes only this exact revision. New edits keep
      // saving while confirmation waits and never inherit this send attempt.
      receiptsKnown.set(false);
      const operation = await reserveSend(client, draftRevision, model);
      const typedAhead = releaseHeld();
      const sent = await confirmSend(client, operation);
      if (!alive) return;
      settleReply(sent.reply, text, epoch, files);
      // Text typed before the send was reserved continues the sent message in
      // the composer; once it is accepted, only the continuation stays. A
      // rejected send leaves its text in the draft, so the whole edit stays.
      if (typedAhead && acceptedSend(sent.reply, sessionId) && draft().startsWith(text))
        changeDraft(draft().slice(text.length));
    } catch (reason) {
      report(reason);
    } finally {
      releaseHeld();
      try {
        if (alive) {
          const operations = await pendingSends(client);
          if (alive) {
            unresolved.set(operations);
            receiptsKnown.set(true);
          }
        }
      } catch (reason) {
        report(reason);
      }
      if (alive) sending.set(false);
    }
  };

  const recover = async () => {
    if (!alive || recovering() || sending()) return;
    recovering.set(true);
    const epoch = editEpoch;
    await flushDraft();
    if (!alive) return;
    try {
      const originals = await pendingSends(client);
      if (!alive) return;
      unresolved.set(originals);
      receiptsKnown.set(true);
      for (const original of originals) {
        if (!original.reference) {
          notice.set(
            uiMessage(
              'An attempt was not confirmed. Explicitly abandon it below before starting a new send.',
            ),
          );
          continue;
        }
        const reply = await recoverSend(client, original.id);
        if (!alive) return;
        settleReply(reply);
      }
      const stored = await loadDraft(client);
      if (!alive) return;
      acceptRecoveredDraft(stored, epoch);
      const remaining = await pendingSends(client);
      if (!alive) return;
      unresolved.set(remaining);
    } catch (reason) {
      report(reason);
    } finally {
      if (alive) recovering.set(false);
    }
  };

  const abandon = async (operationId: string) => {
    if (!alive || recovering() || sending()) return;
    recovering.set(true);
    const epoch = editEpoch;
    try {
      const original = await abandonSend(client, operationId);
      if (!alive) return;
      if (original.abandoned) {
        notice.set(
          uiMessage(
            'Unconfirmed attempt abandoned. The draft is kept; press Enter explicitly to send a new attempt.',
          ),
        );
      } else if (original.reference) {
        const reply = await recoverSend(client, operationId);
        if (!alive) return;
        settleReply(reply);
        const stored = await loadDraft(client);
        if (!alive) return;
        acceptRecoveredDraft(stored, epoch);
      }
      const operations = await pendingSends(client);
      if (!alive) return;
      unresolved.set(operations);
      receiptsKnown.set(true);
    } catch (reason) {
      report(reason);
    } finally {
      if (alive) recovering.set(false);
    }
  };

  const stop = async (invocationId: string | null) => {
    if (!alive || !invocationId || invocation() !== invocationId || stopping()) return;
    stoppingRun.set(invocationId);
    try {
      const result = await props.control('stop', { sessionId, invocationId });
      if (!alive) return;
      if (!result.requested) await observe();
      // A requested cancellation is not an ended run. The watch owns that fact.
    } catch (reason) {
      if (alive && stoppingRun() === invocationId) stoppingRun.set(null);
      report(reason);
    }
  };
  const chooseReading = ({ owner, mode }: { owner: string; mode: 'chat' | 'trajectory' }) => {
    if (alive && owner === sessionId) {
      cancelNavigation();
      reading.set(mode);
    }
  };
  const sendRendered = ({
    owner,
    text,
    backend: expectedBackend,
    attachments: files,
  }: SendAction) => {
    if (
      !alive ||
      owner !== sessionId ||
      draft() !== text ||
      !attachments.same(files) ||
      !sameBackend(backendIdentity(backend()), expectedBackend)
    )
      return;
    void send(text, expectedBackend);
  };
  const queueSession: QueueSession = {
    sessionId,
    snapshot: queued,
    running: () => invocation() !== null && !stopping(),
    async read(messageId, expectedRevision) {
      if (!alive) throw new UiError('This conversation is closed.');
      return host.query('agent', 'queueMessage', { sessionId, messageId, expectedRevision });
    },
    async change(expectedRevision, edit) {
      if (!alive) throw new UiError('This conversation is closed.');
      return props.control('editQueue', { sessionId, expectedRevision, edit });
    },
  };
  const ownHandle: ConversationHandle = {
    sessionId,
    title: () => title() || tr('Untitled conversation'),
    queue: queueSession,
    interactions,
    computerApps,
    draft,
    attachments,
    previewImage: props.previewImage,
    editable: () => draftReady() && !savingFailed(),
    blockedReason: sendBlockedReason,
    backend: () => backendIdentity(backend()),
    modelDetails,
    refreshModel,
    permissions,
    projectMcp,
    workspace,
    empty: () =>
      ready() &&
      invocation() === null &&
      rows().length === 0 &&
      live().length === 0 &&
      pendingMessages().length === 0 &&
      (queued()?.entries.length ?? 0) === 0 &&
      toolActivity().length === 0,
    error,
    notice,
    recoverable: () => !sending() && draftReady() && (!receiptsKnown() || unresolved().length > 0),
    recovering: () => recovering() || sending(),
    unconfirmed: () =>
      unresolved()
        .filter((original) => !original.reference)
        .map((original) => original.id),
    stopping,
    metrics: () => metricText(metrics()),
    changeDraft,
    submit(event) {
      void send(event.text);
    },
    sendRendered,
    recover,
    abandon,
    invocation,
    activeTurn: runTurn,
    activityTurn: () => {
      const group = projection().entries.findLast((entry) => entry.kind === 'process');
      return group?.kind === 'process' ? group.turnId : null;
    },
    async flushDraft() {
      if (!draftReady()) {
        notice.set(uiMessage('Wait for the saved draft before switching.'));
        return false;
      }
      await flushDraft();
      // Edits can arrive while the saved draft is being flushed. Held edits
      // must survive until the send reserves them, before this view is disposed.
      if (heldDraft !== null) {
        notice.set(uiMessage('Wait for the message to send before switching.'));
        return false;
      }
      return !savingFailed();
    },
    focus() {
      cancelNavigation();
      props.focusComposer();
    },
    reveal,
    focusHistory() {
      cancelNavigation();
      list?.focus();
    },
    focusActivity(turnId) {
      cancelNavigation();
      const group = projection().entries.findLast(
        (entry) => entry.kind === 'process' && entry.turnId === turnId,
      );
      if (group?.kind !== 'process') {
        const index = display().findLastIndex(
          (entry) =>
            entry.kind === 'row' && projection().rowsById.get(entry.rowId)?.turnId === turnId,
        );
        if (index >= 0) {
          list?.scrollToIndex({ index, viewPosition: 0 });
          list?.focus();
        }
        return;
      }
      const turn = projection().turns.get(group.turnId);
      if (!turn) return;
      turnState(turn.turnId).expanded.set({
        open: true,
        answerKey: turn.answerKey,
      });
      const state = groupState(group.key);
      if (!state.open()) {
        innerReader.set(group.closed ? group.key : null);
        state.opening = group.closed ? 'top' : 'bottom';
        state.following.set(!group.closed);
      }
      state.open.set(true);
      const index = displayKeys().indexOf(group.key);
      if (index >= 0) list?.scrollToIndex({ index, viewPosition: 0 });
      state.requestFocus = true;
      if (state.list) {
        state.requestFocus = false;
        state.list.focus();
      } else list?.focus();
    },
    jumpLatest(turnId) {
      if (!alive) return;
      const target: HistoryNavigation = { kind: 'tail' };
      historyDestination = { position: { kind: 'tail' }, explicit: true, failed: false };
      navigation.set(target);
      props.focusComposer();
      void (async () => {
        try {
          const observed = await observe();
          if (!alive || navigation() !== target) return;
          if (
            !(await resetHistory(
              { kind: 'tail' },
              observed.through,
              undefined,
              () => navigation() === target,
            )) ||
            navigation() !== target
          )
            return;
          awayFromLatest.set(false);
          innerReader.set(null);
          const group = projection().entries.findLast(
            (entry) => entry.kind === 'process' && entry.turnId === (turnId ?? runTurn()),
          );
          if (group?.kind === 'process') {
            const state = groupState(group.key);
            state.following.set(true);
            if (state.list) state.list.scrollToEnd({ animated: false });
            else state.opening = 'bottom';
          }
          list?.scrollToEnd({ animated: false });
        } finally {
          if (navigation() === target) navigation.set(null);
        }
      })().catch(report);
    },
    stop,
    async compact(prompt) {
      if (!alive) return;
      if (invocation() !== null) throw new UiError('Wait for the current run before compacting.');
      const expectedBackend = backendIdentity(backend());
      if (expectedBackend === null) throw new UiError('Choose a model before compacting.');
      const model = await selection(expectedBackend);
      if (!alive || model === null) return;
      if (!sameBackend(backendIdentity(backend()), expectedBackend))
        throw new UiError('The model changed before confirmation. Send again to confirm it.');
      const result = await props.control('compact', {
        sessionId,
        model: model.model,
        thinkingLevel: model.thinkingLevel,
        prompt: prompt?.trim() || null,
      });
      if (!alive) return;
      if (result.kind !== 'started')
        throw new UiError('Context compaction rejected: {reason}', { reason: result.reason });
      await observe();
      ownHandle.jumpLatest(null);
    },
    refresh: observe,
  };
  const readTarget = () => {
    const observed = readState();
    const exposure = readExposure();
    if (
      !alive ||
      !props.visible() ||
      !props.foreground() ||
      !observed.hasUnread ||
      !ready() ||
      !atHistoryTail() ||
      awayFromLatest() ||
      navigation() !== null ||
      invocation() !== null ||
      observed.through < runThrough ||
      (historyWindow()?.through ?? -1) < observed.through ||
      observed.tailMessageId === null
    )
      return null;
    const tail = rows().findLast((row) => row.messageId === observed.tailMessageId);
    if (!tail?.position) return null;
    const id = stableRowId(tail);
    const entry = display().find((item) =>
      item.kind === 'row'
        ? item.rowId === id
        : item.kind === 'process' && item.group.rowIds.includes(id),
    );
    if (!entry || !visibleRows().has(entry.key)) return null;
    if (entry.kind === 'process') {
      const state = groupState(entry.key);
      if (
        !state.open() ||
        !state.visibleRows().has(id) ||
        (innerReader() !== null && innerReader() !== entry.key) ||
        !state.list ||
        !state.rowNodes.get(id) ||
        !list
      )
        return null;
      return {
        kind: 'process' as const,
        observed,
        exposure,
        tail,
        state,
        row: state.rowNodes.get(id)!,
        reader: state.list,
        viewport: list,
        lease: state.lease,
        identity: historyIdentity,
      };
    }
    if (innerReader() !== null) return null;
    return { kind: 'row' as const, observed, exposure, tail, identity: historyIdentity };
  };
  effect(() => {
    if (!props.visible() || !props.foreground()) {
      attemptedRead = null;
      return;
    }
    if (acknowledging()) return;
    const target = readTarget();
    if (!target) return;
    if (
      attemptedRead?.revision === target.observed.revision &&
      attemptedRead.messageId === target.tail.messageId &&
      attemptedRead.exposure === target.exposure
    )
      return;
    attemptedRead = {
      revision: target.observed.revision,
      messageId: target.tail.messageId,
      exposure: target.exposure,
    };
    acknowledging.set(true);
    void (async () => {
      if (target.kind === 'process') {
        // Nested List viewability is local. Intersect the real row with both
        // scroll viewports so a group header alone cannot acknowledge its tail.
        const measured = await Promise.all([
          target.row.measure(),
          target.reader.measure(),
          target.viewport.measure(),
        ]);
        if (measured.some((bounds) => bounds === null)) return;
        const left = Math.max(...measured.map((bounds) => bounds!.pagePosition.x));
        const top = Math.max(...measured.map((bounds) => bounds!.pagePosition.y));
        const right = Math.min(
          ...measured.map((bounds) => bounds!.pagePosition.x + bounds!.bounds.size.width),
        );
        const bottom = Math.min(
          ...measured.map((bounds) => bounds!.pagePosition.y + bounds!.bounds.size.height),
        );
        if (left >= right || top >= bottom) return;
      }
      const current = readTarget();
      if (
        !current ||
        current.identity !== target.identity ||
        current.exposure !== target.exposure ||
        current.observed.revision !== target.observed.revision ||
        current.tail.messageId !== target.tail.messageId ||
        (target.kind === 'process' &&
          (current.kind !== 'process' ||
            current.state !== target.state ||
            current.lease !== target.lease))
      )
        return;
      const attempt = await host.control('markRead', {
        sessionId,
        messageId: target.tail.messageId,
      });
      const reply = attempt.reply as OperationReply;
      if (reply.receipt.kind !== 'recorded' || reply.receipt.outcome.kind !== 'returned')
        throw new UiError('The read confirmation is still unknown.');
      const result = reply.receipt.outcome.value as AgentMarkReadResult;
      if (!alive) return;
      if (result.kind === 'rejected')
        throw new UiError('Read confirmation rejected: {reason}', { reason: result.reason });
      acceptReadState(result.session);
    })()
      .catch(report)
      .finally(() => {
        if (alive) acknowledging.set(false);
      });
  });
  props.attach(ownHandle);

  cleanup(() => {
    alive = false;
    historyIdentity = {};
    navigation.set(null);
    wakeReconnect?.();
    modelGeneration += 1;
    modelRead = null;
    toolActivity.set([]);
    props.detach(ownHandle);
    const stream = subscription;
    subscription = null;
    if (stream !== null) void stream.close().catch(() => {});
  });
  effect(() =>
    untracked(() => {
      void host
        .query('agent', 'pendingInteractions', { sessionId })
        .then((pending) => {
          if (alive && !interactionsFromStream && pending.revision >= interactions().revision)
            interactions.set(pending);
        })
        .catch(report);
      startTranscript();
      void (async () => {
        const stored = await loadDraft(client);
        if (!alive) return;
        draftRevision = stored.revision;
        draft.set(stored.text);
        attachments.restore(stored.attachments);
        draftReady.set(true);
        void attachments.start();
        const operations = await pendingSends(client);
        if (!alive) return;
        unresolved.set(operations);
        receiptsKnown.set(true);
        if (operations.length) await recover();
      })().catch(report);
    }),
  );

  const railShown = () => ready() && navigationItems().length > 1;
  const rail = () => (
    <TurnNavigation
      items={navigationItems}
      active={visibleTurn}
      busy={navigatingTurn}
      navigate={(item) => {
        void navigateTurn(item).catch(report);
      }}
      cancel={inputAction(cancelNavigation, navigatingTurn())}
    />
  );
  return (
    <View
      ref={(node) => root.set(node)}
      style={{
        flex: ownHandle.empty() ? 0 : 1,
        flexBasis: 'auto',
        flexShrink: 0,
        minHeight: 0,
        backgroundColor: C.background,
      }}
    >
      <If when={attachmentMetadataFailed()}>
        <Button
          onPress={inputAction(retryAttachmentMetadata, sessionId)}
          style={{ ...controlStyle, alignSelf: 'flex-start' }}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={{ backgroundColor: C.raised }}
        >
          <Text style={{ ...captionTextStyle, color: C.accent }}>
            {tr('Retry attachment metadata')}
          </Text>
        </Button>
      </If>
      <Header
        title={title() || tr('Untitled conversation')}
        workspace={workspace()}
        status={
          stopping()
            ? 'stopping'
            : run() === 'loading'
              ? 'loading'
              : run() === 'failed'
                ? 'failed'
                : undefined
        }
        commands={props.commands}
        browser={props.browser()}
        files={props.files}
        filesOpener={props.filesOpener}
      />
      <If when={transcriptStatus() === 'failed'}>
        <Button
          accessibilityLabel={ready() ? tr('Reconnect updates') : tr('Retry loading conversation')}
          onPress={inputAction(retryTranscript, sessionId)}
          style={{
            ...controlStyle,
            alignSelf: 'flex-start',
            backgroundColor: C.raised,
          }}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={{ backgroundColor: C.line }}
        >
          <Text style={{ ...captionTextStyle, color: C.accent }}>
            {ready() ? tr('Reconnect updates') : tr('Retry loading conversation')}
          </Text>
        </Button>
      </If>
      <View
        style={{
          display: ownHandle.empty() ? 'none' : 'flex',
          flexDirection: 'row',
          flexWrap: 'wrap',
          paddingHorizontal: 16,
          gap: 8,
          paddingVertical: 4,
          borderBottomWidth: 1,
          borderBottomColor: C.surface,
        }}
      >
        <Button
          role="tab"
          accessibilityLabel={tr('Chat')}
          selected={reading() === 'chat'}
          style={controlStyle}
          onPress={inputAction(chooseReading, { owner: sessionId, mode: 'chat' })}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={{ backgroundColor: C.raised }}
          activeStyle={{ backgroundColor: C.line }}
        >
          <Text
            style={{
              color: reading() === 'chat' ? C.accent : C.muted,
              fontWeight: reading() === 'chat' ? '700' : '400',
            }}
          >
            {tr('Chat')}
          </Text>
        </Button>
        <Button
          role="tab"
          accessibilityLabel={tr('Trajectory')}
          selected={reading() === 'trajectory'}
          style={controlStyle}
          onPress={inputAction(chooseReading, { owner: sessionId, mode: 'trajectory' })}
          hoverStyle={{ backgroundColor: C.surface }}
          focusStyle={{ backgroundColor: C.raised }}
          activeStyle={{ backgroundColor: C.line }}
        >
          <Text
            style={{
              color: reading() === 'trajectory' ? C.accent : C.muted,
              fontWeight: reading() === 'trajectory' ? '700' : '400',
            }}
          >
            {tr('Trajectory')}
          </Text>
        </Button>
      </View>
      <View
        style={{
          display: ownHandle.empty() ? 'none' : 'flex',
          flex: 1,
          flexDirection: 'column',
          minHeight: 0,
          width: '100%',
          // Reserve the desktop rail's width so it never overlaps the reading column.
          paddingHorizontal: !platform.isTerminal && railShown() ? railWidth() + 8 : 0,
        }}
      >
        <View
          style={{
            flex: 1,
            flexDirection: 'column',
            minHeight: 0,
            width: '100%',
            maxWidth: 800,
            alignSelf: 'center',
            paddingHorizontal: 16,
          }}
        >
          <View style={{ flex: 1, minHeight: 0, flexDirection: 'row' }}>
            <List
              ref={list}
              onLayout={({ bounds: frame }) => {
                readingSize.set(frame.size);
                changedReadExposure();
              }}
              each={displayKeys()}
              onScrollIntent={(event) => {
                if (event.intent === 'start') void navigateStart().catch(report);
                else cancelNavigation();
              }}
              onBlur={() => {
                // Latest returns to editing immediately; its expected blur does
                // not revoke the pending history read or later steal focus back.
                if (navigation()?.kind !== 'tail') cancelNavigation();
              }}
              onViewableItemsChange={(event) => {
                visibleTurn.set(entryTurn(event.viewableItems[0]?.item ?? ''));
                visibleRows.set(new Set(event.viewableItems.map((item) => item.item)));
                changedReadExposure();
              }}
              estimatedItemSize={96}
              maintainVisibleContentPosition={
                atHistoryTail() && innerReader() === null && navigation() === null
                  ? { autoscrollToBottomThreshold: 32 }
                  : {}
              }
              contentStyle={{ paddingRight: 8, paddingBottom: platform.isTerminal ? 0 : 16 }}
              style={{ flex: 1, minHeight: 0 }}
              onScroll={(event) => {
                changedReadExposure();
                awayFromLatest.set(
                  !atHistoryTail() ||
                    event.offset.y < Math.max(0, event.contentSize.height - event.size.height) - 32,
                );
                const reader = innerReader();
                const row = reader === null ? undefined : projection().rowsById.get(reader);
                const toolReader =
                  reader !== null &&
                  displayByKey().get(reader)?.kind === 'row' &&
                  (row?.tool != null || row?.role === 'tool_call' || row?.role === 'tool_result') &&
                  rowStates.get(reader)?.expanded() === true;
                if (
                  reader !== null &&
                  !groupStates.get(reader)?.list &&
                  !toolReader &&
                  event.offset.y >= Math.max(0, event.contentSize.height - event.size.height) - 1
                )
                  innerReader.set(null);
                if (event.offset.y <= 32) void loadOlder();
                if (
                  event.offset.y >=
                  Math.max(0, event.contentSize.height - event.size.height) - 32
                )
                  void loadNewer();
              }}
              empty={
                <Text style={{ color: C.muted, paddingVertical: 32 }}>
                  {tr('Loading session history…')}
                </Text>
              }
            >
              {(key) => (
                <Each of={[key()]} key={(id: string) => id}>
                  {(ownedKey) => {
                    const initial = displayByKey().get(ownedKey());
                    if (!initial) return <View />;
                    const entry = () => displayByKey().get(ownedKey()) ?? initial;
                    const reveal = () =>
                      list?.scrollToIndex({
                        index: displayKeys().indexOf(ownedKey()),
                        viewPosition: 0,
                        animated: false,
                      });
                    if (initial.kind === 'summary') {
                      const first = projection().turns.get(initial.turnId);
                      if (!first) return <View />;
                      const turn = () => projection().turns.get(initial.turnId) ?? first;
                      return (
                        <TurnSummary
                          turn={turn}
                          expanded={() => turnExpanded(turn())}
                          canFold={() => canFoldTurn(turn())}
                          toggle={(open) => {
                            turnState(initial.turnId).expanded.set({
                              open,
                              answerKey: turn().answerKey,
                            });
                            if (open) reveal();
                          }}
                        />
                      );
                    }
                    if (initial.kind === 'process') {
                      const group = () => {
                        const latest = entry();
                        return latest.kind === 'process' ? latest.group : initial.group;
                      };
                      const first = projection().turns.get(initial.group.turnId);
                      if (!first) return <View />;
                      const turn = () => projection().turns.get(initial.group.turnId) ?? first;
                      const tool = () =>
                        latestToolActivity(
                          toolActivity().filter((item) => group().toolIds.includes(item.toolUseId)),
                          invocation(),
                          group().turnId,
                        );
                      return (
                        <TurnPanel
                          group={group}
                          turn={turn}
                          toolActivity={tool}
                          state={groupState(initial.group.key)}
                          row={currentRow}
                          rowState={rowState}
                          sessionId={sessionId}
                          through={() => latestKnown}
                          previewImage={props.previewImage}
                          openLink={props.openLink}
                          userScroll={() => cancelNavigation()}
                          reveal={reveal}
                          activity={activity}
                          viewport={readingSize}
                          reading={(away) => {
                            changedReadExposure();
                            if (away) innerReader.set(initial.group.key);
                            else if (innerReader() === initial.group.key) innerReader.set(null);
                          }}
                        />
                      );
                    }
                    const first = currentRow(initial.rowId);
                    if (!first) return <View />;
                    const row = () => currentRow(initial.rowId) ?? first;
                    return (
                      <MessageRow
                        item={row}
                        repeats={() => {
                          const item = displayByKey().get(initial.rowId);
                          return item?.kind === 'row' ? (item.repeats ?? 1) : 1;
                        }}
                        toolMaxHeight={() => readingSize().height}
                        ownerKey={() => initial.rowId}
                        viewState={rowState(initial.rowId)}
                        sessionId={sessionId}
                        through={() => latestKnown}
                        previewImage={props.previewImage}
                        openLink={props.openLink}
                        userScroll={() => cancelNavigation()}
                        onExpand={reveal}
                        onToolReading={(key) => {
                          if (
                            !alive ||
                            key !== initial.rowId ||
                            displayByKey().get(key)?.kind !== 'row' ||
                            !rowStates.get(key)?.expanded()
                          )
                            return;
                          innerReader.set(key);
                        }}
                        finalActions={(row, ownerKey) => (
                          <FinalActions
                            row={row}
                            ownerKey={ownerKey}
                            sessionId={sessionId}
                            through={() => latestKnown}
                            fork={props.fork}
                          />
                        )}
                      />
                    );
                  }}
                </Each>
              )}
            </List>
            <If when={platform.isTerminal && railShown()}>{rail()}</If>
            <ReturnToLatest
              visible={awayFromLatest() || innerReader() !== null}
              activate={inputAction(ownHandle.jumpLatest, null)}
            />
          </View>
          <Each of={compacting() === null ? [] : [compacting()!]} key={(progress) => progress.id}>
            {(progress) => (
              <CompactionDivider state="running" startedAt={() => progress().startedAt} />
            )}
          </Each>
        </View>
        <If when={!platform.isTerminal && railShown()}>
          <View style={{ position: 'absolute', top: 0, bottom: 0, right: 8, flexDirection: 'row' }}>
            {rail()}
          </View>
        </If>
      </View>
    </View>
  );
}
function metricText(value: any): string {
  if (!value) return '';
  const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const parts: string[] = [];
  if (value.outputTokensPerSecond != null)
    parts.push(tr('{speed} tok/s', { speed: value.outputTokensPerSecond.toFixed(1) }));
  if (value.contextTokens != null) {
    const context = `${value.approximate || value.contextLastKnown ? '≈' : ''}${compact(value.contextTokens)}`;
    const total = value.contextWindow != null ? ` / ${compact(value.contextWindow)}` : '';
    const percent =
      value.contextWindow > 0
        ? ` · ${Math.round((value.contextTokens / value.contextWindow) * 100)}%`
        : '';
    parts.push(`${tr('Context')} ${context}${total}${percent}`);
  }
  return parts.join(' · ');
}
