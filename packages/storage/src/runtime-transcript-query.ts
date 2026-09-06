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
import {
  decodeRuntimeEvent,
  isTerminalRuntimeEvent,
  type RuntimeEvent,
} from '@maka/core/runtime-event';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import type { AssistantStepContentKind } from '@maka/core/session';

/** SQL counterpart of isTerminalRuntimeEvent; shared with the ledger store. */
export const TERMINAL_RUNTIME_EVENT_SQL = `(
  json_extract(payload_json, '$.actions.endInvocation') = 1
  OR json_extract(payload_json, '$.status') IN ('completed', 'failed', 'aborted', 'cancelled')
)`;

export const TRANSCRIPT_MESSAGE_KEY_SQL = `CASE WHEN event_kind = 'function_call'
  THEN json_extract(payload_json, '$.refs.stepId')
  ELSE COALESCE(json_extract(payload_json, '$.refs.providerEventId'), json_extract(payload_json, '$.refs.storedMessageId'), event_id) END`;
export const TRANSCRIPT_STORED_ID_SQL = `COALESCE(json_extract(payload_json, '$.refs.storedMessageId'), json_extract(payload_json, '$.refs.providerEventId'), json_extract(payload_json, '$.content.id'), event_id)`;
/** Small indexed facts needed by a terminal row and the Turn index. */
export const TRANSCRIPT_OUTPUT_SHAPE_SQL = `CASE
  WHEN event_kind = 'text' AND json_extract(payload_json, '$.role') = 'model'
    THEN CASE WHEN TRIM(json_extract(payload_json, '$.content.text'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)) <> '' THEN 3 ELSE 1 END
  WHEN event_kind = 'function_response' THEN CASE WHEN json_extract(payload_json, '$.content.isError') = 1 THEN 12 ELSE 4 END
  ELSE 0 END`;

export interface RuntimeTranscriptSource {
  readonly ordinal: number;
  readonly event: RuntimeEvent;
  /** Only this message's thinking, in ledger order around its text event. */
  readonly events: readonly RuntimeEvent[];
  readonly invocation: RuntimeInvocationRecord;
  readonly contentOrder?: readonly AssistantStepContentKind[];
  readonly permissionRequest?: RuntimeEvent;
  readonly toolName?: string;
  readonly hasRetainedOutput: boolean;
}

export interface RuntimeTranscriptPosition {
  readonly direction: 'older' | 'newer';
  readonly throughOrdinal: number;
  readonly position: number;
  /** Exact lookup for the bounded live-to-durable handoff. */
  readonly messageId?: string;
}

export interface RuntimeTranscriptTurn {
  readonly firstOrdinal: number;
  readonly terminalOrdinal: number;
  readonly invocation: RuntimeInvocationRecord;
  readonly user?: { ordinal: number; event: RuntimeEvent };
  readonly hasAssistantMessage: boolean;
  readonly hasAssistantOutput: boolean;
  readonly hasToolResult: boolean;
  readonly hasFailedToolResult: boolean;
  readonly hasAbortNote: boolean;
}

export interface RuntimeTranscriptQueries {
  readTranscriptSourceHighWater(sessionId: string): Promise<number | null>;
  readTranscriptSource(
    sessionId: string,
    request: RuntimeTranscriptPosition,
  ): Promise<RuntimeTranscriptSource | null>;
  readTranscriptTurns(
    sessionId: string,
    throughOrdinal: number,
    position: number,
    limit: number,
  ): Promise<RuntimeTranscriptTurn[]>;
  readTranscriptLandmarks(
    sessionId: string,
    throughOrdinal: number,
    limit: number,
  ): Promise<RuntimeTranscriptTurn[]>;
}

const messageKey = (alias: string) =>
  TRANSCRIPT_MESSAGE_KEY_SQL.replaceAll('event_kind', `${alias}.event_kind`)
    .replaceAll('payload_json', `${alias}.payload_json`)
    .replaceAll('event_id', `${alias}.event_id`);
