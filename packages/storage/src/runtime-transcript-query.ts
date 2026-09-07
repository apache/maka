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

/**
 * A Turn the Session transcript shows: one this Session ran itself rather than
 * on behalf of a subagent.
 *
 * This is a fact about the invocation, not about any row it produces — which
 * rows it produces is the read model's question, and is not asked here.
 */
const visibleOpening = (payload: string) => `
  (${payload} IS NOT NULL
    AND (json_extract(${payload}, '$.lineage.parentRunId') IS NULL
      OR (json_extract(${payload}, '$.source.kind') <> 'fresh'
        AND json_extract(${payload}, '$.lineage.agentId') IS NULL)))`;
/** Where an invocation ends; NULL while it is still running. */
const endingOrdinal = (invocation: string) => `
  (SELECT MIN(o2.ordinal) FROM runtime_events t
   JOIN runtime_session_event_ordinals o2 ON o2.event_id = t.event_id
   WHERE t.invocation_id = ${invocation}
     AND ${TERMINAL_RUNTIME_EVENT_SQL.replaceAll('payload_json', 't.payload_json')})`;
/**
 * A Session migrated from run headers keeps some openings beside the ledger
 * rather than in it, ordered by the anchor event each one names.
 */
const migratedOpening = `
  FROM runtime_legacy_invocation_openings legacy
  JOIN runtime_session_event_ordinals o ON o.event_id = legacy.anchor_event_id
  WHERE legacy.session_id = :sessionId
    AND ${visibleOpening('legacy.opening_json')}
    AND NOT EXISTS (
      SELECT 1 FROM runtime_events opened
      WHERE opened.invocation_id = legacy.invocation_id
        AND opened.event_kind = 'invocation_opened'
    )`;
const ledgerOpening = `
  FROM runtime_session_event_ordinals o
  JOIN runtime_events e ON e.event_id = o.event_id
  WHERE o.session_id = :sessionId
    AND e.event_kind = 'invocation_opened'
    AND ${visibleOpening("json_extract(e.payload_json, '$.content')")}`;
/** Either shelf's opening for one invocation, reached from an event it owns. */
const openingOrdinal = (invocation: string) => `
  COALESCE(
    (SELECT o3.ordinal FROM runtime_events op
     JOIN runtime_session_event_ordinals o3 ON o3.event_id = op.event_id
     WHERE op.invocation_id = ${invocation} AND op.event_kind = 'invocation_opened'),
    (SELECT o3.ordinal FROM runtime_legacy_invocation_openings lg
     JOIN runtime_session_event_ordinals o3 ON o3.event_id = lg.anchor_event_id
     WHERE lg.invocation_id = ${invocation}))`;
const openingContent = (invocation: string) => `
  COALESCE(
    (SELECT json_extract(op.payload_json, '$.content') FROM runtime_events op
     WHERE op.invocation_id = ${invocation} AND op.event_kind = 'invocation_opened'),
    (SELECT lg.opening_json FROM runtime_legacy_invocation_openings lg
     WHERE lg.invocation_id = ${invocation}))`;

type InvocationRow = { invocation_id: string; first: number; last: number };

/** Selects invocations by Session ordinal. Payloads are decoded, never classified. */
export class RuntimeTranscriptQuery {
  constructor(
    private readonly db: DatabaseSync,
    private readonly invocation: (
      sessionId: string,
      invocationId: string,
    ) => RuntimeInvocationRecord,
  ) {}

