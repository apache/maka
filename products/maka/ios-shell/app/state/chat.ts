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

import { approvalOutcome, approvalRejectionError } from '../approval';
import { trimHostWhitespace } from '../hostText';
import { batch, cleanup, computed, effect, signal, untracked } from 'nsh';
import {
  hostMutate,
  hostQuery,
  MutationNotSubmitted,
  watchHost,
  type AgentBackendPreference,
  type AgentDeliveryPage,
  type AgentGitWorkspaceDiff,
  type AgentHistoryChunk,
  type AgentHistoryPage,
  type AgentInteractionRecord,
  type AgentInteractionResult,
  type AgentInteractionSummary,
  type AgentModelChoice,
  type AgentMetadataResult,
  type AgentQueueAction,
  type AgentQueueEntry,
  type AgentQueueMessageResult,
  type AgentQueueMutationResult,
  type AgentRun,
  type AgentObservation,
  type AgentExecution,
  type ServiceMethods,
  type AgentQueue,
  type AgentRoomMessage,
  type AgentSession,
  type AgentSendResult,
  type HistoryOrder,
  type HistoryPosition,
  type HistoryRowAddress,
  type HistoryView,
  type QuoteRef,
} from '../bridge';
import { LivePreviewAccumulator, type LivePreviewSnapshot } from '../streaming';
import { activeHostInfo, hostById, showToast } from './hostPool';
import { createGoalController } from './goal';
import { dismissInboxRequest, refreshHostInbox } from './inbox';
import { hapticNotification, hapticSelection } from './preferences';
import { listHostModels, refreshHostSessions } from './sessions';
import {
  loadModelCatalog,
  labelModelChoices,
  modelBackend,
  modelConnectionLabels,
  readDefaultModel,
} from './settings/models';
import { settingsRpc } from './settings/rpc';
import { tr, type MessageKey } from '../locale';

type AgentOutput<M extends keyof ServiceMethods['agent']> = ServiceMethods['agent'][M]['output'];
type RunTarget = {
  rootId: string;
  generation: number;
  sessionId: string;
  runId: AgentRun['runId'];
};

const continuationRejected: Record<
  Extract<AgentOutput<'continueRun'>, { kind: 'rejected' }>['reason'],
  MessageKey
> = {
  closed: 'Maka is shutting down. Try again after it restarts.',
  archived: 'Restore this conversation to continue it.',
  busy: 'Wait for the current reply and queue to finish.',
  source_missing: 'There is no stopped reply to continue.',
  source_changed: 'The conversation changed. Send a new message instead.',
  source_not_terminal: 'Wait for this reply to finish before continuing.',
  already_continued: 'This reply has already been continued.',
  workspace_changed: 'The workspace changed. Send a new message instead.',
  safety_check_failed: 'This reply can’t be continued safely. Send a new message instead.',
};

const isStoppedExecution = ({ state }: AgentExecution) =>
  state.kind === 'failed' || state.kind === 'cancelled';

export const backendKey = (backend: AgentBackendPreference) =>
  JSON.stringify(
    backend.kind === 'model'
      ? [
          'model',
          backend.connectionId,
          backend.modelId,
          backend.serviceTier ?? null,
          backend.thinkingLevel ?? null,
        ]
      : [
          'executor',
          backend.selection.executor,
          backend.selection.settings?.runtime ?? null,
          backend.selection.settings?.model ?? null,
          backend.selection.settings?.thinkingLevel ?? null,
        ],
  );

export const displayModelKey = (backend: AgentBackendPreference) =>
  backend.kind === 'model'
    ? JSON.stringify(['model', backend.connectionId, backend.modelId])
    : JSON.stringify([
        'executor',
        backend.selection.executor,
        backend.selection.settings.runtime ?? null,
        backend.selection.settings.model ?? null,
      ]);

export function compareHistoryRows(
  a: Pick<AgentHistoryChunk, 'order'>,
  b: Pick<AgentHistoryChunk, 'order'>,
): number {
  for (let i = 0; i < Math.min(a.order.path.length, b.order.path.length); i++) {
    const order = a.order.path[i] - b.order.path[i];
    if (order) return order;
  }
  return a.order.path.length - b.order.path.length || a.order.itemIndex - b.order.itemIndex;
}

export function conversationKey(rootId: string, sessionId: string): string {
  return rootId + '::' + sessionId;
}

export interface HistoryRow {
  key: string;
  first: AgentHistoryChunk;
  last: AgentHistoryChunk;
  text: string;
}

const chunkEnd = (chunk: AgentHistoryChunk) => chunk.offset + Buffer.byteLength(chunk.text, 'utf8');

function sameHistoryField(a: AgentHistoryChunk, b: AgentHistoryChunk) {
  return (
    a.field === b.field &&
    compareHistoryRows(a, b) === 0 &&
    historyAddressKey(a.position) === historyAddressKey(b.position)
  );
}

export function assembleHistoryRows(chunks: readonly AgentHistoryChunk[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const chunk of chunks) {
    const row = rows.at(-1);
    if (
      row &&
      chunk.offset > 0 &&
      chunkEnd(row.last) === chunk.offset &&
      sameHistoryField(row.first, chunk)
    ) {
      row.text += chunk.text;
      row.last = chunk;
    } else {
      rows.push({
        key:
          row && sameHistoryField(row.first, chunk)
            ? row.key + ':' + chunk.offset
            : chunk.order.path.join('/') + ':' + String(chunk.order.itemIndex),
        first: chunk,
        last: chunk,
        text: chunk.text,
      });
    }
  }
  return rows;
}

export function historyAddressKey(position: HistoryRowAddress): string {
  switch (position.kind) {
    case 'live':
      return JSON.stringify([position.kind, position.sequence, position.fact, position.itemIndex]);
    case 'snapshot':
      return JSON.stringify([
        position.kind,
        position.path,
        position.snapshot,
        position.sequence,
        position.fact,
        position.itemIndex,
      ]);
    case 'imported':
      return JSON.stringify([
        position.kind,
        position.path,
        position.snapshot,
        position.messageOrdinal,
        position.partOrdinal,
      ]);
  }
}

export function historyQuote(row: HistoryRow, text: string): QuoteRef {
  const { messageId, turnId, role } = row.first;
  return {
    text: trimHostWhitespace(text),
    label: role === 'user' ? tr('You') : 'Maka',
    sourceMessageId: messageId ?? undefined,
    sourceTurnId: turnId ?? undefined,
  };
}

export function isCompleteHistoryRow(row: HistoryRow): boolean {
  const { last } = row;
  return row.first.offset === 0 && chunkEnd(last) === last.totalBytes;
}

export function historyTurnKey(chunk: AgentHistoryChunk): string | null {
  const position = chunk.position;
  const id = position.kind === 'imported' ? chunk.importedTurn : chunk.turnId;
  if (id == null) return null;
  return JSON.stringify(
    position.kind === 'live' ? ['live', id] : [position.kind, position.path, position.snapshot, id],
  );
}

type AgentPage = Extract<AgentHistoryPage, { kind: 'ready' }>;
export type HistoryFence = { generation: number; through: number | null };

// A fresh tail may have moved beyond our entire window. Chronology alone
// cannot distinguish adjacent rows from rows with missing history between them.
function overlappingTail(existing: AgentHistoryChunk[], tail: AgentHistoryChunk[]) {
  const first = tail[0];
  if (!first) return false;
  for (let i = existing.length - 1; i >= 0; i--) {
    const old = existing[i];
    if (compareHistoryRows(old, first) < 0) break;
    if (first.offset > 0) {
      if (
        sameHistoryField(old, first) &&
        old.offset <= first.offset &&
        chunkEnd(old) >= first.offset
      )
        return true;
    } else if (
      tail.some(
        (row) =>
          sameHistoryField(old, row) && old.offset <= chunkEnd(row) && row.offset <= chunkEnd(old),
      )
    ) {
      return true;
    }
  }
  return false;
}

function checkFragmentSeam(older: AgentHistoryChunk | undefined, next: AgentHistoryChunk) {
  if (
    next.offset > 0 &&
    (!older ||
      !sameHistoryField(older, next) ||
      older.offset >= next.offset ||
      chunkEnd(older) !== next.offset)
  ) {
    throw new Error('Conversation history has a gap at the page boundary');
  }
}

const projectionKey = (row: AgentHistoryChunk) =>
  row.position.kind === 'live' && row.runId ? row.runId : historyTurnKey(row);

function boundaryProjectionChanged(existing: AgentHistoryChunk[], tail: AgentHistoryChunk[]) {
  const first = tail[0];
  if (!first) return false;
  const key = projectionKey(first);
  if (key === null) return false;
  let folded = tail.some((row) => row.foldedWork && projectionKey(row) === key);
  let final = tail.some((row) => row.finalOutput && projectionKey(row) === key);
  for (let i = existing.length - 1; (folded || final) && i >= 0; i--) {
    const row = existing[i];
    if (projectionKey(row) !== key) continue;
    if (row.foldedWork) folded = false;
    if (row.finalOutput) final = false;
  }
  return folded || final;
}

function joinHistory(older: AgentHistoryChunk[], tail: AgentHistoryChunk[]) {
  const first = tail[0];
  if (!first) return older;
  const prefix: AgentHistoryChunk[] = [];
  for (const row of older) {
    const order = compareHistoryRows(row, first);
    if (order > 0 || (order === 0 && row.offset >= first.offset)) break;
    if (order < 0) {
      prefix.push(row);
      continue;
    }
    if (!sameHistoryField(row, first)) break;
    // The newer window owns row metadata, including on a prefix fetched
    // before it. Only source data specific to the first fragment stays there.
    const text =
      chunkEnd(row) <= first.offset
        ? row.text
        : Buffer.from(row.text)
            .subarray(0, first.offset - row.offset)
            .toString('utf8');
    prefix.push({
      ...first,
      offset: row.offset,
      text,
      attachments: row.attachments,
      quotes: row.quotes,
      citation: row.citation,
      citationAnchor: row.citationAnchor,
      hasReferences: row.hasReferences,
    });
  }
  return [...prefix, ...tail];
}

type EarlierHistory =
  | { kind: 'agent'; cursor: NonNullable<AgentPage['before']>; through: number | null }
  | { kind: 'room'; cursor: string };

