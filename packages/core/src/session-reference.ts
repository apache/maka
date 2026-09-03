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

import type { QuoteRef } from './events.js';
import { redactSecrets } from './redaction.js';
import type { StoredMessage } from './session.js';
import { userFacingText } from './session.js';

/** Default per-reference budget. It is deliberately small enough to leave room for the active task. */
export const SESSION_SNAPSHOT_DEFAULT_MAX_CHARS = 12_000;
export const SESSION_SNAPSHOT_MAX_CHARS = 32_000;
export const SESSION_SNAPSHOT_MAX_ITEMS = 24;

export interface SessionSnapshotReference {
  sessionId: string;
  sessionName: string;
  capturedAt: number;
}

export interface SessionSnapshotItem {
  role: 'user' | 'assistant';
  text: string;
  turnId: string;
  ts: number;
}

export interface SessionSnapshot {
  reference: SessionSnapshotReference;
  items: readonly SessionSnapshotItem[];
  text: string;
  estimatedTokens: number;
  maxChars: number;
  truncated: boolean;
}

export interface SessionSnapshotOptions {
  sessionId: string;
  sessionName: string;
  capturedAt?: number;
  maxChars?: number;
  maxItems?: number;
}

/**
 * Build the model-safe portion of a Session transcript.
 *
 * Only user and assistant text is shareable. Tool calls/results, permission
 * events, system notes, and other Runtime records remain outside this
 * projection. Items are selected from the tail, then restored to transcript
 * order so a large history cannot crowd the current request unexpectedly.
 */
export function createSessionSnapshot(
  messages: readonly StoredMessage[],
  options: SessionSnapshotOptions,
): SessionSnapshot {
  const maxChars = clampPositiveInteger(
    options.maxChars ?? SESSION_SNAPSHOT_DEFAULT_MAX_CHARS,
    1,
    SESSION_SNAPSHOT_MAX_CHARS,
  );
  const maxItems = clampPositiveInteger(
    options.maxItems ?? SESSION_SNAPSHOT_MAX_ITEMS,
    1,
    SESSION_SNAPSHOT_MAX_ITEMS,
  );
  const candidates: SessionSnapshotItem[] = messages.flatMap((message) => {
    if (message.type !== 'user' && message.type !== 'assistant') return [];
    const text = message.type === 'user' ? userFacingText(message) : message.text;
    const normalized = redactSecrets(text).trim();
    if (!normalized) return [];
    return [
      {
        role: message.type,
        text: normalized,
        turnId: message.turnId,
        ts: message.ts,
      },
    ];
  });

  const selected: SessionSnapshotItem[] = [];
  let usedChars = 0;
  let truncated = false;
  for (let index = candidates.length - 1; index >= 0 && selected.length < maxItems; index -= 1) {
    const candidate = candidates[index]!;
    const line = formatSnapshotItem(candidate);
    const separator = selected.length > 0 ? 2 : 0;
    const available = maxChars - usedChars - separator;
    if (available <= 0) {
      truncated = true;
      break;
    }
    if (line.length <= available) {
      selected.push(candidate);
      usedChars += separator + line.length;
      continue;
    }
    if (selected.length === 0) {
      const prefixLength = formatSnapshotItem({ ...candidate, text: '' }).length;
      const contentBudget = Math.max(0, available - prefixLength);
      if (contentBudget > 0) {
        const text = sliceAtCodePointBoundary(candidate.text, contentBudget).trimEnd();
        if (!text) {
          truncated = true;
          break;
        }
        selected.push({
          ...candidate,
          text,
        });
        usedChars = maxChars;
      }
    }
    truncated = true;
    break;
  }
  if (selected.length < candidates.length) truncated = true;
  selected.reverse();

  const text = sliceAtCodePointBoundary(selected.map(formatSnapshotItem).join('\n\n'), maxChars);
  return {
    reference: {
      sessionId: options.sessionId,
      sessionName: options.sessionName,
      capturedAt: options.capturedAt ?? Date.now(),
    },
    items: selected,
    text,
    estimatedTokens: Math.ceil(text.length / 4),
    maxChars,
    truncated,
  };
}

/** Convert a snapshot into the existing inline quote transport. */
export function sessionSnapshotToQuote(snapshot: SessionSnapshot): QuoteRef {
  return {
    text: snapshot.text,
    label: `Session: ${snapshot.reference.sessionName}`,
    sourceSessionId: snapshot.reference.sessionId,
    sourceSessionName: snapshot.reference.sessionName,
    sourceCapturedAt: snapshot.reference.capturedAt,
    sourceTruncated: snapshot.truncated,
  };
}

function formatSnapshotItem(item: Pick<SessionSnapshotItem, 'role' | 'text'>): string {
  return `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text}`;
}

/** Keep a UTF-16 slice from ending between the halves of a surrogate pair. */
function sliceAtCodePointBoundary(value: string, maxCodeUnits: number): string {
  const sliced = value.slice(0, maxCodeUnits);
  const last = sliced.charCodeAt(sliced.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? sliced.slice(0, -1) : sliced;
}

function clampPositiveInteger(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value)) return min;
  return Math.max(min, Math.min(max, value));
}
