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

/**
 * SQL counterpart of isTerminalRuntimeEvent; shared with the ledger store.
 *
 * The `json_valid` guard is what keeps this usable as a partial index: SQLite
 * evaluates the index predicate over every row while building it, and
 * `json_extract` on a malformed payload fails the whole statement. That would
 * abort the migration that creates the index, roll back its version bump, and
 * leave the next open to try — and fail — again.
 */
export const TERMINAL_RUNTIME_EVENT_SQL = `(
  json_valid(payload_json)
  AND (
    json_extract(payload_json, '$.actions.endInvocation') = 1
    OR json_extract(payload_json, '$.status') IN ('completed', 'failed', 'aborted', 'cancelled')
  )
)`;

/**
 * One unbroken stretch of Session ordinals owned by a single invocation.
 *
 * No other invocation has an event between `firstOrdinal` and `lastOrdinal`,
 * so this invocation is the only one that can produce a row there. A Turn
 * interleaved with another owns several runs rather than one.
 *
 * The transcript rows come from projecting the invocation's events together:
 * what a RuntimeEvent becomes is decided by the read model alone, so nothing
 * here classifies an event or decides whether it produces a row.
 */
export interface RuntimeTranscriptRun {
  readonly invocation: RuntimeInvocationRecord;
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
}

/** An invocation start, with the prompt event a landmark is labelled by. */
export interface RuntimeTranscriptLandmark {
  readonly invocation: RuntimeInvocationRecord;
  readonly firstOrdinal: number;
  readonly prompt?: { readonly ordinal: number; readonly event: RuntimeEvent };
}

export interface RuntimeTranscriptRunRequest {
  readonly direction: 'older' | 'newer';
  readonly throughOrdinal: number;
  /** Ordinal the walk starts from, inclusive, in `direction`. */
  readonly position: number;
  /** Refused rather than truncated: half a Turn projects to a wrong transcript. */
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly maxRecordBytes: number;
}