// A page may be mostly tool rows or a single fragment of a long message.
// Walk backwards across pages once, looking for a prompt and reply in a Turn
// older than the one already at the head of the transcript.
function earlierTurnBoundary(head: AgentHistoryChunk | undefined) {
  const headTurn = head ? historyTurnKey(head) : null;
  let turn: string | null = null;
  let reply = false;
  let prompt = false;
  return (page: readonly AgentHistoryChunk[]) => {
    for (let i = page.length - 1; i >= 0; i--) {
      const row = page[i];
      const key = historyTurnKey(row);
      if (key !== turn) {
        if (prompt && reply) return true;
        turn = key;
        reply = false;
        prompt = false;
      }
      if (key === null || key === headTurn) continue;
      if (
        row.role === 'assistant' &&
        row.field === 'body' &&
        !row.sourceCitation &&
        row.text &&
        row.offset + Buffer.byteLength(row.text, 'utf8') === row.totalBytes
      ) {
        reply = true;
      }
      if (reply && row.role === 'user' && !row.work && row.offset === 0) prompt = true;
    }
    return false;
  };
}

const maxEarlierPages = 24;

export const quoteLimit = 16;

export interface SideAnchor {
  position: HistoryRowAddress;
  order: HistoryOrder;
}

export interface DraftQuote {
  id: number;
  sourceKey: string;
  reference: QuoteRef;
  anchor?: SideAnchor;
}

export interface DraftLink {
  id: string;
  title: string;
}

interface Draft {
  // Text and quotes can be edited independently while a snapshot is being sent.
  readonly input: { readonly text: string };
  readonly quotes: readonly DraftQuote[];
  readonly links: readonly DraftLink[];
  readonly sending: boolean;
}

const emptyDraft: Draft = { input: { text: '' }, quotes: [], links: [], sending: false };
const draftMap = signal<Record<string, Draft>>({});
let nextQuoteId = 0;

export function getDraft(rootId: string, sessionId: string): Draft {
  return draftMap()[conversationKey(rootId, sessionId)] ?? emptyDraft;
}

function updateDraft(rootId: string, sessionId: string, update: (draft: Draft) => Draft) {
  const key = conversationKey(rootId, sessionId);
  draftMap.update((prev) => {
    const current = prev[key] ?? emptyDraft;
    const next = update(current);
    if (next === current) return prev;
    const drafts = { ...prev };
    if (next.input.text || next.quotes.length || next.links.length || next.sending)
      drafts[key] = next;
    else delete drafts[key];
    return drafts;
  });
}

export function setDraft(rootId: string, sessionId: string, text: string) {
  updateDraft(rootId, sessionId, (draft) =>
    text === draft.input.text ? draft : { ...draft, input: { text } },
  );
}

export function seedSideDraft(
  rootId: string,
  sessionId: string,
  text: string,
  quotes: readonly DraftQuote[],
) {
  updateDraft(rootId, sessionId, (draft) => ({ ...draft, input: { text }, quotes }));
}

export function appendSideLink(rootId: string, mainId: string, side: DraftLink) {
  updateDraft(rootId, mainId, (draft) =>
    draft.links.some(({ id }) => id === side.id)
      ? draft
      : { ...draft, links: [...draft.links, { id: side.id, title: side.title }] },
  );
}

export function removeDraftLink(rootId: string, sessionId: string, id: string) {
  updateDraft(rootId, sessionId, (draft) => ({
    ...draft,
    links: draft.links.filter((link) => link.id !== id),
  }));
}

function sessionInvocation({ id, title }: DraftLink): string {
  // Same inline session reference as Desktop's sessionInvocation.
  const label = (title || id).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/[\\\]/]/g, '\\$&');
  return `[@${label}](maka://session/${id})`;
}

export function draftQuote(
  sourceKey: string,
  reference: QuoteRef,
  anchor?: SideAnchor,
): DraftQuote {
  return { id: ++nextQuoteId, sourceKey, reference, anchor };
}

export function appendDraftQuote(
  rootId: string,
  sessionId: string,
  sourceKey: string,
  reference: QuoteRef,
  anchor?: SideAnchor,
): boolean {
  const text = trimHostWhitespace(reference.text);
  if (!text) return false;
  const label = trimHostWhitespace(reference.label ?? '') || undefined;
  const { quotes } = getDraft(rootId, sessionId);
  if (quotes.length >= quoteLimit) {
    showToast(tr('Quote limit reached ({count})', { count: quoteLimit }));
    return false;
  }
  if (quotes.some((quote) => quote.sourceKey === sourceKey && quote.reference.text === text)) {
    showToast(tr('Already quoted'));
    return false;
  }
  updateDraft(rootId, sessionId, (draft) => ({
    ...draft,
    quotes: [...draft.quotes, draftQuote(sourceKey, { ...reference, text, label }, anchor)],
  }));
  return true;
}

export function removeDraftQuote(rootId: string, sessionId: string, id: number) {
  updateDraft(rootId, sessionId, (draft) => ({
    ...draft,
    quotes: draft.quotes.filter((quote) => quote.id !== id),
  }));
}

export function clearDraftQuotes(rootId: string, sessionId: string) {
  updateDraft(rootId, sessionId, (draft) => ({ ...draft, quotes: [] }));
}

export function appendFileQuote(
  rootId: string,
  sessionId: string,
  path: string,
  line: number,
  snippet?: { side: 'old' | 'new'; text: string },
): boolean {
  const label = path + ':' + String(line);
  return appendDraftQuote(rootId, sessionId, 'file:' + (snippet?.side ?? '') + ':' + label, {
    label,
    text: trimHostWhitespace(snippet?.text ?? '') || label,
  });
}

export interface ParsedDiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: number;
  deleted: number;
  patch: string;
}

export function parseUnifiedDiffFiles(fullPatch: string): ParsedDiffFile[] {
  if (!fullPatch.trim()) return [];
  const sections = fullPatch.split(/(?=^diff --git )/m).filter((s) => s.trim().length > 0);
  const files: ParsedDiffFile[] = [];
  for (const section of sections) {
    const lines = section.split('\n');
    const header = lines[0] ?? '';
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
    let path = match ? match[2] : '';
    let oldPath = match && match[1] !== match[2] ? match[1] : undefined;
    let status: ParsedDiffFile['status'] = oldPath ? 'renamed' : 'modified';
    let added = 0;
    let deleted = 0;
    for (const line of lines) {
      if (line.startsWith('new file mode')) status = 'added';
      else if (line.startsWith('deleted file mode')) status = 'deleted';
      else if (line.startsWith('rename to ')) {
        status = 'renamed';
        path = line.slice('rename to '.length).trim();
      } else if (line.startsWith('rename from ')) {
        oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('+++ b/') && !path) {
        path = line.slice('+++ b/'.length).trim();
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        added += 1;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deleted += 1;
      }
    }
    if (!path) path = 'changes.diff';
    files.push({ path, oldPath, status, added, deleted, patch: section });
  }
  return files;
}

export function extractPatchLineText(
  patch: string,
  side: 'old' | 'new',
  targetLine: number,
): string {
  const lines = patch.split('\n');
  let oldCur = 0;
  let newCur = 0;
  let inHunk = false;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldCur = Number(hunk[1]);
      newCur = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      if (side === 'new' && newCur === targetLine) return line.slice(1);
      newCur += 1;
    } else if (line.startsWith('-')) {
      if (side === 'old' && oldCur === targetLine) return line.slice(1);
      oldCur += 1;
    } else if (!line.startsWith('\\')) {
      if ((side === 'new' && newCur === targetLine) || (side === 'old' && oldCur === targetLine)) {
        return line.startsWith(' ') ? line.slice(1) : line;
      }
      oldCur += 1;
      newCur += 1;
    }
  }
  return '';
}

export async function fetchGitWorkspaceDiff(
  rootId: string,
  sessionId: string,
): Promise<AgentGitWorkspaceDiff | null> {
  return hostQuery<AgentGitWorkspaceDiff | null>(
    'agent',
    'gitWorkspaceDiff',
    { sessionId, area: null, worktreePath: null },
    undefined,
    rootId,
  );
}

export type SendDelivery = 'steer' | 'queue';

type DraftContent = Pick<Draft, 'input' | 'quotes' | 'links'>;
type SendTarget = {
  backend: AgentBackendPreference | null;
  expectedRunId: AgentRun['runId'] | null;
};

function sendText(snapshot: DraftContent) {
  return [trimHostWhitespace(snapshot.input.text), ...snapshot.links.map(sessionInvocation)]
    .filter(Boolean)
    .join(' ');
}

function consumeDraft(rootId: string, sessionId: string, snapshot: DraftContent) {
  const sentQuoteIds = new Set(snapshot.quotes.map((quote) => quote.id));
  updateDraft(rootId, sessionId, (draft) => ({
    ...draft,
    input: draft.input === snapshot.input ? emptyDraft.input : draft.input,
    quotes: draft.quotes.filter((quote) => !sentQuoteIds.has(quote.id)),
    links: draft.links.filter((link) => !snapshot.links.includes(link)),
  }));
}

async function sendBackend(
  rootId: string,
  connection: NonNullable<ReturnType<typeof activeHostInfo>>,
  backend: AgentBackendPreference | null,
) {
  let selected = backend;
  if (!selected && connection.endpoints.includes('settings')) {
    const choice = await readDefaultModel(settingsRpc(rootId));
    selected = choice ? modelBackend(choice) : null;
  }
  if (!selected) throw new Error(tr('Select model'));
  return selected;
}

function deliverDraft(
  rootId: string,
  sessionId: string,
  generation: number,
  room: boolean,
  draft: DraftContent,
  target: SendTarget,
  delivery: SendDelivery,
  onRoomPostPrepared?: (messageId: string) => void,
) {
  return hostMutate<AgentSendResult>(
    'agent',
    'send',
    {
      mentions: [],
      replyTo: null,
      onComplete: null,
      ...(!room && { quotes: draft.quotes.map((quote) => quote.reference) }),
      delivery,
      ...target,
      attachments: [],
      sessionId,
      message: sendText(draft),
    },
    {
      rootId,
      generation,
      ...(onRoomPostPrepared && {
        prepareRoomPost: true,
        onProgress: ({ value }) => {
          const event = value as { kind: string; messageId?: string } | null;
          if (event?.kind === 'room_post_prepared' && typeof event.messageId === 'string')
            onRoomPostPrepared(event.messageId);
        },
      }),
    },
  );
}