const terminal = (alias: string) =>
  TERMINAL_RUNTIME_EVENT_SQL.replaceAll('payload_json', `${alias}.payload_json`);
const opening = `COALESCE(json_extract(opened.payload_json, '$.content'), legacy.opening_json)`;
const joins = `
  FROM runtime_session_event_ordinals o
  JOIN runtime_events e ON e.event_id = o.event_id
  LEFT JOIN runtime_events opened ON opened.invocation_id = e.invocation_id AND opened.event_kind = 'invocation_opened'
  LEFT JOIN runtime_legacy_invocation_openings legacy ON legacy.invocation_id = e.invocation_id`;
const settledInline = `
  ${opening} IS NOT NULL
  AND (json_extract(${opening}, '$.lineage.parentRunId') IS NULL
    OR (json_extract(${opening}, '$.source.kind') = 'continuation'
      AND json_extract(${opening}, '$.lineage.agentId') IS NULL))
  AND EXISTS (
    SELECT 1 FROM runtime_events ended
    JOIN runtime_session_event_ordinals ending ON ending.event_id = ended.event_id
    WHERE ended.invocation_id = e.invocation_id AND ${terminal('ended')}
      AND ending.ordinal <= :throughOrdinal
  )`;
// Thinking is context for its text row. An orphan must still reach the
// projector, which reports the missing text instead of silently dropping it.
const transcriptSource = `(
  (json_extract(e.payload_json, '$.content') IS NOT NULL
    AND e.event_kind <> 'invocation_opened'
    AND (e.event_kind <> 'thinking' OR NOT EXISTS (
      SELECT 1 FROM runtime_events text
      WHERE text.invocation_id = e.invocation_id AND text.event_kind = 'text'
        AND json_extract(text.payload_json, '$.role') = 'model'
        AND COALESCE(json_extract(text.payload_json, '$.refs.storedMessageId'), json_extract(text.payload_json, '$.refs.providerEventId'), text.event_id) = ${messageKey('e')}
    )))
  OR json_extract(e.payload_json, '$.actions.permissionDecision') IS NOT NULL
  OR json_extract(e.payload_json, '$.actions.permissionAnswerAccepted') IS NOT NULL
  OR json_extract(e.payload_json, '$.actions.tokenUsage') IS NOT NULL
  OR ${terminal('e')}
)`;

type SourceRow = {
  ordinal: number;
  event_id: string;
  run_id: string;
  invocation_id: string;
  event_seq: number;
};

/** Queries select ledger positions before loading any message payload. No transcript is persisted. */
export class RuntimeTranscriptQuery {
  constructor(
    private readonly db: DatabaseSync,
    private readonly invocation: (sessionId: string, runId: string) => RuntimeInvocationRecord,
  ) {}

  highWater(sessionId: string): number | null {
    return (
      this.sourceRow(sessionId, {
        direction: 'older',
        throughOrdinal: Number.MAX_SAFE_INTEGER,
        position: Number.MAX_SAFE_INTEGER,
      })?.ordinal ?? null
    );
  }

  private sourceRow(sessionId: string, request: RuntimeTranscriptPosition): SourceRow | undefined {
    assertOrdinal(request.throughOrdinal);
    assertOrdinal(request.position);
    if (request.direction !== 'older' && request.direction !== 'newer')
      throw new Error('Invalid transcript direction');
    return this.db
      .prepare(`
      SELECT o.ordinal, e.event_id, e.run_id, e.invocation_id, e.event_seq ${joins}
      WHERE o.session_id = :sessionId AND o.ordinal <= :throughOrdinal
        ${
          request.messageId === undefined
            ? ''
            : `AND e.event_id IN (
          SELECT event_id FROM runtime_events WHERE session_id = :sessionId AND (${TRANSCRIPT_STORED_ID_SQL}) = :messageId
          UNION SELECT event_id FROM runtime_events WHERE session_id = :sessionId AND event_id = :noticeEventId
        )`
        }
        AND o.ordinal ${request.direction === 'older' ? '<=' : '>='} :position
        AND ${settledInline} AND ${transcriptSource}
      ORDER BY o.ordinal ${request.direction === 'older' ? 'DESC' : 'ASC'} LIMIT 1
    `)
      .get({
        sessionId,
        throughOrdinal: request.throughOrdinal,
        position: request.position,
        ...(request.messageId === undefined
          ? {}
          : {
              messageId: request.messageId,
              noticeEventId: request.messageId.endsWith(':step-limit-notice')
                ? request.messageId.slice(0, -':step-limit-notice'.length)
                : null,
            }),
      }) as SourceRow | undefined;
  }

