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

import type { DatabaseSync } from 'node:sqlite';
import { decodeRuntimeEvent, type RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';

/** SQL counterpart of isTerminalRuntimeEvent; shared with the ledger store. */
export const TERMINAL_RUNTIME_EVENT_SQL = `(
  json_extract(payload_json, '$.actions.endInvocation') = 1
  OR json_extract(payload_json, '$.status') IN ('completed', 'failed', 'aborted', 'cancelled')
)`;

/**
 * One invocation's events, in ledger order, carrying the Session ordinal each
 * one sits at.
 *
 * The transcript rows of a Turn come from projecting these together: what a
 * RuntimeEvent becomes is decided by the read model alone, so nothing here
 * classifies an event or decides whether it produces a row.
 */
export interface RuntimeTranscriptInvocation {
  readonly invocation: RuntimeInvocationRecord;
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
  readonly events: readonly { readonly ordinal: number; readonly event: RuntimeEvent }[];
}

/** An invocation start, with the prompt event a landmark is labelled by. */
export interface RuntimeTranscriptLandmark {
  readonly invocation: RuntimeInvocationRecord;
  readonly firstOrdinal: number;
  readonly prompt?: { readonly ordinal: number; readonly event: RuntimeEvent };
}

export interface RuntimeTranscriptInvocationRequest {
  readonly direction: 'older' | 'newer';
  readonly throughOrdinal: number;
  /** Ordinal the walk starts from, inclusive, in `direction`. */
  readonly position: number;
  readonly limit: number;
  /** Refused rather than truncated: half a Turn projects to a wrong transcript. */
  readonly maxEvents: number;
  readonly maxBytes: number;
}

export interface RuntimeTranscriptQueries {
  readTranscriptHighWater(sessionId: string): Promise<number | null>;
  readTranscriptInvocations(
    sessionId: string,
    request: RuntimeTranscriptInvocationRequest,
  ): Promise<RuntimeTranscriptInvocation[]>;
  readTranscriptLandmarks(
    sessionId: string,
    throughOrdinal: number,
    limit: number,
  ): Promise<RuntimeTranscriptLandmark[]>;
}

export class RuntimeTranscriptOversizedTurnError extends Error {
  readonly name = 'RuntimeTranscriptOversizedTurnError';
}

const joins = `
  FROM runtime_session_event_ordinals o
  JOIN runtime_events e ON e.event_id = o.event_id
  LEFT JOIN runtime_events opened ON opened.invocation_id = e.invocation_id AND opened.event_kind = 'invocation_opened'
  LEFT JOIN runtime_legacy_invocation_openings legacy ON legacy.invocation_id = e.invocation_id`;
const opening = `COALESCE(json_extract(opened.payload_json, '$.content'), legacy.opening_json)`;
/**
 * A Turn the Session transcript shows: one this Session ran itself rather than
 * on behalf of a subagent, and one that has already ended.
 *
 * This is a fact about the invocation, not about any row it produces — which
 * rows it produces is the read model's question, and is not asked here.
 */
const settledInline = `
  ${opening} IS NOT NULL
  AND (json_extract(${opening}, '$.lineage.parentRunId') IS NULL
    OR (json_extract(${opening}, '$.source.kind') = 'continuation'
      AND json_extract(${opening}, '$.lineage.agentId') IS NULL))
  AND EXISTS (
    SELECT 1 FROM runtime_events ended
    JOIN runtime_session_event_ordinals ending ON ending.event_id = ended.event_id
    WHERE ended.invocation_id = e.invocation_id
      AND ${TERMINAL_RUNTIME_EVENT_SQL.replaceAll('payload_json', 'ended.payload_json')}
      AND ending.ordinal <= :throughOrdinal
  )`;

type InvocationRow = { invocation_id: string; run_id: string; first: number; last: number };

/** Selects invocations by Session ordinal. Payloads are decoded, never classified. */
export class RuntimeTranscriptQuery {
  constructor(
    private readonly db: DatabaseSync,
    private readonly invocation: (sessionId: string, runId: string) => RuntimeInvocationRecord,
  ) {}

  highWater(sessionId: string): number | null {
    const row = this.db
      .prepare(`
      SELECT MAX(o.ordinal) AS ordinal ${joins}
      WHERE o.session_id = :sessionId AND o.ordinal <= :throughOrdinal AND ${settledInline}
    `)
      .get({ sessionId, throughOrdinal: Number.MAX_SAFE_INTEGER }) as { ordinal?: unknown };
    return typeof row.ordinal === 'number' ? row.ordinal : null;
  }

  invocations(
    sessionId: string,
    request: RuntimeTranscriptInvocationRequest,
  ): RuntimeTranscriptInvocation[] {
    assertOrdinal(request.throughOrdinal);
    assertOrdinal(request.position);
    if (request.direction !== 'older' && request.direction !== 'newer') {
      throw new Error('Invalid transcript direction');
    }
    // An invocation is selected by where its own events sit, so a walk that
    // starts inside a Turn still finds that Turn and can serve its rows.
    const rows = this.db
      .prepare(`
      SELECT e.invocation_id, e.run_id, MIN(o.ordinal) AS first, MAX(o.ordinal) AS last ${joins}
      WHERE o.session_id = :sessionId AND o.ordinal <= :throughOrdinal AND ${settledInline}
      GROUP BY e.invocation_id
      HAVING ${request.direction === 'older' ? 'first <= :position' : 'last >= :position'}
      ORDER BY first ${request.direction === 'older' ? 'DESC' : 'ASC'}
      LIMIT :limit
    `)
      .all({
        sessionId,
        throughOrdinal: request.throughOrdinal,
        position: request.position,
        limit: request.limit,
      }) as InvocationRow[];
    return rows.map((row) => ({
      invocation: this.invocation(sessionId, row.run_id),
      firstOrdinal: row.first,
      lastOrdinal: row.last,
      events: this.events(row.invocation_id, request),
    }));
  }

  landmarks(sessionId: string, throughOrdinal: number, limit: number): RuntimeTranscriptLandmark[] {
    assertOrdinal(throughOrdinal);
    if (limit < 1) return [];
    // Evenly spaced Turn starts, chosen before any payload is read.
    const rows = this.db
      .prepare(`
      WITH candidates AS (
        SELECT e.invocation_id, e.run_id, o.ordinal,
          ROW_NUMBER() OVER (ORDER BY o.ordinal) - 1 AS rank, COUNT(*) OVER () AS total
        ${joins} WHERE o.session_id = :sessionId AND o.ordinal <= :throughOrdinal
          AND e.event_seq = 1 AND ${settledInline}
      ), samples(n) AS (
        SELECT 0 UNION ALL SELECT n + 1 FROM samples WHERE n + 1 < :limit
      )
      SELECT DISTINCT invocation_id, run_id, ordinal FROM candidates
      JOIN samples ON rank = CASE WHEN :limit = 1 THEN total - 1
        ELSE CAST(n * (total - 1) / (:limit - 1) AS INTEGER) END
      ORDER BY ordinal
    `)
      .all({ sessionId, throughOrdinal, limit }) as Array<{
      invocation_id: string;
      run_id: string;
      ordinal: number;
    }>;
    return rows.map((row) => {
      // The prompt is the Turn's first user text event, which is what the read
      // model projects a user message from. Only that one event is loaded: a
      // landmark is a label, and projecting whole Turns to build a scrollbar
      // would read most of the Session.
      const prompt = this.db
        .prepare(`
        SELECT o.ordinal, e.event_id FROM runtime_events e
        JOIN runtime_session_event_ordinals o ON o.event_id = e.event_id
        WHERE e.invocation_id = ? AND o.ordinal <= ?
          AND e.event_kind = 'text' AND json_extract(e.payload_json, '$.role') = 'user'
        ORDER BY e.event_seq LIMIT 1
      `)
        .get(row.invocation_id, throughOrdinal) as
        | { ordinal: number; event_id: string }
        | undefined;
      return {
        invocation: this.invocation(sessionId, row.run_id),
        firstOrdinal: row.ordinal,
        ...(prompt
          ? { prompt: { ordinal: prompt.ordinal, event: this.event(prompt.event_id) } }
          : {}),
      };
    });
  }

  private events(
    invocationId: string,
    limits: { maxEvents: number; maxBytes: number },
  ): RuntimeTranscriptInvocation['events'] {
    // Walked row by row: the limits cap what one Turn may pull into memory, so
    // a check after `.all()` has already paid the cost it was meant to refuse.
    const cursor = this.db
      .prepare(`
      SELECT o.ordinal, e.event_id, e.session_id, e.invocation_id, e.run_id, e.turn_id, e.payload_json
      FROM runtime_events e JOIN runtime_session_event_ordinals o ON o.event_id = e.event_id
      WHERE e.invocation_id = ? ORDER BY e.event_seq
    `)
      .iterate(invocationId) as Iterable<StoredEventRow & { ordinal: number }>;
    const events: Array<RuntimeTranscriptInvocation['events'][number]> = [];
    let bytes = 0;
    for (const row of cursor) {
      if (events.length === limits.maxEvents) {
        throw new RuntimeTranscriptOversizedTurnError(
          `Turn ${invocationId} holds more RuntimeEvents than a transcript page may read`,
        );
      }
      bytes += Buffer.byteLength(row.payload_json);
      if (bytes > limits.maxBytes) {
        throw new RuntimeTranscriptOversizedTurnError(
          `Turn ${invocationId} holds more RuntimeEvent bytes than a transcript page may read`,
        );
      }
      events.push({ ordinal: row.ordinal, event: decodeStoredEvent(row) });
    }
    return events;
  }

  private event(id: string): RuntimeEvent {
    const row = this.db
      .prepare(
        'SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json FROM runtime_events WHERE event_id = ?',
      )
      .get(id) as StoredEventRow | undefined;
    if (!row) throw new Error(`Transcript RuntimeEvent ${id} is missing`);
    return decodeStoredEvent(row);
  }
}

type StoredEventRow = {
  event_id: string;
  session_id: string;
  invocation_id: string;
  run_id: string;
  turn_id: string;
  payload_json: string;
};

function decodeStoredEvent(row: StoredEventRow): RuntimeEvent {
  const event = decodeRuntimeEvent(JSON.parse(row.payload_json));
  if (
    event.id !== row.event_id ||
    event.sessionId !== row.session_id ||
    event.invocationId !== row.invocation_id ||
    event.runId !== row.run_id ||
    event.turnId !== row.turn_id
  ) {
    throw new Error(`Transcript RuntimeEvent ${row.event_id} has inconsistent storage identity`);
  }
  return event;
}

function assertOrdinal(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid transcript event ordinal');
}