function sendRejection(result: Extract<AgentSendResult, { kind: 'rejected' | 'not_your_worker' }>) {
  switch (result.kind === 'rejected' ? result.reason : result.kind) {
    case 'turn_stopped':
      return stoppedSend();
    case 'workspace_unavailable':
      return tr('Not sent. Choose a workspace, then retry.');
    case 'model_unavailable':
      return tr('The selected model is unavailable. Try again or choose another model.');
    case 'original_operation_unsettled':
      return tr(
        'Message was not sent because the previous run is unsettled. Your message is kept.',
      );
    case 'skills_unavailable':
      return tr('The requested skill is unavailable. Edit the message or try again.');
    case 'not_your_worker':
      return tr('Could not send the message.');
  }
}

const stoppedSend = () => tr('Stopped before delivery. Your message is kept.');

const unconfirmedSend = () =>
  tr(
    'Could not confirm whether the message was sent. Check the conversation or queue before retrying.',
  );

// The fork receipt owns the first side-question send before its chat is mounted.
export async function sendDraft(
  rootId: string,
  sessionId: string,
  backend: AgentBackendPreference | null,
  delivery: SendDelivery = 'steer',
): Promise<boolean> {
  const snapshot = getDraft(rootId, sessionId);
  if (snapshot.sending || (!sendText(snapshot) && !snapshot.quotes.length)) return false;
  updateDraft(rootId, sessionId, (draft) => ({ ...draft, sending: true }));
  const fail = (message: string) => {
    hapticNotification('error');
    showToast(message);
    return false;
  };
  try {
    const connection = activeHostInfo(rootId);
    if (!connection) return fail(tr('Computer is offline'));
    const selected = await sendBackend(rootId, connection, backend);
    if (activeHostInfo(rootId)?.generation !== connection.generation)
      return fail(tr('Computer is offline'));
    let result: AgentSendResult;
    try {
      result = await deliverDraft(
        rootId,
        sessionId,
        connection.generation,
        false,
        snapshot,
        { backend: selected, expectedRunId: null },
        delivery,
      );
    } catch (cause) {
      console.warn('Could not confirm send result', cause);
      return fail(
        cause instanceof MutationNotSubmitted
          ? tr('Could not send the message.')
          : unconfirmedSend(),
      );
    }
    if (result.kind === 'rejected' || result.kind === 'not_your_worker')
      return fail(tr('Could not send the message.'));
    consumeDraft(rootId, sessionId, snapshot);
    hapticSelection();
    void refreshHostSessions(rootId, hostById(rootId)?.hostName ?? rootId);
    return true;
  } catch (cause) {
    console.warn('Could not send message', cause);
    return fail(cause instanceof Error ? cause.message : tr('Could not send the message.'));
  } finally {
    updateDraft(rootId, sessionId, (draft) => ({ ...draft, sending: false }));
  }
}

type ComposerSend = {
  id: number;
  generation: number;
  historyThrough: number;
  draft: DraftContent;
  delivery: SendDelivery;
} & (
  | { state: 'sending'; startsRun: boolean; messageId?: string }
  | { state: 'queued'; startsRun: boolean; messageId: string; revision: number }
  | { state: 'started'; messageId: string }
  | { state: 'failed' | 'unknown'; detail: string; messageId?: string }
);

type QueueSnapshot = { generation: number; value: AgentQueue };
type SteeringObservation = { entry: AgentQueueEntry; historyThrough: number; withheldBy?: number };
type DeliveryCheck = { generation: number } & (
  | { kind: 'pending' | 'checked'; revision: number }
  | { kind: 'interrupted'; snapshot: QueueSnapshot }
  | { kind: 'delivered'; historyThrough: number }
);

const sentMessageId = (send: ComposerSend) => ('messageId' in send ? send.messageId : undefined);

const emptySends: readonly ComposerSend[] = [];
// Like drafts, undelivered messages survive leaving and reopening this chat.
const sendsByChat = signal<Record<string, readonly ComposerSend[]>>({});
let nextSendId = 0;

export function sendPreview(draft: DraftContent) {
  return (
    trimHostWhitespace(draft.input.text) ||
    draft.quotes[0]?.reference.text ||
    draft.links[0]?.title ||
    ''
  );
}

let watchSeq = 0;

