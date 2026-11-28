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

import { Buffer } from 'buffer';
import type {
  RunId,
  StepId,
  ModelAttemptId,
  AgentHistoryAttachment,
  AgentHistoryPage,
  AgentHistoryChunk,
  HistoryRowAddress,
  HistoryOrder,
  HistoryTool,
  HistoryCompaction,
  HistoryModel,
  HistoryPosition,
  HistoryTurnTiming,
  MessageOrigin,
  HistoryQuote,
  QuoteRef,
} from '../../../../packages/plugin-sdk/src/index.js';

export type ConversationHistoryPage = Extract<AgentHistoryPage, { kind: 'ready' }>;

export function historyRowKey(position: HistoryRowAddress, field?: string): string {
  const identity =
    position.kind === 'live'
      ? [position.kind, position.sequence, position.fact, position.itemIndex]
      : position.kind === 'snapshot'
        ? [
            position.kind,
            position.path,
            position.snapshot,
            position.sequence,
            position.fact,
            position.itemIndex,
          ]
        : [
            position.kind,
            position.path,
            position.snapshot,
            position.messageOrdinal,
            position.partOrdinal,
          ];
  return JSON.stringify(field === undefined ? identity : [identity, field]);
}
export function sameHistoryRow(left: HistoryRowAddress, right: HistoryRowAddress): boolean {
  return historyRowKey(left) === historyRowKey(right);
}
export function compareHistoryOrder(left: HistoryOrder, right: HistoryOrder): number {
  for (let index = 0; index < Math.min(left.path.length, right.path.length); index += 1) {
    const order = left.path[index] - right.path[index];
    if (order !== 0) return order;
  }
  return left.path.length - right.path.length || left.itemIndex - right.itemIndex;
}
/** A UI grouping key, never a foreign or Root Turn identifier. */
export function historyTurnKey(
  row:
    | { position?: HistoryRowAddress; turnId?: string | null; importedTurn?: number | null }
    | undefined,
): string | undefined {
  if (row === undefined) return undefined;
  const position = row.position;
  if (position?.kind === 'imported')
    return row.importedTurn == null
      ? undefined
      : JSON.stringify(['imported-turn', position.path, position.snapshot, row.importedTurn]);
  if (row.turnId == null) return undefined;
  return position?.kind === 'snapshot'
    ? JSON.stringify(['snapshot-turn', position.path, position.snapshot, row.turnId])
    : row.turnId;
}

export function rootEventSequence(row: Pick<Row, 'position' | 'sequence'>): number | undefined {
  return row.position?.kind === 'live'
    ? row.position.sequence
    : row.position === undefined
      ? row.sequence
      : undefined;
}
type Fragment = { offset: number; text: string };
export type Subscription = {
  next(): Promise<any | null>;
  close(): Promise<void>;
};
export type Row = {
  key: string;
  messageId?: string;
  field: string;
  role: string;
  text: string;
  position?: HistoryRowAddress;
  order?: HistoryOrder;
  importedTurn?: number;
  fragments?: Fragment[];
  prefix?: boolean;
  totalBytes?: number;
  tool?: HistoryTool | null;
  attachments?: AgentHistoryAttachment[];
  hasReferences?: boolean;
  quotes?: (HistoryQuote | QuoteRef)[];
  /** The Host's attribution of a message it generated; absent when the user wrote it. */
  origin?: MessageOrigin;
  turnId?: string;
  timestamp?: number;
  timing?: HistoryTurnTiming;
  model?: HistoryModel;
  replyInfo?: AgentHistoryChunk['replyInfo'];
  finalOutput?: boolean;
  finalAnswer?: boolean;
  sourceCitation?: boolean;
  citation?: AgentHistoryChunk['citation'];
  citationAnchor?: AgentHistoryChunk['citationAnchor'];
  compaction?: HistoryCompaction;
  foldedWork?: AgentHistoryChunk['foldedWork'];
  work?: AgentHistoryChunk['work'];
  metadataThrough?: number | null;
  runId?: RunId;
  stepId?: StepId;
  attemptId?: ModelAttemptId;
  sequence?: number;
  startSequence?: number;
  modelPart?: { stepId: StepId; attemptId: ModelAttemptId; ordinal: number };
  preview?: { stepOrder: number; ordinal: number; revision: number };
  closedAt?: number | null;
};