export interface RuntimeTranscriptQueries {
  readTranscriptHighWater(sessionId: string): Promise<number | null>;
  /**
   * The run the walk reaches from `position`, or `undefined` past the end.
   *
   * A caller that projects the invocation, yields the rows it produces inside
   * the run, and resumes past the run is monotone in ordinal however the
   * Session interleaved its Turns. The whole invocation is projected because a
   * row is the read model's fold over the Turn's events, not a per-event map;
   * only the rows inside the run are this walk's to yield.
   */
  readTranscriptRun<T>(
    sessionId: string,
    request: RuntimeTranscriptRunRequest,
    /** Consume `events` and return synchronously while the read transaction is open. */
    project: (
      run: RuntimeTranscriptRun,
      events: Iterable<{ readonly ordinal: number; readonly event: RuntimeEvent }>,
    ) => T,
  ): Promise<T | undefined>;
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
const openingContent = (invocation: string) => `
  COALESCE(
    (SELECT json_extract(op.payload_json, '$.content') FROM runtime_events op
     WHERE op.invocation_id = ${invocation} AND op.event_kind = 'invocation_opened'),
    (SELECT lg.opening_json FROM runtime_legacy_invocation_openings lg
     WHERE lg.invocation_id = ${invocation}))`;

/**
 * The nearest event in `direction` that a visible invocation owns.
 *
 * An invocation is reached through its own events rather than through its
 * opening or its ending, so a Turn that is still running — and a Turn the walk
 * lands in the middle of — is reached the same way any other is.
 */
const seek = (direction: 'older' | 'newer') => `
  SELECT o.ordinal AS ordinal, e.invocation_id AS invocation_id
  FROM runtime_session_event_ordinals o
  JOIN runtime_events e ON e.event_id = o.event_id
  WHERE o.session_id = :sessionId
    ${
      direction === 'older'
        ? // Folded into one bound because SQLite takes a single inequality per
          // column into the index range and leaves the other to filter every
          // row it walks — here, every ordinal between the two.
          'AND o.ordinal <= MIN(:position, :throughOrdinal)'
        : 'AND o.ordinal >= :position AND o.ordinal <= :throughOrdinal'
    }
    AND ${visibleOpening(openingContent('e.invocation_id'))}
  ORDER BY o.ordinal ${direction === 'older' ? 'DESC' : 'ASC'}
  LIMIT 1`;

/** Where the seeked invocation stops owning consecutive ordinals. */
const boundary = (direction: 'older' | 'newer') => `
  SELECT o.ordinal AS ordinal
  FROM runtime_session_event_ordinals o
  JOIN runtime_events e ON e.event_id = o.event_id
  WHERE o.session_id = :sessionId
    ${
      direction === 'older'
        ? 'AND o.ordinal < MIN(:ordinal, :throughOrdinal + 1)'
        : 'AND o.ordinal > :ordinal AND o.ordinal <= :throughOrdinal'
    }
    AND e.invocation_id <> :invocationId
  ORDER BY o.ordinal ${direction === 'older' ? 'DESC' : 'ASC'}
  LIMIT 1`;

const RUN_QUERIES = {
  older: { seek: seek('older'), boundary: boundary('older') },
  newer: { seek: seek('newer'), boundary: boundary('newer') },
} as const;

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
    const row = this.db
      .prepare(
        'SELECT MAX(ordinal) AS high FROM runtime_session_event_ordinals WHERE session_id = ?',
      )
      .get(sessionId) as { high: number | null };
    return row.high;
  }

  run<T>(
    sessionId: string,
    request: RuntimeTranscriptRunRequest,
    project: (
      run: RuntimeTranscriptRun,
      events: Iterable<{ readonly ordinal: number; readonly event: RuntimeEvent }>,
    ) => T,
  ): T | undefined {
    assertOrdinal(request.throughOrdinal);
    assertOrdinal(request.position);
    assertReadLimit(request.maxEvents, 'event count');
    assertReadLimit(request.maxBytes, 'byte');
    assertReadLimit(request.maxRecordBytes, 'record byte');
    if (request.direction !== 'older' && request.direction !== 'newer') {
      throw new Error('Invalid transcript direction');
    }
    const queries = RUN_QUERIES[request.direction];
    const bind = {
      sessionId,
      position: request.position,
      throughOrdinal: request.throughOrdinal,
    };
    const seeked = this.db.prepare(queries.seek).get(bind) as
      | { ordinal: number; invocation_id: string }
      | undefined;
    if (!seeked) return undefined;
    const stop = this.db.prepare(queries.boundary).get({
      sessionId,
      throughOrdinal: request.throughOrdinal,
      ordinal: seeked.ordinal,
      invocationId: seeked.invocation_id,
    }) as { ordinal: number } | undefined;
    const older = request.direction === 'older';
    return project(
      {
        invocation: this.invocation(sessionId, seeked.invocation_id),
        firstOrdinal: older ? (stop ? stop.ordinal + 1 : 0) : seeked.ordinal,
        lastOrdinal: older ? seeked.ordinal : stop ? stop.ordinal - 1 : request.throughOrdinal,
      },
      this.events(seeked.invocation_id, request),
    );
  }

  landmarks(sessionId: string, throughOrdinal: number, limit: number): RuntimeTranscriptLandmark[] {
    assertOrdinal(throughOrdinal);
    if (limit < 1) return [];
    // Evenly spaced Turn starts, chosen before any payload is read.
    const rows = this.db
      .prepare(`
      WITH opened AS (
        SELECT e.invocation_id AS invocation_id, o.ordinal AS ordinal ${ledgerOpening}
          AND o.ordinal <= :throughOrdinal
        UNION ALL
        SELECT legacy.invocation_id, o.ordinal ${migratedOpening}
          AND o.ordinal <= :throughOrdinal
      ), candidates AS (
        SELECT invocation_id, ordinal,
          ROW_NUMBER() OVER (ORDER BY ordinal) - 1 AS rank, COUNT(*) OVER () AS total
        FROM opened
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

  private *events(
    invocationId: string,
    limits: {
      throughOrdinal: number;
      maxEvents: number;
      maxBytes: number;
      maxRecordBytes: number;
    },
  ): Iterable<{ readonly ordinal: number; readonly event: RuntimeEvent }> {
    // Walked row by row so cumulative limits apply to raw IO without retaining
    // the Turn. SQLite withholds an oversized payload before it crosses into JS.
    const cursor = this.db
      .prepare(`
      SELECT o.ordinal, e.event_id, e.session_id, e.invocation_id, e.run_id, e.turn_id,
        length(CAST(e.payload_json AS BLOB)) AS stored_bytes,
        CASE WHEN length(CAST(e.payload_json AS BLOB)) <= ? THEN e.payload_json END AS payload_json
      FROM runtime_events e JOIN runtime_session_event_ordinals o ON o.event_id = e.event_id
      WHERE e.invocation_id = ? AND o.ordinal <= ? ORDER BY e.event_seq
    `)
      .iterate(limits.maxRecordBytes, invocationId, limits.throughOrdinal) as Iterable<
      Omit<StoredEventRow, 'payload_json'> & {
        ordinal: number;
        stored_bytes: number;
        payload_json: string | null;
      }
    >;
    let count = 0;
    let bytes = 0;
    for (const row of cursor) {
      if (count === limits.maxEvents) {
        throw new RuntimeTranscriptOversizedTurnError(
          `Turn ${invocationId} holds more RuntimeEvents than a transcript page may read`,
        );
      }
      const payload = row.payload_json;
      if (payload === null) {
        throw new RuntimeTranscriptOversizedTurnError(
          `Turn ${invocationId} holds a RuntimeEvent larger than a transcript page may read`,
        );
      }
      bytes += row.stored_bytes;
      if (bytes > limits.maxBytes) {
        throw new RuntimeTranscriptOversizedTurnError(
          `Turn ${invocationId} holds more RuntimeEvent bytes than a transcript page may read`,
        );
      }
      count += 1;
      yield { ordinal: row.ordinal, event: decodeStoredEvent({ ...row, payload_json: payload }) };
    }
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

function assertReadLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Invalid transcript ${name} limit`);
  }
}
