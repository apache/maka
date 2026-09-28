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
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import {
  ExternalSessionLimitError,
  ExternalSessionNotFoundError,
  externalSessionMatchesQuery,
  sanitizeExternalSessionTitle,
} from '@maka/core/external-session';
import type {
  ExternalMakaSession,
  ExternalSessionAdapter,
  ExternalSessionCatalogPage,
  ExternalSessionCatalogPageQuery,
  ExternalSessionQuery,
  ExternalSessionSummary,
} from '@maka/core/external-session';
import type { StoredMessage } from '@maka/core/session';
import { listOffsetExternalSessionCatalogPage } from './offset-external-session-catalog.js';

export const OPENCODE_SESSION_ADAPTER_ID = 'opencode';
/**
 * What one OpenCode transcript may cost before the import is refused.
 *
 * Rows are `message` rows plus `part` rows, counted the way the preflight
 * counts them, and bytes are the id, foreign-key and `data` columns it sums.
 * These bounds protect the source side of the import: bytes cap encoded SQLite
 * payload and rows cap the number of decoded source objects. They are not a
 * process-RSS promise; JSON parsing depends on payload shape. The converter has
 * its own `OPENCODE_TRANSCRIPT_MAX_CONVERTED_BYTES` limit for retained Maka
 * messages, so source and output memory are never conflated.
 */
export const OPENCODE_TRANSCRIPT_MAX_RAW_BYTES = 64 * 1024 * 1024;
export const OPENCODE_TRANSCRIPT_MAX_ROWS = 250_000;
export const OPENCODE_TRANSCRIPT_MAX_CONVERTED_BYTES = 256 * 1024 * 1024;

const EXTERNAL_SNAPSHOT_ABORT_SOURCE = 'external_session_snapshot';

/**
 * Guards a source field before it reaches JavaScript.
 *
 * These are memory bounds, not display limits. Display length is enforced by
 * `sanitizeExternalSessionTitle` and the wire protocol; these larger bounds
 * only prevent malformed source fields from being loaded whole.
 */
const OPENCODE_CATALOG_ID_MAX_BYTES = 512;
const OPENCODE_CATALOG_TITLE_MAX_BYTES = 64 * 1024;
const OPENCODE_CATALOG_CWD_MAX_BYTES = 4 * 1024;