/** Imported reply text has no native final-output marker. */
export function isReplyWithActions(
  row: Pick<Row, 'role' | 'field' | 'tool' | 'sourceCitation' | 'finalOutput' | 'position'>,
): boolean {
  return (
    row.role === 'assistant' &&
    row.field === 'body' &&
    !row.tool &&
    !row.sourceCitation &&
    (row.finalOutput === true || row.position?.kind === 'imported')
  );
}

export function modelPartRowId({ stepId, attemptId, ordinal }: NonNullable<Row['modelPart']>) {
  return `model/${stepId}/${attemptId}/${ordinal}`;
}

/** One identity across streaming fragments, canonical handoff and tool result pairing. */
export function stableRowId(
  row: Pick<Row, 'tool' | 'position' | 'modelPart' | 'messageId' | 'field' | 'work'>,
): string {
  if (row.work && row.position) return historyRowKey(row.position, 'work');
  if (row.tool?.call) return `tool/${row.tool.toolUseId}/${historyRowKey(row.tool.call.position)}`;
  if (row.position && row.position.kind !== 'live') return historyRowKey(row.position, row.field);
  if (row.modelPart && !row.tool) return modelPartRowId(row.modelPart);
  if (row.messageId !== undefined) return `${row.messageId}/${row.field}`;
  if (row.position) return historyRowKey(row.position, row.field);
  throw new Error('Transcript row has neither a source address nor a live message identity.');
}

export function recentMessages(rows: readonly Row[]) {
  const merged: { id: string; role: 'user' | 'assistant'; text: string }[] = [];
  for (const row of rows) {
    if (
      (row.role === 'user' || row.role === 'assistant') &&
      row.field === 'body' &&
      !row.origin &&
      row.text.trim().length > 0
    ) {
      const prev = merged.at(-1);
      const id = stableRowId(row);
      if (prev && prev.id === id) prev.text = row.text;
      else merged.push({ id, role: row.role, text: row.text });
    }
  }
  return merged.slice(-6);
}

export type DossierToolStep = {
  id: string;
  name: string;
  title?: Row['tool'] extends infer T
    ? T extends { call: infer C }
      ? C extends { title: infer D }
        ? D
        : null
      : null
    : null;
  presentation?: string | null;
  pending: boolean;
  failed: boolean;
};

export function dossierThreadActivity(rows: readonly Row[]): {
  steps: DossierToolStep[];
  active: boolean;
} {
  let start = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.role === 'user' && row.field === 'body' && !row.origin && row.text.trim().length > 0) {
      start = i + 1;
      break;
    }
  }
  const turnRows = rows.slice(Math.max(0, start - 1));
  const latest = historyTurnKey(turnRows.findLast((row) => historyTurnKey(row) !== undefined));
  const inLatestTurn = (row: Row) => latest === undefined || historyTurnKey(row) === latest;
  const finished = turnRows.some(
    (row) =>
      inLatestTurn(row) && (row.timing?.finished != null || row.finalOutput || row.finalAnswer),
  );
  const byId = new Map<string, DossierToolStep>();
  let active = false;
  for (let i = start; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (!inLatestTurn(row)) continue;
    if (row.work) {
      const live = row.position === undefined || row.position.kind === 'live';
      if (!finished && live && (row.timing?.finished === null || row.closedAt === null))
        active = true;
      continue;
    }
    const call = row.tool?.call;
    if (!call) continue;
    const result = row.tool?.result;
    const pending = !finished && Boolean(call.pending && !result);
    const failed = Boolean(result?.isError);
    if (pending) active = true;
    byId.set(row.tool!.toolUseId, {
      id: row.tool!.toolUseId,
      name: call.name,
      title: call.title,
      presentation: call.presentation ?? null,
      pending,
      failed,
    });
  }
  return { steps: [...byId.values()].slice(-4), active };
}

export function dossierThreadMessages(rows: readonly Row[]) {
  const merged: { id: string; role: 'user' | 'assistant'; text: string; at?: number }[] = [];
  for (const row of rows) {
    if (
      (row.role === 'user' || row.role === 'assistant') &&
      row.field === 'body' &&
      !row.origin &&
      row.text.trim().length > 0
    ) {
      const prev = merged.at(-1);
      const id = stableRowId(row);
      if (prev && prev.id === id) {
        prev.text = row.text;
        if (row.timestamp !== undefined) prev.at = row.timestamp;
      } else {
        merged.push({ id, role: row.role, text: row.text, at: row.timestamp });
      }
    }
  }
  return merged.slice(-40);
}