  source(sessionId: string, request: RuntimeTranscriptPosition): RuntimeTranscriptSource | null {
    const row = this.sourceRow(sessionId, request);
    if (!row) return null;
    const event = this.event(row.event_id);
    const invocation = this.invocation(sessionId, row.run_id);
    let primary = event;
    if (event.content?.kind === 'thinking') {
      const text = this.db
        .prepare(`
        SELECT 1 FROM runtime_events WHERE invocation_id = ? AND event_kind = 'text'
          AND json_extract(payload_json, '$.role') = 'model'
          AND COALESCE(json_extract(payload_json, '$.refs.storedMessageId'), json_extract(payload_json, '$.refs.providerEventId'), event_id) = ? LIMIT 1
      `)
        .get(
          row.invocation_id,
          event.refs?.providerEventId ?? event.refs?.storedMessageId ?? event.id,
        );
      if (text) {
        // Its thinking is attached at the text position; any actions still own
        // their rows at this event's position, exactly once.
        const { content: _content, ...actionsOnly } = event;
        primary = actionsOnly;
      }
    }
    const events: Array<{ event: RuntimeEvent; sequence: number }> = [
      { event: primary, sequence: row.event_seq },
    ];
    let contentOrder: AssistantStepContentKind[] | undefined;
    if (event.role === 'model' && event.content?.kind === 'text') {
      const id = event.refs?.storedMessageId ?? event.refs?.providerEventId ?? event.id;
      const thinking = this.db
        .prepare(`
        SELECT e.event_id, e.event_seq FROM runtime_events e
        WHERE e.invocation_id = ? AND e.event_kind = 'thinking' AND ${messageKey('e')} = ?
        ORDER BY e.event_seq
      `)
        .all(row.invocation_id, id) as Array<{ event_id: string; event_seq: number }>;
      for (const item of thinking) {
        const { actions: _actions, status: _status, ...context } = this.event(item.event_id);
        events.push({ event: context, sequence: item.event_seq });
      }
      const kinds = this.db
        .prepare(`
        SELECT CASE e.event_kind WHEN 'function_call' THEN 'tools' ELSE e.event_kind END AS kind,
          MIN(e.event_seq) AS first_sequence FROM runtime_events e
        WHERE e.invocation_id = :invocationId AND e.event_seq <= :sequence
          AND e.event_kind IN ('text', 'thinking', 'function_call') AND json_extract(e.payload_json, '$.role') = 'model'
          AND ${messageKey('e')} = :messageId
        GROUP BY kind ORDER BY first_sequence
      `)
        .all({ invocationId: row.invocation_id, sequence: row.event_seq, messageId: id }) as Array<{
        kind: AssistantStepContentKind;
      }>;
      contentOrder = kinds.map((item) => item.kind);
    }
    const requestId =
      event.actions?.permissionDecision?.requestId ??
      event.actions?.permissionAnswerAccepted?.requestId;
    const permissionRow = requestId
      ? (this.db
          .prepare(`
      SELECT event_id FROM runtime_events
      WHERE invocation_id = ? AND event_seq <= ? AND json_extract(payload_json, '$.actions.permissionRequest.requestId') = ?
      ORDER BY event_seq DESC LIMIT 1
    `)
          .get(row.invocation_id, row.event_seq, requestId) as { event_id: string } | undefined)
      : undefined;
    const permissionRequest = permissionRow ? this.event(permissionRow.event_id) : undefined;
    const toolUseId =
      event.refs?.toolCallId ?? permissionRequest?.actions?.permissionRequest?.toolUseId;
    const toolRow =
      requestId && toolUseId
        ? (this.db
            .prepare(`
      SELECT json_extract(payload_json, '$.content.name') AS name FROM runtime_events
      WHERE invocation_id = ? AND event_seq <= ? AND json_extract(payload_json, '$.content.id') = ?
        AND event_kind IN ('function_call', 'function_response')
      ORDER BY event_seq DESC LIMIT 1
    `)
            .get(row.invocation_id, row.event_seq, toolUseId) as { name: string } | undefined)
        : undefined;
    const hasRetainedOutput =
      isTerminalRuntimeEvent(event) && this.hasShape(row.invocation_id, row.ordinal, 0, '3,4,12');
    return {
      ordinal: row.ordinal,
      event,
      invocation,
      events: events.sort((a, b) => a.sequence - b.sequence).map((item) => item.event),
      ...(contentOrder ? { contentOrder } : {}),
      ...(permissionRequest ? { permissionRequest } : {}),
      ...(toolRow?.name ? { toolName: toolRow.name } : {}),
      hasRetainedOutput,
    };
  }