export function createConversationController(
  rootId: string,
  initialSession: AgentSession,
  active: () => boolean,
  enabled = true,
) {
  const sessionId = initialSession.id;
  const observed = signal<{ generation: number; value: AgentObservation } | null>(null);
  const observation = () => {
    const snapshot = observed();
    return snapshot && snapshot.generation === activeHostInfo(rootId)?.generation
      ? snapshot.value
      : null;
  };
  const selectedBackend = () => {
    const current = observation();
    return current?.session.backend ?? current?.rememberedBackend ?? null;
  };
  const lastObservation = () => observed()?.value ?? null;
  const chunks = signal<AgentHistoryChunk[] | null>(null);
  const roomMessages = signal<AgentRoomMessage[] | null>(null);
  const isRoom = signal(initialSession.kind === 'room');
  const earlierHistory = signal<EarlierHistory | null>(null);
  const loading = signal(true);
  const earlierState = signal<{ kind: 'loading' | 'failed'; generation: number } | null>(null);
  const currentEarlierState = () => {
    const state = earlierState();
    return state?.generation === activeHostInfo(rootId)?.generation ? state : null;
  };
  const loadingEarlier = () => currentEarlierState()?.kind === 'loading';
  const earlierFailed = () => currentEarlierState()?.kind === 'failed';
  const modelSelection = signal<{ generation: number; done: Promise<boolean> } | null>(null);
  const selectingModel = () => {
    const pending = modelSelection();
    return pending?.generation === activeHostInfo(rootId)?.generation ? pending : null;
  };
  const error = signal<string | null>(null);
  const queueSnapshot = signal<QueueSnapshot | null>(null);
  const queue = () => {
    const snapshot = queueSnapshot();
    return snapshot && snapshot.generation === activeHostInfo(rootId)?.generation
      ? snapshot.value
      : undefined;
  };
  const visibleQueue = computed(
    () =>
      queue()?.entries.filter(
        (entry) =>
          entry.kind !== 'in_flight' &&
          entry.origin?.kind !== 'session_completion' &&
          entry.origin?.kind !== 'goal',
      ) ?? [],
  );
  const queuedMessages = computed(() =>
    visibleQueue().filter((entry) => entry.kind === 'followup' || entry.kind === 'held'),
  );
  const key = conversationKey(rootId, sessionId);
  const observedSteering = signal<ReadonlyMap<string, SteeringObservation>>(new Map());
  const deliveryChecks = new Map<string, DeliveryCheck>();
  const composerSends = computed(() => sendsByChat()[key] ?? emptySends);
  const updateSends = (update: (sends: readonly ComposerSend[]) => readonly ComposerSend[]) => {
    sendsByChat.update((all) => {
      const current = all[key] ?? emptySends;
      const next = update(current);
      if (next === current) return all;
      const updated = { ...all };
      if (next.length) updated[key] = next;
      else delete updated[key];
      return updated;
    });
  };

  const transcriptMessageIds = computed(
    () =>
      new Set<string>(
        isRoom()
          ? (roomMessages() ?? []).map((row) => row.id)
          : (chunks() ?? []).flatMap((chunk) =>
              chunk.role === 'user' && chunk.messageId != null ? [chunk.messageId] : [],
            ),
      ),
  );
  // Until the RPC supplies a message ID, hold back newly projected rows,
  // not rows with matching text: repeated prompts are different messages.
  const unacknowledgedIdle = computed(() =>
    composerSends().find(
      (send) =>
        send.state === 'sending' &&
        send.startsRun &&
        send.generation === activeHostInfo(rootId)?.generation,
    ),
  );
  const visibleChunks = computed(() => {
    const rows = chunks() ?? [];
    const send = unacknowledgedIdle();
    return send
      ? rows.filter(
          ({ position }) => position?.kind !== 'live' || position.sequence <= send.historyThrough,
        )
      : rows;
  });
  // Never hide a Room post. The bridge supplies our exact ID before confirming
  // the mutation; handoff can then use identity even before the final receipt.
  const visibleRoomMessages = computed(() => roomMessages() ?? []);
  const unacknowledgedSteer = computed(() =>
    composerSends().find(
      (send) => send.state === 'sending' && send.delivery === 'steer' && !send.startsRun,
    ),
  );
  const handedOff = computed(() => {
    const sends = composerSends();
    if (!sends.some(sentMessageId)) return emptySends;
    const revision = queue()?.revision ?? -1;
    const generation = activeHostInfo(rootId)?.generation;
    const queuedIds = new Set(queuedMessages().map((entry) => entry.messageId));
    const delivered = transcriptMessageIds();
    return sends.filter((send) => {
      const id = sentMessageId(send);
      return (
        id !== undefined &&
        (delivered.has(id) ||
          (send.state === 'queued' &&
            queuedIds.has(id) &&
            (send.generation !== generation || revision >= send.revision)))
      );
    });
  });
  effect(() => {
    const settled = handedOff();
    if (!settled.length) return;
    const ids = new Set(settled.map((send) => send.id));
    updateSends((sends) => sends.filter((send) => !ids.has(send.id)));
  });

  const projectsInTranscript = (send: ComposerSend) => {
    if (send.state === 'sending') return send.startsRun;
    if (send.state !== 'started' && !(send.state === 'queued' && send.startsRun)) return false;
    // A paginated tail can have advanced past an accepted send while this
    // chat was closed. Keep it in the dock while checking that delivery.
    const head = chunks()?.[0]?.position;
    return (
      earlierHistory()?.kind !== 'agent' ||
      head?.kind !== 'live' ||
      head.sequence <= send.historyThrough
    );
  };
  const remainingSends = computed(() => {
    const hidden = new Set(handedOff());
    return composerSends().filter((send) => !hidden.has(send));
  });
  const optimisticSends = computed(() => remainingSends().filter(projectsInTranscript));
  const pendingSends = computed(() =>
    remainingSends().filter((send) => !projectsInTranscript(send)),
  );
  const isWithheld = (steering: SteeringObservation) =>
    steering.withheldBy !== undefined && steering.withheldBy === unacknowledgedSteer()?.id;
  const steeringMessages = computed(() => {
    const steering = observedSteering();
    if (!steering.size) return [];
    const delivered = transcriptMessageIds();
    const localIds = new Set(composerSends().map(sentMessageId));
    return [...steering.values()]
      .filter(
        (item) =>
          !isWithheld(item) &&
          !localIds.has(item.entry.messageId) &&
          !delivered.has(item.entry.messageId),
      )
      .map(({ entry }) => entry);
  });
  const forgetSteering = (ids: ReadonlySet<string>) =>
    observedSteering.update((previous) => {
      if (![...ids].some((id) => previous.has(id))) return previous;
      const next = new Map(previous);
      for (const id of ids) next.delete(id);
      return next;
    });
  const retireDelivered = (ids: ReadonlySet<string>) => {
    if (!ids.size) return;
    batch(() => {
      forgetSteering(ids);
      updateSends((sends) =>
        sends.filter((send) => {
          const id = sentMessageId(send);
          return id === undefined || !ids.has(id);
        }),
      );
    });
  };
  const pendingInteractions = signal<AgentInteractionRecord[]>([]);
  const models = signal<AgentModelChoice[]>([]);
  const busyInteractionIds = signal<Record<string, boolean>>({});

  const accumulator = new LivePreviewAccumulator();
  const livePreview = signal<LivePreviewSnapshot>(accumulator.snapshot());

  let disposed = false;
  let lastThrough: number | null = null;
  const knownTip = signal<{ generation: number; through: number }>();
  const advanceTip = (generation: number, through: number) => {
    const tip = untracked(knownTip);
    if (tip?.generation !== generation || through > tip.through) {
      knownTip.set({ generation, through });
    }
  };
  const historyFence = signal<HistoryFence>();
  let pageEpoch = 0;
  effect(() => {
    if (active()) return;
    pageEpoch++;
    if (untracked(loadingEarlier)) earlierState.set(null);
  });
  let stopSubscription: (() => void) | undefined;
  let activeGeneration = -1;

  const stopWatch = () => {
    stopSubscription?.();
    stopSubscription = undefined;
  };

  const loadInteractions = async () => {
    try {
      const res = await hostQuery<{
        revision: number;
        entries: AgentInteractionSummary[];
      }>('agent', 'pendingInteractions', { sessionId }, undefined, rootId);
      if (disposed) return;
      const records: AgentInteractionRecord[] = [];
      for (const entry of res?.entries ?? []) {
        const rec = await hostQuery<AgentInteractionRecord | null>(
          'agent',
          'interaction',
          { sessionId, requestId: entry.requestId },
          undefined,
          rootId,
        ).catch(() => null);
        if (disposed) return;
        if (rec && (rec.outcome === null || rec.outcome === undefined)) {
          records.push(rec);
        }
      }
      if (!disposed) pendingInteractions.set(records);
    } catch {
      // Preserve last known interactions on transient query errors.
    }
  };

  const queryHistory = (
    position: HistoryPosition,
    through: number | null,
    view: HistoryView = 'chat',
  ) =>
    hostQuery<AgentHistoryPage>(
      'agent',
      'history',
      { sessionId, through, position, includeThinking: true, view },
      undefined,
      rootId,
    );
  const agentPage = (page: AgentHistoryPage): AgentPage => {
    if (page.kind !== 'ready') throw new Error('Expected agent history', { cause: page.kind });
    return page;
  };
  const assertHistoryAdvance = (current: unknown, next: unknown, count: number) => {
    if (next != null && (!count || JSON.stringify(current) === JSON.stringify(next)))
      throw new Error('Conversation history did not advance');
  };
  const readBefore = async (
    head: AgentHistoryChunk | undefined,
    before: NonNullable<AgentPage['before']>,
    through: number | null,
    current: () => boolean,
    enough: (chunks: AgentHistoryChunk[]) => boolean,
  ) => {
    const pages: AgentHistoryChunk[][] = [];
    let boundary = head;
    let cursor: AgentPage['before'] = before;
    for (let n = 0; n < maxEarlierPages && cursor != null; n++) {
      const page = agentPage(await queryHistory({ kind: 'before', cursor }, through));
      if (!current()) return;
      assertHistoryAdvance(cursor, page.before, page.chunks.length);
      if (boundary) checkFragmentSeam(page.chunks.at(-1), boundary);
      pages.push(page.chunks);
      boundary = page.chunks[0] ?? boundary;
      cursor = page.before;
      if (enough(page.chunks)) break;
    }
    return { chunks: pages.reverse().flat(), before: cursor };
  };

  const readHistoryDetail = async (
    anchor: AgentHistoryChunk,
    view: 'steps' | 'turn',
    fence: HistoryFence,
    wanted: () => boolean,
  ) => {
    const epoch = pageEpoch;
    const current = () =>
      !disposed &&
      active() &&
      pageEpoch === epoch &&
      activeHostInfo(rootId)?.generation === fence.generation &&
      wanted();
    let position: HistoryPosition = { kind: 'row', position: anchor.position, field: anchor.field };
    const rows: AgentHistoryChunk[] = [];
    try {
      while (current()) {
        const page = agentPage(await queryHistory(position, fence.through, view));
        if (!current()) return;
        rows.push(...page.chunks);
        if (page.after == null) return rows;
        assertHistoryAdvance(
          position.kind === 'after' ? position.cursor : null,
          page.after,
          page.chunks.length,
        );
        position = { kind: 'after', cursor: page.after };
      }
    } catch (cause) {
      if (current()) throw cause;
    }
  };

  let pagedHistory = false;
  const refreshTail = async () => {
    const generation = activeHostInfo(rootId)?.generation;
    const current = () => !disposed && activeHostInfo(rootId)?.generation === generation;
    // Only a read dispatched after delivery was confirmed can use a
    // truncated window as evidence that the message is now outside it.
    const confirmedPosts = new Set<string>();
    const confirmedSteers = new Map<string, number>();
    if (isRoom()) {
      for (const send of composerSends())
        if (send.state === 'started') confirmedPosts.add(send.messageId);
    } else {
      for (const [id, check] of deliveryChecks)
        if (check.kind === 'delivered' && check.generation === generation)
          confirmedSteers.set(id, check.historyThrough);
    }
    try {
      const page = await queryHistory({ kind: 'tail' }, null);
      if (!current()) return;
      const preserveHistory = pagedHistory || loadingEarlier();
      if (page.kind === 'room') {
        batch(() => {
          isRoom.set(true);
          const { items: tail, before, through } = page.page;
          const existing = roomMessages() ?? [];
          // Room sequences need not be consecutive. A shared message proves overlap.
          const overlaps = tail.length > 0 && existing.some((item) => item.id === tail[0].id);
          if (preserveHistory && overlaps) {
            roomMessages.set([
              ...existing.filter((item) => item.sequence < tail[0].sequence),
              ...tail,
            ]);
          } else {
            if (loadingEarlier()) earlierState.set(null);
            pagedHistory = false;
            roomMessages.set(tail);
            earlierHistory.set(before == null ? null : { kind: 'room', cursor: before });
          }
          if (generation !== undefined) historyFence.set({ generation, through });
          lastThrough = Math.max(lastThrough ?? 0, through);
          if (before != null) retireDelivered(confirmedPosts);
        });
      } else {
        const existing = chunks() ?? [];
        let { chunks: tail, before, through } = page;
        let preserve = preserveHistory && overlappingTail(existing, tail);
        let rebased = false;
        let rebaseFailure: { cause: unknown } | undefined;
        if (preserve && boundaryProjectionChanged(existing, tail)) {
          // A tail starting inside a newly folded Run cannot tell us which
          // earlier rows survived projection. Re-read that boundary at its
          // new fence; only splice untouched history beyond the Run.
          const boundaryRun = projectionKey(tail[0]);
          const epoch = pageEpoch;
          const reading = () => current() && active() && epoch === pageEpoch;
          preserve = false;
          if (generation !== undefined && before != null && reading()) {
            const flight = { kind: 'loading', generation } as const;
            earlierState.set(flight);
            try {
              const rebuilt = await readBefore(tail[0], before, through, reading, (rows) =>
                rows.some((row) => projectionKey(row) !== boundaryRun),
              );
              if (!current()) return;
              if (rebuilt) {
                rebased = rebuilt.chunks.length > 0;
                tail = joinHistory(rebuilt.chunks, tail);
                before = rebuilt.before;
                preserve =
                  projectionKey(tail[0]) !== boundaryRun && overlappingTail(existing, tail);
              }
            } catch (cause) {
              if (reading()) rebaseFailure = { cause };
            } finally {
              if (!disposed && earlierState() === flight) earlierState.set(null);
            }
          }
        }
        if (!current()) return;
        batch(() => {
          isRoom.set(false);
          const merged = preserve ? joinHistory(existing, tail) : undefined;
          const sameHead =
            existing[0] &&
            tail[0] &&
            sameHistoryField(existing[0], tail[0]) &&
            existing[0].offset === tail[0].offset;
          if (merged && (merged[0] !== tail[0] || sameHead)) {
            pagedHistory ||= rebased;
            chunks.set(merged);
          } else {
            if (loadingEarlier()) earlierState.set(null);
            pagedHistory = rebased;
            chunks.set(tail);
            earlierHistory.set(before == null ? null : { kind: 'agent', cursor: before, through });
          }
          if (generation !== undefined) {
            historyFence.set({ generation, through });
            if (rebaseFailure) {
              earlierState.set({ kind: 'failed', generation });
              const { cause } = rebaseFailure;
              showToast(cause instanceof Error ? cause.message : String(cause));
            }
          }
          if (through !== null) lastThrough = Math.max(lastThrough ?? 0, through);
          const head = chunks()?.[0]?.position;
          if (before != null && head?.kind === 'live') {
            const pagedOut = new Set<string>();
            for (const [id, fence] of confirmedSteers) if (head.sequence > fence) pagedOut.add(id);
            retireDelivered(pagedOut);
          }
        });
      }
      const handoff = !historyDirty && accumulator.completeHandoffIfPending();
      if (handoff) livePreview.set(handoff);
    } catch (cause) {
      if (current()) error.set(cause instanceof Error ? cause.message : String(cause));
    }
  };

  let historyDirty = false;
  let historyFlight: Promise<void> | undefined;
  const loadHistory = () => {
    if (disposed) return Promise.resolve();
    historyDirty = true;
    historyFlight ??= (async () => {
      try {
        while (historyDirty && !disposed) {
          historyDirty = false;
          await refreshTail();
        }
      } finally {
        historyFlight = undefined;
      }
    })();
    return historyFlight;
  };

  const loadModels = async () => {
    const connection = activeHostInfo(rootId);
    if (!connection || isRoom()) return;
    const current = () => !disposed && connection.generation === activeHostInfo(rootId)?.generation;
    const metadata = connection.endpoints.includes('settings')
      ? loadModelCatalog(settingsRpc(rootId))
      : null;
    try {
      const choices = await listHostModels(rootId, current);
      if (!current()) return;
      models.set(choices);
      void metadata?.then((catalog) => {
        if (catalog && current() && models() === choices) {
          models.set(labelModelChoices(choices, modelConnectionLabels(catalog)));
        }
      });
    } catch (cause) {
      if (current()) showToast(cause instanceof Error ? cause.message : String(cause));
    }
  };

  let observeFlight:
    | { generation: number; dirty: boolean; promise: Promise<AgentObservation | null> }
    | undefined;
  const loadObserve = (fresh = true) => {
    const generation = activeHostInfo(rootId)?.generation;
    if (generation === undefined || disposed) return Promise.resolve(null);
    if (observeFlight?.generation === generation) {
      if (fresh) observeFlight.dirty = true;
      return observeFlight.promise;
    }
    const flight = {
      generation,
      dirty: true,
      promise: Promise.resolve<AgentObservation | null>(null),
    };
    flight.promise = (async () => {
      try {
        while (flight.dirty && isCurrent(generation)) {
          flight.dirty = false;
          let obs: AgentObservation;
          try {
            obs = await hostQuery<AgentObservation>(
              'agent',
              'observe',
              { sessionId },
              undefined,
              rootId,
            );
            if (obs.session.id !== sessionId)
              throw new Error('Host observed a different conversation');
          } catch (cause) {
            if (!isCurrent(generation)) return null;
            error.set(cause instanceof Error ? cause.message : String(cause));
            // Only an already queued read can follow this failure.
            if (flight.dirty) continue;
            return null;
          }
          if (!isCurrent(generation)) return null;
          const current = observation();
          if (
            current &&
            (obs.session.revision < current.session.revision || obs.through < current.through)
          ) {
            // A committed backend may have advanced the summary while this read
            // was in flight. Watch events queued behind it still need a read.
            if (flight.dirty) continue;
            return null;
          }
          batch(() => {
            observed.set({ generation, value: obs });
            const request = pendingContinuation();
            const observedRunId = obs.run?.runId ?? obs.latestRunId;
            if (
              request?.ownsComposer &&
              observedRunId != null &&
              observedRunId !== request.source.runId
            ) {
              continuationRequest.set({ ...request, ownsComposer: false });
            }
            if (obs.session.kind === 'room') isRoom.set(true);
            if (typeof obs.through === 'number') {
              lastThrough = Math.max(lastThrough ?? 0, obs.through);
              advanceTip(generation, obs.through);
            }
          });
        }
        return isCurrent(generation) ? observation() : null;
      } finally {
        if (observeFlight === flight) observeFlight = undefined;
      }
    })();
    observeFlight = flight;
    return flight.promise;
  };

  const syncIdleTail = (snapshot: AgentObservation) => {
    const fence = historyFence();
    if (
      snapshot === observation() &&
      !snapshot.run &&
      !isRoom() &&
      fence?.generation === activeHostInfo(rootId)?.generation &&
      fence?.through != null &&
      fence.through < snapshot.through
    ) {
      void loadHistory();
    }
  };

  const refreshDetails = async () => {
    const snapshot = await loadObserve(false);
    if (snapshot && !disposed) syncIdleTail(snapshot);
  };

  const startWatch = (gen: number) => {
    stopWatch();
    const subId = 'watch:' + rootId + ':' + sessionId + ':' + String(++watchSeq);
    stopSubscription = watchHost<AgentDeliveryPage>(
      rootId,
      gen,
      subId,
      'watch',
      { sessionId, after: lastThrough ?? 0 },
      (page) => applyWatchItem(page, gen),
      (cause) => console.warn('Could not watch conversation', cause),
    );
  };

  const isCurrent = (generation: number) =>
    !disposed && activeHostInfo(rootId)?.generation === generation;

  const applyQueue = (value: AgentQueue, generation: number) => {
    if (isRoom() || !isCurrent(generation) || !(value.revision >= (queue()?.revision ?? -1)))
      return;
    batch(() => {
      queueSnapshot.set({ generation, value });
      observedSteering.update((previous) => {
        const delivered = previous.size ? transcriptMessageIds() : null;
        const next = new Map(previous);
        if (delivered) for (const id of next.keys()) if (delivered.has(id)) next.delete(id);
        for (const entry of value.entries) {
          if (entry.kind === 'steering' && entry.origin?.kind !== 'session_completion') {
            if (!transcriptMessageIds().has(entry.messageId)) {
              // Keep the existing remote pills; only new contenders wait for
              // a local receipt to tell us which one belongs to our send.
              const existing = next.get(entry.messageId);
              next.set(entry.messageId, {
                entry,
                historyThrough: existing?.historyThrough ?? historyFence()?.through ?? 0,
                withheldBy: existing ? existing.withheldBy : unacknowledgedSteer()?.id,
              });
            }
          } else if (entry.kind !== 'in_flight') {
            next.delete(entry.messageId);
          }
        }
        return next;
      });
    });
  };

  const queryQueue = () =>
    hostQuery<AgentQueue>('agent', 'queue', { sessionId }, undefined, rootId);
  const loadQueue = async (generation: number) => applyQueue(await queryQueue(), generation);
  const refreshQueue = async (generation = activeHostInfo(rootId)?.generation) => {
    if (isRoom() || generation === undefined || !isCurrent(generation)) return;
    try {
      await loadQueue(generation);
    } catch (cause) {
      console.warn('Could not read the message queue', cause);
      if (isCurrent(generation)) showToast(tr('Could not load the message queue.'));
    }
  };

  const queueMessage = (messageId: string, expectedRevision: number) =>
    hostQuery<AgentQueueMessageResult>(
      'agent',
      'queueMessage',
      { sessionId, messageId, expectedRevision },
      undefined,
      rootId,
    );

  const recoverDelivery = (messageId: string, cancelled: boolean) => {
    const send = composerSends().find((item) => sentMessageId(item) === messageId);
    if (!send) {
      if (cancelled) forgetSteering(new Set([messageId]));
      return;
    }
    const { id, generation, historyThrough, draft, delivery } = send;
    const problem: ComposerSend = {
      id,
      generation,
      historyThrough,
      draft,
      delivery,
      messageId,
      state: cancelled ? 'failed' : 'unknown',
      detail: cancelled ? stoppedSend() : unconfirmedSend(),
    };
    batch(() => {
      forgetSteering(new Set([messageId]));
      updateSends((sends) => sends.map((item) => (item === send ? problem : item)));
    });
  };

  const checkFinished = signal(0);
  effect(() => {
    const snapshot = queueSnapshot();
    if (!snapshot || !isCurrent(snapshot.generation) || isRoom()) return;
    const { generation, value } = snapshot;
    const local = remainingSends();
    const steering = observedSteering();
    checkFinished();
    if (!local.length && !steering.size && !deliveryChecks.size) return;

    const delivered = transcriptMessageIds();
    const present = new Set(value.entries.map((entry) => entry.messageId));
    const missing = new Set<string>();
    const landedSteering = new Set<string>();
    for (const [id, entry] of steering) {
      if (delivered.has(id)) landedSteering.add(id);
      else if (!present.has(id) && !isWithheld(entry)) missing.add(id);
    }
    if (landedSteering.size) forgetSteering(landedSteering);
    for (const send of local) {
      const id = sentMessageId(send);
      if (id === undefined || send.state === 'failed' || present.has(id)) continue;
      if (
        send.state === 'queued' &&
        send.generation === generation &&
        value.revision < send.revision
      )
        continue;
      missing.add(id);
    }
    for (const [id, check] of deliveryChecks) {
      if (!missing.has(id) && check.kind !== 'pending') deliveryChecks.delete(id);
    }
    for (const id of missing) {
      const previous = deliveryChecks.get(id);
      if (
        previous?.generation === generation &&
        (previous.kind === 'pending' ||
          previous.kind === 'delivered' ||
          (previous.kind === 'checked' && previous.revision === value.revision) ||
          (previous.kind === 'interrupted' && previous.snapshot === snapshot))
      )
        continue;

      const check: DeliveryCheck = { generation, kind: 'pending', revision: value.revision };
      deliveryChecks.set(id, check);
      const interruptCheck = () => {
        if (!isCurrent(generation)) return;
        // A new snapshot can retry even at this revision; don't spin on this one.
        if (queueSnapshot() !== snapshot) {
          deliveryChecks.delete(id);
          return;
        }
        deliveryChecks.set(id, { generation, kind: 'interrupted', snapshot });
        recoverDelivery(id, false);
      };
      void (async () => {
        try {
          const result = await queueMessage(id, check.revision);
          if (!isCurrent(generation)) return;
          if (result.kind === 'revision_conflict') {
            if ((queue()?.revision ?? -1) < result.actual) {
              const refreshed = await queryQueue();
              // A refresh that did not reach the reported revision must not
              // publish another copy of the very snapshot that conflicted.
              if (refreshed.revision >= result.actual) applyQueue(refreshed, generation);
            }
            interruptCheck();
            return;
          }
          if (result.kind !== 'missing') return;
          if (result.reason === 'delivered') {
            const send = composerSends().find((item) => sentMessageId(item) === id);
            deliveryChecks.set(id, {
              generation,
              kind: 'delivered',
              historyThrough: send?.historyThrough ?? steering.get(id)?.historyThrough ?? 0,
            });
            void loadHistory();
          } else if (result.reason === 'cancelled' || queue()?.revision === check.revision) {
            recoverDelivery(id, result.reason === 'cancelled');
          }
        } catch (cause) {
          if (!isCurrent(generation)) return;
          console.warn('Could not verify message delivery', cause);
          interruptCheck();
        } finally {
          if (deliveryChecks.get(id) === check)
            deliveryChecks.set(id, { generation, kind: 'checked', revision: value.revision });
          if (isCurrent(generation)) checkFinished.update((n) => n + 1);
        }
      })();
    }
  });

  const refreshAll = async () => {
    error.set(null);
    loading.set(true);
    const stop = stoppingTarget();
    try {
      const [snapshot] = await Promise.all([
        loadObserve(),
        loadHistory(),
        loadInteractions(),
        loadModels(),
        refreshQueue(),
      ]);
      if (snapshot && stop?.phase === 'unknown' && stopRequest() === stop) stopRequest.set(null);
      return snapshot;
    } finally {
      if (!disposed) loading.set(false);
    }
  };

  const loadEarlier = async (retry = false) => {
    const edge = earlierHistory();
    const generation = activeHostInfo(rootId)?.generation;
    if (
      !active() ||
      !edge ||
      generation == null ||
      loading() ||
      loadingEarlier() ||
      retry !== earlierFailed()
    )
      return;
    const flight = { kind: 'loading', generation } as const;
    earlierState.set(flight);
    const epoch = pageEpoch;
    const current = () =>
      !disposed &&
      active() &&
      pageEpoch === epoch &&
      earlierState() === flight &&
      earlierHistory() === edge &&
      generation === activeHostInfo(rootId)?.generation;
    try {
      if (edge.kind === 'room') {
        const page = await queryHistory(
          { kind: 'before_message', messageId: edge.cursor },
          lastThrough,
        );
        if (!current()) return;
        if (page.kind !== 'room') throw new Error('Expected Room history', { cause: page.kind });
        const { items, before } = page.page;
        assertHistoryAdvance(edge.cursor, before, items.length);
        pagedHistory = true;
        batch(() => {
          roomMessages.update((existing) => {
            if (!existing?.length) return items;
            const first = existing[0];
            return [...items.filter((item) => item.sequence < first.sequence), ...existing];
          });
          earlierHistory.set(before == null ? null : { kind: 'room', cursor: before });
        });
      } else {
        const head = chunks()?.[0];
        const result = await readBefore(
          head,
          edge.cursor,
          edge.through,
          current,
          earlierTurnBoundary(head),
        );
        if (!result || !current()) return;
        pagedHistory = true;
        batch(() => {
          chunks.update((existing) => joinHistory(result.chunks, existing ?? []));
          earlierHistory.set(result.before == null ? null : { ...edge, cursor: result.before });
        });
      }
    } catch (cause) {
      if (current()) {
        earlierState.set({ kind: 'failed', generation });
        showToast(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (!disposed && earlierState() === flight) earlierState.set(null);
    }
  };

  const draft = () => getDraft(rootId, sessionId);
  const sending = () => draft().sending;
  const hasDraftReferences = () => !isRoom() && !!(draft().quotes.length || draft().links.length);
  const hasDraftEdits = () => draft().input.text.length > 0 || hasDraftReferences();
  const hasDraftContent = () => !!trimHostWhitespace(draft().input.text) || hasDraftReferences();

  const submit = async (snapshot: DraftContent, delivery: SendDelivery, retryId?: number) => {
    if (runControlBusy()) return false;
    const room = isRoom();
    const content = room ? { input: snapshot.input, quotes: [], links: [] } : snapshot;
    if (sending() || (!sendText(content) && !content.quotes.length)) return false;
    error.set(null);
    const failPreflight = (message: string) => {
      hapticNotification('error');
      if (!disposed && retryId === undefined) error.set(message);
      showToast(message);
      return false;
    };

    const connection = activeHostInfo(rootId);
    if (!connection) return failPreflight(tr('Computer is offline'));
    const { generation } = connection;
    updateDraft(rootId, sessionId, (draft) => ({ ...draft, sending: true }));
    try {
      if (!room && (retryId !== undefined || !observation())) {
        await loadObserve(retryId !== undefined);
        if (!isCurrent(generation)) return failPreflight(tr('Computer is offline'));
        if (error() || !observation()) return failPreflight(error() ?? tr('Select model'));
      }
      const run = observation()?.run;
      const expectedRunId = room ? null : (run?.runId ?? null);
      const startsRun = run == null;
      const send = {
        id: retryId ?? ++nextSendId,
        generation,
        draft: content,
        delivery,
        historyThrough: historyFence()?.through ?? observation()?.through ?? 0,
      };
      const keep = (attempt: ComposerSend) => {
        if (retryId !== undefined && !failedSend(retryId)) return false;
        batch(() => {
          if (retryId === undefined) {
            updateSends((sends) => [...sends, attempt]);
            consumeDraft(rootId, sessionId, content);
          } else
            updateSends((sends) => sends.map((item) => (item.id === send.id ? attempt : item)));
        });
        return true;
      };
      const runChanged = () => !room && run?.runId !== observation()?.run?.runId;
      const rejectChangedRun = () => {
        const detail = observation()?.run
          ? tr('The active turn changed. Your message is kept.')
          : stoppedSend();
        if (keep({ ...send, state: 'failed', detail })) hapticNotification('error');
        return false;
      };

      let backend: AgentBackendPreference | null = null;
      if (!room && !(delivery === 'steer' && run?.backend === 'model')) {
        const pending = selectingModel();
        const selected = !pending || (await pending.done);
        if (!isCurrent(generation)) return failPreflight(tr('Computer is offline'));
        if (runChanged()) return rejectChangedRun();
        if (!selected) return false;
        try {
          backend = await sendBackend(rootId, connection, selectedBackend());
        } catch (cause) {
          if (isCurrent(generation) && runChanged()) return rejectChangedRun();
          throw cause;
        }
      }
      if (!isCurrent(generation)) return failPreflight(tr('Computer is offline'));
      if (runChanged()) return rejectChangedRun();
      if (!keep({ ...send, state: 'sending', startsRun })) return false;
      const settle = (next: ComposerSend) =>
        updateSends((sends) =>
          sends.map((item) =>
            item.id === send.id && item.state === 'sending' && item.generation === generation
              ? next
              : item,
          ),
        );
      let result: AgentSendResult;
      let preparedRoomPost: string | undefined;
      try {
        result = await deliverDraft(
          rootId,
          sessionId,
          generation,
          room,
          content,
          {
            backend,
            expectedRunId,
          },
          delivery,
          room
            ? (messageId) => {
                preparedRoomPost = messageId;
                settle({ ...send, state: 'sending', startsRun, messageId });
              }
            : undefined,
        );
      } catch (cause) {
        console.warn('Could not confirm send result', cause);
        if (cause instanceof MutationNotSubmitted) {
          settle({ ...send, state: 'failed', detail: tr('Could not send the message.') });
          hapticNotification('error');
        } else {
          settle({
            ...send,
            state: 'unknown',
            detail: unconfirmedSend(),
            messageId: preparedRoomPost,
          });
          hapticNotification('warning');
        }
        return false;
      }
      if (result.kind === 'rejected' || result.kind === 'not_your_worker') {
        settle({ ...send, state: 'failed', detail: sendRejection(result) });
        hapticNotification('error');
        return false;
      }
      const { messageId } = result;
      settle(
        result.kind === 'queued'
          ? { ...send, state: 'queued', messageId, startsRun, revision: result.revision }
          : { ...send, state: 'started', messageId },
      );
      hapticSelection();
      if (isCurrent(generation)) {
        void loadObserve();
        void loadHistory();
        if (result.kind === 'queued') void refreshQueue(generation);
        void refreshHostSessions(rootId, hostById(rootId)?.hostName ?? rootId);
      }
      return true;
    } catch (cause) {
      console.warn('Could not prepare message', cause);
      return failPreflight(
        cause instanceof Error ? cause.message : tr('Could not send the message.'),
      );
    } finally {
      updateDraft(rootId, sessionId, (draft) => ({ ...draft, sending: false }));
    }
  };

  const sendMessage = (delivery: SendDelivery = 'steer', target?: RunTarget) => {
    if (!active() || (target && !sameRun(target))) return Promise.resolve(false);
    return submit(draft(), delivery);
  };
  const failedSend = (id: number) =>
    composerSends().find(
      (send) => send.id === id && (send.state === 'failed' || send.state === 'unknown'),
    );
  const dismissPendingSend = (id: number) => {
    const send = failedSend(id);
    if (!send) return;
    batch(() => {
      const messageId = sentMessageId(send);
      if (messageId !== undefined) forgetSteering(new Set([messageId]));
      updateSends((sends) => sends.filter((send) => send.id !== id));
    });
  };
  const editPendingSend = (id: number) => {
    const send = failedSend(id);
    if (!send || sending()) return false;
    const current = draft();
    const quotes = [...current.quotes];
    for (const quote of send.draft.quotes) {
      if (
        !quotes.some(
          (item) =>
            item.sourceKey === quote.sourceKey && item.reference.text === quote.reference.text,
        )
      )
        quotes.push(quote);
    }
    if (quotes.length > quoteLimit) {
      showToast(tr('Quote limit reached ({count})', { count: quoteLimit }));
      return false;
    }
    const links = [
      ...current.links,
      ...send.draft.links.filter((link) => !current.links.some((item) => item.id === link.id)),
    ];
    const text =
      current.input.text === send.draft.input.text
        ? current.input.text
        : [current.input.text, send.draft.input.text].filter(Boolean).join('\n\n');
    batch(() => {
      updateDraft(rootId, sessionId, (draft) => ({ ...draft, input: { text }, quotes, links }));
      dismissPendingSend(id);
    });
    return true;
  };
  const retryPendingSend = (id: number) => {
    const send = failedSend(id);
    if (send?.state === 'failed') return submit(send.draft, send.delivery, id);
  };

  const runTarget = computed<RunTarget | null>(() => {
    const generation = activeHostInfo(rootId)?.generation;
    const run = observation()?.run;
    return !isRoom() && run && generation !== undefined
      ? { rootId, generation, sessionId, runId: run.runId }
      : null;
  });
  const sameRun = (target: RunTarget) =>
    target.rootId === rootId &&
    target.sessionId === sessionId &&
    isCurrent(target.generation) &&
    runTarget()?.runId === target.runId;
  const stopRequest = signal<{ target: RunTarget; phase: 'pending' | 'unknown' } | null>(null);
  const stoppingTarget = () => {
    const request = stopRequest();
    return request && sameRun(request.target) ? request : null;
  };
  const stopRun = async (target: RunTarget) => {
    if (!active() || !sameRun(target) || runControlBusy()) return;
    const request = { target, phase: 'pending' } as const;
    stopRequest.set(request);
    try {
      const result = await hostMutate<AgentOutput<'stop'>>(
        'agent',
        'stop',
        { sessionId, runId: target.runId },
        { rootId, generation: target.generation },
      );
      if (!isCurrent(target.generation)) return;
      if (result.requested && active() && sameRun(target)) hapticNotification('warning');
      await loadObserve();
      if (!result.requested && stopRequest() === request) stopRequest.set(null);
    } catch (cause) {
      if (stopRequest() !== request || !sameRun(target)) return;
      if (cause instanceof MutationNotSubmitted) {
        stopRequest.set(null);
        if (active()) showToast(tr('Could not stop the reply. Try again.'));
      } else {
        stopRequest.set({ target, phase: 'unknown' });
        if (active()) showToast(tr('Stop not confirmed. Refresh to check the reply.'));
        void loadObserve();
      }
    }
  };

  const watchObserveTip = signal<{ generation: number; through: number }>();
  const continuationCandidate = () => {
    const generation = activeHostInfo(rootId)?.generation;
    const obs = observation();
    const fence = historyFence();
    const tip = knownTip();
    const requiredObservation = watchObserveTip();
    const backend = selectedBackend();
    const rawQueue = queue();
    if (
      !enabled ||
      !active() ||
      isRoom() ||
      generation === undefined ||
      !obs ||
      obs.session.archived ||
      obs.run ||
      (requiredObservation?.generation === generation &&
        obs.through < requiredObservation.through) ||
      fence?.generation !== generation ||
      fence.through === null ||
      (tip?.generation === generation && fence.through < tip.through) ||
      !rawQueue ||
      rawQueue.entries.some(({ kind }) => kind !== 'held') ||
      selectingModel() ||
      sending() ||
      backend?.kind !== 'model'
    )
      return null;
    const runId =
      obs.latestRunId ??
      chunks()?.findLast((row) => row.position.kind === 'live' && row.runId != null)?.runId;
    if (!runId) return null;
    return {
      generation,
      runId,
      backend,
      key: JSON.stringify([
        generation,
        runId,
        fence.through,
        obs.through,
        obs.session.workspace,
        backendKey(backend),
      ]),
    };
  };
  const continuationKey = computed(() => continuationCandidate()?.key ?? null);
  type ResumeSource = NonNullable<ReturnType<typeof continuationCandidate>> & { highWater: number };
  const verifiedContinuation = signal<ResumeSource | null>(null);
  const continuationRequest = signal<{ source: ResumeSource; ownsComposer: boolean } | null>(null);
  // An ambiguous receipt must not turn into a retry of the same durable source.
  const settledContinuation = signal<Pick<ResumeSource, 'runId' | 'highWater'> | null>(null);
  const pendingContinuation = () => {
    const request = continuationRequest();
    return request && isCurrent(request.source.generation) ? request : null;
  };
  // Receipt deduplication lasts until settlement; composer ownership does not
  // come back after a successor has been observed.
  const continueRequestBusy = () => pendingContinuation()?.ownsComposer === true;
  const runControlBusy = () => !!stoppingTarget() || continueRequestBusy();
  const availableContinuation = () => {
    const source = verifiedContinuation();
    const settled = settledContinuation();
    return source &&
      source.key === continuationKey() &&
      !(settled?.runId === source.runId && settled.highWater === source.highWater)
      ? source
      : null;
  };
  const continuationReady = () => (pendingContinuation() ? null : availableContinuation());
  const readExecution = (runId: ResumeSource['runId']) =>
    hostQuery<AgentOutput<'execution'>>(
      'agent',
      'execution',
      { sessionId, runId },
      undefined,
      rootId,
    );
  const matchesSource = (execution: AgentExecution, runId: ResumeSource['runId']) =>
    execution.sessionId === sessionId && execution.runId === runId && isStoppedExecution(execution);
  const modelSupportsContinuation = async (backend: ResumeSource['backend']) => {
    const model = await hostQuery<AgentOutput<'model'>>(
      'agent',
      'model',
      { backend },
      undefined,
      rootId,
    );
    return (
      model.kind === 'ready' &&
      (backend.serviceTier == null ||
        model.choice.serviceTiers?.some(({ id }) => id === backend.serviceTier)) &&
      (backend.thinkingLevel == null || model.choice.thinkingLevels.includes(backend.thinkingLevel))
    );
  };
  const continueRun = async (source: ResumeSource, composerEmpty: () => boolean) => {
    const eligible = () =>
      isCurrent(source.generation) &&
      availableContinuation() === source &&
      !hasDraftEdits() &&
      !sending() &&
      composerEmpty();
    if (!eligible() || pendingContinuation() || stoppingTarget()) return;
    continuationRequest.set({ source, ownsComposer: true });
    const current = () => continueRequestBusy() && eligible();
    let submitted = false;
    try {
      const fresh = await loadObserve();
      if (!fresh) return;
      if (!current()) {
        if (isCurrent(source.generation)) syncIdleTail(fresh);
        return;
      }
      const supported = await modelSupportsContinuation(source.backend);
      if (!current()) return;
      if (!supported) {
        verifiedContinuation.set(null);
        showToast(tr('The selected model is unavailable. Try again or choose another model.'));
        return;
      }
      const result = await readExecution(source.runId);
      if (!current()) return;
      if (
        result.kind !== 'found' ||
        !matchesSource(result.execution, source.runId) ||
        result.execution.highWater !== source.highWater
      ) {
        verifiedContinuation.set(null);
        showToast(tr('The conversation changed. Send a new message instead.'));
        return;
      }
      const { connectionId, modelId, serviceTier, thinkingLevel } = source.backend;
      submitted = true;
      const receipt = await hostMutate<AgentOutput<'continueRun'>>(
        'agent',
        'continueRun',
        {
          sessionId,
          sourceRunId: source.runId,
          sourceHighWater: source.highWater,
          model: { connectionId, modelId, ...(serviceTier != null && { serviceTier }) },
          thinkingLevel: thinkingLevel ?? null,
        },
        { rootId, generation: source.generation },
      );
      if (receipt.kind === 'started') {
        if (receipt.execution.sessionId !== sessionId || receipt.execution.runId === source.runId)
          throw new Error('Host returned an unexpected continuation');
        if (!disposed) settledContinuation.set(source);
      }
      if (!isCurrent(source.generation)) return;
      if (receipt.kind === 'rejected') {
        if (verifiedContinuation()?.runId === source.runId) verifiedContinuation.set(null);
        showToast(tr(continuationRejected[receipt.reason]));
        hapticNotification('error');
      } else hapticSelection();
      void loadHistory();
      void refreshQueue(source.generation);
      await loadObserve();
    } catch (cause) {
      const unknown = submitted && !(cause instanceof MutationNotSubmitted);
      if (unknown && !disposed) settledContinuation.set(source);
      if (isCurrent(source.generation)) {
        console.warn('Could not confirm continuation', cause);
        showToast(
          unknown
            ? tr('Continue not confirmed. Refresh to check the reply.')
            : tr('Could not continue the reply. Try again.'),
        );
        if (unknown) {
          hapticNotification('warning');
          void loadHistory();
          void refreshQueue(source.generation);
          await loadObserve();
        } else hapticNotification('error');
      }
    } finally {
      if (continuationRequest()?.source === source) continuationRequest.set(null);
    }
  };

  const selectModel = (backend: AgentBackendPreference) => {
    const generation = activeHostInfo(rootId)?.generation;
    if (
      disposed ||
      isRoom() ||
      generation === undefined ||
      selectingModel() ||
      sending() ||
      continueRequestBusy()
    )
      return;
    const alreadySelected = () => {
      const chosen = selectedBackend();
      return chosen !== null && backendKey(chosen) === backendKey(backend);
    };
    if (alreadySelected()) return;
    const done = (async () => {
      try {
        if (!observation()) await loadObserve(false);
        if (disposed || activeHostInfo(rootId)?.generation !== generation) return false;
        if (!observation()) throw new Error(error() ?? tr('Select model'));
        if (alreadySelected()) return true;
        const result = await hostMutate<AgentMetadataResult>(
          'agent',
          'selectBackend',
          { sessionId, backend },
          { rootId, generation },
        );
        if (disposed || activeHostInfo(rootId)?.generation !== generation) return false;
        if (result.kind !== 'committed')
          throw new Error(tr('Could not change the model.'), { cause: result.kind });
        const current = observation()!;
        if (result.session.revision >= current.session.revision) {
          observed.set({
            generation,
            value: { ...current, session: result.session, metrics: null },
          });
          void loadObserve();
        }
        return true;
      } catch (cause) {
        if (!disposed && activeHostInfo(rootId)?.generation === generation) {
          showToast(cause instanceof Error ? cause.message : String(cause));
        }
        return false;
      } finally {
        if (modelSelection()?.generation === generation) modelSelection.set(null);
      }
    })();
    modelSelection.set({ generation, done });
    return done;
  };

  const queueOperation = signal<{ generation: number; through?: number } | null>(null);
  const queueNotice = signal<{ generation: number; detail: string } | null>(null);
  const queueError = () => {
    const notice = queueNotice();
    return notice && isCurrent(notice.generation) ? notice.detail : null;
  };
  const clearQueueError = () => queueNotice.set(null);
  const queueBusy = () => {
    const pending = queueOperation();
    return (
      !!pending &&
      isCurrent(pending.generation) &&
      (pending.through === undefined || (queue()?.revision ?? -1) < pending.through)
    );
  };
  const queueChanged = () =>
    tr('The queue changed. Review the current message before trying again.');
  const queueMissing = () => tr('This message is no longer queued.');
  const reportQueueError = (generation: number, detail: string) => {
    if (isCurrent(generation)) queueNotice.set({ generation, detail });
  };
  const changeQueue = async (
    edit: Exclude<AgentQueueAction, { kind: 'reorder' }>,
    expectedRevision = queue()?.revision,
  ) => {
    const generation = activeHostInfo(rootId)?.generation;
    if (disposed || generation === undefined || expectedRevision === undefined || queueBusy())
      return false;
    const operation = { generation };
    queueOperation.set(operation);
    clearQueueError();
    let committed: number | undefined;
    try {
      if (expectedRevision !== queue()?.revision) {
        reportQueueError(generation, queueChanged());
        return false;
      }
      const result = await hostMutate<AgentQueueMutationResult>(
        'agent',
        'editQueue',
        { sessionId, expectedRevision, edit },
        { rootId, generation },
      );
      if (!isCurrent(generation)) return false;
      if (result.kind === 'committed') {
        committed = result.revision;
        hapticSelection();
        return true;
      }
      reportQueueError(
        generation,
        result.kind === 'revision_conflict'
          ? queueChanged()
          : result.reason === 'execution_changed'
            ? tr('This turn cannot accept this message right now. It remains queued.')
            : result.reason === 'not_running'
              ? tr('No turn is running. This message remains queued.')
              : result.reason === 'missing' || result.reason === 'in_flight'
                ? queueMissing()
                : tr('Could not update the message queue.'),
      );
    } catch (cause) {
      console.warn('Could not update the message queue', cause);
      reportQueueError(generation, tr('Could not update the message queue.'));
    } finally {
      if (queueOperation() === operation) {
        if (committed !== undefined) {
          // The receipt fences controls, but only a watch or query can replace the queue.
          queueOperation.set({ generation, through: committed });
          if (queueBusy()) void refreshQueue(generation);
        } else {
          await refreshQueue(generation);
          if (queueOperation() === operation) queueOperation.set(null);
        }
      }
    }
    return false;
  };

  const readQueuedMessage = async (messageId: string) => {
    const generation = activeHostInfo(rootId)?.generation;
    const expectedRevision = queue()?.revision;
    if (disposed || generation === undefined || expectedRevision === undefined || queueBusy())
      return null;
    const operation = { generation };
    queueOperation.set(operation);
    clearQueueError();
    try {
      const result = await queueMessage(messageId, expectedRevision);
      if (!isCurrent(generation)) return null;
      if (
        result.kind === 'ready' &&
        result.revision === queue()?.revision &&
        queuedMessages().some((item) => item.messageId === messageId)
      )
        return { ...result, generation };
      reportQueueError(generation, result.kind === 'missing' ? queueMissing() : queueChanged());
      await refreshQueue(generation);
    } catch (cause) {
      console.warn('Could not read queued message', cause);
      reportQueueError(generation, tr('Could not read the queued message.'));
    } finally {
      if (queueOperation() === operation) queueOperation.set(null);
    }
    return null;
  };

  const respondInteraction = async (requestId: string, answer: Record<string, unknown>) => {
    if (busyInteractionIds()[requestId]) return null;
    busyInteractionIds.update((prev) => ({ ...prev, [requestId]: true }));
    const generation = activeHostInfo(rootId)?.generation;
    try {
      const result = await hostMutate<AgentInteractionResult>(
        'agent',
        'respond',
        { sessionId, requestId, answer },
        { rootId },
      );
      if (result.kind === 'rejected') {
        void loadInteractions();
        throw approvalRejectionError(result.reason);
      }
      if (activeHostInfo(rootId)?.generation === generation)
        dismissInboxRequest(rootId, sessionId, requestId);
      hapticNotification(approvalOutcome(result.record.outcome) === false ? 'warning' : 'success');
      const hostName = hostById(rootId)?.hostName ?? rootId;
      refreshHostInbox(rootId);
      await Promise.all([loadInteractions(), loadObserve(), refreshHostSessions(rootId, hostName)]);
      return result.record;
    } catch (cause) {
      hapticNotification('error');
      showToast(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      if (!disposed) {
        busyInteractionIds.update((prev) => {
          const next = { ...prev };
          delete next[requestId];
          return next;
        });
      }
    }
  };

  const applyWatchItem = (page: AgentDeliveryPage, generation: number) => {
    if (page.kind === 'preview') {
      livePreview.set(accumulator.applyPreviewPage(page.page));
      return;
    }
    if (page.kind === 'queue') {
      applyQueue(page.queue, generation);
      return;
    }
    if (page.kind === 'interactions') {
      void loadInteractions();
      refreshHostInbox(rootId);
      return;
    }
    if (page.kind === 'room') {
      if (typeof page.through === 'number') lastThrough = Math.max(lastThrough ?? 0, page.through);
      void loadHistory();
      return;
    }
    if (page.kind === 'events') {
      if (typeof page.through === 'number') {
        lastThrough = Math.max(lastThrough ?? 0, page.through);
        advanceTip(generation, page.through);
      }
      let needsHistory = false;
      let needsObserve = false;
      let needsCatalog = false;
      for (const ev of page.events ?? []) {
        const fact = ev.fact;
        if (fact.kind === 'step_ended') needsObserve = true;
        if (fact.kind === 'delta') {
          livePreview.set(accumulator.applyDelta(ev.runId, fact.text));
        } else if (
          fact.kind === 'part_committed' ||
          fact.kind === 'transcript_changed' ||
          fact.kind === 'tool_settled' ||
          fact.kind === 'executor_tool_result' ||
          [
            'step_ended',
            'executor_text_changed',
            'executor_tool_start',
            'tool_dispatched',
          ].includes(fact.kind)
        ) {
          needsHistory = true;
        } else if (['opened', 'executor_started'].includes(fact.kind)) {
          needsObserve = true;
          needsCatalog = true;
        } else if (fact.kind === 'ended') {
          needsHistory = true;
          needsObserve = true;
          needsCatalog = true;
          livePreview.set(accumulator.beginHandoff());
        }
      }
      if (needsHistory) void loadHistory();
      if (needsObserve || (!observation()?.run && needsHistory)) {
        watchObserveTip.set({ generation, through: page.through });
        void loadObserve();
      }
      if (needsCatalog) {
        const hostName = hostById(rootId)?.hostName ?? rootId;
        void refreshHostSessions(rootId, hostName);
      }
    }
  };

  effect(() => {
    if (!enabled) return;
    const conn = activeHostInfo(rootId);
    if (!conn) {
      stopWatch();
      activeGeneration = -1;
      return;
    }
    const gen = conn.generation;
    if (gen === activeGeneration) return;
    stopWatch();
    activeGeneration = gen;
    void refreshAll().then(() => {
      if (!disposed && activeHostInfo(rootId)?.generation === gen) {
        startWatch(gen);
      }
    });
  });

  effect(() => {
    const key = continuationKey();
    const refreshing = loading();
    untracked(() => {
      verifiedContinuation.set(null);
      const candidate = continuationCandidate();
      if (!key || refreshing || !candidate) return;
      let live = true;
      cleanup(() => {
        live = false;
      });
      const current = () => live && isCurrent(candidate.generation) && continuationKey() === key;
      void (async () => {
        try {
          const result = await readExecution(candidate.runId);
          if (
            !current() ||
            result.kind !== 'found' ||
            !matchesSource(result.execution, candidate.runId)
          )
            return;
          const availability = await hostQuery<AgentOutput<'continuationAvailability'>>(
            'agent',
            'continuationAvailability',
            { sessionId, runId: candidate.runId },
            undefined,
            rootId,
          );
          if (
            !current() ||
            availability.kind !== 'ready' ||
            !matchesSource(availability.source, candidate.runId) ||
            availability.source.highWater !== result.execution.highWater
          )
            return;
          const supported = await modelSupportsContinuation(candidate.backend);
          if (current() && supported)
            verifiedContinuation.set({ ...candidate, highWater: result.execution.highWater });
        } catch (cause) {
          if (current()) console.warn('Could not check whether the reply can continue', cause);
        }
      })();
    });
  });

  cleanup(() => {
    disposed = true;
    stopWatch();
  });

  const goal = createGoalController({
    rootId,
    sessionId,
    active: () => enabled && !isRoom() && active(),
    approval: async (connection) => {
      const selection = selectingModel();
      if (selection && !(await selection.done)) return null;
      if (!observation()) await loadObserve(false);
      const observed = observation();
      if (!isCurrent(connection.generation) || !observed || observed.session.kind === 'room')
        return null;
      const { id, workspace, permissions, boundaryRevision, binding } = observed.session;
      if (id !== sessionId || !workspace || !permissions || boundaryRevision == null || !binding)
        return null;
      const selectionAtApproval = selectedBackend();
      const backend = await sendBackend(rootId, connection, selectionAtApproval);
      const selected = selectedBackend();
      if (
        !isCurrent(connection.generation) ||
        observation()?.session.revision !== observed.session.revision ||
        JSON.stringify(selected) !== JSON.stringify(selectionAtApproval)
      )
        return null;
      return {
        target: { sessionId, workspace, permissions, boundaryRevision, binding },
        backend,
      };
    },
  });

  return {
    goal,
    observation,
    lastObservation,
    refreshDetails,
    selectedBackend,
    selectingModel,
    chunks: visibleChunks,
    roomMessages: visibleRoomMessages,
    historyLoaded: () => chunks() !== null || roomMessages() !== null,
    isRoom,
    hasMoreBefore: () => earlierHistory() !== null,
    loading,
    loadingEarlier,
    earlierFailed,
    sending,
    hasDraftContent,
    hasDraftEdits,
    error,
    queue,
    queuedMessages,
    steeringMessages,
    optimisticSends,
    pendingSends,
    editPendingSend,
    retryPendingSend,
    dismissPendingSend,
    queueBusy,
    queueError,
    clearQueueError,
    pendingInteractions,
    models,
    busyInteractionIds,
    livePreview,
    refreshAll,
    loadEarlier,
    historyFence,
    readHistoryDetail,
    sendMessage,
    runTarget,
    stoppingTarget,
    stopRun,
    continuationReady,
    continueRequestBusy,
    runControlBusy,
    continueRun,
    selectModel,
    readQueuedMessage,
    promoteQueuedMessage: (messageId: string) => changeQueue({ kind: 'promote', messageId }),
    updateQueuedMessage: (messageId: string, revision: number, message: string) =>
      changeQueue({ kind: 'update', messageId, message }, revision),
    cancelQueuedMessage: (messageId: string) => changeQueue({ kind: 'retract', messageId }),
    respondInteraction,
  };
}