export function activityMessage(origin: MessageOrigin | null | undefined): boolean {
  return origin?.kind === 'automation' || senderSession(origin) !== null;
}

/** Expanded rows can come from a newer read than the surrounding window. */
export function historyRowThrough(
  row: Pick<Row, 'metadataThrough'>,
  windowThrough: number,
): number {
  return Math.max(row.metadataThrough ?? 0, windowThrough);
}

export function historyFollowTail(
  rows: readonly Row[],
  view: 'chat' | 'conversation' = 'chat',
): Row | undefined {
  if (view === 'conversation') return rows.at(-1);
  return rows.findLast(
    (row) =>
      Boolean(row.work) ||
      historyTurnKey(row) === undefined ||
      (!row.tool &&
        row.field !== 'thinking' &&
        (row.role === 'assistant' ||
          row.role === 'failure' ||
          row.role === 'compaction' ||
          (row.role === 'user' && !activityMessage(row.origin)))),
  );
}

export function senderSession(origin: MessageOrigin | null | undefined): string | null {
  if (origin?.kind === 'session') return origin.execution.sessionId;
  if (origin?.kind === 'room') return origin.sessionId;
  return origin?.kind === 'bot_worker' ||
    origin?.kind === 'discovery_report' ||
    origin?.kind === 'session_completion'
    ? origin.sessionId
    : null;
}

/** Closed native text can commit behind the loaded tail, at its message-start seat. */
export function historyFollowPosition(
  last: Row | undefined,
  live: readonly Row[],
  closedStarts: readonly number[] = [],
  windowStart?: number,
): HistoryPosition {
  let start: number | undefined;
  const consider = (sequence: number | undefined) => {
    if (sequence === undefined || (windowStart !== undefined && sequence < windowStart)) return;
    start = Math.min(start ?? sequence, sequence);
  };
  for (const row of live) if (!row.preview && row.closedAt != null) consider(row.startSequence);
  for (const sequence of closedStarts) consider(sequence);
  if (start !== undefined) return { kind: 'event', sequence: start };
  if (last?.work) return { kind: 'after', cursor: last.work.end };
  return last
    ? {
        kind: 'after',
        cursor: {
          position: last.position!,
          field: last.field as 'body' | 'thinking',
          offset: last.fragments!.at(-1)!.offset,
        },
      }
    : { kind: 'start' };
}

/** The opening user message, only when the loaded window proves the turn's start. */
export function openingUserMessage(
  rows: readonly Row[],
  turnKey: string | undefined,
  before: ConversationHistoryPage['before'] | undefined,
): Row | null {
  if (turnKey === undefined) return null;
  let precedingTurnLoaded = before === null;
  for (const row of rows) {
    if (historyTurnKey(row) !== undefined && historyTurnKey(row) !== turnKey)
      precedingTurnLoaded = true;
    if (row.role === 'user' && row.field === 'body' && historyTurnKey(row) === turnKey)
      return precedingTurnLoaded ? row : null;
  }
  return null;
}

/** Whether the user wrote this message, rather than the Host generating it (a scheduled execution). */
export function userAuthored(row: Row): boolean {
  return row.origin === undefined;
}

/** Whether replaying the displayed text retains all material in the original user input. */
export function canRegenerateFromText(row: Row): boolean {
  return (
    userAuthored(row) &&
    row.attachments !== undefined &&
    row.attachments.length === 0 &&
    row.hasReferences === false
  );
}

export function replayStartCursor(
  through: number,
  parts: readonly { startSequence: number }[],
  toolSeeds: readonly { startSequence: number }[],
): number {
  let after = through;
  for (const part of parts) after = Math.min(after, part.startSequence - 1);
  for (const tool of toolSeeds) after = Math.min(after, tool.startSequence - 1);
  return after;
}

// A send receipt and canonical history refer to the same user message.
export const messageKey = (row: Row) =>
  row.role === 'user' &&
  row.messageId !== undefined &&
  (row.position === undefined || row.position.kind === 'live')
    ? `user/${row.messageId}/${row.field}`
    : row.key;

