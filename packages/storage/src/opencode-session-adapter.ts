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

// opencode sessions as Maka Sessions.
//
// State lives in one SQLite database, `~/.local/share/opencode/opencode.db`,
// which the CLI itself will name (`opencode db path`). Earlier releases wrote
// a `storage/session/{info,message,part}` JSON tree; that layout is gone, so
// this reads the database and nothing else. Verified against 1.18.21.
//
// A conversation is three tables. `session` holds identity and `directory`,
// which is the cwd a project-scoped query reads. `message` and `part` each
// keep their payload in an opaque `data` JSON column — the schema names the
// container, the column names the shape.
//
// Turn state is derivable here, unlike a Claude Code transcript: every
// assistant message records `time.completed`, and `finish` is `stop` on a
// closing step, `tool-calls` on an intermediate one, and absent on a message
// that was aborted, which also carries `error.name`.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { externalSessionMatchesQuery } from '@maka/core/external-session';
import type {
  ExternalMakaSession,
  ExternalSessionAdapter,
  ExternalSessionQuery,
  ExternalSessionSummary,
} from '@maka/core/external-session';
import { sanitizeForeignTitle } from '@maka/core/foreign-session';
import type { StoredMessage } from '@maka/core/session';

export const OPENCODE_SESSION_ADAPTER_ID = 'opencode';

const EXTERNAL_SNAPSHOT_ABORT_SOURCE = 'external_session_snapshot';

/** Guards the value interpolated into no SQL, but read back out of one. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export interface OpenCodeSessionAdapterOptions {
  /** Overrides `~/.local/share/opencode`. */
  opencodeHome?: string;
}

interface SessionRow {
  readonly id: string;
  readonly title: string;
  readonly directory: string;
  readonly timeCreated?: number;
  readonly timeUpdated?: number;
  readonly archived: boolean;
  readonly parentId?: string;
}

interface MessageRow {
  readonly id: string;
  readonly timeCreated: number;
  readonly data: Record<string, unknown>;
}

interface PartRow {
  readonly messageId: string;
  readonly data: Record<string, unknown>;
}

export class OpenCodeSessionAdapter implements ExternalSessionAdapter {
  readonly id = OPENCODE_SESSION_ADAPTER_ID;
  readonly #home: string;

  constructor(options: OpenCodeSessionAdapterOptions = {}) {
    this.#home = options.opencodeHome ?? join(homedir(), '.local', 'share', 'opencode');
  }