  highWater(sessionId: string): number | null {
    // The furthest a transcript reaches is the last ending on it.
    const [row] = this.byEnding(sessionId, {
      order: 'DESC',
      from: 0,
      throughOrdinal: Number.MAX_SAFE_INTEGER,
      limit: 1,
    });
    return row?.last ?? null;
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
    // starts inside a Turn still finds that Turn and can serve its rows. Both
    // ends are the invocation's own two events — its opening and its ending —
    // rather than the extremes of everything between them.
    //
    // Each direction walks the end of the Turn that `position` bounds, which
    // is the one the ordinal index can seek to: backward that is the opening,
    // forward the ending. Neither assumes Turns do not overlap, and each stops
    // at the page, so a page costs the page rather than the Session.
    const rows =
      request.direction === 'older'
        ? this.byOpening(sessionId, request)
        : this.byEnding(sessionId, {
            order: 'ASC',
            from: request.position,
            throughOrdinal: request.throughOrdinal,
            limit: request.limit,
          }).sort((a, b) => a.first - b.first);
    return rows.map((row) => ({
      invocation: this.invocation(sessionId, row.invocation_id),
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
      WITH settled AS (
        SELECT e.invocation_id AS invocation_id, o.ordinal AS ordinal ${ledgerOpening}
          AND ${endingOrdinal('e.invocation_id')} <= :throughOrdinal
        UNION ALL
        SELECT legacy.invocation_id, o.ordinal ${migratedOpening}
          AND ${endingOrdinal('legacy.invocation_id')} <= :throughOrdinal
      ), candidates AS (
        SELECT invocation_id, ordinal,
          ROW_NUMBER() OVER (ORDER BY ordinal) - 1 AS rank, COUNT(*) OVER () AS total
        FROM settled
      ), samples(n) AS (
        SELECT 0 UNION ALL SELECT n + 1 FROM samples WHERE n + 1 < :limit
      )
      SELECT DISTINCT invocation_id, ordinal FROM candidates
      JOIN samples ON rank = CASE WHEN :limit = 1 THEN total - 1
        ELSE CAST(n * (total - 1) / (:limit - 1) AS INTEGER) END
      ORDER BY ordinal
    `)
      .all({ sessionId, throughOrdinal, limit }) as Array<{
      invocation_id: string;
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
        invocation: this.invocation(sessionId, row.invocation_id),
        firstOrdinal: row.ordinal,
        ...(prompt
          ? { prompt: { ordinal: prompt.ordinal, event: this.event(prompt.event_id) } }
          : {}),
      };
    });
  }

  /**
   * The page of settled visible invocations that opened at or before
   * `position`, newest first.
   *
   * The two shelves are read as separate statements and merged rather than
   * unioned, so each keeps its own index walk and stops at the page — and the
   * common Session pays nothing for a table its history never wrote to.
   */
  private byOpening(
    sessionId: string,
    request: RuntimeTranscriptInvocationRequest,
  ): InvocationRow[] {
    const bind = {
      sessionId,
      position: request.position,
      throughOrdinal: request.throughOrdinal,
      limit: request.limit,
    };
    const ledger = this.db
      .prepare(`
      SELECT e.invocation_id AS invocation_id, o.ordinal AS first,
        ${endingOrdinal('e.invocation_id')} AS last
      ${ledgerOpening}
        AND o.ordinal <= :position
        AND ${endingOrdinal('e.invocation_id')} <= :throughOrdinal
      ORDER BY o.ordinal DESC
      LIMIT :limit
    `)
      .all(bind) as InvocationRow[];
    const migrated = this.db
      .prepare(`
      SELECT legacy.invocation_id AS invocation_id, o.ordinal AS first,
        ${endingOrdinal('legacy.invocation_id')} AS last
      ${migratedOpening}
        AND o.ordinal <= :position
        AND ${endingOrdinal('legacy.invocation_id')} <= :throughOrdinal
      ORDER BY o.ordinal DESC
      LIMIT :limit
    `)
      .all(bind) as InvocationRow[];
    if (migrated.length === 0) return ledger;
    return [...ledger, ...migrated].sort((a, b) => b.first - a.first).slice(0, request.limit);
  }

  /**
   * The page of settled visible invocations whose ending sits between `from`
   * and `throughOrdinal`, in `order` of that ending.
   *
   * An ending is an event of the invocation like any other, so this walks the
   * same ordinal index — one statement, because the ending is on the ledger
   * whichever shelf the opening came from.
   */
  private byEnding(
    sessionId: string,
    bounds: { order: 'ASC' | 'DESC'; from: number; throughOrdinal: number; limit: number },
  ): InvocationRow[] {
    return this.db
      .prepare(`
      SELECT ending.invocation_id AS invocation_id,
        ${openingOrdinal('ending.invocation_id')} AS first,
        o.ordinal AS last
      FROM runtime_session_event_ordinals o
      JOIN runtime_events ending ON ending.event_id = o.event_id
      WHERE o.session_id = :sessionId
        AND o.ordinal BETWEEN :from AND :throughOrdinal
        AND ${TERMINAL_RUNTIME_EVENT_SQL.replaceAll('payload_json', 'ending.payload_json')}
        AND o.ordinal = ${endingOrdinal('ending.invocation_id')}
        AND ${visibleOpening(openingContent('ending.invocation_id'))}
      ORDER BY o.ordinal ${bounds.order}
      LIMIT :limit
    `)
      .all({
        sessionId,
        from: bounds.from,
        throughOrdinal: bounds.throughOrdinal,
        limit: bounds.limit,
      }) as InvocationRow[];
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