  turns(
    sessionId: string,
    throughOrdinal: number,
    position: number,
    limit: number,
  ): RuntimeTranscriptTurn[] {
    assertOrdinal(throughOrdinal);
    assertOrdinal(position);
    const rows = this.db
      .prepare(`
      SELECT e.run_id, e.invocation_id, o.ordinal ${joins}
      WHERE o.session_id = :sessionId AND o.ordinal <= :throughOrdinal
        AND e.event_seq = 1 AND ${settledInline}
        AND EXISTS (SELECT 1 FROM runtime_events tail JOIN runtime_session_event_ordinals t ON t.event_id = tail.event_id
          WHERE tail.invocation_id = e.invocation_id AND t.ordinal >= :position AND t.ordinal <= :throughOrdinal AND ${transcriptSource.replaceAll('e.', 'tail.')})
      ORDER BY o.ordinal LIMIT :limit
    `)
      .all({ sessionId, throughOrdinal, position, limit }) as SourceRow[];
    return rows.map((row) => this.turn(sessionId, row, throughOrdinal, position));
  }

  landmarks(sessionId: string, throughOrdinal: number, limit: number): RuntimeTranscriptTurn[] {
    assertOrdinal(throughOrdinal);
    if (limit < 1) return [];
    const rows = this.db
      .prepare(`
      WITH candidates AS (
        SELECT e.run_id, e.invocation_id, o.ordinal,
          ROW_NUMBER() OVER (ORDER BY o.ordinal) - 1 AS rank, COUNT(*) OVER () AS total
        ${joins} WHERE o.session_id = :sessionId AND o.ordinal <= :throughOrdinal
          AND e.event_seq = 1 AND ${settledInline}
      ), samples(n) AS (
        SELECT 0 UNION ALL SELECT n + 1 FROM samples WHERE n + 1 < :limit
      )
      SELECT DISTINCT run_id, invocation_id, ordinal FROM candidates
      JOIN samples ON rank = CASE WHEN :limit = 1 THEN total - 1
        ELSE CAST(n * (total - 1) / (:limit - 1) AS INTEGER) END
      ORDER BY ordinal
    `)
      .all({ sessionId, throughOrdinal, limit }) as SourceRow[];
    return rows.map((row) => this.turn(sessionId, row, throughOrdinal, 0));
  }