  async detect(): Promise<boolean> {
    return existsSync(this.#databasePath());
  }

  async listSessions(query?: ExternalSessionQuery): Promise<readonly ExternalSessionSummary[]> {
    const rows = await this.#readSessions();
    const summaries: ExternalSessionSummary[] = [];
    for (const row of rows) {
      // A child session is one operator's leg of a parent conversation, not a
      // conversation a user started. Listing it offers an import of half a
      // dialogue whose other half is a separate entry.
      if (row.parentId !== undefined) continue;
      const summary = toSummary(row);
      if (externalSessionMatchesQuery(summary, query)) summaries.push(summary);
    }
    summaries.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    return summaries;
  }

  async readSession(sessionId: string): Promise<ExternalMakaSession> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`opencode session id is not usable: ${sessionId}`);
    }
    const rows = await this.#readSessions();
    const row = rows.find((candidate) => candidate.id === sessionId);
    if (!row) throw new Error(`opencode session not found: ${sessionId}`);
    if (row.parentId !== undefined) {
      throw new Error(`opencode session is a child of another session: ${sessionId}`);
    }
    const { messages, parts } = await this.#readTranscript(sessionId);
    return {
      sourceSessionId: sessionId,
      metadata: { name: row.title || sessionId, cwd: row.directory },
      messages: convertTranscript(sessionId, messages, parts),
    };
  }

  #databasePath(): string {
    return join(this.#home, 'opencode.db');
  }

  /**
   * Opens the database and runs one read.
   *
   * Failure is reported, not flattened into an empty result. An unreadable
   * database and an opencode install with no sessions are different facts, and
   * a caller that cannot tell them apart reports the wrong one: "no sessions
   * here" for a database that is locked, corrupt, or written by a version
   * whose tables this does not recognise.
   */
  async #withDatabase<T>(read: (db: OpenCodeDatabase) => T): Promise<T> {
    const path = this.#databasePath();
    let sqlite: typeof import('node:sqlite');
    try {
      sqlite = await import('node:sqlite');
    } catch (cause) {
      throw new Error('opencode sessions need node:sqlite, which is unavailable', { cause });
    }
    let db: OpenCodeDatabase;
    try {
      db = new sqlite.DatabaseSync(path, { readOnly: true }) as OpenCodeDatabase;
    } catch (cause) {
      throw new Error(`opencode database could not be opened: ${path}`, { cause });
    }
    try {
      return read(db);
    } catch (cause) {
      throw new Error(`opencode database could not be read: ${path}`, { cause });
    } finally {
      try {
        db.close();
      } catch {
        // A close that fails leaves nothing for a reader to do; the process
        // releases the handle either way, and throwing here would replace a
        // usable result with an error about cleanup.
      }
    }
  }

  async #readSessions(): Promise<readonly SessionRow[]> {
    // Discovery is allowed to come up empty — the catalog lists whatever
    // sources are present, and an opencode that was installed but never used
    // is a normal state rather than a failure to report.
    if (!existsSync(this.#databasePath())) return [];
    return await this.#withDatabase((db) => {
      const columns = tableColumns(db, 'session');
      if (!columns.has('id') || !columns.has('directory')) {
        throw new Error('opencode `session` table does not carry `id` and `directory`');
      }
      const selected = [
        'id',
        'title',
        'directory',
        'time_created',
        'time_updated',
        'time_archived',
        'parent_id',
      ].filter((column) => columns.has(column));
      const raw = db.prepare(`SELECT ${selected.join(', ')} FROM session`).all();
      return raw.map(toSessionRow).filter((row): row is SessionRow => row !== undefined);
    });
  }

  async #readTranscript(
    sessionId: string,
  ): Promise<{ messages: readonly MessageRow[]; parts: readonly PartRow[] }> {
    return await this.#withDatabase((db) => {
      // A row that will not decode is not skipped. Dropping one silently
      // yields a transcript missing a message or a part while the import
      // reports success — a history that reads as complete and is not. A
      // selected import either carries what the session recorded or fails.
      const messages = db
        .prepare('SELECT id, time_created, data FROM message WHERE session_id = ?')
        .all(sessionId)
        .map((row, index) => requireRow(toMessageRow(row), 'message', index));
      // Ordered by the message they belong to and then by their own id, which
      // is how the writer orders them; `time_created` ties within one step.
      const parts = db
        .prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id')
        .all(sessionId)
        .map((row, index) => requireRow(toPartRow(row), 'part', index));
      return { messages, parts };
    });
  }
}

interface OpenCodeDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

function tableColumns(db: OpenCodeDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
  return new Set(
    rows.map((column) => (typeof column.name === 'string' ? column.name : '')).filter(Boolean),
  );
}

function toSummary(row: SessionRow): ExternalSessionSummary {
  return {
    id: row.id,
    name: sanitizeForeignTitle(row.title) || row.id,
    cwd: row.directory,
    ...(row.timeCreated !== undefined ? { createdAt: row.timeCreated } : {}),
    ...(row.timeUpdated !== undefined ? { updatedAt: row.timeUpdated } : {}),
    ...(row.archived ? { archived: true } : {}),
  };
}

/**
 * Turns one opencode conversation into Maka messages.
 *
 * Exported for the fixture tests, which exercise the mapping without a
 * database: the conversion is where the source format is interpreted, and it
 * is the part worth pinning.
 */