/** Guards the value interpolated into no SQL, but read back out of one. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export interface OpenCodeSessionAdapterOptions {
  /** Overrides `~/.local/share/opencode`. */
  opencodeHome?: string;
  /** Maximum aggregate bytes across source rows loaded for one import. */
  maxRawBytes?: number;
  /** Maximum message + part rows loaded for one import. */
  maxRows?: number;
  /** Maximum serialized bytes retained across converted Maka messages. */
  maxConvertedBytes?: number;
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
  readonly #maxRawBytes: number;
  readonly #maxRows: number;
  readonly #maxConvertedBytes: number;

  constructor(options: OpenCodeSessionAdapterOptions = {}) {
    this.#home = options.opencodeHome ?? join(homedir(), '.local', 'share', 'opencode');
    this.#maxRawBytes = options.maxRawBytes ?? OPENCODE_TRANSCRIPT_MAX_RAW_BYTES;
    this.#maxRows = options.maxRows ?? OPENCODE_TRANSCRIPT_MAX_ROWS;
    this.#maxConvertedBytes = options.maxConvertedBytes ?? OPENCODE_TRANSCRIPT_MAX_CONVERTED_BYTES;
    assertPositiveSafeInteger(this.#maxRawBytes, 'OpenCode transcript byte limit');
    assertPositiveSafeInteger(this.#maxRows, 'OpenCode transcript row limit');
    assertPositiveSafeInteger(this.#maxConvertedBytes, 'OpenCode converted message byte limit');
  }

  async detect(): Promise<boolean> {
    return (await this.#resolvedDatabasePath()) !== undefined;
  }

  async listSessions(query: ExternalSessionQuery = {}): Promise<readonly ExternalSessionSummary[]> {
    return this.#readSessionPage(query);
  }

  async listSessionPage(
    query: ExternalSessionCatalogPageQuery,
  ): Promise<ExternalSessionCatalogPage> {
    return listOffsetExternalSessionCatalogPage(query, (pageQuery) => this.listSessions(pageQuery));
  }

  async readSession(sessionId: string): Promise<ExternalMakaSession> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`opencode session id is not usable: ${sessionId}`);
    }
    return this.#withDatabase((db) =>
      withReadSnapshot(db, () => {
        requireTranscriptSchema(db);
        preflightSessionMetadata(db, sessionId);
        const rawSession = db
          .prepare(
            'SELECT id, title, directory, time_created, time_updated, time_archived, parent_id FROM session WHERE id = ?',
          )
          .get(sessionId);
        const row = toSessionRow(rawSession);
        if (!row) throw new ExternalSessionNotFoundError();
        if (row.parentId !== undefined) {
          throw new Error(`opencode session is a child of another session: ${sessionId}`);
        }
        preflightTranscript(db, sessionId, this.#maxRawBytes, this.#maxRows);
        const { messages, parts } = readTranscript(db, sessionId);
        return {
          sourceSessionId: sessionId,
          metadata: {
            name: sanitizeExternalSessionTitle(row.title) || sessionId,
            cwd: row.directory,
          },
          messages: convertTranscript(sessionId, messages, parts, this.#maxConvertedBytes),
        };
      }),
    );
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
  async #resolvedDatabasePath(): Promise<string | undefined> {
    try {
      const root = await realpath(this.#home);
      const path = await realpath(this.#databasePath());
      if (path !== root && !path.startsWith(root + sep)) return undefined;
      if (basename(path) !== 'opencode.db' || !(await stat(path)).isFile()) return undefined;
      return path;
    } catch {
      return undefined;
    }
  }

  async #withDatabase<T>(read: (db: OpenCodeDatabase) => T): Promise<T> {
    const path = await this.#resolvedDatabasePath();
    if (!path) throw new Error('opencode database is unavailable');
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
      if (
        cause instanceof ExternalSessionLimitError ||
        (cause instanceof Error && cause.message.startsWith('opencode session '))
      ) {
        throw cause;
      }
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

  async #readSessionPage(query: ExternalSessionQuery): Promise<readonly ExternalSessionSummary[]> {
    // Discovery is allowed to come up empty — the catalog lists whatever
    // sources are present, and an opencode that was installed but never used
    // is a normal state rather than a failure to report.
    if (!(await this.#resolvedDatabasePath())) return [];
    return await this.#withDatabase((db) => {
      const columns = tableColumns(db, 'session');
      if (!columns.has('id') || !columns.has('directory') || !columns.has('parent_id')) {
        throw new Error('opencode `session` table does not carry required columns');
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
      const bounds = [
        "(parent_id IS NULL OR parent_id = '')",
        ...(!query.includeArchived && columns.has('time_archived')
          ? ['time_archived IS NULL']
          : []),
        `length(CAST(id AS BLOB)) <= ${OPENCODE_CATALOG_ID_MAX_BYTES}`,
        `length(CAST(coalesce(directory, '') AS BLOB)) <= ${OPENCODE_CATALOG_CWD_MAX_BYTES}`,
        ...(columns.has('title')
          ? [`length(CAST(coalesce(title, '') AS BLOB)) <= ${OPENCODE_CATALOG_TITLE_MAX_BYTES}`]
          : []),
      ];
      const order = columns.has('time_updated')
        ? columns.has('time_created')
          ? 'coalesce(time_updated, time_created, 0) DESC, id DESC'
          : 'coalesce(time_updated, 0) DESC, id DESC'
        : columns.has('time_created')
          ? 'coalesce(time_created, 0) DESC, id DESC'
          : 'id DESC';
      const requestedOffset = query.offset ?? 0;
      const requestedLimit = query.limit ?? Number.MAX_SAFE_INTEGER;
      if (
        !Number.isSafeInteger(requestedOffset) ||
        requestedOffset < 0 ||
        !Number.isSafeInteger(requestedLimit) ||
        requestedLimit < 0
      ) {
        throw new Error('Invalid OpenCode catalog page');
      }
      if (requestedLimit === 0) return [];
      const batchSize = Math.max(32, Math.min(256, requestedLimit * 2));
      const statement = db.prepare(
        `SELECT ${selected.join(', ')} FROM session WHERE ${bounds.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
      );
      const summaries: ExternalSessionSummary[] = [];
      let matched = 0;
      let rawOffset = 0;
      while (summaries.length < requestedLimit) {
        const raw = statement.all(batchSize, rawOffset);
        for (const value of raw) {
          const row = toSessionRow(value);
          if (!row) continue;
          const summary = toSummary(row);
          if (!externalSessionMatchesQuery(summary, query)) continue;
          if (matched++ < requestedOffset) continue;
          summaries.push(summary);
          if (summaries.length === requestedLimit) break;
        }
        rawOffset += raw.length;
        if (raw.length < batchSize) break;
      }
      return summaries;
    });
  }
}

interface OpenCodeDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}

function withReadSnapshot<T>(db: OpenCodeDatabase, read: () => T): T {
  db.exec('BEGIN DEFERRED');
  try {
    const result = read();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the read failure. Closing the read-only connection releases
      // any transaction SQLite could not roll back explicitly.
    }
    throw error;
  }
}

function requireTranscriptSchema(db: OpenCodeDatabase): void {
  const required = {
    session: ['id', 'title', 'directory', 'parent_id'],
    message: ['id', 'session_id', 'time_created', 'data'],
    part: ['id', 'message_id', 'session_id', 'time_created', 'data'],
  } as const;
  for (const [table, columns] of Object.entries(required)) {
    const actual = tableColumns(db, table);
    if (columns.some((column) => !actual.has(column))) {
      throw new Error(`opencode \`${table}\` table does not carry required columns`);
    }
  }
}

function preflightSessionMetadata(db: OpenCodeDatabase, sessionId: string): void {
  const sizes = asRecord(
    db
      .prepare(
        `SELECT length(CAST(id AS BLOB)) AS id_bytes,
                length(CAST(coalesce(title, '') AS BLOB)) AS title_bytes,
                length(CAST(directory AS BLOB)) AS cwd_bytes
           FROM session WHERE id = ?`,
      )
      .get(sessionId),
  );
  if (!sizes) throw new ExternalSessionNotFoundError();
  for (const [field, max] of [
    ['id_bytes', OPENCODE_CATALOG_ID_MAX_BYTES],
    ['title_bytes', OPENCODE_CATALOG_TITLE_MAX_BYTES],
    ['cwd_bytes', OPENCODE_CATALOG_CWD_MAX_BYTES],
  ] as const) {
    if ((numberOf(sizes[field]) ?? 0) > max) {
      throw new ExternalSessionLimitError(
        'record_bytes',
        max,
        `OpenCode Session metadata exceeds ${max} bytes`,
      );
    }
  }
}

function preflightTranscript(
  db: OpenCodeDatabase,
  sessionId: string,
  maxRawBytes: number,
  maxRows: number,
): void {
  const stats = asRecord(
    db
      .prepare(
        `SELECT count(*) AS rows, coalesce(sum(raw_bytes), 0) AS raw_bytes, coalesce(max(data_bytes), 0) AS max_data_bytes
         FROM (
           SELECT length(CAST(id AS BLOB)) + length(CAST(data AS BLOB)) AS raw_bytes,
                  length(CAST(data AS BLOB)) AS data_bytes
             FROM message WHERE session_id = ?
           UNION ALL
           SELECT length(CAST(id AS BLOB)) + length(CAST(message_id AS BLOB)) + length(CAST(data AS BLOB)) AS raw_bytes,
                  length(CAST(data AS BLOB)) AS data_bytes
             FROM part WHERE session_id = ?
           LIMIT ?
         )`,
      )
      .get(sessionId, sessionId, maxRows + 1),
  );
  const rows = numberOf(stats?.rows) ?? 0;
  const rawBytes = numberOf(stats?.raw_bytes) ?? 0;
  const maxDataBytes = numberOf(stats?.max_data_bytes) ?? 0;
  if (rows > maxRows) {
    throw new ExternalSessionLimitError(
      'records',
      maxRows,
      `OpenCode transcript exceeds ${maxRows} source rows`,
    );
  }
  if (maxDataBytes > maxRawBytes) {
    throw new ExternalSessionLimitError(
      'record_bytes',
      maxRawBytes,
      `OpenCode transcript contains a source record larger than ${maxRawBytes} bytes`,
    );
  }
  if (rawBytes > maxRawBytes) {
    throw new ExternalSessionLimitError(
      'transcript_bytes',
      maxRawBytes,
      `OpenCode transcript exceeds ${maxRawBytes} source bytes`,
    );
  }
}

function readTranscript(
  db: OpenCodeDatabase,
  sessionId: string,
): { messages: readonly MessageRow[]; parts: readonly PartRow[] } {
  const messages = db
    .prepare(
      'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id',
    )
    .all(sessionId)
    .map((row, index) => requireRow(toMessageRow(row), 'message', index));
  const parts = db
    .prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id')
    .all(sessionId)
    .map((row, index) => requireRow(toPartRow(row), 'part', index));
  return { messages, parts };
}

function tableColumns(db: OpenCodeDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
  return new Set(
    rows.map((column) => (typeof column.name === 'string' ? column.name : '')).filter(Boolean),
  );
}

function toSummary(row: SessionRow): ExternalSessionSummary {
  const updatedAt = row.timeUpdated ?? row.timeCreated;
  return {
    id: row.id,
    name: sanitizeExternalSessionTitle(row.title) || row.id,
    cwd: row.directory,
    ...(row.timeCreated !== undefined ? { createdAt: row.timeCreated } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
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
  maxConvertedBytes = OPENCODE_TRANSCRIPT_MAX_CONVERTED_BYTES,
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
  let convertedBytes = 0;
  const append = (message: StoredMessage): void => {
    const encodedBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (encodedBytes > maxConvertedBytes - convertedBytes) {
      throw new ExternalSessionLimitError(
        'converted_bytes',
        maxConvertedBytes,
        `OpenCode transcript converts to more than ${maxConvertedBytes} bytes`,
      );
    }
    convertedBytes += encodedBytes;
    out.push(message);
  };
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
      append({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'failed',
        errorClass: 'opencode_error',
      });
    } else if (turn.aborted) {
      append({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'aborted',
        abortedAt: turn.lastTs,
        abortSource: EXTERNAL_SNAPSHOT_ABORT_SOURCE,
      });
    } else if (turn.closed) {
      append({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'completed',
      });
    } else {
      // A turn whose last assistant step asked for tools and never came back:
      // the run stopped between a call and its answer. Recording it as
      // completed would assert a reply the session never produced.
      append({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'aborted',
        abortedAt: turn.lastTs,
        abortSource: EXTERNAL_SNAPSHOT_ABORT_SOURCE,
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
        .filter((part) => stringOf(part.type) === 'text' && part.synthetic !== true)
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
      append({ type: 'user', id: id('user'), turnId: turn.turnId, ts, text });
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
        append({
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
        append({
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
      append({
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
        append({
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
        append({
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
  const parentId = readParentId(row?.parent_id);
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

/**
 * The source marks a root Session's `parent_id` as NULL or the empty string.
 *
 * Anything else is a child. A value this build cannot read as text is a child
 * it cannot name — not the absence of a parent — so it is refused rather than
 * decoded to `undefined`, which would let a child session be imported as a
 * root of its own. The catalog's SQL already restricts its rows to roots, so a
 * row that fails here is one the pagination bounds did not anticipate: skipped
 * there, refused here.
 */
function readParentId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(
      'opencode session `parent_id` is neither text nor null, so the session cannot be proven a root',
    );
  }
  return value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}