  private turn(
    sessionId: string,
    row: SourceRow,
    throughOrdinal: number,
    position: number,
  ): RuntimeTranscriptTurn {
    const bounds = this.db
      .prepare(`
      SELECT o.ordinal AS first
      FROM runtime_events e JOIN runtime_session_event_ordinals o ON o.event_id = e.event_id
      WHERE e.invocation_id = ? AND o.ordinal >= ? AND o.ordinal <= ? AND ${transcriptSource}
      ORDER BY e.event_seq LIMIT 1
    `)
      .get(row.invocation_id, position, throughOrdinal) as { first: number };
    const user = this.db
      .prepare(`
      SELECT o.ordinal, e.event_id FROM runtime_events e JOIN runtime_session_event_ordinals o ON o.event_id = e.event_id
      WHERE e.invocation_id = ? AND o.ordinal >= ? AND o.ordinal <= ?
        AND e.event_kind = 'text' AND json_extract(e.payload_json, '$.role') = 'user'
      ORDER BY e.event_seq LIMIT 1
    `)
      .get(row.invocation_id, position, throughOrdinal) as
      | { ordinal: number; event_id: string }
      | undefined;
    const ended = this.db
      .prepare(`
      SELECT o.ordinal FROM runtime_events e JOIN runtime_session_event_ordinals o ON o.event_id = e.event_id
      WHERE e.invocation_id = ? AND o.ordinal <= ? AND ${terminal('e')}
      ORDER BY o.ordinal DESC LIMIT 1
    `)
      .get(row.invocation_id, throughOrdinal) as { ordinal: number };
    return {
      firstOrdinal: bounds.first,
      terminalOrdinal: ended.ordinal,
      invocation: this.invocation(sessionId, row.run_id),
      ...(user ? { user: { ordinal: user.ordinal, event: this.event(user.event_id) } } : {}),
      ...this.flags(row.invocation_id, throughOrdinal, position),
    };
  }

  private flags(invocationId: string, throughOrdinal: number, position: number) {
    return {
      hasAssistantMessage: this.hasShape(invocationId, throughOrdinal, position, '1,3'),
      hasAssistantOutput: this.hasShape(invocationId, throughOrdinal, position, '3'),
      hasToolResult: this.hasShape(invocationId, throughOrdinal, position, '4,12'),
      hasFailedToolResult: this.hasShape(invocationId, throughOrdinal, position, '12'),
      hasAbortNote: false,
    };
  }

  private hasShape(
    invocationId: string,
    throughOrdinal: number,
    position: number,
    shapes: string,
  ): boolean {
    return (
      this.db
        .prepare(`
      SELECT 1 FROM runtime_events JOIN runtime_session_event_ordinals o USING (event_id)
      WHERE invocation_id = ? AND (${TRANSCRIPT_OUTPUT_SHAPE_SQL}) IN (${shapes})
        AND o.ordinal >= ? AND o.ordinal <= ? LIMIT 1
    `)
        .get(invocationId, position, throughOrdinal) !== undefined
    );
  }

  private event(id: string): RuntimeEvent {
    const row = this.db
      .prepare(
        'SELECT event_id, session_id, invocation_id, run_id, turn_id, payload_json FROM runtime_events WHERE event_id = ?',
      )
      .get(id) as
      | {
          event_id: string;
          session_id: string;
          invocation_id: string;
          run_id: string;
          turn_id: string;
          payload_json: string;
        }
      | undefined;
    if (!row) throw new Error(`Transcript RuntimeEvent ${id} is missing`);
    const event = decodeRuntimeEvent(JSON.parse(row.payload_json));
    if (
      event.id !== row.event_id ||
      event.sessionId !== row.session_id ||
      event.invocationId !== row.invocation_id ||
      event.runId !== row.run_id ||
      event.turnId !== row.turn_id
    ) {
      throw new Error(`Transcript RuntimeEvent ${id} has inconsistent storage identity`);
    }
    return event;
  }
}

function assertOrdinal(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid transcript event ordinal');
}