export function messageBytes(text: string): number {
  let length = 0;
  for (const point of text) {
    const code = point.codePointAt(0)!;
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return length;
}

// History windows can contain tails or gaps; previews are assembled from byte zero.
export function hasTextPrefix(row: Row): boolean {
  if (!row.fragments) return row.prefix === true;
  let offset = 0;
  for (const fragment of row.fragments) {
    if (fragment.offset !== offset) return false;
    offset += messageBytes(fragment.text);
  }
  return row.fragments.length > 0 && row.totalBytes !== undefined && offset <= row.totalBytes;
}

export function historyMetadata(
  chunk: AgentHistoryChunk | Row,
  through: number | null,
  previous?: Row,
) {
  return {
    order: chunk.order,
    totalBytes: chunk.totalBytes,
    attachments:
      'offset' in chunk && chunk.offset === 0
        ? (chunk.attachments ?? [])
        : (previous?.attachments ?? chunk.attachments),
    quotes:
      'offset' in chunk && chunk.offset === 0
        ? (chunk.quotes ?? [])
        : (previous?.quotes ?? chunk.quotes),
    hasReferences:
      'offset' in chunk && chunk.offset === 0
        ? (chunk.hasReferences ?? false)
        : previous?.hasReferences,
    origin: chunk.origin ?? previous?.origin,
    importedTurn: chunk.importedTurn ?? undefined,
    timing: chunk.timing ?? undefined,
    replyInfo: chunk.replyInfo ?? undefined,
    model: chunk.model ?? undefined,
    modelPart: chunk.modelPart ?? undefined,
    runId: chunk.runId ?? undefined,
    stepId: chunk.modelPart?.stepId,
    attemptId: chunk.modelPart?.attemptId,
    finalOutput: chunk.finalOutput,
    finalAnswer: chunk.finalAnswer,
    sourceCitation: chunk.sourceCitation,
    citation: chunk.citation ?? previous?.citation,
    citationAnchor: chunk.citationAnchor ?? previous?.citationAnchor,
    compaction: chunk.compaction ?? undefined,
    foldedWork: chunk.foldedWork ?? previous?.foldedWork,
    work: chunk.work ?? undefined,
    tool: chunk.tool,
    metadataThrough: through,
  };
}

export function replaceHistoryMetadata(
  row: Row,
  chunk: AgentHistoryChunk,
  through: number | null,
): Row {
  if (through !== null && row.metadataThrough != null && through < row.metadataThrough) return row;
  const next = historyMetadata(chunk, through, row);
  // Metadata is Host JSON. Compare the complete projection so new fields are preserved.
  return row.metadataThrough === through &&
    JSON.stringify(historyMetadata(row, through, row)) === JSON.stringify(next)
    ? row
    : { ...row, ...next };
}

/** Apply a Host-bounded tailThought continuation update to the matching work summary row. */
export function applyWorkTailThought(
  row: Row,
  update: NonNullable<ConversationHistoryPage['tailThought']>,
): Row {
  if (!row.work) return row;
  const matchesEnd = sameHistoryRow(row.work.end.position, update.position);
  const matchesLast =
    row.work.lastThought != null && sameHistoryRow(row.work.lastThought.position, update.position);
  if (!matchesEnd && !matchesLast) return row;
  if (
    matchesLast &&
    row.work.lastThought!.offset >= update.offset &&
    row.work.lastThought!.text === update.text &&
    (!matchesEnd || row.work.end.offset >= update.offset)
  )
    return row;
  return {
    ...row,
    work: {
      ...row.work,
      end: matchesEnd
        ? { ...row.work.end, offset: Math.max(row.work.end.offset, update.offset) }
        : row.work.end,
      lastThought: {
        position: update.position,
        offset: Math.max(matchesLast ? row.work.lastThought!.offset : 0, update.offset),
        text: update.text,
      },
    },
  };
}

/** Return the next `after` cursor for an open steps window at tail, catching up stale thoughts before `window.last`. */
export function groupStepsFollowCursor(
  row: Pick<Row, 'work' | 'metadataThrough'>,
  window: {
    after: ConversationHistoryPage['after'];
    last: ConversationHistoryPage['after'];
    through: number;
  },
  through: number,
  lookup: (key: string) => Pick<Row, 'fragments' | 'totalBytes'> | undefined,
): NonNullable<ConversationHistoryPage['after']> | null {
  if (window.after !== null) return null;
  const thought = row.work?.lastThought;
  if (thought && window.through < through) {
    const loaded = lookup(historyRowKey(thought.position, 'thinking'));
    if (loaded) {
      const last = loaded.fragments?.at(-1);
      const covered = last ? last.offset + messageBytes(last.text) : (loaded.totalBytes ?? 0);
      if (covered < thought.offset)
        return { position: thought.position, field: 'thinking', offset: covered };
    }
  }
  return window.last && window.through < (row.metadataThrough ?? through) ? window.last : null;
}

// These are the Desktop transcript's position/fragment rules, independent of
// either renderer. History cursors use byte offsets; JS never derives them
// from UTF-16 string lengths.
export function historyChunkKey(chunk: AgentHistoryChunk): string {
  return historyRowKey(chunk.position, chunk.work ? 'work' : chunk.field);
}

export function compareRows(a: Row, b: Row): number {
  return (
    compareHistoryOrder(a.order!, b.order!) ||
    Number(!a.work) - Number(!b.work) ||
    Number(a.field === 'body') - Number(b.field === 'body')
  );
}

// Forward and reverse pages can split the same immutable field at different UTF-8 offsets.
function mergeFragments(
  previous: Fragment[] | undefined,
  fresh: Fragment,
  older: boolean,
  totalBytes: number,
): Fragment[] {
  if (
    !previous?.length ||
    (!older && fresh.offset === 0 && messageBytes(fresh.text) === totalBytes)
  )
    return [fresh];
  if (!fresh.text) return previous;
  if (previous.length === 1 && !previous[0].text) return [fresh];
  const last = previous[previous.length - 1];
  if (fresh.offset > last.offset && last.offset + messageBytes(last.text) <= fresh.offset)
    return [...previous, fresh];
  if (
    fresh.offset < previous[0].offset &&
    fresh.offset + messageBytes(fresh.text) <= previous[0].offset
  )
    return [fresh, ...previous];
  const ordered = older ? [...previous, fresh] : [fresh, ...previous];
  ordered.sort((a, b) => a.offset - b.offset);
  const parts: Fragment[] = [];
  let end = -1;
  for (const part of ordered) {
    if (part.offset >= end && part.offset !== parts.at(-1)?.offset) {
      parts.push(part);
      end = part.offset + messageBytes(part.text);
    } else {
      const bytes = Buffer.from(part.text, 'utf8');
      if (part.offset + bytes.length > end) {
        parts.push({ offset: end, text: bytes.toString('utf8', end - part.offset) });
        end = part.offset + bytes.length;
      }
    }
  }
  return parts;
}
export function mergeHistoryPage(
  chunks: AgentHistoryChunk[],
  lookup: (key: string) => Row | undefined,
  older: boolean,
  through: number | null,
): Row[] {
  const changed = new Map<string, Row>();
  for (const chunk of chunks) {
    const key = historyChunkKey(chunk);
    const previous = changed.get(key) ?? lookup(key);
    const previousThrough = previous?.metadataThrough;
    const newerMetadata =
      previous !== undefined &&
      previousThrough != null &&
      through !== null &&
      previousThrough > through;
    const fresh = { offset: chunk.offset, text: chunk.text };
    const fragments = mergeFragments(
      previous?.fragments,
      fresh,
      older || newerMetadata,
      chunk.totalBytes,
    );
    const next = {
      key,
      messageId: chunk.messageId ?? undefined,
      turnId: chunk.turnId ?? undefined,
      timestamp: chunk.timestamp ?? undefined,
      ...(newerMetadata
        ? {
            ...historyMetadata(previous, previousThrough, previous),
            citation: previous.citation ?? chunk.citation,
            citationAnchor: previous.citationAnchor ?? chunk.citationAnchor,
            ...(chunk.offset === 0 && previous.attachments === undefined
              ? { attachments: chunk.attachments ?? [] }
              : {}),
            ...(chunk.offset === 0 && previous.hasReferences === undefined
              ? { hasReferences: chunk.hasReferences ?? false }
              : {}),
          }
        : historyMetadata(chunk, through, previous)),
      position: chunk.position,
      field: chunk.field,
      role: chunk.role,
      fragments,
      text: fragments.map((part) => part.text).join(''),
    };
    if (
      previous?.metadataThrough === next.metadataThrough &&
      JSON.stringify(previous) === JSON.stringify(next)
    )
      continue;
    changed.set(key, next);
  }
  return [...changed.values()].sort(compareRows);
}

/** The window owns its source order and indexes. Insert pages in runs of new
 * rows so a prepend moves the existing array once and never reindexes it. */
export class HistoryRows {
  readonly ordered: Row[] = [];
  readonly byKey = new Map<string, Row>();
  readonly byId = new Map<string, Row>();
  readonly byMessage = new Map<string, Row>();
  readonly byTurn = new Map<string, Row[]>();
  readonly missingAttachments = new Set<string>();
  readonly senderIds = new Set<string>();
  readonly userRows = new Map<string, Row>();
  readonly #senderCounts = new Map<string, number>();
  readonly #byStableId = new Map<string, Row[]>();

  index(row: Row): number {
    let lo = 0;
    let hi = this.ordered.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareRows(this.ordered[mid], row) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  put(changed: Row[]) {
    const ordered = this.ordered;
    let pending: Row[] = [];
    let at = -1;
    const flush = () => {
      if (!pending.length) return;
      ordered.splice(at, 0, ...pending);
      pending = [];
    };
    const editedTurns = new Map<string, Row[]>();
    for (const row of changed) {
      const previous = this.byKey.get(row.key);
      let position = this.index(previous ?? row);
      if (pending.length && (position !== at || previous)) {
        flush();
        position = this.index(previous ?? row);
      }
      if (previous) ordered[position] = row;
      else {
        at = position;
        pending.push(row);
      }
      this.byKey.set(row.key, row);
      const stableId = stableRowId(row);
      if (previous && stableRowId(previous) !== stableId)
        this.indexStable(stableRowId(previous), previous);
      this.indexStable(stableId, row, row);
      if (row.messageId !== undefined && row.position?.kind === 'live') {
        const key = `${row.messageId}/${row.field}`;
        const first = this.byMessage.get(key);
        if (!first || first === previous || compareRows(row, first) < 0)
          this.byMessage.set(key, row);
      }
      const turnKey = historyTurnKey(row);
      if (turnKey !== undefined) {
        let turn = editedTurns.get(turnKey);
        if (!turn) {
          turn = [...(this.byTurn.get(turnKey) ?? [])];
          editedTurns.set(turnKey, turn);
        }
        const old = previous === undefined ? -1 : turn.indexOf(previous);
        if (old >= 0) turn[old] = row;
        else {
          const before = turn.findIndex((item) => compareRows(row, item) < 0);
          if (before < 0) turn.push(row);
          else turn.splice(before, 0, row);
        }
      }
      if (row.role === 'user' && row.field === 'body' && row.attachments === undefined)
        this.missingAttachments.add(row.key);
      else this.missingAttachments.delete(row.key);
      if (
        row.role === 'user' &&
        row.field === 'body' &&
        row.position &&
        row.fragments?.[0]?.offset === 0
      )
        this.userRows.set(historyRowKey(row.position), row);
      const before = senderSession(previous?.origin);
      const sender = senderSession(row.origin);
      if (before !== sender) {
        if (before !== null) {
          const count = this.#senderCounts.get(before)! - 1;
          if (count) this.#senderCounts.set(before, count);
          else {
            this.#senderCounts.delete(before);
            this.senderIds.delete(before);
          }
        }
        if (sender !== null) {
          this.#senderCounts.set(sender, (this.#senderCounts.get(sender) ?? 0) + 1);
          this.senderIds.add(sender);
        }
      }
    }
    flush();
    for (const [key, turn] of editedTurns) this.byTurn.set(key, turn);
  }

  private indexStable(id: string, changed: Row, next?: Row) {
    const seats = this.#byStableId.get(id) ?? [];
    const old = seats.findIndex((seat) => seat.key === changed.key);
    if (old >= 0) seats.splice(old, 1);
    if (next) {
      const after = seats.findIndex((seat) => compareRows(next, seat) < 0);
      if (after < 0) seats.push(next);
      else seats.splice(after, 0, next);
    }
    if (seats.length === 0) {
      this.#byStableId.delete(id);
      this.byId.delete(id);
      return;
    }
    this.#byStableId.set(id, seats);
    this.byId.set(id, seats.findLast((seat) => !seat.tool?.call || seat.tool.result) ?? seats[0]);
  }
}

export function acceptedSend(reply: any, sessionId: string): any | null {
  const receipt = reply?.receipt;
  if (receipt?.kind !== 'recorded' || receipt.outcome?.kind !== 'returned') return null;
  if (receipt.outcome.result?.kind !== 'success') return null;
  const result = receipt.outcome.result.value;
  if (result?.sessionId !== sessionId || typeof result.messageId !== 'string' || !result.messageId)
    return null;
  if (result.kind === 'started' && typeof result.runId === 'string' && result.runId) return result;
  if (result.kind === 'queued' && Number.isSafeInteger(result.revision) && result.revision >= 0)
    return result;
  return null;
}
