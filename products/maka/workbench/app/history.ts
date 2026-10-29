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
  AgentHistoryAttachment,
  AgentHistoryPage,
  HistoryCompaction,
  HistoryModel,
  HistoryTurnTiming,
} from '../../../../packages/plugin-sdk/src/index.js';

export type Position = { sourceSequence: number; itemIndex: number };
type Fragment = { offset: number; text: string };
export type Subscription = {
  next(): Promise<any | null>;
  close(): Promise<void>;
};
export type Row = {
  key: string;
  messageId: string;
  field: string;
  role: string;
  text: string;
  position?: Position;
  fragments?: Fragment[];
  totalBytes?: number;
  tool?: any;
  attachments?: AgentHistoryAttachment[];
  hasReferences?: boolean;
  turnId?: string;
  timestamp?: number;
  timing?: HistoryTurnTiming;
  model?: HistoryModel;
  finalOutput?: boolean;
  compaction?: HistoryCompaction;
  metadataThrough?: number;
  invocationId?: string;
  stepId?: string;
  sequence?: number;
  startSequence?: number;
  closedAt?: number | null;
};

/** The opening user message, only when the loaded window proves the turn's start. */
export function openingUserMessage(
  rows: readonly Row[],
  turnId: string | undefined,
  before: AgentHistoryPage['before'] | undefined,
): Row | null {
  if (turnId === undefined) return null;
  let precedingTurnLoaded = before === null;
  for (const row of rows) {
    if (row.turnId !== undefined && row.turnId !== turnId) precedingTurnLoaded = true;
    if (row.role === 'user' && row.field === 'body' && row.turnId === turnId)
      return precedingTurnLoaded ? row : null;
  }
  return null;
}

/** Whether replaying the displayed text retains all material in the original user input. */
export function canRegenerateFromText(row: Row): boolean {
  return (
    row.attachments !== undefined && row.attachments.length === 0 && row.hasReferences === false
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
  row.role === 'user' ? `user/${row.messageId}/${row.field}` : row.key;

export function messageBytes(text: string): number {
  let length = 0;
  for (const point of text) {
    const code = point.codePointAt(0)!;
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return length;
}

// A live part starts at its original opening. A history window may instead
// contain only a tail or separated fragments, without Markdown's opening context.
export function hasCompletePrefix(row: Row): boolean {
  if (!row.fragments) return row.startSequence !== undefined && row.sequence !== undefined;
  let offset = 0;
  for (const fragment of row.fragments) {
    if (fragment.offset !== offset) return false;
    offset += messageBytes(fragment.text);
  }
  return row.fragments.length > 0 && row.totalBytes !== undefined && offset <= row.totalBytes;
}

export function historyMetadata(chunk: any, through: number, previous?: Row) {
  return {
    totalBytes: chunk.totalBytes,
    attachments:
      chunk.offset === 0 ? (chunk.attachments ?? []) : (previous?.attachments ?? chunk.attachments),
    hasReferences: chunk.offset === 0 ? (chunk.hasReferences ?? false) : previous?.hasReferences,
    timing: chunk.timing,
    model: chunk.model,
    finalOutput: chunk.finalOutput,
    compaction: chunk.compaction,
    tool: chunk.tool,
    metadataThrough: through,
  };
}

export function updateHistoryMetadata(rows: Row[], chunks: any[], through: number): Row[] {
  if (chunks.length === 0) return rows;
  const metadata = new Map(
    chunks.map((chunk) => [
      `${chunk.position.sourceSequence}/${chunk.position.itemIndex}/${chunk.field}`,
      chunk,
    ]),
  );
  let updated = rows;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const chunk = metadata.get(row.key);
    if (!chunk || through < (row.metadataThrough ?? 0)) continue;
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
export function mergeChunks(rows: Row[], chunks: any[], older = false, through = 0): Row[] {
  if (chunks.length === 0) return rows;
  const merged = new Map(rows.map((row) => [row.key, row]));
  let changed = false;
  for (const chunk of chunks) {
    const key = `${chunk.position.sourceSequence}/${chunk.position.itemIndex}/${chunk.field}`;
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
      messageId: chunk.messageId,
      turnId: chunk.turnId,
      timestamp: chunk.timestamp,
      ...((previous?.metadataThrough ?? -1) > through
        ? historyMetadata(previous, previous!.metadataThrough!, previous)
        : historyMetadata(chunk, through, previous)),
      position: chunk.position,
      field: chunk.field,
      role: chunk.field === 'thinking' ? 'thinking' : chunk.role,
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
      a.position!.sourceSequence - b.position!.sourceSequence ||
      a.position!.itemIndex - b.position!.itemIndex ||
      Number(a.field === 'body') - Number(b.field === 'body'),
  );
}

export function acceptedSend(reply: any, sessionId: string): any | null {
  const receipt = reply?.receipt;
  if (receipt?.kind !== 'recorded' || receipt.outcome?.kind !== 'returned') return null;
  const result = receipt.outcome.value;
  if (result?.sessionId !== sessionId || typeof result.messageId !== 'string' || !result.messageId)
    return null;
  if (result.kind === 'started' && typeof result.invocationId === 'string' && result.invocationId)
    return result;
  if (result.kind === 'queued' && Number.isSafeInteger(result.revision) && result.revision >= 0)
    return result;
  return null;
}