export function convertTranscript(
  sessionId: string,
  messages: readonly MessageRow[],
  parts: readonly PartRow[],
): readonly StoredMessage[] {
  const partsByMessage = new Map<string, Record<string, unknown>[]>();
  for (const part of parts) {
    const existing = partsByMessage.get(part.messageId);
    if (existing) existing.push(part.data);
    else partsByMessage.set(part.messageId, [part.data]);
  }

  const ordered = [...messages].sort((left, right) =>
    left.timeCreated === right.timeCreated
      ? left.id.localeCompare(right.id)
      : left.timeCreated - right.timeCreated,
  );

  const out: StoredMessage[] = [];
  let sequence = 0;
  const id = (kind: string): string => `opencode:${sessionId}:${kind}:${sequence++}`;
  let turnSequence = 0;

  interface Turn {
    turnId: string;
    lastTs: number;
    aborted: boolean;
    closed: boolean;
    errorName?: string;
  }
  let turn: Turn | undefined;

  const closeTurn = (): void => {
    if (!turn) return;
    if (turn.errorName !== undefined && !turn.aborted) {
      out.push({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'failed',
        errorClass: 'opencode_error',
        partialOutputRetained: true,
      });
    } else if (turn.aborted) {
      out.push({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'aborted',
        abortedAt: turn.lastTs,
        abortSource: EXTERNAL_SNAPSHOT_ABORT_SOURCE,
        partialOutputRetained: true,
      });
    } else if (turn.closed) {
      out.push({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'completed',
        partialOutputRetained: true,
      });
    } else {
      // A turn whose last assistant step asked for tools and never came back:
      // the run stopped between a call and its answer. Recording it as
      // completed would assert a reply the session never produced.
      out.push({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'aborted',
        abortedAt: turn.lastTs,
        abortSource: EXTERNAL_SNAPSHOT_ABORT_SOURCE,
        partialOutputRetained: true,
      });
    }
    turn = undefined;
  };

  for (const message of ordered) {
    const data = message.data;
    const role = stringOf(data.role);
    const ts =
      numberOf((data.time as Record<string, unknown> | undefined)?.created) ?? message.timeCreated;
    const messageParts = partsByMessage.get(message.id) ?? [];

    if (role === 'user') {
      // A user message closes whatever came before it either way: it is the
      // boundary, whether or not it carries a prompt this import can use.
      closeTurn();
      const text = messageParts
        .filter((part) => stringOf(part.type) === 'text')
        .map((part) => stringOf(part.text) ?? '')
        .filter((part) => part.length > 0)
        .join('\n\n');
      // No text part means no prompt to import. Opening a turn for it would
      // produce a `turn_state` describing a turn that holds no messages —
      // a terminal verdict on a conversation that is not there. An assistant
      // message that follows opens its own turn.
      if (text.length === 0) continue;
      turn = {
        turnId: `opencode:${sessionId}:turn:${turnSequence++}`,
        lastTs: ts,
        aborted: false,
        closed: false,
      };
      out.push({ type: 'user', id: id('user'), turnId: turn.turnId, ts, text });
      continue;
    }

    if (role !== 'assistant') continue;

    if (!turn) {
      // An assistant message with no preceding user message: a resumed
      // session whose opening prompt is not in this transcript. Give it a turn
      // rather than dropping the content.
      turn = {
        turnId: `opencode:${sessionId}:turn:${turnSequence++}`,
        lastTs: ts,
        aborted: false,
        closed: false,
      };
    }
    turn.lastTs = Math.max(turn.lastTs, ts);

    const errorName = stringOf((data.error as Record<string, unknown> | undefined)?.name);
    if (errorName !== undefined) {
      if (errorName === 'MessageAbortedError') turn.aborted = true;
      else turn.errorName = errorName;
    }
    const finish = stringOf(data.finish);
    // `stop` is the only finish that closes a turn. `tool-calls` means the
    // step handed off to a tool and another assistant message follows.
    if (finish === 'stop') turn.closed = true;
    else if (finish !== undefined) turn.closed = false;

    const modelId = stringOf(data.modelID) ?? 'opencode';

    // Parts are walked in the order the session recorded them rather than
    // bucketed by type. opencode accepts `text` before `reasoning`, and its
    // own replay keeps that order; emitting all reasoning first would move a
    // model's thinking across text it actually wrote after.
    for (const part of messageParts) {
      const kind = stringOf(part.type);

      if (kind === 'reasoning') {
        const thinking = stringOf(part.text);
        if (thinking === undefined) continue;
        out.push({
          type: 'assistant',
          id: id('thinking'),
          turnId: turn.turnId,
          ts,
          text: '',
          thinking: { text: thinking },
          contentOrder: ['thinking'],
          modelId,
        });
        continue;
      }

      if (kind === 'text') {
        const text = stringOf(part.text);
        if (text === undefined) continue;
        out.push({
          type: 'assistant',
          id: id('assistant'),
          turnId: turn.turnId,
          ts,
          text,
          contentOrder: ['text'],
          modelId,
        });
        continue;
      }

      if (kind !== 'tool') continue;
      const callId = stringOf(part.callID);
      // A call with no id cannot be paired with its result. Minting one
      // produces a row guaranteed not to match anything, which reads as a
      // detached call rather than an absent one.
      if (callId === undefined) continue;
      const state = asRecord(part.state);
      const status = stringOf(state?.status);
      out.push({
        type: 'tool_call',
        id: callId,
        turnId: turn.turnId,
        ts,
        toolName: stringOf(part.tool) ?? 'unknown',
        args: asRecord(state?.input) ?? {},
      });
      // `completed` and `error` are both terminal: opencode records a failed
      // call as `{ status: 'error', error: <message> }` and replays it as an
      // errored output. Dropping the failure would leave a call with no
      // answer inside a turn a later `finish: "stop"` marks completed — a
      // transcript asserting the tool never replied when it replied with a
      // failure.
      //
      // `pending` and `running` are the calls that genuinely had no answer
      // when the session was written, and they get no result.
      if (status === 'completed') {
        out.push({
          type: 'tool_result',
          id: id('tool-result'),
          turnId: turn.turnId,
          ts,
          toolUseId: callId,
          isError: false,
          content: { kind: 'text', text: stringOf(state?.output) ?? '' },
        });
        continue;
      }
      if (status === 'error') {
        out.push({
          type: 'tool_result',
          id: id('tool-result'),
          turnId: turn.turnId,
          ts,
          toolUseId: callId,
          isError: true,
          content: { kind: 'text', text: stringOf(state?.error) ?? 'opencode tool call failed' },
        });
      }
    }
  }

  closeTurn();
  return out;
}

