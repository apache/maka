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
import { batch, cleanup, computed, effect, signal, untracked } from 'nsh';
import {
  hostMutate,
  hostQuery,
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
  type AgentQueueMutationResult,
  type AgentObservation,
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
import { tr } from '../locale';

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
        ],
  );

export const displayModelKey = (backend: AgentBackendPreference) =>
  backend.kind === 'model'
    ? JSON.stringify(['model', backend.connectionId, backend.modelId])
    : backendKey(backend);

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

// Rust str::trim uses Unicode White_Space, not JavaScript's trim set.
export function trimHostWhitespace(text: string): string {
  return text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
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

// Snapshot and consume only the submitted draft, whether this is the first side question or a normal send.
export async function sendDraft(
  rootId: string,
  sessionId: string,
  room: boolean,
  selectedBackend: (generation: number) => Promise<AgentBackendPreference | null | false>,
  current = () => true,
  onError?: (message: string) => void,
): Promise<boolean> {
  const snapshot = getDraft(rootId, sessionId);
  const quotes = room ? undefined : snapshot.quotes;
  const links = room ? [] : snapshot.links;
  const text = [trimHostWhitespace(snapshot.input.text), ...links.map(sessionInvocation)]
    .filter(Boolean)
    .join(' ');
  if (snapshot.sending || (!text && !quotes?.length)) return false;
  updateDraft(rootId, sessionId, (draft) => ({ ...draft, sending: true }));
  const fail = (message: string) => {
    hapticNotification('error');
    if (current()) onError?.(message);
    showToast(message);
    return false;
  };
  try {
    const connection = activeHostInfo(rootId);
    if (!connection) return fail(tr('Computer is offline'));
    const { generation } = connection;
    let backend = room ? null : await selectedBackend(generation);
    if (backend === false || !current()) return false;
    if (!room && !backend && connection.endpoints.includes('settings')) {
      const choice = await readDefaultModel(settingsRpc(rootId));
      backend = choice ? modelBackend(choice) : null;
    }
    if (!current()) return false;
    if (activeHostInfo(rootId)?.generation !== generation) return fail(tr('Computer is offline'));
    if (!room && !backend) return fail(tr('Select model'));
    let res: AgentSendResult;
    try {
      res = await hostMutate<AgentSendResult>(
        'agent',
        'send',
        {
          mentions: [],
          replyTo: null,
          onComplete: null,
          ...(quotes && { quotes: quotes.map((quote) => quote.reference) }),
          delivery: 'queue',
          expectedRunId: null,
          attachments: [],
          backend,
          sessionId,
          message: text,
        },
        { rootId, generation },
      );
    } catch (cause) {
      console.warn('Could not confirm send result', cause);
      return fail(
        tr(
          'Could not confirm whether the message was sent. Check the conversation or queue before retrying.',
        ),
      );
    }
    if (res.kind === 'rejected' || res.kind === 'not_your_worker') {
      console.warn('Host declined send', res.kind === 'rejected' ? res.reason : res.kind);
      return fail(tr('Could not send the message.'));
    }
    const sentQuoteIds = new Set(quotes?.map((quote) => quote.id));
    updateDraft(rootId, sessionId, (draft) => ({
      ...draft,
      input: draft.input === snapshot.input ? emptyDraft.input : draft.input,
      quotes: draft.quotes.filter((quote) => !sentQuoteIds.has(quote.id)),
      links: draft.links.filter((link) => !links.includes(link)),
    }));
  } catch (cause) {
    console.warn('Could not send message', cause);
    return fail(tr('Could not send the message.'));
  } finally {
    updateDraft(rootId, sessionId, (draft) => ({ ...draft, sending: false }));
  }
  hapticSelection();
  void refreshHostSessions(rootId, hostById(rootId)?.hostName ?? rootId);
  return true;
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
  const queue = signal<AgentQueue>({ revision: 0, entries: [] });
  const pendingInteractions = signal<AgentInteractionRecord[]>([]);
  const models = signal<AgentModelChoice[]>([]);
  const busyInteractionIds = signal<Record<string, boolean>>({});

  const accumulator = new LivePreviewAccumulator();
  const livePreview = signal<LivePreviewSnapshot>(accumulator.snapshot());

  let disposed = false;
  let lastThrough: number | null = null;
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
          lastThrough = Math.max(lastThrough ?? 0, through);
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

  let observeFlight: { generation: number; dirty: boolean; promise: Promise<void> } | undefined;
  const loadObserve = (fresh = true) => {
    const generation = activeHostInfo(rootId)?.generation;
    if (generation === undefined || disposed) return Promise.resolve();
    if (observeFlight?.generation === generation) {
      if (fresh) observeFlight.dirty = true;
      return observeFlight.promise;
    }
    const flight = { generation, dirty: true, promise: Promise.resolve() };
    flight.promise = (async () => {
      try {
        while (flight.dirty && !disposed && activeHostInfo(rootId)?.generation === generation) {
          flight.dirty = false;
          const obs = await hostQuery<AgentObservation>(
            'agent',
            'observe',
            { sessionId },
            undefined,
            rootId,
          );
          if (disposed || activeHostInfo(rootId)?.generation !== generation) return;
          const current = observation();
          if (current && obs.session.revision < current.session.revision) continue;
          observed.set({ generation, value: obs });
          if (obs.session?.kind === 'room') isRoom.set(true);
          if (typeof obs.through === 'number') {
            lastThrough = Math.max(lastThrough ?? 0, obs.through);
          }
        }
      } catch (cause) {
        if (!disposed && activeHostInfo(rootId)?.generation === generation) {
          error.set(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (observeFlight === flight) observeFlight = undefined;
      }
    })();
    observeFlight = flight;
    return flight.promise;
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
      applyWatchItem,
      (cause) => console.warn('Could not watch conversation', cause),
    );
  };

  const refreshAll = async () => {
    error.set(null);
    loading.set(true);
    try {
      await Promise.all([loadObserve(), loadHistory(), loadInteractions(), loadModels()]);
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
  const hasDraftContent = () =>
    Boolean(
      trimHostWhitespace(draft().input.text) ||
        (!isRoom() && (draft().quotes.length || draft().links.length)),
    );

  const sendMessage = async () => {
    error.set(null);
    const sent = await sendDraft(
      rootId,
      sessionId,
      isRoom(),
      async (generation) => {
        if (isRoom()) return null;
        const pending = selectingModel();
        if (pending && !(await pending.done)) return false;
        if (!observation() && activeHostInfo(rootId)?.generation === generation)
          await loadObserve(false);
        if (disposed) return null;
        if (activeHostInfo(rootId)?.generation !== generation)
          throw new Error(tr('Computer is offline'));
        if (!observation()) throw new Error(error() ?? tr('Select model'));
        return selectedBackend();
      },
      () => !disposed,
      (message) => error.set(message),
    );
    if (sent && !disposed) {
      void Promise.all([loadObserve(), loadHistory()]).catch((cause) => {
        if (!disposed) error.set(cause instanceof Error ? cause.message : String(cause));
      });
    }
    return sent;
  };

  const stopRun = async () => {
    const run = observation()?.run;
    if (!run) return;
    try {
      await hostMutate('agent', 'stop', { sessionId, runId: run.runId }, { rootId });
      hapticNotification('warning');
      await loadObserve();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const selectModel = (backend: AgentBackendPreference) => {
    const generation = activeHostInfo(rootId)?.generation;
    if (disposed || isRoom() || generation === undefined || selectingModel() || sending()) return;
    const alreadySelected = () => {
      const chosen = selectedBackend();
      return chosen !== null && displayModelKey(chosen) === displayModelKey(backend);
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
          observed.set({ generation, value: { ...current, session: result.session } });
        }
        hapticSelection();
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

  const cancelQueuedMessage = async (messageId: string) => {
    const q = queue();
    try {
      const result = await hostMutate<AgentQueueMutationResult>(
        'agent',
        'editQueue',
        {
          sessionId,
          expectedRevision: q.revision,
          edit: { kind: 'retract', messageId },
        },
        { rootId },
      );
      queue.set(await hostQuery<AgentQueue>('agent', 'queue', { sessionId }, undefined, rootId));
      if (result.kind !== 'committed')
        throw new Error(tr('Could not update the message queue.'), {
          cause: result.kind === 'rejected' ? result.reason : result.kind,
        });
      hapticSelection();
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : String(cause));
    }
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

  const applyWatchItem = (page: AgentDeliveryPage) => {
    if (page.kind === 'preview') {
      livePreview.set(accumulator.applyPreviewPage(page.page));
      return;
    }
    if (page.kind === 'queue') {
      queue.set(page.queue);
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
      if (typeof page.through === 'number') lastThrough = Math.max(lastThrough ?? 0, page.through);
      let needsHistory = false;
      let needsObserve = false;
      for (const ev of page.events ?? []) {
        const fact = ev.fact;
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
        } else if (fact.kind === 'ended') {
          needsHistory = true;
          needsObserve = true;
          livePreview.set(accumulator.beginHandoff());
        }
      }
      if (needsHistory) void loadHistory();
      if (needsObserve) {
        void loadObserve();
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

  cleanup(() => {
    disposed = true;
    stopWatch();
  });

  return {
    observation,
    selectedBackend,
    selectingModel,
    chunks: computed(() => chunks() ?? []),
    roomMessages: computed(() => roomMessages() ?? []),
    historyLoaded: () => chunks() !== null || roomMessages() !== null,
    isRoom,
    hasMoreBefore: () => earlierHistory() !== null,
    loading,
    loadingEarlier,
    earlierFailed,
    sending,
    hasDraftContent,
    error,
    queue,
    pendingInteractions,
    models,
    busyInteractionIds,
    livePreview,
    refreshAll,
    loadEarlier,
    historyFence,
    readHistoryDetail,
    sendMessage,
    stopRun,
    selectModel,
    cancelQueuedMessage,
    respondInteraction,
  };
}
