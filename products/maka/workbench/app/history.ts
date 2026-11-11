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
} from '../../../../packages/plugin-sdk/src/index.js';

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

/** Prepare the latest turn before exposing its first history window. */
export async function readHistoryTail(
  page: AgentHistoryPage,
  readOlder: (cursor: NonNullable<AgentHistoryPage['before']>) => Promise<AgentHistoryPage | null>,
): Promise<AgentHistoryPage | null> {
  const chunks = [...page.chunks];
  const turnKey = historyTurnKey(chunks.at(-1));
  let before = page.before;
  for (let olderPages = 0; olderPages < 8 && before !== null && turnKey !== undefined; ) {
    if (
      chunks.some(
        (chunk) =>
          chunk.role === 'user' &&
          chunk.field === 'body' &&
          chunk.offset === 0 &&
          historyTurnKey(chunk) === turnKey,
      )
    )
      break;
    const older = await readOlder(before);
    if (older === null) return null;
    chunks.unshift(...older.chunks);
    before = older.before;
    if (older.chunks.length) olderPages++;
  }
  return { ...page, chunks, before };
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
  /** The Host's attribution of a message it generated; absent when the user wrote it. */
  origin?: MessageOrigin;
  turnId?: string;
  timestamp?: number;
  timing?: HistoryTurnTiming;
  model?: HistoryModel;
  finalOutput?: boolean;
  compaction?: HistoryCompaction;
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

export function modelPartRowId({ stepId, attemptId, ordinal }: NonNullable<Row['modelPart']>) {
  return `model/${stepId}/${attemptId}/${ordinal}`;
}

/** One identity across streaming fragments, canonical handoff and tool result pairing. */
export function stableRowId(
  row: Pick<Row, 'tool' | 'position' | 'modelPart' | 'messageId' | 'field'>,
): string {
  if (row.tool?.call) return `tool/${row.tool.toolUseId}/${historyRowKey(row.tool.call.position)}`;
  if (row.position && row.position.kind !== 'live') return historyRowKey(row.position, row.field);
  if (row.modelPart && !row.tool) return modelPartRowId(row.modelPart);
  if (row.messageId !== undefined) return `${row.messageId}/${row.field}`;
  if (row.position) return historyRowKey(row.position, row.field);
  throw new Error('Transcript row has neither a source address nor a live message identity.');
}

export function senderSession(origin: MessageOrigin | null | undefined): string | null {
  if (origin?.kind === 'session') return origin.execution.sessionId;
  // A Bot Turn started because a worker finished names that worker.
  return origin?.kind === 'bot_worker' || origin?.kind === 'session_completion'
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
  before: AgentHistoryPage['before'] | undefined,
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
    hasReferences:
      'offset' in chunk && chunk.offset === 0
        ? (chunk.hasReferences ?? false)
        : previous?.hasReferences,
    origin: chunk.origin ?? previous?.origin,
    importedTurn: chunk.importedTurn ?? undefined,
    timing: chunk.timing ?? undefined,
    model: chunk.model ?? undefined,
    modelPart: chunk.modelPart ?? undefined,
    runId: chunk.runId ?? undefined,
    stepId: chunk.modelPart?.stepId,
    attemptId: chunk.modelPart?.attemptId,
    finalOutput: chunk.finalOutput,
    compaction: chunk.compaction ?? undefined,
    tool: chunk.tool,
    metadataThrough: through,
  };
}

export function updateHistoryMetadata(
  rows: Row[],
  chunks: AgentHistoryChunk[],
  through: number | null,
): Row[] {
  if (chunks.length === 0) return rows;
  const metadata = new Map(
    chunks.map((chunk) => [historyRowKey(chunk.position, chunk.field), chunk]),
  );
  let updated = rows;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const chunk = metadata.get(row.key);
    if (
      !chunk ||
      (through !== null && row.metadataThrough != null && through < row.metadataThrough)
    )
      continue;
    const next = historyMetadata(chunk, through, row);
    // Metadata is Host JSON. Compare its complete projection so new fields are
    // not silently ignored by a display-specific list of equality checks.
    if (
      row.metadataThrough === through &&
      JSON.stringify(historyMetadata(row, through, row)) === JSON.stringify(next)
    )
      continue;
    if (updated === rows) updated = rows.slice();
    updated[index] = { ...row, ...next };
  }
  return updated;
}

// These are the Desktop transcript's position/fragment rules, independent of
// either renderer. History cursors use byte offsets; JS never derives them
// from UTF-16 string lengths.
export function mergeChunks(
  rows: Row[],
  chunks: AgentHistoryChunk[],
  older = false,
  through: number | null = null,
): Row[] {
  if (chunks.length === 0) return rows;
  const merged = new Map(rows.map((row) => [row.key, row]));
  let changed = false;
  for (const chunk of chunks) {
    const key = historyRowKey(chunk.position, chunk.field);
    const previous = merged.get(key);
    const fresh = { offset: chunk.offset, text: chunk.text };
    const fragments = (
      older && previous
        ? [
            ...previous.fragments!,
            ...(previous.fragments!.some((part) => part.offset === chunk.offset) ? [] : [fresh]),
          ]
        : [...(previous?.fragments ?? []).filter((part) => part.offset !== chunk.offset), fresh]
    ).sort((a, b) => a.offset - b.offset);
    const next = {
      key,
      messageId: chunk.messageId ?? undefined,
      turnId: chunk.turnId ?? undefined,
      timestamp: chunk.timestamp ?? undefined,
      ...(previous?.metadataThrough != null &&
      through !== null &&
      previous.metadataThrough > through
        ? historyMetadata(previous, previous!.metadataThrough!, previous)
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
    merged.set(key, next);
    changed = true;
  }
  if (!changed) return rows;
  return [...merged.values()].sort(
    (a, b) =>
      compareHistoryOrder(a.order!, b.order!) ||
      Number(a.field === 'body') - Number(b.field === 'body'),
  );
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