function requireRow<T>(row: T | undefined, table: string, index: number): T {
  if (row === undefined) {
    throw new Error(`opencode \`${table}\` row ${index} could not be decoded`);
  }
  return row;
}

function toSessionRow(value: unknown): SessionRow | undefined {
  const row = asRecord(value);
  const id = stringOf(row?.id);
  if (id === undefined) return undefined;
  const directory = stringOf(row?.directory) ?? '';
  const parentId = stringOf(row?.parent_id);
  return {
    id,
    title: stringOf(row?.title) ?? '',
    directory,
    ...(numberOf(row?.time_created) !== undefined
      ? { timeCreated: numberOf(row?.time_created) }
      : {}),
    ...(numberOf(row?.time_updated) !== undefined
      ? { timeUpdated: numberOf(row?.time_updated) }
      : {}),
    archived: numberOf(row?.time_archived) !== undefined,
    ...(parentId !== undefined ? { parentId } : {}),
  };
}

function toMessageRow(value: unknown): MessageRow | undefined {
  const row = asRecord(value);
  const id = stringOf(row?.id);
  const data = parseJsonRecord(row?.data);
  if (id === undefined || data === undefined) return undefined;
  return { id, timeCreated: numberOf(row?.time_created) ?? 0, data };
}

function toPartRow(value: unknown): PartRow | undefined {
  const row = asRecord(value);
  const messageId = stringOf(row?.message_id);
  const data = parseJsonRecord(row?.data);
  if (messageId === undefined || data === undefined) return undefined;
  return { messageId, data };
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
