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
import { cleanup, computed, effect, signal } from 'nsh';
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
  type HistoryRowAddress,
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

export function assembleHistoryRows(chunks: readonly AgentHistoryChunk[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const chunk of chunks) {
    const row = rows.at(-1);
    if (row && chunk.offset > 0 && compareHistoryRows(row.first, chunk) === 0) {
      row.text += chunk.text;
      row.last = chunk;
    } else {
      rows.push({
        key: chunk.order.path.join('/') + ':' + String(chunk.order.itemIndex),
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
  return (
    row.first.offset === 0 && last.offset + Buffer.byteLength(last.text, 'utf8') === last.totalBytes
  );
}

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
const scrollOffsetMap = new Map<string, number>();
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

export function getSavedScrollOffset(rootId: string, sessionId: string): number {
  return scrollOffsetMap.get(conversationKey(rootId, sessionId)) ?? 0;
}

export function saveScrollOffset(rootId: string, sessionId: string, y: number) {
  scrollOffsetMap.set(conversationKey(rootId, sessionId), Math.max(0, y));
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
  const beforeCursor = signal<unknown>(null);
  const loading = signal(true);
  const earlierGeneration = signal<number | null>(null);
  const loadingEarlier = () =>
    earlierGeneration() !== null && earlierGeneration() === activeHostInfo(rootId)?.generation;
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

  const joinHistory = (older: AgentHistoryChunk[], tail: AgentHistoryChunk[]) => {
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
      // Host offsets are UTF-8 byte offsets on character boundaries.
      let remaining = first.offset - row.offset;
      let end = 0;
      for (const character of row.text) {
        if (remaining <= 0) break;
        const code = character.codePointAt(0)!;
        remaining -= code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
        end += character.length;
      }
      prefix.push(end === row.text.length ? row : { ...row, text: row.text.slice(0, end) });
    }
    return [...prefix, ...tail];
  };
  let pagedHistory = false;
  const refreshTail = async () => {
    const generation = activeHostInfo(rootId)?.generation;
    try {
      const page = await hostQuery<AgentHistoryPage>(
        'agent',
        'history',
        {
          sessionId,
          through: null,
          position: { kind: 'tail' },
          includeThinking: true,
          view: 'conversation',
        },
        undefined,
        rootId,
      );
      if (disposed || activeHostInfo(rootId)?.generation !== generation) return;
      const preserveHistory = pagedHistory || loadingEarlier();
      if (page?.kind === 'room') {
        isRoom.set(true);
        const tail = page.page.items;
        if (tail.length || !preserveHistory)
          roomMessages.update((previous) =>
            preserveHistory && tail.length
              ? [...(previous ?? []).filter((item) => item.sequence < tail[0].sequence), ...tail]
              : tail,
          );
        if (!preserveHistory) beforeCursor.set(page.page.before ?? null);
        if (typeof page.page?.through === 'number') {
          lastThrough = Math.max(lastThrough ?? 0, page.page.through);
        }
      } else if (page?.kind === 'ready') {
        isRoom.set(false);
        const tail = page.chunks;
        if (tail.length || !preserveHistory)
          chunks.update((previous) =>
            preserveHistory && tail.length ? joinHistory(previous ?? [], tail) : tail,
          );
        if (!preserveHistory) beforeCursor.set(page.before ?? null);
        if (typeof page.through === 'number') {
          lastThrough = Math.max(lastThrough ?? 0, page.through);
        }
      }
      const handoff = !historyDirty && accumulator.completeHandoffIfPending();
      if (handoff) livePreview.set(handoff);
    } catch (cause) {
      if (!disposed && activeHostInfo(rootId)?.generation === generation) {
        error.set(cause instanceof Error ? cause.message : String(cause));
      }
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

  const loadEarlier = async () => {
    const cursor = beforeCursor();
    const generation = activeHostInfo(rootId)?.generation;
    if (cursor == null || generation == null || loadingEarlier()) return;
    earlierGeneration.set(generation);
    try {
      const page = await hostQuery<AgentHistoryPage>(
        'agent',
        'history',
        {
          sessionId,
          through: lastThrough,
          position: isRoom()
            ? { kind: 'before_message', messageId: cursor }
            : { kind: 'before', cursor },
          includeThinking: true,
          view: 'conversation',
        },
        undefined,
        rootId,
      );
      if (disposed || activeHostInfo(rootId)?.generation !== generation) return;
      pagedHistory = true;
      if (page?.kind === 'room') {
        const older = page.page?.items ?? [];
        const existing = roomMessages() ?? [];
        const seen = new Set(existing.map((m) => m.id));
        roomMessages.set([...older.filter((m) => !seen.has(m.id)), ...existing]);
        beforeCursor.set(page.page?.before ?? null);
      } else if (page?.kind === 'ready') {
        const older = page.chunks ?? [];
        chunks.update((existing) => joinHistory(older, existing ?? []));
        beforeCursor.set(page.before ?? null);
      }
    } catch (cause) {
      if (!disposed && activeHostInfo(rootId)?.generation === generation) {
        showToast(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (!disposed && earlierGeneration() === generation) earlierGeneration.set(null);
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
    beforeCursor,
    loading,
    loadingEarlier,
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
    sendMessage,
    stopRun,
    selectModel,
    cancelQueuedMessage,
    respondInteraction,
  };
}
