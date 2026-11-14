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

import { createTrajectoryRequests } from './trajectoryRequests';
import { sendReceiptFailure } from './sendReceipt';
import { createHistoryPrefetch, HISTORY_LOOKAHEAD_VIEWPORTS } from './historyPrefetch';
import { quietWaits, retrying } from './runWaits';
import { LoadingState } from '../../../../products/maka/workbench/app/Loading';
import { delayed } from '../../../../products/maka/workbench/app/delayed';
import { createPendingRecovery } from '../../../../products/maka/workbench/app/pendingRecovery';
import {
  createText,
  createTransientText,
  UiError,
  errorText,
  isObservationCancelled,
  renderText,
  type UiText,
  message as uiMessage,
} from '../../../../products/maka/workbench/app/text';
import { tr, type MessageKey } from '../../../../products/maka/workbench/app/locale';
import type { StagedFile } from 'maka/host';
import type {
  AgentContinuationRejection,
  AgentContinuationResult,
  AgentExecution,
  RunId,
} from '../../../../packages/plugin-sdk/src/generated/runtime.js';
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
import type { ListRef, ReadonlyListSource, ScrollRef, ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import { keymap, platform, reduceMotion, Scroll } from 'nsh';
import { AnimatedValue } from 'nsh';
import {
  useHost,
  loadDraft,
  saveDraft,
  reserveSend,
  confirmSend,
  pendingSends,
  recoverSend,
  sendDelivery,
  type SendDelivery,
  retrySend,
  dismissSend,
  abandonSend,
  type SendOperation,
  type ScopedHost,
} from '../../../../products/maka/workbench/app/host';
import {
  C,
  Header,
  ViewSegment,
  captionTextStyle,
  controlStyle,
  toolbarControlStyle,
  type BrowserHeader,
} from '../../../../products/maka/workbench/app/ui';
import {
  acceptedSend,
  sameHistoryRow,
  compareHistoryOrder,
  historyTurnKey,
  historyRowKey,
  readHistoryTail,
  rootEventSequence,
  historyFollowPosition,
  compareRows,
  HistoryRows,
  mergeHistoryPage,
  openingUserMessage,
  replayStartCursor,
  senderSession,
  stableRowId,
  replaceHistoryMetadata,
} from '../../../../products/maka/workbench/app/history';
import type { Row, Subscription } from '../../../../products/maka/workbench/app/history';
import {
  TranscriptOverlay,
  type LivePart,
} from '../../../../products/maka/workbench/app/transcriptOverlay';
import {
  TrajectoryInspector,
  TrajectoryOverview,
  TrajectoryRecord,
  TrajectoryRequest,
  TrajectoryRequestInspector,
  TrajectoryToolbar,
  TrajectoryTurn,
  trajectoryLabel,
} from '../../../../products/maka/workbench/app/TrajectoryLedger';
import {
  projectTrajectory,
  trajectoryOverlaps,
  trajectoryRecordMatches,
  trajectoryRecordKey,
  trajectoryTurnKey,
  trajectoryTimeline,
  visibleTrajectory,
  type TrajectoryEntry,
  type TrajectoryRange,
} from '../../../../products/maka/workbench/app/trajectory';
import { thinkingSummary } from '../../../../products/maka/workbench/app/thinkingSummary';
import type {
  ComposerSession,
  ComposerContinuation,
  ComposerPrediction,
  ComposerQueue,
  ComposerSendAction as SendAction,
  ComposerSendStatus,
} from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { AttachmentDraft } from '../../../../products/maka/workbench/app/attachmentDraft';
import {
  sameRoute,
  sameBackend,
  routeKey,
  backendName,
} from '../../../../products/maka/workbench/app/modelSelection';
import type {
  BackendIdentity,
  ModelDetails,
} from '../../../../products/maka/workbench/app/modelSelection';
import { CompactionDivider } from '../../../../products/maka/workbench/app/CompactionDivider';
import {
  botTurnEnding,
  reportedWorker,
  activeWorkers,
  type ActiveWorker,
  createBotTranscript,
} from '../../../../products/maka/workbench/app/botTranscript';
import { createBotWorkers } from '../../../../products/maka/workbench/app/botWorkers';
import {
  BotNote,
  BotReply,
  BotWaiting,
  BotWorking,
} from '../../../../products/maka/workbench/app/BotReply';
import { BotRestart } from '../../../../products/maka/workbench/app/BotRestart';
import {
  MessageRow,
  type MessageViewState,
} from '../../../../products/maka/workbench/app/MessageRow';
import { FinalActions } from '../../../../products/maka/workbench/app/FinalActions';
import {
  MessageEdit,
  MessageEditor,
  TurnRetry,
  type InlineEdit,
} from '../../../../products/maka/workbench/app/MessageEdit';
import { createMessageSenders } from '../../../../products/maka/workbench/app/messageSenders';
import type { SessionAction } from '../../../../products/maka/workbench/app/sessionLifecycle';
import { createProjectMcp } from '../../../../products/maka/workbench/app/projectMcp';
import { createSessionPermissions } from '../../../../products/maka/workbench/app/sessionPermissions';
import { createSessionGoal } from '../../../../products/maka/workbench/app/sessionGoal';
import {
  createMessagePrediction,
  predictionTrigger,
} from '../../../../products/maka/workbench/app/messagePrediction';
import { TurnPanel, TurnSummary } from '../../../../products/maka/workbench/app/TurnPanel';
import { turnImages } from '../../../../products/maka/workbench/app/ToolImage';
import type {
  GroupViewState,
  LiveActivity,
  TurnViewState,
} from '../../../../products/maka/workbench/app/TurnPanel';
import {
  projectProcessGroups,
  sameProcessActivity,
  sameProcessRows,
  orderProcessRows,
  turnOutcome,
  turnWorkFold,
} from '../../../../products/maka/workbench/app/processGroups';
import type {
  ProcessActivity,
  ProcessEntry,
  ProcessProjection,
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
import { latestToolActivity } from '../../../../products/maka/workbench/app/toolActivity';
import type { ToolActivity } from '../../../../products/maka/workbench/app/toolActivity';
import type {
  AgentHistoryAttachment,
  AgentHistoryChunk,
  AgentHistoryLandmark,
  AgentHistoryPage,
  AgentMarkReadResult,
  AgentSession,
  AgentRunBackend,
  HistoryPosition,
  HistoryRowAddress,
  HistoryOrder,
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

export type ConversationAnchor = { messageId?: string | null; position: HistoryRowAddress };
type HistoryNavigation =
  | { kind: 'start' | 'tail' }
  | { kind: 'turn'; item: TurnNavigationItem }
  | { kind: 'message'; anchor: ConversationAnchor };
type HistoryWindow = Pick<AgentHistoryPage, 'before' | 'after'> & {
  through: number;
  identity: object;
};

export type Control = (method: string, input: any) => Promise<any>;
export type ConversationHandle = Omit<
  ComposerSession,
  'attachments' | 'modelDetails' | 'permissions' | 'projectMcp' | 'completion' | 'checklist'
> & {
  attachments: AttachmentDraft;
  goal: ReturnType<typeof createSessionGoal>;
  modelDetails(): ModelDetails;
  permissions: ReturnType<typeof createSessionPermissions>;
  projectMcp: ReturnType<typeof createProjectMcp>;
  compact(prompt?: string): Promise<void>;
  interactions(): AgentPendingInteractions;
  executionWaitMessage(): string;
  reconnecting(): boolean;
  reconnect(): void;
  attachmentMetadataFailed(): boolean;
  retryAttachmentMetadata(): void;
  activeTurn(): string | null;
  activityTurn(): string | null;
  flushDraft(): Promise<boolean>;
  focus(): void;
  /** A null target follows the current live turn; `reload` reads the tail again. */
  jumpLatest(turnId: string | null, reload?: boolean): void;
  refresh(): Promise<any>;
  reveal(anchor: ConversationAnchor, current: () => boolean): Promise<void>;
  focusHistory(): void;
  focusActivity(turnId: string | null): void;
  /** The title its header shows. */
  title(): string;
};
// What the user can do about each reason the Host declined to continue.
const continuationRejected: Record<AgentContinuationRejection, MessageKey> = {
  closed: 'Maka is shutting down. Continue after it restarts.',
  archived: 'Restore this conversation to continue it.',
  busy: 'This conversation is busy or has queued messages. Continue once it is idle.',
  source_missing: 'There is no stopped response to continue.',
  source_changed:
    'The conversation changed after this response stopped. Send a new message instead.',
  source_not_terminal: 'Wait for this run to finish before continuing.',
  already_continued: 'This response has already been continued.',
  workspace_changed:
    'The workspace changed after this response stopped. Send a new message instead.',
  safety_check_failed: 'This response cannot be continued safely. Send a new message instead.',
};

type ConversationProps = {
  client: ScopedHost;
  control: Control;
  continuationPending(): boolean;
  /** The Bot Session when the application knows it; `null` for none; `undefined` if unknown. */
  botSession?(): string | null | undefined;
  fork(action: Extract<SessionAction, { kind: 'fork' }>): Promise<void>;
  /**
   * Edit and resend a user message, or regenerate a reply (desktop): fork before
   * the turn with its text, which the fork sends when `send` is set.
   */
  edit?(
    action: Extract<SessionAction, { kind: 'fork' }>,
    text: string,
    send: boolean,
  ): Promise<boolean>;
  /** Text for an empty draft once it loads, taken once (a fork made to edit or regenerate). */
  takePrefill?(available: boolean): {
    text: string;
    send: boolean;
    files?: StagedFile[];
    first?: boolean;
  } | null;
  commands(): void;
  connectionLost(): boolean;
  visible(): boolean;
  foreground(): boolean;
  browser(): BrowserHeader;
  files?(): void;
  filesOpener(node: ViewRef): void;
  previewImage(image: ImagePreview): void;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  openSessionBeside?(sessionId: string): void;
  knownSession?(sessionId: string): AgentSession | undefined;
  /** Opens a conversation in this pane, for when no side pane fits. */
  openSessionHere?(sessionId: string): void;
  attach(handle: ConversationHandle): void;
  detach(handle: ConversationHandle): void;
  focusComposer(): void;
  stopAction(): () => void;
  /** Starts the Bot over; offered only on the Bot's own conversation. */
  restartBot?(): Promise<void>;
  /** Shows only the latest exchange, as tall as its content, with no header. */
  compact?: boolean;
};
function indexRows(items: readonly Row[]) {
  const byId = new Map<string, Row>();
  const byMessage = new Map<string, Row>();
  for (const row of items) {
    const id = stableRowId(row);
    // The result supplies current content at the original tool call's seat.
    if (!byId.has(id) || !row.tool?.call || row.tool.result) byId.set(id, row);
    if (
      row.messageId !== undefined &&
      (row.position === undefined || row.position.kind === 'live')
    ) {
      const message = `${row.messageId}/${row.field}`;
      if (!byMessage.has(message)) byMessage.set(message, row);
    }
  }
  return { byId, byMessage };
}
// Rows share the composer's column: at most 800 wide, centered. The terminal's
// scroll bar takes a cell of the right margin.
const readingColumn = {
  width: '100%',
  maxWidth: 800,
  alignSelf: 'center',
  paddingLeft: 16,
  paddingRight: platform.idiom === 'terminal' ? 24 : 16,
} as const;
const historyEndTolerance = 1;

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
  const historyRows = signal(new HistoryRows(), { equals: false });
  const rows = () => historyRows().ordered;
  const loadedOpening = (turnId: string | undefined) => {
    if (turnId === undefined) return null;
    const current = historyRows();
    const turn = current.byTurn.get(turnId);
    if (!turn) return null;
    const start = current.index(turn[0]);
    for (let index = start - 1; index >= 0; index--) {
      if (historyTurnKey(current.ordered[index]) !== undefined)
        return openingUserMessage(turn, turnId, null);
    }
    return openingUserMessage(turn, turnId, historyWindow()?.before);
  };
  const opensTurn = (row: Row) => {
    const first = loadedOpening(historyTurnKey(row));
    return (
      first !== null &&
      first.position !== undefined &&
      row.position !== undefined &&
      sameHistoryRow(first.position, row.position)
    );
  };
  const overlay = new TranscriptOverlay();
  const transient = signal(overlay.snapshot());
  const publishOverlay = () => transient.set(overlay.snapshot());
  const live = computed(() => transient().rows);
  const toolActivity = computed(() => transient().tools);
  const parts = computed(() => transient().parts);
  const pendingMessages = signal<Row[]>([]);
  const queued = signal<AgentQueue | null>(null);
  const title = signal(sessionId);
  const archived = signal(false);
  const run = signal<ConversationStatus>('loading');
  const runId = signal<RunId | null>(null);
  const runBackend = signal<AgentRunBackend | null>(null);
  const toolProgressById = computed(
    () =>
      new Map(
        toolActivity()
          .filter((item) => item.runId === runId())
          .map((item) => [item.toolUseId, item.phase] as const),
      ),
  );
  const toolProgress = (id: string) => toolProgressById().get(id) ?? null;
  const compacting = signal<AgentCompactionProgress | null>(null);
  const execution = signal<AgentExecution | null>(null);
  const continuing = signal(false);
  const confirmingContinuation = () => continuing() || props.continuationPending();
  const executionRevision = signal(0);
  const stoppingRun = signal<RunId | null>(null);
  const stopping = () => runId() !== null && stoppingRun() === runId();
  const workspace = signal('');
  const permissions = createSessionPermissions(host, sessionId, props.control);
  const goal = createSessionGoal(host, sessionId, props.control, permissions, () => selection());
  const projectMcp = createProjectMcp(host, sessionId, props.control);
  const runTurn = signal<string | null>(null);
  const lastCompletedTurn = signal<string | null>(null);
  const backend = signal<BackendIdentity>(null);
  const interactions = signal<AgentPendingInteractions>({
    revision: -1,
    entries: [],
  });
  const computerApps = signal<AgentComputerApps>({ entries: [] });
  let interactionsFromStream = false;
  const error = createText();
  const ready = signal(false);
  const showHistoryLoading = delayed(() => !ready());
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
  const historyFollowPaused = signal(false);
  const visibleTurns = signal<ReadonlySet<string>>(new Set());
  const visibleTurn = () => visibleTurns().values().next().value ?? null;
  const navigation = signal<HistoryNavigation | null>(null);
  const navigatingTurn = computed(() => {
    const target = navigation();
    return target?.kind === 'turn' ? target.item.turnKey : null;
  });
  const attachmentMetadataFailed = signal(false);
  const attachmentMetadataReads = new Set<string>();
  const draft = signal('');
  const draftReady = signal(false);
  const savingFailed = signal(false);
  const unresolved = signal<SendOperation[]>([]);
  type FrozenSend = {
    id: string;
    text: string;
    files: DraftAttachment[];
    edit: AttachmentEdit & { text: string };
    selection: ReturnType<typeof sendSelection>;
    revision?: number;
  };
  type FreezeState =
    | { kind: 'idle' }
    | { kind: 'reserving'; frozen: FrozenSend }
    | { kind: 'failed'; frozen: FrozenSend; error: UiText };
  const freezeState = signal<FreezeState>({ kind: 'idle' });
  const checkingModel = signal(false);
  const sending = () => freezeState().kind === 'reserving' || checkingModel();
  const activeSends = signal<Map<string, FrozenSend>>(new Map());
  const sendErrors = signal<Map<string, UiText>>(new Map());
  const checkingSends = signal<Set<string>>(new Set());
  const sendDeliveries = signal<Map<string, SendDelivery>>(new Map());
  let sendSequence = 0;
  const receiptsKnown = signal(false);
  const recovering = signal(false);
  const notice = createTransientText();
  const reading = signal<'chat' | 'trajectory'>('chat');
  const trajectoryQuery = signal('');
  const trajectoryRange = signal<TrajectoryRange | null>(null);
  const trajectoryFiltering = () => !!trajectoryQuery().trim() || trajectoryRange() !== null;
  const trajectoryCollapsed = signal<ReadonlySet<string>>(new Set());
  const trajectoryCollapsedTools = signal<ReadonlySet<string>>(new Set());
  const trajectorySelection = signal<string | null>(null);
  const trajectorySideBySide = signal(false);
  // In the Bot Session, Chat shows what the Bot told the user (SendUser); its own
  // replies and steps stay in Trajectory.
  const bot = createBotTranscript(host, sessionId, () => props.botSession?.());
  // The Bot's own conversations come from the Host's catalog stream; the sidebar list
  // holds only top-level ones. Not read for a replaced Bot, which has no live workers.
  const botWorkers = createBotWorkers(
    host,
    () => sessionId,
    () => bot.identity() === 'bot' && props.visible() && !formerBot(),
  );
  // A Bot that was replaced is a Bot only as an archived record of what it told the user.
  // Restored, it is an ordinary conversation again: it holds no SendUser, so its own
  // replies must show in Chat.
  const formerBot = () =>
    bot.identity() === 'bot' && (props.botSession?.() ?? sessionId) !== sessionId;
  const botView = (): 'unknown' | 'bot' | 'ordinary' => {
    const identity = bot.identity();
    return formerBot() && ready() && !archived() ? 'ordinary' : identity;
  };
  const readingSize = signal({ width: 640, height: 192 });
  let historyOffset = 0;
  let historyMaxOffset = 0;
  let historyScrollInput: 'idle' | 'pending' | 'dragging' = 'idle';
  const highlightedAnchor = signal<string | null>(null);
  let anchorHighlight: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(anchorHighlight));
  const innerReader = signal<string | null>(null);
  // The process group whose activity list last reported its end.
  const readerAtEnd = signal<string | null>(null);
  // At the end of a paused group there is nothing below to reach, only
  // following to resume, and nothing to follow once the run has ended.
  const pausedAtEnd = () =>
    !historyFollowPaused() && innerReader() !== null && innerReader() === readerAtEnd();
  const metrics = signal<any>(null);
  const turnStates = new Map<string, TurnViewState>();
  const groupStates = new Map<string, GroupViewState>();
  const rowStates = new Map<string, MessageViewState>();
  const turnState = (id: string) => {
    let state = turnStates.get(id);
    if (!state) {
      state = { expanded: signal<boolean | null>(null), ran: false };
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
      state = {
        expanded: signal(false),
        sourceMode: signal(false),
        edit: signal<InlineEdit | null>(null),
      };
      rowStates.set(id, state);
    }
    return state;
  };
  const liveRows = computed(() => indexRows(live()));
  const currentRow = (id: string) =>
    historyRows().byId.get(id) ??
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
      if (run() === 'waiting_for_user' || run() === 'waiting')
        return { kind: 'waiting', detail: '' };
      let latest: { part: LivePart; row: Row; sequence: number } | undefined;
      for (const part of parts()) {
        if (part.runId !== runId()) continue;
        const message = `${part.messageId}/${part.field}`;
        const row = liveRows().byMessage.get(message) ?? historyRows().byMessage.get(message);
        if (!row || row.closedAt != null) continue;
        const sequence = Math.max(part.startSequence, row.sequence ?? 0);
        if (!latest || sequence > latest.sequence) latest = { part, row, sequence };
      }
      const currentPreview = live()
        .filter((row) => row.preview && row.runId === runId() && row.closedAt === null)
        .at(-1);
      if (currentPreview)
        return currentPreview.field === 'body'
          ? { kind: 'response', detail: '', rowId: stableRowId(currentPreview) }
          : {
              kind: 'thinking',
              detail: thinkingSummary(currentPreview.text),
              rowId: stableRowId(currentPreview),
            };
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
  const answerTurn = computed(() => {
    if (!atHistoryTail() || reading() !== 'chat' || botView() !== 'ordinary') return null;
    // A successful end can arrive before history marks the final answer.
    if (runId() === null) return lastCompletedTurn();
    return run() === 'running' ? runTurn() : null;
  });
  type Section = { turns: readonly string[]; rows: readonly Row[] };
  const durableSections = computed((previous: Map<string, Section> | undefined) => {
    const canonical = historyRows();
    const ordered = canonical.ordered;
    const sections = new Map<string, Section>();
    for (let start = 0; start < ordered.length; ) {
      const first = ordered[start];
      const turnKey = historyTurnKey(first);
      const turn = turnKey === undefined ? undefined : canonical.byTurn.get(turnKey);
      if (turnKey !== undefined && turn && ordered[start + turn.length - 1] === turn.at(-1)) {
        const old = previous?.get(turnKey);
        sections.set(turnKey, old?.rows === turn ? old : { turns: [turnKey], rows: turn });
        start += turn.length;
        continue;
      }
      const turns = new Set<string>();
      let end = start + 1;
      for (let index = start; index < end; ) {
        const row = ordered[index];
        const key = historyTurnKey(row);
        if (key === undefined) {
          // Consecutive failures without a turn still share a presentation boundary.
          if (
            index + 1 === end &&
            end < ordered.length &&
            historyTurnKey(ordered[end]) === undefined
          )
            end++;
          index++;
          continue;
        }
        const turn = canonical.byTurn.get(key)!;
        if (!turns.has(key)) {
          turns.add(key);
          end = Math.max(end, canonical.index(turn.at(-1)!) + 1);
        }
        index +=
          ordered[index + turn.length - 1] === turn.at(-1) && row === turn[0] ? turn.length : 1;
      }
      const key = historyTurnKey(first) ?? first.key;
      const old = previous?.get(key);
      const rows = ordered.slice(start, end);
      sections.set(
        key,
        old?.rows.length === rows.length && old.rows.every((row, index) => row === rows[index])
          ? old
          : { turns: [...turns], rows },
      );
      start = end;
    }
    return sections;
  });
  const settledSections = new WeakMap<
    Section,
    { followed: boolean; projection: ProcessProjection }
  >();
  let priorByTurn = new Map<string, ProcessProjection>();
  let lastLive:
    | {
        sections: Section[];
        live: readonly ProcessRow[];
        activity: readonly ProcessActivity[];
        pending: readonly Row[];
        active: string | null;
        answer: string | null;
        projection: ProcessProjection;
      }
    | undefined;
  let projectedWindow: HistoryRows | undefined;
  const projectionSections = computed(() => {
    const canonical = historyRows();
    if (projectedWindow !== canonical) {
      projectedWindow = canonical;
      lastLive = undefined;
      priorByTurn.clear();
    }
    const sections = [...durableSections().values()];
    const live = processLive();
    const activity = processActivity();
    const pending = atHistoryTail() ? pendingMessages() : undefined;
    const active = runId() === null ? null : runTurn();
    const answer = answerTurn();
    // A live preview, including a late one, belongs to the same ordered
    // suffix as its first durable fact.
    let liveStart = sections.length;
    if (active !== null || answer !== null || live.length || activity.length) {
      const liveTurns = new Set([
        active,
        answer,
        ...live.map(historyTurnKey),
        ...activity.map((row) => row.turnId),
      ]);
      const first = sections.findIndex((section) =>
        section.turns.some((key) => liveTurns.has(key)),
      );
      if (first >= 0) liveStart = first;
    }
    const output: ProcessProjection[] = [];
    for (let index = 0; index < liveStart; index++) {
      const section = sections[index];
      const followed =
        index + 1 < sections.length ||
        live.length > 0 ||
        activity.length > 0 ||
        Boolean(pending?.length);
      const cached = settledSections.get(section);
      if (cached?.followed === followed) {
        output.push(cached.projection);
        continue;
      }
      const prior = section.turns.map((key) => priorByTurn.get(key)).find((part) => part);
      const projected = projectProcessGroups({
        rows: orderProcessRows(section.rows),
        toolActivity: [],
        activeTurnId: null,
        previous: prior?.entries,
        followed,
      });
      settledSections.set(section, { followed, projection: projected });
      output.push(projected);
    }
    if (
      liveStart < sections.length ||
      live.length ||
      activity.length ||
      pending?.length ||
      active !== null
    ) {
      const suffix = sections.slice(liveStart);
      const queued = pending ?? [];
      const prior = lastLive;
      if (
        prior &&
        prior.live === live &&
        prior.activity === activity &&
        (prior.pending === pending || (!prior.pending.length && !queued.length)) &&
        prior.active === active &&
        prior.answer === answer &&
        prior.sections.length === suffix.length &&
        prior.sections.every((section, index) => section === suffix[index])
      ) {
        output.push(prior.projection);
      } else {
        const projected = projectProcessGroups({
          rows: [
            ...orderProcessRows([...suffix.flatMap((section) => section.rows), ...live]),
            ...queued,
          ],
          toolActivity: activity,
          activeTurnId: active,
          answerTurnId: answer,
          previous:
            prior?.projection.entries ??
            (suffix[0]?.turns[0] ? priorByTurn.get(suffix[0].turns[0])?.entries : undefined),
        });
        lastLive = {
          sections: suffix,
          live,
          activity,
          pending: queued,
          active,
          answer,
          projection: projected,
        };
        output.push(projected);
      }
    } else lastLive = undefined;
    priorByTurn = new Map();
    for (const part of output) for (const key of part.turns.keys()) priorByTurn.set(key, part);
    return output;
  });
  const sectionsByTurn = computed(() => {
    const byTurn = new Map<string, ProcessProjection>();
    for (const section of projectionSections())
      for (const key of section.turns.keys()) byTurn.set(key, section);
    return byTurn;
  });
  const projection = (): ProcessProjection => {
    const entries: ProcessEntry[] = [];
    const turns = new Map<string, TurnPresentation>();
    const rowsById = new Map<string, ProcessRow>();
    for (const section of projectionSections()) {
      entries.push(...section.entries);
      for (const [key, turn] of section.turns) turns.set(key, turn);
      for (const [id, row] of section.rowsById) rowsById.set(id, row);
    }
    return { entries, turns, rowsById };
  };
  const projectedSection = (key: string) => sectionsByTurn().get(key);
  const projectedTurn = (key: string) => projectedSection(key)?.turns.get(key);
  // Origins belong to durable inputs and the queue, not token-driven previews.
  const senderIds = computed(
    () => {
      const ids = new Set(historyRows().senderIds);
      for (const entry of queued()?.entries ?? []) {
        const id = senderSession(entry.origin);
        if (id !== null) ids.add(id);
      }
      return ids;
    },
    { equals: (left, right) => left.size === right.size && [...left].every((id) => right.has(id)) },
  );
  // A worker or sender opens beside this conversation when a side pane fits, otherwise in
  // this pane (the Bot stays pinned in the sidebar to switch back).
  const canOpenWorker = () => !!(props.openSessionBeside ?? props.openSessionHere);
  const openWorker = (id: string) => (props.openSessionBeside ?? props.openSessionHere)?.(id);
  const senders = createMessageSenders(
    host,
    senderIds,
    (id) => props.knownSession?.(id),
    () => (canOpenWorker() ? openWorker : undefined),
  );
  const workFold = (turn: TurnPresentation) => turnWorkFold(turn, platform.idiom === 'terminal');
  const turnExpanded = (turn: TurnPresentation) => {
    const fold = workFold(turn);
    return fold === 'unavailable' || (turnState(turn.turnKey).expanded() ?? fold === 'open');
  };
  // Showing something in a folded turn opens it; an open turn keeps folding by default.
  const unfoldTurn = (turn: TurnPresentation) => {
    if (!turnExpanded(turn)) turnState(turn.turnKey).expanded.set(true);
  };
  const trajectoryRequests = createTrajectoryRequests({
    active: () => reading() === 'trajectory' && props.visible(),
    rows,
    through: () => historyWindow()?.through,
    read: (through, position, after) =>
      host.query('agent', 'historyRequests', {
        sessionId,
        through,
        position,
        after,
      }),
    failed: (reason) => report(reason),
  });
  const trajectory = computed(() =>
    reading() === 'trajectory' ? projectTrajectory(projection(), trajectoryRequests()) : [],
  );
  const trajectoryByKey = computed(() => new Map(trajectory().map((entry) => [entry.key, entry])));
  const trajectoryOverview = computed(() => trajectoryTimeline(trajectory()));
  const trajectoryTurns = computed(() =>
    trajectory().flatMap((entry) => (entry.kind === 'trajectory-turn' ? [entry.turnKey] : [])),
  );
  const trajectoryParents = computed(
    () =>
      new Set(
        trajectory().flatMap((entry) =>
          entry.kind === 'trajectory-record' ? entry.ancestorToolKeys : [],
        ),
      ),
  );
  const allTrajectorySubcallsCollapsed = computed(
    () =>
      trajectoryParents().size > 0 &&
      [...trajectoryParents()].every((key) => trajectoryCollapsedTools().has(key)),
  );
  const toggleTrajectoryTool = (key: string) => {
    const next = new Set(trajectoryCollapsedTools());
    if (!next.delete(key)) next.add(key);
    trajectoryCollapsedTools.set(next);
  };
  const allTrajectoryTurnsCollapsed = computed(
    () =>
      trajectoryTurns().length > 0 &&
      trajectoryTurns().every((key) => trajectoryCollapsed().has(key)),
  );
  const toggleTrajectoryTurn = (key: string) => {
    const next = new Set(trajectoryCollapsed());
    if (!next.delete(key)) next.add(key);
    trajectoryCollapsed.set(next);
  };
  const selectedTrajectory = computed(() => {
    if (reading() !== 'trajectory') return null;
    const key = trajectorySelection();
    const entry = key === null ? undefined : trajectoryByKey().get(key);
    return entry && entry.kind !== 'trajectory-turn' ? entry : null;
  });
  type DisplayEntry =
    | TrajectoryEntry
    | { kind: 'summary'; key: string; turnKey: string }
    | { kind: 'process'; key: string; group: ProcessGroup }
    | { kind: 'row'; key: string; rowId: string; turnKey?: string; repeats?: number }
    | { kind: 'bot'; key: string; turnId: string; worker?: string }
    | { kind: 'botNote'; key: string; turnId: string }
    | { kind: 'botWorking'; key: string }
    | { kind: 'botWaiting'; key: string; workers: readonly ActiveWorker[] };
  const chatSections = new WeakMap<
    ProcessProjection,
    {
      entries: DisplayEntry[];
      turns: [TurnPresentation, boolean][];
    }
  >();
  // A retry or a child run keeps the run at work; an approval has its own card.
  const runAtWork = () =>
    run() === 'running' || (run() === 'waiting' && quietWaits(execution()).length > 0);
  const chatDisplaySections = computed(() =>
    projectionSections().map((section) => {
      const cache = chatSections.get(section);
      if (cache && cache.turns.every(([turn, open]) => turnExpanded(turn) === open))
        return cache.entries;
      const entries = chatEntries(section, false);
      chatSections.set(section, {
        entries,
        turns: [...section.turns.values()].map((turn) => [turn, turnExpanded(turn)]),
      });
      return entries;
    }),
  );
  const otherDisplay = computed<DisplayEntry[]>(() => {
    if (reading() === 'trajectory') {
      const query = trajectoryQuery().trim().toLocaleLowerCase();
      const range = trajectoryRange();
      return visibleTrajectory(
        trajectory(),
        trajectoryCollapsed(),
        trajectoryCollapsedTools(),
        query || range
          ? (entry) => {
              if (entry.kind === 'trajectory-request') {
                const { modelId, startedAt, firstTokenAt, finished } = entry.request;
                return (
                  (!query ||
                    modelId.toLocaleLowerCase().includes(query) ||
                    (finished?.diagnostic?.toLocaleLowerCase().includes(query) ?? false)) &&
                  (!range ||
                    (startedAt != null &&
                      trajectoryOverlaps(
                        range,
                        startedAt,
                        finished?.at ?? firstTokenAt ?? undefined,
                      )))
                );
              }
              const row = currentRow(entry.rowId);
              return (
                row !== undefined &&
                (!query || trajectoryRecordMatches(row, query, trajectoryLabel(row))) &&
                (!range ||
                  (row.timestamp !== undefined && trajectoryOverlaps(range, row.timestamp)))
              );
            }
          : undefined,
      );
    }
    return botView() !== 'ordinary' ? chatEntries(projection(), true) : [];
  });
  const ordinaryChat = () => reading() === 'chat' && botView() === 'ordinary';
  // A model can take minutes to say its first word, or wait to retry. Until the
  // running Turn has its own header, ordinary Chat says it is at work, as Bot
  // Chat does. The row stays outside the cached sections, which do not follow
  // the run.
  const workingEntries: DisplayEntry[] = [{ kind: 'botWorking', key: 'bot/working' }];
  const ordinaryChatSections = computed(() => {
    const sections = chatDisplaySections();
    if (!runAtWork()) return sections;
    const running = runTurn();
    const headed =
      running !== null &&
      sections.some((entries) =>
        entries.some(
          (item) =>
            (item.kind === 'process' && item.group.turnKey === running) ||
            (item.kind === 'summary' && item.turnKey === running),
        ),
      );
    return headed ? sections : [...sections, workingEntries];
  });
  const display = () => (ordinaryChat() ? ordinaryChatSections().flat() : otherDisplay());
  function chatEntries(section: ProcessProjection, botChat: boolean): DisplayEntry[] {
    const result: DisplayEntry[] = [];
    const summaries = new Set<string>();
    // Until the Host has said whether this is the Bot, assume it is: showing the model's
    // own text on the Bot's Chat would publish internal output, while a short blank on an
    // ordinary conversation only delays it. Reading a Bot never becomes visible by failing.
    // The Bot's reply to a Turn is what it sent with SendUser during that Turn,
    // shown after the Turn's own entries.
    let openTurn: string | undefined;
    let workingShown = false;
    // Chat hides the model's own output. Until the running Turn has its own header,
    // show that the Bot is at work, where that header will appear so it replaces
    // this row in place instead of arriving above an already shown reply.
    const working = (turnId: string | undefined) => {
      const running = runTurn();
      if (!runAtWork() || workingShown || (turnId !== undefined && turnId !== running)) return;
      const headed = result.some(
        (item) =>
          running !== null &&
          ((item.kind === 'process' && item.group.turnKey === running) ||
            (item.kind === 'summary' && item.turnKey === running)),
      );
      if (headed) return;
      workingShown = true;
      result.push({ kind: 'botWorking', key: 'bot/working' });
    };
    const speak = () => {
      if (openTurn !== undefined) {
        working(openTurn);
        const sent = bot.forTurn(openTurn).length > 0;
        // A Turn the Bot started because a worker finished carries that worker as the
        // origin of its opening message; the reply can then link to the worker's record.
        const worker = sent ? reportedWorker(section.rowsById.values(), openTurn) : undefined;
        if (sent)
          result.push({
            kind: 'bot',
            key: `bot/${openTurn}`,
            turnId: openTurn,
            ...(worker !== undefined ? { worker } : {}),
          });
        // Silence is valid and gets no marker; a Turn that neither sent nor slept would
        // look the same, so say so.
        const turn = section.turns.get(openTurn);
        const finished = turn !== undefined && !turn.active && openTurn !== runTurn();
        const turnId = openTurn;
        const slept = [...section.rowsById.values()].some(
          (row) =>
            (row.position === undefined || row.position.kind === 'live') &&
            row.turnId === turnId &&
            row.tool?.call?.name === 'sleep',
        );
        if (
          turn &&
          botTurnEnding({
            finished,
            outcome: turnOutcome(turn),
            sent,
            slept,
          }) === 'unanswered'
        )
          result.push({
            kind: 'botNote',
            key: `bot/${openTurn}/note`,
            turnId: openTurn,
          });
      }
      openTurn = undefined;
    };
    for (const entry of section.entries) {
      const row = entry.kind === 'message' ? section.rowsById.get(entry.rowId) : undefined;
      const turnId =
        entry.kind === 'process'
          ? entry.turnKey
          : row === undefined
            ? undefined
            : historyTurnKey(row);
      const turn = turnId ? section.turns.get(turnId) : undefined;
      if (botChat && turnId !== openTurn) {
        speak();
        openTurn = turnId;
      }
      const outcome = turn && turnOutcome(turn);
      const foldedWork = turn && workFold(turn) === 'closed';
      if (
        turn &&
        (entry.kind === 'process' ||
          row?.role === 'assistant' ||
          // Recovered failures sit under the summary that folds them.
          (row?.role === 'failure' &&
            (platform.idiom !== 'terminal' || outcome === 'completed' || foldedWork))) &&
        !summaries.has(turn.turnKey) &&
        (platform.idiom !== 'terminal' || outcome !== null || foldedWork)
      ) {
        summaries.add(turn.turnKey);
        result.push({
          kind: 'summary',
          key: `turn/${turn.turnKey}`,
          turnKey: turn.turnKey,
        });
      }
      if (entry.kind === 'process') {
        if (!turn || !turnExpanded(turn)) continue;
        result.push({ kind: 'process', key: entry.key, group: entry });
      } else if (row) {
        // Only SendUser publishes for the Bot. The model's own text, including a
        // deliberately silent Turn's conclusion, stays internal in Trajectory; a real
        // failure is a failure row, which this does not hide.
        if (botChat && row.role === 'assistant') continue;
        // A message the Host wrote on the user's behalf (a worker finishing, a task
        // result) is not something the user said. It stays in Trajectory.
        if (botChat && row.role === 'user' && row.origin && row.origin.kind !== 'session') continue;
        if (
          entry.processTurnKey &&
          turn &&
          !turnExpanded(turn) &&
          !turn.answerOutputIds.includes(entry.rowId)
        )
          continue;
        // A completed turn recovered from its failures (retries that later
        // succeeded); they fold away with the rest of its work.
        if (row.role === 'failure' && turn && !turnExpanded(turn)) continue;
        result.push({
          kind: 'row',
          key: entry.key,
          rowId: entry.rowId,
          turnKey: turnId,
          repeats: entry.repeats,
        });
      }
    }
    if (botChat) {
      speak();
      // The running Turn may not be projected yet (its message is still pending).
      working(undefined);
      // A worker that is running, or waiting for the user's approval or answer, has not
      // ended its run, so the Bot has nothing to say about it yet; Chat is where the user
      // would look for it.
      const active = activeWorkers(botWorkers.sessions(), sessionId);
      if (active.length > 0)
        result.push({
          kind: 'botWaiting',
          key: 'bot/waiting',
          workers: active,
        });
    }
    return result;
  }
  const expandedByTurn = new Map<string, boolean>();
  effect(() => {
    for (const section of projectionSections()) {
      for (const turn of section.turns.values()) {
        const expanded = turnExpanded(turn);
        if (!expanded && expandedByTurn.get(turn.turnKey)) {
          for (const entry of section.entries)
            if (entry.kind === 'process' && entry.turnKey === turn.turnKey)
              groupStates.get(entry.key)?.open.set(false);
        }
        expandedByTurn.set(turn.turnKey, expanded);
      }
    }
  });
  const displaySections = computed(() =>
    ordinaryChat() ? ordinaryChatSections() : [otherDisplay()],
  );
  const entriesByKey = new Map<string, DisplayEntry>();
  const indexedSections = computed((previous: Set<DisplayEntry[]> | undefined) => {
    const current = new Set(displaySections());
    for (const entries of previous ?? []) {
      if (current.has(entries)) continue;
      for (const entry of entries) entriesByKey.delete(entry.key);
    }
    for (const entries of current) {
      if (previous?.has(entries)) continue;
      for (const entry of entries) entriesByKey.set(entry.key, entry);
    }
    return current;
  });
  const displayEntry = (key: string) => {
    indexedSections();
    return entriesByKey.get(key);
  };
  effect(() => {
    const reader = innerReader();
    if (reader !== null && !displayEntry(reader)) innerReader.set(null);
  });
  const keysBySection = new WeakMap<DisplayEntry[], string[]>();
  const keySections = computed(() =>
    displaySections().flatMap((entries) => {
      if (!entries.length) return [];
      let keys = keysBySection.get(entries);
      if (!keys) {
        keys = entries.map((entry) => entry.key);
        keysBySection.set(entries, keys);
      }
      return [keys];
    }),
  );
  type HistoryList = ReadonlyListSource<string> & { sections: string[][]; ends: number[] };
  const historyList = computed<HistoryList>(() => {
    const sections = keySections();
    let length = 0;
    const ends = sections.map((keys) => (length += keys.length));
    return {
      sections,
      ends,
      length,
      at(index) {
        let lo = 0;
        let hi = ends.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (ends[mid] <= index) lo = mid + 1;
          else hi = mid;
        }
        return sections[lo][index - (ends[lo - 1] ?? 0)];
      },
      spliceFrom(previous) {
        if (!('sections' in previous)) return undefined;
        const old = previous as HistoryList;
        let first = 0;
        let last = sections.length;
        let oldLast = old.sections.length;
        while (first < last && first < oldLast && sections[first] === old.sections[first]) first++;
        while (
          last > first &&
          oldLast > first &&
          sections[last - 1] === old.sections[oldLast - 1]
        ) {
          last--;
          oldLast--;
        }
        let start = ends[first - 1] ?? 0;
        let end = ends[last - 1] ?? 0;
        let oldEnd = old.ends[oldLast - 1] ?? 0;
        // Preserve unchanged keys inside the changed turn too. A tool result
        // can update its call in place without removing its measured row.
        while (start < end && start < oldEnd && this.at(start) === old.at(start)) start++;
        while (end > start && oldEnd > start && this.at(end - 1) === old.at(oldEnd - 1)) {
          end--;
          oldEnd--;
        }
        return [start, oldEnd - start, end - start];
      },
    };
  });
  const lastDisplayKey = () => {
    const list = historyList();
    return list.length ? list.at(list.length - 1) : undefined;
  };
  const displayKeys = () => keySections().flat();
  const latestQuestion = computed(() =>
    props.compact
      ? display().findLastIndex(
          (item) => item.kind === 'row' && currentRow(item.rowId)?.role === 'user',
        )
      : -1,
  );
  const latestQuestionKey = () => displayKeys()[latestQuestion()] ?? null;
  // Set by the first follow-up, so the exchanges of this popup stay above the newest one.
  const compactStart = signal<string | null>(null);
  const shownKeys = computed(() => {
    if (!props.compact) return [];
    const start = compactStart();
    const anchored = start === null ? -1 : displayKeys().indexOf(start);
    const first = anchored >= 0 ? anchored : latestQuestion();
    return first <= 0 ? displayKeys() : displayKeys().slice(first);
  });
  const navigationItems = computed<TurnNavigationItem[]>(() => {
    const items = new Map<string, TurnNavigationItem>();
    for (const item of landmarks().items) {
      const turnKey = historyTurnKey(item);
      if (turnKey === undefined)
        throw new UiError('A history landmark has no source turn identity.');
      items.set(turnKey, {
        turnKey,
        order: item.order,
        label: item.label,
        anchor: {
          kind: 'landmark',
          through: landmarks().through,
          position: item.position,
          lastPosition: item.lastPosition,
        },
      });
    }
    for (const row of historyRows().userRows.values()) {
      const turnKey = historyTurnKey(row);
      if (
        turnKey === undefined ||
        !row.position ||
        !row.order ||
        row.role !== 'user' ||
        row.origin ||
        row.field !== 'body' ||
        (row.fragments && row.fragments[0]?.offset !== 0)
      )
        continue;
      const previous = items.get(turnKey);
      const label = (/\S[\s\S]{0,239}/u.exec(row.text)?.[0] ?? '').replace(/\s+/g, ' ').trim();
      if (
        !previous ||
        (previous.anchor.kind === 'loaded' && compareHistoryOrder(row.order, previous.order) < 0)
      )
        items.set(turnKey, {
          turnKey,
          order: row.order,
          label,
          anchor: { kind: 'loaded', position: row.position },
        });
      else if (sameHistoryRow(previous.anchor.position, row.position) && label)
        items.set(turnKey, { ...previous, label });
    }
    return [...items.values()].sort((left, right) => compareHistoryOrder(left.order, right.order));
  });
  const entryTurn = (key: string) => {
    const entry = displayEntry(key);
    if (entry?.kind === 'process') return entry.group.turnKey;
    if (entry && 'turnKey' in entry) return entry.turnKey ?? null;
    return null;
  };
  let list: ListRef | undefined;
  const scrollToTurn = (turnKey: string) => {
    const index =
      reading() === 'trajectory'
        ? displayKeys().indexOf(trajectoryTurnKey(turnKey))
        : displayKeys().findIndex((key) => entryTurn(key) === turnKey);
    if (index >= 0) list?.scrollToIndex({ index, viewPosition: 0, animated: false });
  };
  const showAnchor = (key: string, highlight: boolean) => {
    const index = displayKeys().indexOf(key);
    if (index < 0 || !list) return false;
    historyScrollInput = 'idle';
    batch(() => {
      historyFollowPaused.set(true);
      innerReader.set(null);
      highlightedAnchor.set(highlight ? key : null);
    });
    clearTimeout(anchorHighlight);
    if (highlight) anchorHighlight = setTimeout(() => highlightedAnchor.set(null), 1400);
    list.scrollToIndex({
      index,
      viewPosition: 0,
      viewOffset: platform.idiom === 'terminal' ? 0 : 12,
      // A distant row can still have estimated geometry. Resolve its native
      // reading pin before drawing the destination rather than traversing it.
      animated: false,
    });
    return true;
  };
  let pendingTrajectoryAnchor: string | null = null;
  const selectTrajectory = (key: string) => {
    if (selectedTrajectory() === null && !trajectorySideBySide()) pendingTrajectoryAnchor = key;
    trajectorySelection.set(key);
  };
  const closeTrajectoryInspector = () => {
    pendingTrajectoryAnchor = null;
    trajectorySelection.set(null);
    if (!historyFollowPaused() && atHistoryTail()) resumeHistoryFollowing();
  };
  const selectTrajectoryRange = (range: TrajectoryRange | null) => {
    batch(() => {
      trajectoryRange.set(range);
      if (range) historyFollowPaused.set(true);
    });
    const selected = trajectorySelection();
    const keys = displayKeys();
    if (selected !== null && !keys.includes(selected)) closeTrajectoryInspector();
    if (range && keys.length > 0) list?.scrollToIndex({ index: 0, animated: false });
  };
  const jumpTrajectoryEntry = (key: string) => {
    const entry = trajectoryByKey().get(key);
    if (!entry) return;
    batch(() => {
      trajectoryQuery.set('');
      if (trajectoryRange() !== null && !displayEntry(key)) trajectoryRange.set(null);
      if (entry.turnKey !== null && trajectoryCollapsed().has(entry.turnKey))
        toggleTrajectoryTurn(entry.turnKey);
      if (entry.kind === 'trajectory-record' && entry.ancestorToolKeys.length > 0) {
        const expanded = new Set(trajectoryCollapsedTools());
        for (const ancestor of entry.ancestorToolKeys) expanded.delete(ancestor);
        trajectoryCollapsedTools.set(expanded);
      }
      if (entry.kind !== 'trajectory-turn') selectTrajectory(key);
      historyFollowPaused.set(true);
    });
    const index = displayKeys().indexOf(key);
    if (index >= 0) list?.scrollToIndex({ index, viewPosition: 0, animated: false });
    list?.focus();
  };
  const jumpTrajectoryTurn = (turnKey: string) => jumpTrajectoryEntry(trajectoryTurnKey(turnKey));
  const inspectToolInTrajectory = (rowId: string) => {
    const key = trajectoryRecordKey(rowId);
    if (!currentRow(rowId)) return;
    cancelNavigation();
    batch(() => {
      innerReader.set(null);
      reading.set('trajectory');
    });
    if (!trajectorySideBySide()) pendingTrajectoryAnchor = key;
    jumpTrajectoryEntry(key);
  };

  const resumeHistoryFollowing = (animated = false) => {
    historyFollowPaused.set(false);
    innerReader.set(null);
    // Replace the list's reading anchor when manual scrolling reaches the end.
    list?.scrollToEnd({ animated: animated && !reduceMotion() });
  };
  let compactScroll: ScrollRef | undefined;
  let followCompact = false;
  let alive = true;
  let subscription: Subscription | null = null;
  let transcriptTask: Promise<void> | null = null;
  let wakeReconnect: (() => void) | null = null;
  let readFailure: { stream: Subscription; reason: unknown } | null = null;
  let refreshFrom: { position: HistoryRowAddress; order: HistoryOrder; field: string } | null =
    null;
  let latestKnown = 0;
  let watchLast = 0;
  let runThrough = 0;
  let predictionTriggerTurn: string | null = null;
  let followTask: Promise<void> | null = null;
  let followAgain = false;
  let historyIdentity: object = {};
  let measuredHistory: object | null = null;
  let historyScrolled = false;
  let windowTask: Promise<boolean> | null = null;
  let historyDestination: {
    position: HistoryPosition;
    explicit: boolean;
    failed: boolean;
  } = {
    position: { kind: 'tail' },
    explicit: false,
    failed: false,
  };
  let olderTask: Promise<boolean> | null = null;
  let newerTask: Promise<boolean> | null = null;
  let attemptedRead: {
    revision: number;
    messageId: string;
    exposure: object;
  } | null = null;
  let landmarksReadingThrough = -1;
  let draftRevision = 0;
  let pendingDraft: (AttachmentEdit & { text: string }) | null = null;
  let saveTask: Promise<void> | null = null;
  // From Enter until the send is reserved, the saved draft must stay the
  // revision being sent. Edits made meanwhile show at once and are saved after.
  let holding = false;
  let heldDraft: (AttachmentEdit & { text: string }) | null = null;
  const autoSend = signal<{ text: string; first?: boolean } | null>(null);
  const attachments = createAttachmentDraft({
    sessionId,
    client,
    focus: props.focusComposer,
    changed() {
      if (!alive || !draftReady()) return;
      queueDraft({ text: draft(), ...attachments.snapshot() });
    },
  });

  const report = (reason: unknown) => {
    if (alive) error.set(errorText(reason, 'Could not load conversation history.'));
  };
  const publishHistory = (
    chunks: AgentHistoryChunk[],
    through: number,
    older = false,
    coveredFrom?: number,
    windowStart?: number,
  ) => {
    batch(() => {
      const current = historyRows();
      const changed = mergeHistoryPage(chunks, (key) => current.byKey.get(key), older, through);
      if (changed.length) {
        current.put(changed);
        historyRows.set(current);
      }
      const canonical = historyRows();
      overlay.history(canonical.byId, atHistoryTail() ? through : null, coveredFrom, windowStart);
      publishOverlay();
      const currentPending = pendingMessages();
      const nextPending = currentPending.filter(
        (row) => !canonical.byMessage.has(`${row.messageId}/${row.field}`),
      );
      if (nextPending.length !== currentPending.length) pendingMessages.set(nextPending);
    });
    hydrateAttachmentMetadata();
  };
  const executorTextChanges = new Set<string>();
  const requestMetadata = (row: Pick<Row, 'position' | 'order' | 'field'> | undefined) => {
    if (!row?.position || !row.order) return;
    const next = { position: row.position, order: row.order, field: row.field };
    const order = (a: typeof next, b: typeof next) =>
      compareHistoryOrder(a.order, b.order) ||
      Number(a.field === 'body') - Number(b.field === 'body');
    if (refreshFrom === null || order(next, refreshFrom) < 0) refreshFrom = next;
    followAgain = true;
  };
  const publishMetadata = (chunks: AgentHistoryChunk[], through: number) => {
    const current = historyRows();
    const changed = new Map<string, Row>();
    for (const chunk of chunks) {
      const key = historyRowKey(chunk.position, chunk.field);
      const row = changed.get(key) ?? current.byKey.get(key);
      if (!row) continue;
      const next = replaceHistoryMetadata(row, chunk, through);
      if (next !== row) changed.set(key, next);
    }
    if (changed.size) {
      current.put([...changed.values()].sort(compareRows));
      historyRows.set(current);
    }
    if (!current.missingAttachments.size) attachmentMetadataFailed.set(false);
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
    return { ...page, through: page.through };
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
    historyScrolled = false;
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
      let page: Awaited<ReturnType<typeof history>>;
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
      if (position.kind === 'tail') {
        const tail = await readHistoryTail(page, async (cursor) => {
          const older = await history(through, { kind: 'before', cursor });
          return canPublish() ? older : null;
        });
        if (tail === null || !canPublish()) return false;
        page = { ...tail, through };
      }
      batch(() => {
        historyRows.set(new HistoryRows());
        historyWindow.set({
          identity,
          through: page.through,
          before: page.before,
          after: page.after,
        });
        publishHistory(
          page.chunks,
          page.through,
          false,
          page.after === null && page.before === null ? 0 : undefined,
        );
        ready.set(true);
        historyFollowPaused.set(position.kind !== 'tail');
        innerReader.set(null);
      });
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
    for (const rowKey of historyRows().missingAttachments) {
      const row = historyRows().byKey.get(rowKey)!;
      if (!row.position) continue;
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
          const current = historyRows().byKey.get(row.key);
          if (
            !current ||
            current.messageId !== row.messageId ||
            current.metadataThrough !== through
          )
            return;
          const first = page.chunks.find(
            (chunk) => sameHistoryRow(chunk.position, position) && chunk.field === 'body',
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
          const current = historyRows().byKey.get(row.key);
          if (
            alive &&
            current &&
            current.messageId === row.messageId &&
            current.metadataThrough === through &&
            current.attachments === undefined
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
      if (subscription === null) {
        overlay.observe(observed);
        publishOverlay();
      }
      const completedTurn = observed.lastCompletedTurnId;
      lastCompletedTurn.set(completedTurn);
      const trigger = predictionTrigger({
        completedTurnId: completedTurn,
        activeTurnId: observed.run?.turnId ?? null,
        previousActiveTurnId: runTurn(),
        completedEventTurnId: predictionTriggerTurn,
      });
      if (trigger === 'live') predictionTriggerTurn = completedTurn;
      metrics.set(observed.metrics ?? null);
      if (observed.run) {
        run.set(observed.run.state);
        runId.set(observed.run.runId);
        runBackend.set(observed.run.backend);
        runTurn.set(observed.run.turnId);
      } else if (runId() === null) {
        // Exact execution reads below distinguish terminal history from a Run
        // whose current activation is simply absent.
        run.set(rows().length === 0 ? 'idle' : 'loading');
      }
      compacting.set(observed.compacting);
      messagePrediction.source(
        observed.session.parentSessionId === null ? completedTurn : null,
        trigger,
        JSON.stringify(backend()),
      );
      runThrough = observed.through;
      executionRevision.set(executionRevision() + 1);
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
        const refresh = refreshFrom;
        refreshFrom = null;
        const currentWindow = historyWindow();
        if (currentWindow?.after === null) {
          const tail = rows().at(-1);
          const changedRows = [...executorTextChanges].flatMap((id) => {
            const row = historyRows().byMessage.get(id);
            return row && row !== tail && row.position?.kind === 'live' ? [row] : [];
          });
          executorTextChanges.clear();
          // A native message can keep streaming after another row has taken the tail.
          for (const row of changedRows) {
            let position = historyFollowPosition(row, []);
            const chunks: AgentHistoryChunk[] = [];
            for (;;) {
              const page = await history(fence, position);
              if (!ownsWindow(owner.identity)) return;
              const matching = page.chunks.filter(
                (chunk) =>
                  sameHistoryRow(chunk.position, row.position!) && chunk.field === row.field,
              );
              chunks.push(...matching);
              if (page.after === null || matching.length !== page.chunks.length) break;
              position = { kind: 'after', cursor: page.after };
            }
            publishHistory(chunks, fence);
          }
          const windowStart =
            currentWindow.before && rows()[0] ? rootEventSequence(rows()[0]) : undefined;
          const snap = overlay.snapshot();
          const initial = historyFollowPosition(tail, snap.rows, snap.closedStarts, windowStart);
          const coveredFrom =
            initial.kind === 'start' ? 0 : initial.kind === 'event' ? initial.sequence : undefined;
          let position = initial;
          const chunks: AgentHistoryChunk[] = [];
          for (;;) {
            const page = await history(fence, position);
            if (!ownsWindow(owner.identity)) return;
            chunks.push(...page.chunks);
            if (page.after === null) break;
            position = { kind: 'after', cursor: page.after };
          }
          publishHistory(chunks, fence, false, coveredFrom, windowStart);
          const current = historyWindow()!;
          historyWindow.set({ ...current, through: fence, after: null });
        }
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
                  const order = compareHistoryOrder(chunk.order, last.order!);
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
    if (page.kind === 'preview') {
      overlay.page(page.page);
      publishOverlay();
      return;
    }
    if (page.kind !== 'events') return;
    latestKnown = Math.max(latestKnown, page.through);
    let changed = false;
    for (const event of page.events) {
      if (event.sequence <= watchLast) continue;
      const fact = event.fact;
      overlay.event(event);
      switch (fact.kind) {
        case 'opened':
          if (event.sequence > runThrough) {
            predictionTriggerTurn = null;
            lastCompletedTurn.set(null);
            messagePrediction.source(null, 'live');
            run.set('admitted');
            runId.set(event.runId);
            runBackend.set(null);
            runTurn.set(event.turnId);
            requestMetadata(
              rows().find((row) => row.position?.kind === 'live' && row.turnId === event.turnId),
            );
            void observe().catch(report);
            runThrough = event.sequence;
          }
          changed = true;
          break;
        case 'delta':
          break;
        case 'part_committed':
          changed = true;
          break;
        case 'step_ended':
          void observe().catch(report);
          changed = true;
          break;
        case 'ended':
          requestMetadata(
            rows().find((row) => row.position?.kind === 'live' && row.turnId === event.turnId),
          );
          if (event.sequence > runThrough && event.runId === runId()) {
            const completedTurn = fact.failed ? null : event.turnId;
            predictionTriggerTurn = completedTurn;
            lastCompletedTurn.set(completedTurn);
            run.set('loading');
            runId.set(null);
            runBackend.set(null);
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
        case 'executor_text_changed': {
          const id = `${fact.messageId}/${fact.thinking ? 'thinking' : 'body'}`;
          if (atHistoryTail() || historyRows().byMessage.has(id)) executorTextChanges.add(id);
          changed = true;
          break;
        }
        case 'transcript_changed':
          void observe().catch(report);
          changed = true;
          break;
      }
    }
    publishOverlay();
    watchLast = Math.max(watchLast, page.nextAfter);
    if (changed) void follow().catch(report);
  };

  const openTranscript = async () => {
    if (followTask) await followTask.catch(() => {});
    if (!alive) return;
    // A turn may have ended while its watch was offline. Earlier accepted
    // fragments need the same completion metadata refresh as an ended event.
    const previousTurn = runTurn();
    if (previousTurn !== null)
      requestMetadata(
        rows().find((row) => row.position?.kind === 'live' && row.turnId === previousTurn),
      );
    const observed = await observe();
    if (!alive) return;
    const tailThrough = atHistoryTail() ? historyWindow()?.through : undefined;
    const after = replayStartCursor(
      Math.min(tailThrough ?? observed.through, observed.through),
      observed.parts,
      observed.toolSeeds,
    );
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
      ) {
        list?.scrollToEnd({ animated: false });
      }
      if (!alive) return;
      immediateTranscriptRetry = true;
      if (!historyDestination.failed) error.set('');
      transcriptStatus.set('live');
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
        console.warn('Conversation observer cleanup failed:', reason);
      } finally {
        // This replaces only the read-only JS observer. Native Client retains
        // unconfirmed Request custody until the
        // original session close acknowledges cleanup. No mutation is replayed.
        if (subscription === stream) subscription = null;
        if (readFailure?.stream === stream) readFailure = null;
      }
    }
  };
  let immediateTranscriptRetry = true;
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
          overlay.disconnect();
          publishOverlay();
          if (immediateTranscriptRetry && isObservationCancelled(reason)) {
            immediateTranscriptRetry = false;
            continue;
          }
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
        if (page.chunks.length || page[direction] === null) {
          batch(() => {
            historyWindow.set({ ...current, [direction]: page[direction] });
            publishHistory(page.chunks, page.through, direction === 'before');
          });
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
  const pagingOwner = (edge: 'before' | 'after') => {
    const owner = historyWindow();
    return (edge === 'before' || historyScrolled) &&
      owner?.[edge] &&
      ownsWindow(owner.identity) &&
      props.visible() &&
      navigation() === null
      ? owner.identity
      : null;
  };
  const nearHistoryStart = () =>
    historyOffset <= readingSize().height * HISTORY_LOOKAHEAD_VIEWPORTS;
  const olderHistory = createHistoryPrefetch({
    owner: () => pagingOwner('before'),
    nearEdge: nearHistoryStart,
    loadPage: loadOlder,
  });
  const prefetchOlder = () => void olderHistory().catch(report);
  const nearHistoryEnd = () =>
    historyMaxOffset - historyOffset <= readingSize().height * HISTORY_LOOKAHEAD_VIEWPORTS;
  const newerHistory = createHistoryPrefetch({
    owner: () => pagingOwner('after'),
    nearEdge: nearHistoryEnd,
    loadPage: loadNewer,
  });
  const prefetchNewer = () => void newerHistory().catch(report);
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
    historyDestination = {
      position: { kind: 'start' },
      explicit: true,
      failed: false,
    };
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
    const rowTurn = historyTurnKey(row);
    if (rowTurn !== undefined) {
      const turn = projectedTurn(rowTurn);
      if (turn) unfoldTurn(turn);
    }
    const id = stableRowId(row);
    const entry = display().find((item) =>
      item.kind === 'row'
        ? item.rowId === id
        : item.kind === 'process' &&
          item.group.members.some((member) => member.kind === 'row' && member.rowId === id),
    );
    if (!entry) throw new UiError('The original message is not available in this conversation.');
    if (entry.kind === 'process') {
      // A hidden script opens its group from the top.
      const index = Math.max(0, entry.group.rowIds.indexOf(id));
      const state = groupState(entry.key);
      state.following.set(false);
      state.opening = undefined;
      state.revealRow = entry.group.rowIds[index];
      state.open.set(true);
      state.requestFocus = true;
      innerReader.set(entry.key);
      if (state.list) {
        state.list.scrollToIndex({
          index,
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
    historyFollowPaused.set(true);
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
      position: {
        kind: 'row' as const,
        position: anchor.position,
        field: 'body' as const,
      },
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
                (anchor.messageId == null || chunk.messageId === anchor.messageId) &&
                chunk.field === 'body' &&
                chunk.offset === 0 &&
                sameHistoryRow(chunk.position, anchor.position),
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
          (anchor.messageId == null || candidate.messageId === anchor.messageId) &&
          candidate.field === 'body' &&
          candidate.position &&
          sameHistoryRow(candidate.position, anchor.position),
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
  const loadedAnchorKey = (item: TurnNavigationItem) => {
    if (reading() === 'trajectory')
      return trajectoryByKey().has(trajectoryTurnKey(item.turnKey))
        ? trajectoryTurnKey(item.turnKey)
        : null;
    const row = historyRows().userRows.get(historyRowKey(item.anchor.position));
    if (!row) return null;
    const id = stableRowId(row);
    const entry = displayEntry(id);
    return entry?.kind === 'row' ? entry.key : null;
  };
  const navigateTurn = async (item: TurnNavigationItem, mode: 'select' | 'scrub' = 'select') => {
    if (!alive) return;
    const key = loadedAnchorKey(item);
    if (mode === 'scrub' && (reading() !== 'chat' || key === null)) return;
    cancelNavigation();
    if (key !== null) {
      if (reading() === 'trajectory') jumpTrajectoryTurn(item.turnKey);
      else showAnchor(key, mode === 'select');
      return;
    }
    const target: HistoryNavigation = { kind: 'turn', item };
    const position = { kind: 'row', position: item.anchor.position, field: 'body' } as const;
    historyDestination = {
      position,
      explicit: true,
      failed: false,
    };
    navigation.set(target);
    try {
      if (
        !(await resetHistory(
          position,
          latestKnown,
          (page) => {
            if (!page.chunks.some((chunk) => historyTurnKey(chunk) === item.turnKey))
              throw new UiError('This turn is no longer available.');
          },
          () => navigation() === target,
        ))
      )
        return;
      if (navigation() !== target) return;
      if (reading() === 'trajectory') jumpTrajectoryTurn(item.turnKey);
      else {
        const key = loadedAnchorKey(item);
        if (key !== null) showAnchor(key, true);
        else scrollToTurn(item.turnKey);
      }
    } finally {
      if (navigation() === target) navigation.set(null);
    }
  };
  const navigateAdjacentTurn = (direction: -1 | 1) => {
    const items = navigationItems();
    const selected = navigatingTurn() ?? visibleTurn();
    const active = items.findIndex((item) => item.turnKey === selected);
    const current = active < 0 ? (direction < 0 ? items.length : -1) : active;
    const index = current + direction;
    const item = items[index];
    if (item) void navigateTurn(item).catch(report);
  };
  effect(() => {
    const node = root();
    if (!node || props.compact || !props.visible() || !ready()) return;
    return keymap.bind(
      { 'alt+up': () => navigateAdjacentTurn(-1), 'alt+down': () => navigateAdjacentTurn(1) },
      { within: node, when: 'notEditing' },
    );
  });

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
    const first = autoSend();
    if (first?.first) {
      const firstText = first.text;
      heldDraft = edit.text !== firstText ? edit : null;
      pendingDraft = { ...edit, text: firstText };
      startSave();
      return;
    }
    pendingDraft = edit;
    startSave();
  };
  const changeDraft = (text: string) => {
    if (!alive || !draftReady()) return;
    draft.set(text);
    queueDraft({ text, ...attachments.snapshot() });
  };
  // Save edits held while a send was being reserved.
  const releaseHeld = () => {
    holding = false;
    const edit = heldDraft;
    heldDraft = null;
    if (edit === null || !alive) return;
    pendingDraft = edit;
    startSave();
  };

  // Choosing a model answers the earlier send's complaint; other errors stay.
  effect(() => {
    if (backend() === null) return;
    untracked(() => {
      if (error() === tr('Choose a model before sending.')) error.set('');
    });
  });
  // Metadata follows the route's value, not observe()'s newly allocated backend
  // objects or live stream state. The durable backend remains the only choice.
  const modelRoute = computed(() => {
    const value = backend();
    return value === null ? null : routeKey(value);
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
    const captured = backend();
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
        const result = await host.query('agent', 'model', { backend: captured });
        if (!current()) return;
        modelProjection.set({
          route,
          details:
            result.kind === 'ready' && sameRoute(captured, result.choice.selection)
              ? { kind: 'ready', choice: result.choice }
              : {
                  kind: 'unavailable',
                  message: uiMessage('Model unavailable: {model}.', {
                    model: backendName(captured),
                  }),
                },
        });
      } catch (reason) {
        if (current())
          modelProjection.set({
            route,
            details: { kind: 'unavailable', message: errorText(reason, 'Could not load models.') },
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
    if (expectedBackend !== undefined && !sameBackend(backend ?? null, expectedBackend))
      throw new UiError('The model changed before confirmation. Send again to confirm it.');
    if (backend?.kind !== 'model') throw new UiError('This action requires a native model.');
    const resolved = await host.query('agent', 'model', { backend });
    if (!alive) return null;
    if (resolved.kind !== 'ready')
      throw new UiError('Model unavailable: {model}. Choose another model.', {
        model: backend.modelId,
      });
    return {
      model: { connectionId: backend.connectionId, modelId: backend.modelId },
      thinkingLevel: backend.thinkingLevel ?? null,
    };
  };

  const terminal = (value: AgentExecution): value is ComposerContinuation['source'] =>
    value.state.kind === 'completed' ||
    value.state.kind === 'failed' ||
    value.state.kind === 'cancelled';
  // A history window is not the session tip. Only an exact tail supplies a
  // candidate, and execution() must still prove its durable state and fence.
  const executionSource = computed(() => {
    const active = runId();
    if (active !== null) return active;
    if (!atHistoryTail() || (historyWindow()?.through ?? -1) < readState().through) return null;
    return rows().findLast((row) => row.runId !== undefined)?.runId ?? null;
  });
  const acceptExecution = (value: AgentExecution) => {
    if (value.sessionId !== sessionId) throw new UiError('Host observed a different session.');
    const previous = execution();
    if (previous?.runId === value.runId && previous.highWater > value.highWater) return;
    execution.set(value);
    if (terminal(value)) {
      run.set(value.state.kind === 'failed' ? 'failed' : 'idle');
      if (runId() === value.runId) {
        lastCompletedTurn.set(value.state.kind === 'completed' ? value.turnId : null);
        runId.set(null);
        runBackend.set(null);
        runTurn.set(null);
        stoppingRun.set(null);
      }
    } else {
      // No live handle does not prove failure: a durable wait/blocker remains active.
      runId.set(value.runId);
      runTurn.set(value.turnId);
      switch (value.state.kind) {
        case 'admitted':
        case 'running':
        case 'waiting':
          run.set(value.state.kind);
          break;
      }
    }
  };
  effect(() => {
    const source = executionSource();
    executionRevision();
    readState().through;
    const loaded = ready();
    let current = true;
    untracked(() => {
      if (execution()?.runId !== source) execution.set(null);
      if (!loaded || source === null) return;
      void host
        .query('agent', 'execution', { sessionId, runId: source })
        .then((result) => {
          if (!alive || !current || executionSource() !== source) return;
          if (result.kind !== 'found') return;
          if (result.execution.runId !== source)
            throw new UiError('Host observed a different session.');
          batch(() => acceptExecution(result.execution));
        })
        .catch((reason) => {
          if (alive && current) report(reason);
        });
    });
    return () => {
      current = false;
    };
  });
  const continuation = computed<ComposerContinuation | null>(() => {
    const source = execution();
    if (
      !ready() ||
      archived() ||
      transcriptStatus() !== 'live' ||
      props.connectionLost() ||
      (queued()?.entries.length ?? 0) !== 0 ||
      runId() !== null ||
      backend()?.kind !== 'model' ||
      source === null ||
      source.runId !== executionSource() ||
      !terminal(source) ||
      source.state.kind === 'completed'
    )
      return null;
    return { source };
  });
  const continueRun = async (source: AgentExecution, expectedBackend: BackendIdentity) => {
    const observed = continuation();
    if (
      !alive ||
      confirmingContinuation() ||
      runId() !== null ||
      draft().trim() ||
      attachments.files().length ||
      sendBlockedReason() ||
      observed === null ||
      observed.source.sessionId !== source.sessionId ||
      observed.source.runId !== source.runId ||
      observed.source.highWater !== source.highWater ||
      !terminal(source) ||
      !sameBackend(backend(), expectedBackend)
    )
      return;
    continuing.set(true);
    try {
      const model = await selection(expectedBackend);
      if (!alive || !model || draft().trim() || attachments.files().length) return;
      // Re-read the exact source after model resolution; never reopen the old Run
      // merely because the current activation/handle is missing.
      const latest = await host.query('agent', 'execution', { sessionId, runId: source.runId });
      if (
        !alive ||
        latest.kind !== 'found' ||
        latest.execution.sessionId !== sessionId ||
        latest.execution.runId !== source.runId ||
        latest.execution.highWater !== source.highWater ||
        !terminal(latest.execution) ||
        runId() !== null ||
        draft().trim() ||
        attachments.files().length ||
        !sameBackend(backend(), expectedBackend)
      )
        return;
      const result: AgentContinuationResult = await props.control('continueRun', {
        sessionId,
        sourceRunId: source.runId,
        sourceHighWater: source.highWater,
        ...model,
      });
      if (!alive) return;
      if (result.kind === 'rejected') notice.set(uiMessage(continuationRejected[result.reason]));
      else {
        if (result.execution.sessionId !== sessionId || result.execution.runId === source.runId)
          throw new UiError('Host returned an unexpected send result.');
        batch(() => acceptExecution(result.execution));
      }
      await observe();
    } catch (reason) {
      report(reason);
    } finally {
      if (alive)
        batch(() => {
          continuing.set(false);
          executionRevision.set(executionRevision() + 1);
        });
    }
  };
  const settleReply = (reply: any, text?: string, files: DraftAttachment[] = []) => {
    const accepted = acceptedSend(reply, sessionId);
    if (!accepted) return;
    if (
      accepted.kind === 'started' &&
      text !== undefined &&
      !historyRows().byMessage.has(`${accepted.messageId}/body`)
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
  };

  const nativeSteer = (delivery: 'steer' | 'queue') =>
    delivery === 'steer' && runId() !== null && runBackend() === 'model';
  const modelLoading = (delivery: 'steer' | 'queue' = 'steer') =>
    !nativeSteer(delivery) && backend() !== null && modelDetails().kind === 'loading';
  const autoSending = () => {
    const pending = autoSend();
    return pending !== null && (!!pending.first || draft() === pending.text);
  };
  const sendSelection = (delivery: 'steer' | 'queue', expectedBackend?: BackendIdentity) => {
    const expectedRunId = runId() ?? undefined;
    if (expectedRunId !== undefined && runBackend() === null)
      throw new UiError('Loading session history… Your draft is kept.');
    if (nativeSteer(delivery)) return { delivery, expectedRunId };
    const selected = backend();
    if (expectedBackend !== undefined && !sameBackend(selected, expectedBackend))
      throw new UiError('The model changed before confirmation. Send again to confirm it.');
    if (!selected) throw new UiError('Choose a model before sending.');
    const details = modelDetails();
    if (details.kind !== 'ready')
      throw new UiError('Model unavailable: {model}. Choose another model.', {
        model: backendName(selected),
      });
    return {
      delivery,
      expectedRunId,
      backend: selected,
    };
  };

  const sendBlockedReasonFor = (includeAutoSend: boolean) => {
    if (transcriptStatus() === 'closing')
      return tr('Closing disconnected updates… Your draft is kept.');
    if (transcriptStatus() === 'failed')
      return ready()
        ? tr('Updates disconnected. Reconnecting automatically; your draft is kept.')
        : tr('History unavailable. Retrying automatically; your draft is kept.');
    if (ready() && transcriptStatus() !== 'live')
      return tr('Reconnecting updates… Your draft is kept.');
    if (!ready() || (runId() !== null && runBackend() === null))
      return tr('Loading session history… Your draft is kept.');
    if (archived() && formerBot())
      return tr(
        'This is a Bot that was replaced. It is read-only; restore it in Sessions to use it as a conversation.',
      );
    if (archived())
      return tr(
        'This conversation is archived. Restore it in Sessions to send; your draft is kept.',
      );
    if (!draftReady()) return tr('Loading the saved draft…');
    if (savingFailed()) return tr('The draft could not be saved. Sending is unavailable.');
    if (attachments.blocked()) return attachments.blocked();
    if (confirmingContinuation()) return tr('Confirming continuation…');
    if (sending() || (includeAutoSend && autoSending()))
      return tr('Saving message… New typing is kept.');
    if (freezeState().kind === 'failed')
      return tr('Retry or remove the unsaved message before sending another.');
    if (!receiptsKnown()) return tr('Checking send status…');
    return '';
  };
  const sendBlockedReason = () => sendBlockedReasonFor(true);

  const refreshSends = async () => {
    const operations = await pendingSends(client);
    if (alive) {
      unresolved.set(operations);
      receiptsKnown.set(true);
      const ids = new Set(operations.map((item) => item.id));
      sendErrors.set(new Map([...sendErrors()].filter(([id]) => ids.has(id))));
      sendDeliveries.set(new Map([...sendDeliveries()].filter(([id]) => ids.has(id))));
    }
    return operations;
  };
  const sendError = (id: string, reason: unknown) => {
    if (alive)
      sendErrors.set(
        new Map(sendErrors()).set(id, errorText(reason, 'Could not send the message.')),
      );
  };
  const confirmFrozen = async (id: string, frozen: FrozenSend) => {
    activeSends.set(new Map(activeSends()).set(id, frozen));
    try {
      if (frozen.selection.backend?.kind === 'model' && !(await projectMcp.check())) {
        await abandonSend(client, id);
        sendError(id, new UiError('Approve workspace connections, then retry this message.'));
        return;
      }
      const sent = await confirmSend(client, id);
      if (alive) settleReply(sent.reply, frozen.text, frozen.files);
    } catch (reason) {
      sendError(id, reason);
    } finally {
      try {
        if (alive) await refreshSends();
      } catch (reason) {
        report(reason);
      }
      if (alive) {
        const next = new Map(activeSends());
        next.delete(id);
        activeSends.set(next);
      }
    }
  };
  const freezeSend = async (frozen: FrozenSend) => {
    if (!alive || sending()) return;
    const reservation = { kind: 'reserving' as const, frozen };
    freezeState.set(reservation);
    const ownsReservation = () => alive && freezeState() === reservation;
    let operation: string | undefined;
    try {
      if (frozen.revision !== undefined) {
        // A lost local reply can be recovered by the exact draft revision;
        // message text is never used to infer whether an attempt already exists.
        const originals = await refreshSends();
        if (!ownsReservation()) return;
        operation = originals.find((item) => item.draft?.revision === frozen.revision)?.id;
      }
      if (operation === undefined) {
        if (savingFailed()) {
          const stored = await loadDraft(client);
          if (!ownsReservation()) return;
          draftRevision = stored.revision;
          savingFailed.set(false);
          pendingDraft = frozen.edit;
        }
        await flushDraft();
        if (!ownsReservation()) return;
        if (savingFailed())
          throw new UiError('The draft could not be saved; it has not been sent.');
        frozen.revision = draftRevision;
        operation = await reserveSend(client, draftRevision, frozen.selection);
      }
      if (!ownsReservation()) return;
      releaseHeld();
      freezeState.set({ kind: 'idle' });
      void confirmFrozen(operation, frozen);
    } catch (reason) {
      if (ownsReservation())
        freezeState.set({
          kind: 'failed',
          frozen,
          error: errorText(reason, 'Could not send the message.'),
        });
    }
  };
  const send = async (
    text: string,
    expectedBackend?: BackendIdentity,
    first?: boolean,
    delivery: 'steer' | 'queue' = 'steer',
  ) => {
    if (!alive) return;
    if (!text.trim() && attachments.files().length === 0) {
      return;
    }
    if (sendBlockedReason()) {
      notice.set(
        uiMessage(
          'This message was not sent. Your draft is kept; check the status below before trying again.',
        ),
      );
      return;
    }
    try {
      let targetBackend = expectedBackend;
      if (modelLoading(delivery)) {
        const capturedBackend = expectedBackend ?? backend() ?? undefined;
        const capturedAttachments = attachments.ids();
        checkingModel.set(true);
        try {
          await refreshModel();
        } finally {
          if (alive) checkingModel.set(false);
        }
        if (!alive) return;
        if (sendBlockedReason()) {
          notice.set(
            uiMessage(
              'This message was not sent. Your draft is kept; check the status below before trying again.',
            ),
          );
          return;
        }
        if (!first && (draft() !== text || !attachments.same(capturedAttachments))) {
          throw new UiError('The draft changed before confirmation. Send again to confirm it.');
        }
        targetBackend = capturedBackend;
      }
      const selected = sendSelection(delivery, targetBackend);
      const edit = { text, ...attachments.snapshot() };
      const frozen: FrozenSend = {
        id: `draft-send-${++sendSequence}`,
        text,
        files: edit.attachments,
        edit,
        selection: selected,
      };
      const nextText = first && draft() !== text ? draft() : '';
      pendingDraft = edit;
      holding = true;
      error.set('');
      changeDraft(nextText);
      attachments.sent(edit.attachments.map((file) => file.id));
      await freezeSend(frozen);
    } catch (reason) {
      report(reason);
    }
  };

  const acceptedQueued = (original: SendOperation) =>
    original.receipt?.kind === 'recorded' &&
    original.receipt.outcome.kind === 'returned' &&
    acceptedSend({ receipt: original.receipt }, sessionId)?.kind === 'queued';
  const retryable = (original: SendOperation) =>
    sendDeliveries().get(original.id) === 'cancelled' ||
    original.abandoned ||
    sendReceiptFailure(original.receipt)?.retryable === true;
  const needsRecovery = (original: SendOperation) =>
    !original.abandoned &&
    !activeSends().has(original.id) &&
    (original.receipt == null ||
      (original.receipt.kind === 'recorded' && original.receipt.outcome.kind === 'unresolved'));
  const checkSend = async (id: string) => {
    const original = unresolved().find((item) => item.id === id);
    if (!alive || !original || activeSends().has(id) || checkingSends().has(id)) return;
    checkingSends.set(new Set(checkingSends()).add(id));
    try {
      if (!acceptedQueued(original)) {
        const reply = await recoverSend(client, id);
        if (alive)
          settleReply(
            reply,
            original.correlation.draft.text,
            original.correlation.draft.attachments,
          );
      }
      const delivery = await sendDelivery(client, id);
      if (alive) {
        sendDeliveries.set(new Map(sendDeliveries()).set(id, delivery));
        const errors = new Map(sendErrors());
        errors.delete(id);
        sendErrors.set(errors);
      }
    } catch (reason) {
      if (alive) sendDeliveries.set(new Map(sendDeliveries()).set(id, 'unknown'));
      sendError(id, reason);
    } finally {
      if (alive) {
        const next = new Set(checkingSends());
        next.delete(id);
        checkingSends.set(next);
        await refreshSends();
      }
    }
  };
  const retryOriginal = async (id: string) => {
    const freezing = freezeState();
    if (freezing.kind !== 'idle' && freezing.frozen.id === id) {
      await freezeSend(freezing.frozen);
      return;
    }
    const original = unresolved().find((item) => item.id === id);
    if (
      !alive ||
      !original ||
      !retryable(original) ||
      activeSends().has(id) ||
      checkingSends().has(id)
    )
      return;
    try {
      const snapshot = original.correlation;
      const selected = sendSelection(snapshot.selection.delivery);
      const retry: FrozenSend = {
        id,
        text: snapshot.draft.text,
        files: snapshot.draft.attachments,
        edit: {
          text: snapshot.draft.text,
          attachments: snapshot.draft.attachments,
          settledUploads: [],
        },
        selection: selected,
      };
      activeSends.set(new Map(activeSends()).set(id, retry));
      const next = await retrySend(client, id, selected);
      if (alive) {
        const active = new Map(activeSends());
        active.delete(id);
        activeSends.set(active);
        void confirmFrozen(next, retry);
      }
    } catch (reason) {
      const active = new Map(activeSends());
      active.delete(id);
      activeSends.set(active);
      sendError(id, reason);
    }
  };
  const dismissOriginal = async (id: string) => {
    if (!alive || activeSends().has(id) || checkingSends().has(id)) return;
    const freezing = freezeState();
    if (freezing.kind !== 'idle' && freezing.frozen.id === id) {
      if (freezing.kind === 'reserving') return;
      savingFailed.set(false);
      releaseHeld();
      freezeState.set({ kind: 'idle' });
      return;
    }
    try {
      await dismissSend(client, id);
      if (alive) await refreshSends();
    } catch (reason) {
      sendError(id, reason);
    }
  };
  const sendStatuses = (): ComposerSendStatus[] => {
    const statuses = new Map<string, ComposerSendStatus>();
    const followups = new Set(
      queued()
        ?.entries.filter((entry) => entry.kind === 'followup')
        .map((entry) => entry.messageId),
    );
    for (const original of unresolved()) {
      const receiptFailure = sendReceiptFailure(original.receipt);
      const cancelled = sendDeliveries().get(original.id) === 'cancelled';
      const canRetry = cancelled || original.abandoned || receiptFailure?.retryable === true;
      const failed = canRetry || receiptFailure !== null;
      const checking = checkingSends().has(original.id);
      const detail = sendErrors().get(original.id);
      if (
        !failed &&
        !detail &&
        acceptedQueued(original) &&
        sendDeliveries().get(original.id) !== 'unknown' &&
        followups.has(acceptedSend({ receipt: original.receipt }, sessionId).messageId)
      )
        continue;
      statuses.set(original.id, {
        id: original.id,
        text: original.correlation.draft.text,
        attachments: original.correlation.draft.attachments,
        state: failed
          ? 'failed'
          : acceptedQueued(original) && sendDeliveries().get(original.id) !== 'unknown'
            ? 'accepted'
            : 'unknown',
        detail: checking
          ? tr('Checking send status…')
          : receiptFailure
            ? renderText(receiptFailure.detail)
            : cancelled
              ? tr('Stopped before delivery. Your message is kept.')
              : detail
                ? renderText(detail)
                : original.abandoned
                  ? tr('Message was not sent.')
                  : acceptedQueued(original) && sendDeliveries().get(original.id) !== 'unknown'
                    ? tr('Received · waiting for the next step')
                    : tr('Delivery not confirmed. Check status before retrying.'),
        retryable: canRetry && !checking,
        busy: checking,
      });
    }
    for (const [id, frozen] of activeSends()) {
      statuses.set(id, {
        id,
        text: frozen.text,
        attachments: frozen.files,
        state: 'sending',
        detail: tr('Sending…'),
        retryable: false,
        busy: true,
      });
    }
    const freezing = freezeState();
    if (freezing.kind !== 'idle')
      statuses.set(freezing.frozen.id, {
        id: freezing.frozen.id,
        text: freezing.frozen.text,
        attachments: freezing.frozen.files,
        state: freezing.kind === 'reserving' ? 'sending' : 'failed',
        detail: freezing.kind === 'reserving' ? tr('Saving message…') : renderText(freezing.error),
        retryable: freezing.kind === 'failed',
        busy: freezing.kind === 'reserving',
      });
    return [...statuses.values()];
  };
  const recover = async () => {
    if (!alive || recovering() || sending()) return;
    recovering.set(true);
    try {
      const originals = await refreshSends();
      for (const original of originals) {
        if (!alive) return;
        if (needsRecovery(original) || acceptedQueued(original)) await checkSend(original.id);
      }
    } catch (reason) {
      report(reason);
    } finally {
      if (alive) recovering.set(false);
    }
  };

  let checkedDeliveryKey = '';
  effect(() => {
    const queue = queued();
    const accepted = unresolved().filter(acceptedQueued);
    const key = JSON.stringify([
      queue?.revision,
      accepted.map((item) => item.id),
      [...activeSends().keys()],
      transcriptStatus(),
      props.connectionLost(),
    ]);
    if (key === checkedDeliveryKey) return;
    checkedDeliveryKey = key;
    if (queue && accepted.length)
      untracked(() => {
        const received = new Set(queue.entries.map((item) => item.messageId));
        const deliveries = new Map(sendDeliveries());
        for (const original of accepted) {
          const message = acceptedSend({ receipt: original.receipt }, sessionId);
          if (received.has(message.messageId)) deliveries.set(original.id, 'accepted');
          else void checkSend(original.id).catch(report);
        }
        sendDeliveries.set(deliveries);
      });
  });

  createPendingRecovery({
    pending: () => !receiptsKnown() || unresolved().some(needsRecovery),
    blocked: () => !draftReady() || sending() || recovering(),
    recover,
  });
  const stop = async (targetRunId: RunId | null) => {
    if (!alive || !targetRunId || runId() !== targetRunId || stopping()) return;
    stoppingRun.set(targetRunId);
    try {
      const result = await props.control('stop', { sessionId, runId: targetRunId });
      if (!alive) return;
      if (!result.requested) await observe();
      // Stop is a durable admission fence, not proof that in-flight work ended.
    } catch (reason) {
      if (alive && stoppingRun() === targetRunId) stoppingRun.set(null);
      report(reason);
    }
  };
  const chooseReading = ({ owner, mode }: { owner: string; mode: 'chat' | 'trajectory' }) => {
    if (!alive || owner !== sessionId || reading() === mode) return;
    const anchor = visibleTurn();
    pendingTrajectoryAnchor = null;
    cancelNavigation();
    batch(() => {
      innerReader.set(null);
      reading.set(mode);
    });
    if (historyFollowPaused() && anchor !== null) scrollToTurn(anchor);
    else if (atHistoryTail()) resumeHistoryFollowing();
  };
  const sendRendered = ({
    owner,
    text,
    backend: expectedBackend,
    attachments: files,
    delivery = 'steer',
  }: SendAction) => {
    if (
      !alive ||
      owner !== sessionId ||
      draft() !== text ||
      !attachments.same(files) ||
      (!nativeSteer(delivery) && !sameBackend(backend(), expectedBackend))
    )
      return;
    void send(text, expectedBackend, false, delivery);
  };
  const connected = () => transcriptStatus() === 'live' && !props.connectionLost();
  const predictedMessage = signal<ReturnType<ComposerPrediction['current']>>(null);
  const messagePrediction = createMessagePrediction({
    sessionId,
    preferences: () => host.query('settings', 'assistantPreferences', {}),
    begin: (input) => host.beginControl('predictNextMessage', input),
    changed: (value) => predictedMessage.set(value),
    report: (reason) => console.warn('Message prediction failed:', reason),
  });
  const prediction: ComposerPrediction = {
    current: predictedMessage,
    dismiss: messagePrediction.presentation.dismiss,
  };
  effect(() => {
    const eligible =
      ready() &&
      props.visible() &&
      connected() &&
      !archived() &&
      runId() === null &&
      (queued()?.entries.length ?? 0) === 0 &&
      !sending() &&
      !recovering() &&
      !confirmingContinuation();
    const composer =
      !draftReady() || attachments.restoring()
        ? 'restoring'
        : draft() !== '' || attachments.files().length > 0 || attachments.blocked() !== ''
          ? 'occupied'
          : 'empty';
    untracked(() => messagePrediction.eligible(eligible, composer));
  });
  const queueSession: ComposerQueue = {
    sessionId,
    snapshot: queued,
    running: () => connected() && runId() !== null && !stopping(),
    async read(messageId, expectedRevision) {
      if (!alive) throw new UiError('This conversation is closed.');
      return host.query('agent', 'queueMessage', {
        sessionId,
        messageId,
        expectedRevision,
      });
    },
    async change(expectedRevision, edit) {
      if (!alive) throw new UiError('This conversation is closed.');
      return props.control('editQueue', { sessionId, expectedRevision, edit });
    },
  };
  const executionWaitMessage = computed(() => {
    if (!connected()) return '';
    const state = execution()?.state;
    if (state?.kind === 'waiting' && state.authorityUnavailable && !interactions().entries.length)
      return tr('Waiting for access to be restored');
    return '';
  });
  const ownHandle: ConversationHandle = {
    sessionId,
    prediction,
    title: () => title() || tr('Untitled conversation'),
    queue: queueSession,
    interactions,
    executionWaitMessage,
    reconnecting: () => transcriptStatus() === 'failed' && !props.connectionLost(),
    reconnect: () => retryTranscript(sessionId),
    attachmentMetadataFailed,
    retryAttachmentMetadata: () => retryAttachmentMetadata(sessionId),
    computerAccess: {
      snapshot: computerApps,
      async stop(operationId) {
        await props.control('stopComputerApp', { sessionId, operationId });
      },
    },
    draft,
    attachments,
    previewImage: props.previewImage,
    editable: () => draftReady() && !savingFailed(),
    loading: () => !ready() || !draftReady(),
    blockedReason: sendBlockedReason,
    backend,
    modelDetails,
    refreshModel,
    permissions,
    goal,
    projectMcp,
    workspace,
    empty: () =>
      ready() &&
      runId() === null &&
      rows().length === 0 &&
      live().length === 0 &&
      unresolved().length === 0 &&
      activeSends().size === 0 &&
      freezeState().kind === 'idle' &&
      pendingMessages().length === 0 &&
      (queued()?.entries.length ?? 0) === 0 &&
      toolActivity().length === 0,
    connected,
    error: () => (connected() ? error() : ''),
    notice: () => (connected() ? notice() : ''),
    sends: sendStatuses,
    retrySend: retryOriginal,
    checkSend,
    dismissSend: dismissOriginal,
    recovering: () => !receiptsKnown() || sending() || autoSending(),
    stopping,
    execution,
    continuation,
    continuing: confirmingContinuation,
    continueRun,
    metrics: () => metricText(metrics()),
    contextUsage: () => {
      const value = metrics();
      if (!value?.contextTokens || !value.contextWindow) return null;
      return {
        tokens: value.contextTokens,
        outputTokensPerSecond: value.outputTokensPerSecond ?? null,
        window: value.contextWindow,
        approximate: value.approximate || value.contextLastKnown,
      };
    },
    changeDraft,
    submit(event) {
      if (props.compact) {
        if (compactStart() === null) compactStart.set(latestQuestionKey());
        followCompact = true;
      }
      void send(event.text);
    },
    sendRendered,
    run: runId,
    activeTurn: runTurn,
    activityTurn: () => {
      const group = projection().entries.findLast((entry) => entry.kind === 'process');
      return group?.kind === 'process' ? group.turnKey : null;
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
      if (reading() === 'trajectory') {
        const target = turnId ?? runTurn();
        if (target !== null) jumpTrajectoryTurn(target);
        return;
      }
      const group = projection().entries.findLast(
        (entry) => entry.kind === 'process' && entry.turnKey === turnId,
      );
      if (group?.kind !== 'process') {
        const index = display().findLastIndex(
          (entry) => entry.kind === 'row' && historyTurnKey(currentRow(entry.rowId)) === turnId,
        );
        if (index >= 0) {
          list?.scrollToIndex({ index, viewPosition: 0 });
          list?.focus();
        }
        return;
      }
      const turn = projectedTurn(group.turnKey);
      if (!turn) return;
      unfoldTurn(turn);
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
    jumpLatest(turnId, reload = false) {
      if (!alive) return;
      const showLatest = (animated = false) => {
        if (reading() === 'trajectory' && trajectoryRange() !== null) selectTrajectoryRange(null);
        const group =
          reading() === 'chat'
            ? projection().entries.findLast(
                (entry) => entry.kind === 'process' && entry.turnKey === (turnId ?? runTurn()),
              )
            : undefined;
        if (group?.kind === 'process') {
          const state = groupState(group.key);
          state.following.set(true);
          if (state.list) state.list.scrollToEnd({ animated: false });
          else state.opening = 'bottom';
        }
        resumeHistoryFollowing(animated);
      };
      // The loaded window already reaches the latest row and follows new ones:
      // scroll it in place, keeping the rows above, without waiting on the Host.
      if (!reload && atHistoryTail() && navigation() === null) {
        props.focusComposer();
        showLatest(true);
        return;
      }
      const target: HistoryNavigation = { kind: 'tail' };
      historyDestination = {
        position: { kind: 'tail' },
        explicit: true,
        failed: false,
      };
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
            !alive ||
            navigation() !== target
          )
            return;
          showLatest();
        } finally {
          if (navigation() === target) navigation.set(null);
        }
      })().catch(report);
    },
    stop,
    async compact(prompt) {
      if (!alive) return;
      if (runId() !== null) throw new UiError('Wait for the current run before compacting.');
      const expectedBackend = backend();
      if (expectedBackend === null) throw new UiError('Choose a model before compacting.');
      const model = await selection(expectedBackend);
      if (!alive || model === null) return;
      if (!sameBackend(backend(), expectedBackend))
        throw new UiError('The model changed before confirmation. Send again to confirm it.');
      const result = await props.control('compact', {
        sessionId,
        model: model.model,
        thinkingLevel: model.thinkingLevel,
        prompt: prompt?.trim() || null,
      });
      if (!alive) return;
      if (result.kind !== 'started')
        throw new UiError('Context compaction rejected: {reason}', {
          reason: result.reason,
        });
      await observe();
      ownHandle.jumpLatest(null, true);
    },
    refresh() {
      executionRevision.set(executionRevision() + 1);
      return observe();
    },
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
      historyFollowPaused() ||
      navigation() !== null ||
      runId() !== null ||
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
        messageId: observed.tailMessageId,
        state,
        row: state.rowNodes.get(id)!,
        reader: state.list,
        viewport: list,
        lease: state.lease,
        identity: historyIdentity,
      };
    }
    if (innerReader() !== null) return null;
    return {
      kind: 'row' as const,
      observed,
      exposure,
      messageId: observed.tailMessageId,
      identity: historyIdentity,
    };
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
      attemptedRead.messageId === target.messageId &&
      attemptedRead.exposure === target.exposure
    )
      return;
    attemptedRead = {
      revision: target.observed.revision,
      messageId: target.messageId,
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
        current.messageId !== target.messageId ||
        (target.kind === 'process' &&
          (current.kind !== 'process' ||
            current.state !== target.state ||
            current.lease !== target.lease))
      )
        return;
      const attempt = await host.control('markRead', {
        sessionId,
        messageId: target.messageId,
      });
      const reply = attempt.reply as OperationReply;
      if (reply.receipt.kind !== 'recorded' || reply.receipt.outcome.kind !== 'returned')
        throw new UiError('The read confirmation is still unknown.');
      if (reply.receipt.outcome.result.kind === 'failure')
        throw new Error(reply.receipt.outcome.result.diagnostic);
      const result = reply.receipt.outcome.result.value as AgentMarkReadResult;
      if (!alive) return;
      if (result.kind === 'rejected')
        throw new UiError('Read confirmation rejected: {reason}', {
          reason: result.reason,
        });
      acceptReadState(result.session);
    })()
      .catch(report)
      .finally(() => {
        if (alive) acknowledging.set(false);
      });
  });
  props.attach(ownHandle);

  // A fork made to regenerate a reply sends its prefilled text once sending is possible,
  // unless the draft was changed first.
  effect(() => {
    const pending = autoSend();
    if (pending === null || sendBlockedReasonFor(false) || modelLoading()) return;
    untracked(() => {
      batch(() => {
        autoSend.set(null);
        if (pending.first || draft() === pending.text)
          void send(pending.text, undefined, pending.first);
      });
    });
  });
  cleanup(() => {
    messagePrediction.dispose();
    alive = false;
    bot.close();
    historyIdentity = {};
    navigation.set(null);
    wakeReconnect?.();
    modelGeneration += 1;
    modelRead = null;
    overlay.disconnect();
    publishOverlay();
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
        const prefill =
          props.takePrefill?.(stored.text === '' && stored.attachments.length === 0) ?? null;
        if (prefill) {
          try {
            if (stored.text === '' && stored.attachments.length === 0) {
              changeDraft(prefill.text);
              for (const file of prefill.files ?? [])
                attachments.observeIntake(client.beginStagedUpload(file), () => {});
              props.focusComposer();
              if (prefill.send) {
                autoSend.set({ text: prefill.text, first: prefill.first });
              }
            }
          } finally {
            for (const file of prefill.files ?? []) file.dispose();
          }
        }
        void attachments.start();
        const operations = await pendingSends(client);
        if (!alive) return;
        unresolved.set(operations);
        receiptsKnown.set(true);
        if (operations.length) await recover();
      })().catch(report);
    }),
  );

  let botReadThrough = 0;
  effect(() => {
    const latest = bot.latest();
    if (
      latest === null ||
      latest.sequence <= botReadThrough ||
      !props.visible() ||
      !props.foreground() ||
      !visibleRows().has(`bot/${latest.turnId}`)
    )
      return;
    botReadThrough = latest.sequence;
    void (async () => {
      const attempt = await host.control('markBotRead', { sessionId, through: latest.sequence });
      const reply = attempt.reply as OperationReply;
      if (reply.receipt.kind !== 'recorded' || reply.receipt.outcome.kind !== 'returned')
        throw new UiError('The read confirmation is still unknown.');
      if (reply.receipt.outcome.result.kind === 'failure')
        throw new Error(reply.receipt.outcome.result.diagnostic);
    })().catch(report);
  });

  const historyWidth = signal(0);
  const hasRailRoom = () => historyWidth() >= 400;
  const railShown = () =>
    ready() &&
    (platform.idiom === 'terminal'
      ? navigationItems().length > 1
      : navigationItems().length >= 4 && hasRailRoom());
  // The desktop rail's width, kept on both sides so the reading column stays centered.
  const railInset = () => (platform.idiom !== 'terminal' && hasRailRoom() ? railWidth() + 8 : 0);
  const rail = () => (
    <TurnNavigation
      items={navigationItems}
      active={visibleTurn}
      visible={visibleTurns}
      busy={navigatingTurn}
      preview={async (item) => {
        const position = item.anchor.position;
        const row = historyRows().userRows.get(historyRowKey(position));
        if (row) return row.text;
        if (item.anchor.kind !== 'landmark') return item.label;
        const prompt = await host.query('agent', 'historyPrompt', {
          sessionId,
          through: item.anchor.through,
          position,
        });
        return prompt?.text ?? item.label;
      }}
      navigate={(item, mode) => {
        void navigateTurn(item, mode).catch(report);
      }}
      cancel={inputAction(cancelNavigation, navigatingTurn())}
    />
  );
  const entryRow = (key: () => string) => (
    <View style={readingColumn}>
      <Each of={[key()]} key={(id: string) => id}>
        {(ownedKey) => {
          const initial = displayEntry(ownedKey());
          if (!initial) return <View />;
          const entry = () => displayEntry(ownedKey()) ?? initial;
          const reveal = () =>
            list?.scrollToIndex({
              index: (props.compact ? shownKeys() : displayKeys()).indexOf(ownedKey()),
              viewPosition: 0,
              animated: false,
            });
          if (initial.kind === 'trajectory-turn') {
            return (
              <TrajectoryTurn
                turn={() => projectedTurn(initial.turnKey) ?? initial.turn}
                opening={() => currentRow(initial.rowId)}
                collapsed={() =>
                  !trajectoryFiltering() && trajectoryCollapsed().has(initial.turnKey)
                }
                canFold={() => !trajectoryFiltering()}
                toggle={inputAction(toggleTrajectoryTurn, initial.turnKey)}
              />
            );
          }
          if (initial.kind === 'trajectory-request') {
            return (
              <TrajectoryRequest
                request={() => {
                  const latest = entry();
                  return latest.kind === 'trajectory-request' ? latest.request : initial.request;
                }}
                selected={() => trajectorySelection() === initial.key}
                select={inputAction(selectTrajectory, initial.key)}
              />
            );
          }
          if (initial.kind === 'trajectory-record') {
            const first = currentRow(initial.rowId);
            if (!first) return <View />;
            const row = () => currentRow(initial.rowId) ?? first;
            return (
              <TrajectoryRecord
                row={row}
                selected={() => trajectorySelection() === initial.key}
                progress={() => (row().tool ? toolProgress(row().tool!.toolUseId) : null)}
                select={inputAction(selectTrajectory, initial.key)}
                canFold={() =>
                  !trajectoryFiltering() &&
                  initial.toolKey !== undefined &&
                  trajectoryParents().has(initial.toolKey)
                }
                folded={() =>
                  initial.toolKey !== undefined && trajectoryCollapsedTools().has(initial.toolKey)
                }
                toggle={
                  initial.toolKey ? inputAction(toggleTrajectoryTool, initial.toolKey) : undefined
                }
              />
            );
          }
          if (initial.kind === 'summary') {
            const first = projectedTurn(initial.turnKey);
            if (!first) return <View />;
            const turn = () => projectedTurn(initial.turnKey) ?? first;
            const images = computed(() =>
              turnImages(
                projectedSection(initial.turnKey)?.rowsById.values() ?? [],
                initial.turnKey,
              ),
            );
            const groups = computed(() =>
              (projectedSection(initial.turnKey)?.entries ?? []).filter(
                (item): item is ProcessGroup =>
                  item.kind === 'process' && item.turnKey === initial.turnKey,
              ),
            );
            return (
              <TurnSummary
                turn={turn}
                state={turnState(initial.turnKey)}
                groups={groups}
                row={currentRow}
                expanded={() => turnExpanded(turn())}
                canFold={() => workFold(turn()) !== 'unavailable'}
                images={{
                  sessionId,
                  through: () => latestKnown,
                  refs: images,
                  preview: props.previewImage,
                }}
                toggle={(open) => {
                  if (open) {
                    historyFollowPaused.set(true);
                    // Replace the source reading anchor before the folded rows return.
                    list?.scrollToOffset({ offset: historyOffset, animated: false });
                  }
                  turnState(initial.turnKey).expanded.set(open);
                }}
              />
            );
          }
          if (initial.kind === 'process') {
            const group = () => {
              const latest = entry();
              return latest.kind === 'process' ? latest.group : initial.group;
            };
            const first = projectedTurn(initial.group.turnKey);
            if (!first) return <View />;
            const turn = () => projectedTurn(initial.group.turnKey) ?? first;
            const tool = () =>
              latestToolActivity(
                toolActivity().filter((item) => group().toolIds.includes(item.toolUseId)),
                runId(),
                group().turnKey === runTurn() ? runTurn() : null,
              );
            const liveTools = computed(() =>
              toolActivity().filter((item) =>
                group().members.some(
                  (member) =>
                    member.kind === 'activity' &&
                    member.toolUseId === item.toolUseId &&
                    group().toolIds.includes(item.toolUseId),
                ),
              ),
            );
            return (
              <TurnPanel
                group={group}
                turn={turn}
                toolActivity={tool}
                liveTools={liveTools}
                toolProgress={toolProgress}
                inspectTool={inspectToolInTrajectory}
                state={groupState(initial.group.key)}
                row={currentRow}
                rowState={rowState}
                sessionId={sessionId}
                through={() => latestKnown}
                previewImage={props.previewImage}
                openLink={props.openLink}
                senders={senders}
                userScroll={() => cancelNavigation()}
                reveal={reveal}
                activity={activity}
                viewport={readingSize}
                reading={(away) => {
                  changedReadExposure();
                  if (away) innerReader.set(initial.group.key);
                  else if (innerReader() === initial.group.key) innerReader.set(null);
                }}
                settled={(atEnd) => {
                  if (atEnd) readerAtEnd.set(initial.group.key);
                  else if (readerAtEnd() === initial.group.key) readerAtEnd.set(null);
                }}
              />
            );
          }
          if (initial.kind === 'botWorking')
            return (
              <BotWorking
                detail={() => {
                  if (run() === 'waiting' && retrying(quietWaits(execution())))
                    return tr('Waiting to retry');
                  const tool = latestToolActivity(toolActivity(), runId(), runTurn());
                  return tool ? `${tool.name}` : '';
                }}
              />
            );
          if (initial.kind === 'botWaiting')
            return (
              <BotWaiting
                workers={() => {
                  const latest = entry();
                  return latest.kind === 'botWaiting' ? latest.workers : initial.workers;
                }}
                open={canOpenWorker() ? openWorker : undefined}
              />
            );
          if (initial.kind === 'botNote')
            return <BotNote text={() => tr('The Bot did not reply this time')} />;
          if (initial.kind === 'bot') {
            const worker = () => {
              const latest = entry();
              return latest.kind === 'bot' ? latest.worker : initial.worker;
            };
            return (
              <BotReply
                worker={
                  worker() !== undefined && canOpenWorker()
                    ? {
                        title: () => {
                          const id = worker();
                          return id !== undefined ? (senders.session(id)?.title ?? '') : '';
                        },
                        exists: () => {
                          const id = worker();
                          return id !== undefined && senders.session(id) !== null;
                        },
                        open: () => {
                          const id = worker();
                          if (id !== undefined) openWorker(id);
                        },
                      }
                    : undefined
                }
                messages={() => bot.forTurn(initial.turnId)}
                openLink={props.openLink}
                userScroll={() => cancelNavigation()}
              />
            );
          }
          const first = currentRow(initial.rowId);
          if (!first) return <View />;
          const row = () => currentRow(initial.rowId) ?? first;
          return (
            <MessageRow
              item={row}
              highlighted={() => highlightedAnchor() === initial.key}
              repeats={() => {
                const item = displayEntry(initial.rowId);
                return item?.kind === 'row' ? (item.repeats ?? 1) : 1;
              }}
              toolMaxHeight={() => readingSize().height}
              toolProgress={toolProgress}
              inspectTool={inspectToolInTrajectory}
              ownerKey={() => initial.rowId}
              viewState={rowState(initial.rowId)}
              sessionId={sessionId}
              through={() => latestKnown}
              previewImage={props.previewImage}
              openLink={props.openLink}
              senders={senders}
              userScroll={() => cancelNavigation()}
              onExpand={reveal}
              onToolReading={(key) => {
                if (
                  !alive ||
                  key !== initial.rowId ||
                  displayEntry(key)?.kind !== 'row' ||
                  !rowStates.get(key)?.expanded()
                )
                  return;
                innerReader.set(key);
              }}
              finalActions={(row, ownerKey, menu) => (
                <FinalActions
                  row={row}
                  ownerKey={ownerKey}
                  sessionId={sessionId}
                  through={() => latestKnown}
                  fork={props.fork}
                  menu={menu}
                  extra={
                    platform.idiom !== 'terminal' && props.edit ? (
                      <MessageEdit
                        regenerate
                        row={() => loadedOpening(historyTurnKey(row()))}
                        sessionId={sessionId}
                        through={() => latestKnown}
                        menu={menu}
                        opensTurn={() => true}
                        edit={props.edit!}
                      />
                    ) : undefined
                  }
                />
              )}
              failureActions={
                platform.idiom === 'terminal'
                  ? undefined
                  : (row) => (
                      // Only where the conversation ends in this failure.
                      <If when={run() !== 'running' && lastDisplayKey() === initial.rowId}>
                        <TurnRetry
                          row={() => loadedOpening(historyTurnKey(row()))}
                          sessionId={sessionId}
                          through={() => latestKnown}
                          blocked={() =>
                            draft().trim() || attachments.files().length > 0
                              ? tr('Send or clear the draft first.')
                              : sendBlockedReason()
                          }
                          send={send}
                        />
                      </If>
                    )
              }
              editMessage={
                platform.idiom !== 'terminal' && props.edit
                  ? (row, ownerKey, menu) => (
                      <MessageEdit
                        row={row}
                        ownerKey={ownerKey}
                        sessionId={sessionId}
                        through={() => latestKnown}
                        menu={menu}
                        opensTurn={() => opensTurn(row())}
                        edit={props.edit!}
                        inline={rowState(initial.rowId).edit}
                      />
                    )
                  : undefined
              }
              messageEditor={
                platform.idiom !== 'terminal' && props.edit
                  ? (row, ownerKey) => (
                      <MessageEditor
                        row={row}
                        ownerKey={ownerKey}
                        sessionId={sessionId}
                        through={() => latestKnown}
                        opensTurn={() => opensTurn(row())}
                        edit={props.edit!}
                        state={rowState(initial.rowId).edit!}
                      />
                    )
                  : undefined
              }
            />
          );
        }}
      </Each>
    </View>
  );
  if (props.compact)
    return (
      <View
        ref={(node) => root.set(node)}
        onLayout={({ bounds: frame }) => readingSize.set(frame.size)}
        style={{
          flexShrink: 1,
          minHeight: 0,
          borderTopWidth: shownKeys().length ? 1 : 0,
          borderTopColor: C.line,
        }}
      >
        <Scroll
          ref={(node) => (compactScroll = node)}
          onScroll={(event) => {
            followCompact =
              event.offset.y >= Math.max(0, event.contentSize.height - event.size.height) - 32;
            changedReadExposure();
          }}
          style={{ flexShrink: 1, minHeight: 0 }}
          contentStyle={{ paddingVertical: shownKeys().length ? 16 : 0 }}
        >
          <View
            onLayout={() => {
              if (followCompact) compactScroll?.scrollToEnd({ animated: false });
            }}
          >
            <List
              ref={list}
              viewport="parent"
              each={shownKeys()}
              estimatedItemSize={96}
              onViewableItemsChange={(event) => {
                visibleRows.set(new Set(event.viewableItems.map((item) => item.item)));
                changedReadExposure();
              }}
            >
              {entryRow}
            </List>
          </View>
        </Scroll>
      </View>
    );
  return (
    <View
      ref={(node) => root.set(node)}
      style={{
        flex: ownHandle.empty() ? 0 : 1,
        flexBasis: 'auto',
        flexShrink: 0,
        minHeight: 0,
        backgroundColor: C.panel,
      }}
    >
      <Header
        title={title() || tr('Untitled conversation')}
        workspace={workspace()}
        commands={props.commands}
        browser={props.browser()}
        files={props.files}
        filesOpener={props.filesOpener}
        actions={
          bot.identity() === 'bot' && props.restartBot && props.botSession?.() === sessionId ? (
            <BotRestart restart={props.restartBot} />
          ) : undefined
        }
        views={
          platform.idiom === 'terminal' || ownHandle.empty() ? undefined : (
            <View role="tablist" style={{ flexDirection: 'row', gap: 2 }}>
              <ViewSegment
                label={tr('Chat')}
                selected={reading() === 'chat'}
                onPress={inputAction(chooseReading, { owner: sessionId, mode: 'chat' })}
              />
              <ViewSegment
                label={tr('Trajectory')}
                selected={reading() === 'trajectory'}
                onPress={inputAction(chooseReading, { owner: sessionId, mode: 'trajectory' })}
              />
            </View>
          )
        }
      />
      <View
        style={{
          // The desktop's header holds these views.
          display: ownHandle.empty() || platform.idiom !== 'terminal' ? 'none' : 'flex',
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
          style={toolbarControlStyle}
          onPress={inputAction(chooseReading, {
            owner: sessionId,
            mode: 'chat',
          })}
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
          style={toolbarControlStyle}
          onPress={inputAction(chooseReading, {
            owner: sessionId,
            mode: 'trajectory',
          })}
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
        onLayout={({ bounds }) =>
          trajectorySideBySide.set(platform.idiom !== 'terminal' && bounds.size.width >= 760)
        }
        style={{
          display: ownHandle.empty() ? 'none' : 'flex',
          flex: 1,
          flexDirection: selectedTrajectory() !== null && trajectorySideBySide() ? 'row' : 'column',
          minHeight: 0,
          width: '100%',
        }}
      >
        <View
          style={{
            flex: 1,
            flexDirection: 'column',
            minHeight: 0,
            width: '100%',
          }}
        >
          <If when={reading() === 'trajectory'}>
            <TrajectoryOverview
              timeline={trajectoryOverview}
              selection={trajectoryRange}
              select={selectTrajectoryRange}
              jump={jumpTrajectoryEntry}
            />
            <TrajectoryToolbar
              query={trajectoryQuery}
              search={(value) => trajectoryQuery.set(value)}
              allCollapsed={allTrajectoryTurnsCollapsed}
              canFold={() => !trajectoryFiltering() && trajectoryTurns().length > 0}
              toggleAll={() =>
                trajectoryCollapsed.set(
                  new Set(allTrajectoryTurnsCollapsed() ? [] : trajectoryTurns()),
                )
              }
              canFoldSubcalls={() => !trajectoryFiltering() && trajectoryParents().size > 0}
              subcallsCollapsed={allTrajectorySubcallsCollapsed}
              toggleSubcalls={() =>
                trajectoryCollapsedTools.set(
                  new Set(allTrajectorySubcallsCollapsed() ? [] : trajectoryParents()),
                )
              }
              hasOlder={() => historyWindow()?.before != null}
              loadOlder={loadOlder}
            />
          </If>
          <View
            onLayout={({ bounds }) => historyWidth.set(bounds.size.width)}
            style={{ flex: 1, minHeight: 0, flexDirection: 'row', paddingRight: railInset() }}
          >
            <List
              ref={list}
              onLayout={({ bounds: frame }) => {
                readingSize.set(frame.size);
                if (pendingTrajectoryAnchor !== null && reading() === 'trajectory') {
                  const index = displayKeys().indexOf(pendingTrajectoryAnchor);
                  pendingTrajectoryAnchor = null;
                  if (index >= 0) list?.scrollToIndex({ index, viewPosition: 0, animated: false });
                }
                changedReadExposure();
              }}
              each={historyList()}
              loadMoreAtStartThreshold={HISTORY_LOOKAHEAD_VIEWPORTS}
              onLoadMoreAtStart={prefetchOlder}
              onScrollDragStart={({ offset }) => {
                cancelNavigation();
                historyScrollInput = 'dragging';
                historyScrolled = true;
                if (offset.y <= 1) prefetchOlder();
              }}
              onScrollEnd={({ offset }) => {
                // Native scroll-end can arrive ahead of the last offset report.
                if (historyScrollInput !== 'idle')
                  historyScrollInput = offset.y === historyOffset ? 'idle' : 'pending';
              }}
              onScrollIntent={(event) => {
                if (event.intent === 'start') void navigateStart().catch(report);
                else {
                  cancelNavigation();
                  if (event.intent === 'scroll') {
                    if (historyScrollInput !== 'dragging') historyScrollInput = 'pending';
                    historyScrolled = true;
                    if (nearHistoryStart()) prefetchOlder();
                    if (nearHistoryEnd()) prefetchNewer();
                  } else if (atHistoryTail()) resumeHistoryFollowing();
                  else ownHandle.jumpLatest(null);
                }
              }}
              onBlur={() => {
                // Latest returns to editing immediately; its expected blur does
                // not revoke the pending history read or later steal focus back.
                if (navigation()?.kind !== 'tail') cancelNavigation();
              }}
              onViewableItemsChange={(event) => {
                const turns = new Set<string>();
                for (const { item } of event.viewableItems) {
                  const turn = entryTurn(item);
                  if (turn !== null) turns.add(turn);
                }
                if (turns.size > 0) {
                  visibleTurns.set(turns);
                }
                visibleRows.set(new Set(event.viewableItems.map((item) => item.item)));
                changedReadExposure();
              }}
              estimatedItemSize={
                reading() === 'trajectory' ? (platform.idiom === 'terminal' ? 16 : 32) : 96
              }
              maintainVisibleContentPosition={
                atHistoryTail() &&
                !historyFollowPaused() &&
                innerReader() === null &&
                selectedTrajectory() === null &&
                (reading() !== 'trajectory' || trajectoryRange() === null) &&
                navigation() === null
                  ? { autoscrollToBottomThreshold: historyEndTolerance }
                  : {}
              }
              // The list spans the margins too, so the wheel scrolls it anywhere
              // beside the reading column; the matching left inset keeps that
              // column centered in the window.
              contentStyle={{
                paddingLeft: railInset(),
                paddingBottom: platform.idiom === 'terminal' ? 0 : 16,
              }}
              style={{ flex: 1, minHeight: 0 }}
              onScroll={(event) => {
                const offset = event.offset.y;
                const end = Math.max(0, event.contentSize.height - event.size.height);
                const distance = end - offset;
                const movement = offset - historyOffset;
                // Programmatic jumps and native prepend corrections must not
                // change whether the reader is following the live tail.
                const scrolled = historyScrollInput !== 'idle';
                historyOffset = offset;
                historyMaxOffset = end;
                if (movement !== 0 && historyScrollInput === 'pending') historyScrollInput = 'idle';
                if (scrolled && movement < 0 && distance > historyEndTolerance)
                  historyFollowPaused.set(true);
                else if (
                  scrolled &&
                  movement > 0 &&
                  distance <= historyEndTolerance &&
                  historyFollowPaused() &&
                  (reading() !== 'trajectory' || trajectoryRange() === null) &&
                  atHistoryTail()
                )
                  resumeHistoryFollowing();
                const owner = pagingOwner('before');
                if (owner !== null) {
                  // An underfilled initial viewport needs history before the first gesture.
                  const firstLayout = measuredHistory !== owner;
                  measuredHistory = owner;
                  if ((firstLayout || (scrolled && movement < 0)) && nearHistoryStart())
                    prefetchOlder();
                }
                if (scrolled && movement > 0 && nearHistoryEnd()) prefetchNewer();
                const reader = innerReader();
                const row = reader === null ? undefined : currentRow(reader);
                const toolReader =
                  reader !== null &&
                  displayEntry(reader)?.kind === 'row' &&
                  (row?.tool != null || row?.role === 'tool_call' || row?.role === 'tool_result') &&
                  rowStates.get(reader)?.expanded() === true;
                if (
                  reader !== null &&
                  !groupStates.get(reader)?.list &&
                  !toolReader &&
                  distance <= historyEndTolerance
                )
                  innerReader.set(null);
                changedReadExposure();
              }}
              empty={
                <If
                  when={showHistoryLoading()}
                  else={
                    <If when={reading() === 'trajectory'}>
                      <View style={{ ...readingColumn, paddingVertical: 12 }}>
                        <Text style={{ ...captionTextStyle, color: C.muted }}>
                          {trajectoryFiltering()
                            ? tr('No matching execution records')
                            : tr('No execution records')}
                        </Text>
                      </View>
                    </If>
                  }
                >
                  <LoadingState label={tr('Loading session history…')} />
                </If>
              }
            >
              {entryRow}
            </List>
            <If when={railShown()}>
              <View
                style={[
                  platform.idiom === 'terminal'
                    ? { width: railWidth() }
                    : { position: 'absolute', top: 0, bottom: 0, right: 8 },
                  { pointerEvents: 'box-none', flexDirection: 'row' },
                ]}
              >
                {rail()}
              </View>
            </If>
            <View
              style={[
                {
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: railInset(),
                  right: railInset(),
                },
                { pointerEvents: 'box-none' },
              ]}
            >
              <ReturnToLatest
                visible={
                  historyFollowPaused() ||
                  (innerReader() !== null && (!pausedAtEnd() || run() === 'running'))
                }
                paused={pausedAtEnd()}
                activate={inputAction(ownHandle.jumpLatest, null)}
              />
            </View>
          </View>
          <Each of={compacting() === null ? [] : [compacting()!]} key={(progress) => progress.id}>
            {(progress) => (
              <View style={{ paddingLeft: railInset() }}>
                <View style={[readingColumn, { paddingRight: 16 }]}>
                  <CompactionDivider state="running" startedAt={() => progress().startedAt} />
                </View>
              </View>
            )}
          </Each>
        </View>
        <Each
          of={selectedTrajectory() === null ? [] : [selectedTrajectory()!]}
          key={(item) => item.key}
        >
          {(item) => {
            const selected = item();
            const details =
              selected.kind === 'trajectory-request' ? (
                <TrajectoryRequestInspector
                  request={() => {
                    const current = item();
                    return current.kind === 'trajectory-request'
                      ? current.request
                      : selected.request;
                  }}
                  close={closeTrajectoryInspector}
                />
              ) : (
                <TrajectoryInspector
                  row={() => currentRow(selected.rowId)!}
                  rowId={selected.rowId}
                  sessionId={sessionId}
                  through={() => latestKnown}
                  previewImage={props.previewImage}
                  openLink={props.openLink}
                  toolProgress={toolProgress}
                  maxHeight={() => Math.max(32, readingSize().height - 80)}
                  close={closeTrajectoryInspector}
                />
              );
            return (
              <View
                style={{
                  width: trajectorySideBySide() ? 352 : '100%',
                  height: trajectorySideBySide() ? '100%' : '44%',
                  flexShrink: 0,
                  minHeight: 0,
                  borderLeftWidth: trajectorySideBySide() ? 1 : 0,
                  borderLeftColor: C.line,
                  borderTopWidth: trajectorySideBySide() ? 0 : 1,
                  borderTopColor: C.line,
                }}
              >
                {details}
              </View>
            );
          }}
        </Each>
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
