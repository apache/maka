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

// Cursor sessions as Maka Sessions.
//
// State lives in one SQLite database, `state.vscdb` under Cursor's
// `User/globalStorage` directory. The database is Cursor-internal, not a
// public contract: every field read here is tolerated missing or foreign, and
// a record this build cannot read degrades instead of failing the import.
// Verified against Cursor builds writing `_v` 10 through 14.
//
// A conversation is key-paired rows in one KV table. `composerData:<id>` holds
// the session record: the display name, wall-clock stamps, and
// `fullConversationHeadersOnly`, the ordered list of `bubbleId`s. Each
// `bubbleId:<composerId>:<bubbleId>` row holds one turn message. Headers can
// outlive their bubbles (pruned by the source), so a missing bubble is a gap
// in the transcript, not a broken database.
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export const CURSOR_SESSION_ADAPTER_ID = 'cursor';
/**
 * What one Cursor transcript may cost before the import is refused.
 *
 * Source rows are the composer record plus its bubble rows; bytes cap encoded
 * SQLite payload and rows cap the number of decoded source objects. These are
 * memory bounds, not process-RSS promises: single bubbles were measured at
 * over 800 KB, so `record_bytes` is sized by the same constant rather than a
 * separate per-row figure.
 */
export const CURSOR_TRANSCRIPT_MAX_RAW_BYTES = 64 * 1024 * 1024;
export const CURSOR_TRANSCRIPT_MAX_ROWS = 250_000;
export const CURSOR_TRANSCRIPT_MAX_MESSAGES = 250_000;
export const CURSOR_TRANSCRIPT_MAX_CONVERTED_BYTES = 256 * 1024 * 1024;

const EXTERNAL_SNAPSHOT_ABORT_SOURCE = 'external_session_snapshot';

/**
 * Guards a source field before it reaches JavaScript. Memory bounds, not
 * display limits: the display length is `sanitizeExternalSessionTitle`'s job.
 */
const CURSOR_CATALOG_ID_MAX_BYTES = 512;
const CURSOR_CATALOG_TITLE_MAX_BYTES = 64 * 1024;

/** Guards the value interpolated into no SQL, but read back out of one. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export interface CursorSessionAdapterOptions {
  /** Overrides Cursor's `User/globalStorage` directory. */
  cursorHome?: string;
  /** Overrides the database file inside `cursorHome`. */
  stateDbPath?: string;
  /** Maximum aggregate bytes across source rows loaded for one import. */
  maxRawBytes?: number;
  /** Maximum source rows (composer record + bubbles) loaded for one import. */
  maxRows?: number;
  /** Maximum Maka messages one import may convert. */
  maxMessages?: number;
  /** Maximum serialized bytes retained across converted Maka messages. */
  maxConvertedBytes?: number;
}

export class CursorSessionAdapter implements ExternalSessionAdapter {
  readonly id = CURSOR_SESSION_ADAPTER_ID;
  readonly #home: string;
  readonly #stateDbPath?: string;
  readonly #maxRawBytes: number;
  readonly #maxRows: number;
  readonly #maxMessages: number;
  readonly #maxConvertedBytes: number;

  constructor(options: CursorSessionAdapterOptions = {}) {
    this.#home =
      options.cursorHome ??
      join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
    this.#stateDbPath = options.stateDbPath;
    this.#maxRawBytes = options.maxRawBytes ?? CURSOR_TRANSCRIPT_MAX_RAW_BYTES;
    this.#maxRows = options.maxRows ?? CURSOR_TRANSCRIPT_MAX_ROWS;
    this.#maxMessages = options.maxMessages ?? CURSOR_TRANSCRIPT_MAX_MESSAGES;
    this.#maxConvertedBytes = options.maxConvertedBytes ?? CURSOR_TRANSCRIPT_MAX_CONVERTED_BYTES;
    assertPositiveSafeInteger(this.#maxRawBytes, 'Cursor transcript byte limit');
    assertPositiveSafeInteger(this.#maxRows, 'Cursor transcript row limit');
    assertPositiveSafeInteger(this.#maxMessages, 'Cursor converted message count limit');
    assertPositiveSafeInteger(this.#maxConvertedBytes, 'Cursor converted message byte limit');
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
      throw new Error(`cursor session id is not usable: ${sessionId}`);
    }
    return this.#withDatabase((db) => {
      const composer = readComposerRecord(db, sessionId);
      if (!composer) throw new ExternalSessionNotFoundError();
      const name = sanitizeExternalSessionTitle(composer.name) || sessionId;
      const headers = Array.isArray(composer.fullConversationHeadersOnly)
        ? composer.fullConversationHeadersOnly
        : [];
      if (headers.length > this.#maxRows) {
        throw new ExternalSessionLimitError(
          'records',
          this.#maxRows,
          `Cursor transcript exceeds ${this.#maxRows} source rows`,
        );
      }
      const bubbles = readBubbles(db, sessionId, headers, this.#maxRawBytes);
      return {
        sourceSessionId: sessionId,
        metadata: {
          name,
          cwd: '',
        },
        messages: convertTranscript(sessionId, bubbles, {
          fallbackTs: composer.lastUpdatedAt ?? composer.createdAt ?? 0,
          maxConvertedBytes: this.#maxConvertedBytes,
          maxMessages: this.#maxMessages,
        }),
      };
    });
  }

  async #resolvedDatabasePath(): Promise<string | undefined> {
    const path = this.#stateDbPath ?? join(this.#home, 'state.vscdb');
    // The path ships with spaces on every platform ("Application Support");
    // this adapter only ever opens it through the driver, never through a
    // shell or a URI, so the spaces need no escaping here.
    try {
      return (await stat(path)).isFile() ? path : undefined;
    } catch {
      return undefined;
    }
  }

  async #withDatabase<T>(read: (db: CursorDatabase) => T): Promise<T> {
    const path = await this.#resolvedDatabasePath();
    if (!path) throw new Error('cursor database is unavailable');
    let sqlite: typeof import('node:sqlite');
    try {
      sqlite = await import('node:sqlite');
    } catch (cause) {
      throw new Error('cursor sessions need node:sqlite, which is unavailable', { cause });
    }
    let db: CursorDatabase;
    try {
      db = new sqlite.DatabaseSync(path, { readOnly: true }) as CursorDatabase;
    } catch (cause) {
      throw new Error(`cursor database could not be opened: ${path}`, { cause });
    }
    try {
      return read(db);
    } catch (cause) {
      if (
        cause instanceof ExternalSessionLimitError ||
        cause instanceof ExternalSessionNotFoundError ||
        (cause instanceof Error && cause.message.startsWith('cursor session '))
      ) {
        throw cause;
      }
      throw new Error(`cursor database could not be read: ${path}`, { cause });
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
    // sources are present, and a Cursor install that never opened a composer
    // is a normal state rather than a failure to report.
    if (!(await this.#resolvedDatabasePath())) return [];
    return await this.#withDatabase((db) => {
      const required = ['key', 'value'];
      const actual = tableColumns(db, 'cursorDiskKV');
      if (required.some((column) => !actual.has(column))) {
        throw new Error('cursor `cursorDiskKV` table does not carry required columns');
      }
      const requestedOffset = query.offset ?? 0;
      const requestedLimit = query.limit ?? Number.MAX_SAFE_INTEGER;
      if (
        !Number.isSafeInteger(requestedOffset) ||
        requestedOffset < 0 ||
        !Number.isSafeInteger(requestedLimit) ||
        requestedLimit < 0
      ) {
        throw new Error('Invalid Cursor catalog page');
      }
      if (requestedLimit === 0) return [];
      const statement = db.prepare(
        `SELECT key, value FROM cursorDiskKV
         WHERE key LIKE 'composerData:%'
           AND length(CAST(key AS BLOB)) <= ${CURSOR_COMPOSER_KEY_MAX_BYTES}
         ORDER BY key`,
      );
      const summaries: ExternalSessionSummary[] = [];
      let matched = 0;
      for (const raw of statement.all()) {
        const composer = parseComposerRow(raw);
        if (!composer) continue;
        const summary = toSummary(composer);
        if (!externalSessionMatchesQuery(summary, query)) continue;
        if (matched++ < requestedOffset) continue;
        summaries.push(summary);
        if (summaries.length === requestedLimit) break;
      }
      return summaries;
    });
  }
}

/**
 * `composerData:` + uuid + NUL-safety margin. The bound rides in the SQL so a
 * foreign key shape cannot pull an unbounded row set into memory.
 */
const CURSOR_COMPOSER_KEY_MAX_BYTES = CURSOR_CATALOG_ID_MAX_BYTES + 64;

interface CursorDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}

interface ComposerRecord {
  readonly composerId?: string;
  readonly name?: string;
  readonly createdAt?: number;
  readonly lastUpdatedAt?: number;
  readonly fullConversationHeadersOnly?: readonly unknown[];
}

/** One decoded bubble: the record this build reads, foreign fields ignored. */
export interface CursorBubble {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly createdAt?: unknown;
  readonly toolFormerData?: unknown;
}

function readComposerRecord(db: CursorDatabase, sessionId: string): ComposerRecord | undefined {
  const raw = db
    .prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
    .get(`composerData:${sessionId}`);
  return parseComposerRow(raw);
}

/**
 * Walks a composer's headers in recorded order and fetches each bubble.
 *
 * A header whose bubble row is gone is a pruned transcript, not a broken
 * database: the gap is skipped and the rest of the conversation imports. One
 * bubble larger than the byte budget refuses the session (`record_bytes`)
 * rather than importing a truncated message, and the running total refuses at
 * `transcript_bytes`.
 */
function readBubbles(
  db: CursorDatabase,
  sessionId: string,
  headers: readonly unknown[],
  maxRawBytes: number,
): readonly CursorBubble[] {
  const statement = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
  const bubbles: CursorBubble[] = [];
  let totalBytes = 0;
  for (const header of headers) {
    const bubbleId = stringOf(asRecord(header)?.bubbleId);
    if (bubbleId === undefined) continue;
    const raw = statement.get(`bubbleId:${sessionId}:${bubbleId}`);
    const value = stringOf(rawValue(raw));
    if (value === undefined) continue;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > maxRawBytes) {
      throw new ExternalSessionLimitError(
        'record_bytes',
        maxRawBytes,
        `Cursor transcript contains a source record larger than ${maxRawBytes} bytes`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > maxRawBytes) {
      throw new ExternalSessionLimitError(
        'transcript_bytes',
        maxRawBytes,
        `Cursor transcript exceeds ${maxRawBytes} source bytes`,
      );
    }
    const bubble = parseBubble(value);
    if (bubble) bubbles.push(bubble);
  }
  return bubbles;
}

function parseBubble(value: string): CursorBubble | undefined {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as CursorBubble;
    }
  } catch {
    // A bubble this build cannot decode is a gap in the transcript, not a
    // failure of the import: the rest of the conversation still converts.
  }
  return undefined;
}

/**
 * Turns one Cursor composer's bubbles into Maka messages.
 *
 * Exported for the fixture tests, which exercise the mapping without a
 * database: the conversion is where the source format is interpreted, and it
 * is the part worth pinning.
 */
export function convertTranscript(
  sessionId: string,
  bubbles: readonly CursorBubble[],
  limits: {
    fallbackTs?: number;
    maxConvertedBytes?: number;
    maxMessages?: number;
  } = {},
): readonly StoredMessage[] {
  const maxConvertedBytes = limits.maxConvertedBytes ?? CURSOR_TRANSCRIPT_MAX_CONVERTED_BYTES;
  const maxMessages = limits.maxMessages ?? CURSOR_TRANSCRIPT_MAX_MESSAGES;
  const fallbackTs = limits.fallbackTs ?? 0;

  const out: StoredMessage[] = [];
  let convertedBytes = 0;
  const append = (message: StoredMessage): void => {
    if (out.length >= maxMessages) {
      throw new ExternalSessionLimitError(
        'messages',
        maxMessages,
        `Cursor transcript converts to more than ${maxMessages} messages`,
      );
    }
    const encodedBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (encodedBytes > maxConvertedBytes - convertedBytes) {
      throw new ExternalSessionLimitError(
        'converted_bytes',
        maxConvertedBytes,
        `Cursor transcript converts to more than ${maxConvertedBytes} bytes`,
      );
    }
    convertedBytes += encodedBytes;
    out.push(message);
  };
  let sequence = 0;
  const id = (kind: string): string => `cursor:${sessionId}:${kind}:${sequence++}`;
  let turnSequence = 0;

  interface Turn {
    turnId: string;
    lastTs: number;
    sawErrorTool: boolean;
    sawCancelledTool: boolean;
  }
  let turn: Turn | undefined;

  const closeTurn = (): void => {
    if (!turn) return;
    if (turn.sawErrorTool) {
      append({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'failed',
        errorClass: 'cursor_error',
      });
    } else if (turn.sawCancelledTool) {
      append({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'aborted',
        abortedAt: turn.lastTs,
        abortSource: EXTERNAL_SNAPSHOT_ABORT_SOURCE,
      });
    } else {
      append({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'completed',
      });
    }
    turn = undefined;
  };

  for (const bubble of bubbles) {
    const ts = bubbleTimestamp(bubble.createdAt) ?? fallbackTs;

    if (bubble.type === 1) {
      // A user message closes whatever came before it either way: it is the
      // boundary, whether or not it carries a prompt this import can use.
      closeTurn();
      const text = stringOf(bubble.text) ?? '';
      if (text.length === 0) continue;
      turn = {
        turnId: `cursor:${sessionId}:turn:${turnSequence++}`,
        lastTs: ts,
        sawErrorTool: false,
        sawCancelledTool: false,
      };
      append({ type: 'user', id: id('user'), turnId: turn.turnId, ts, text });
      continue;
    }

    if (bubble.type !== 2) continue;

    if (!turn) {
      // An assistant bubble with no preceding user message: a resumed session
      // whose opening prompt is not in this transcript. Give it a turn rather
      // than dropping the content.
      turn = {
        turnId: `cursor:${sessionId}:turn:${turnSequence++}`,
        lastTs: ts,
        sawErrorTool: false,
        sawCancelledTool: false,
      };
    }
    turn.lastTs = Math.max(turn.lastTs, ts);

    const text = stringOf(bubble.text);
    if (text !== undefined && text.length > 0) {
      append({
        type: 'assistant',
        id: id('assistant'),
        turnId: turn.turnId,
        ts,
        text,
        contentOrder: ['text'],
        modelId: 'cursor',
      });
    }

    const tool = asRecord(bubble.toolFormerData);
    if (!tool) continue;
    const callId = stringOf(tool.toolCallId);
    // A call with no id cannot be paired with its result. Minting one
    // produces a row guaranteed not to match anything, which reads as a
    // detached call rather than an absent one.
    if (callId === undefined) continue;
    const status = stringOf(tool.status);
    append({
      type: 'tool_call',
      id: callId,
      turnId: turn.turnId,
      ts,
      toolName: stringOf(tool.name) ?? 'unknown',
      args: parseJsonObject(tool.params),
    });
    if (status === 'completed') {
      append({
        type: 'tool_result',
        id: id('tool-result'),
        turnId: turn.turnId,
        ts,
        toolUseId: callId,
        isError: false,
        content: { kind: 'text', text: stringOf(tool.result) ?? '' },
      });
      continue;
    }
    if (status === 'error') {
      turn.sawErrorTool = true;
      append({
        type: 'tool_result',
        id: id('tool-result'),
        turnId: turn.turnId,
        ts,
        toolUseId: callId,
        isError: true,
        content: {
          kind: 'text',
          text: stringOf(tool.result) ?? 'cursor tool call failed',
        },
      });
      continue;
    }
    // A cancelled (or otherwise unfinished) call had no answer when the
    // session was written: no result, and the turn records the abort.
    turn.sawCancelledTool = true;
  }

  closeTurn();
  return out;
}

function bubbleTimestamp(value: unknown): number | undefined {
  // Bubbles stamp ISO strings; the composer record stamps epoch millis. Both
  // are read, because a fixture (or a future Cursor) may write either.
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return numberOf(value);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Foreign params shape: the call still imports with empty args rather
      // than failing the record.
    }
  }
  return asRecord(value) ?? {};
}

function parseComposerRow(raw: unknown): ComposerRecord | undefined {
  const value = rawValue(raw);
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        composerId: stringOf(record.composerId),
        name: stringOf(record.name),
        createdAt: numberOf(record.createdAt),
        lastUpdatedAt: numberOf(record.lastUpdatedAt),
        fullConversationHeadersOnly: Array.isArray(record.fullConversationHeadersOnly)
          ? (record.fullConversationHeadersOnly as unknown[])
          : undefined,
      };
    }
  } catch {
    // Foreign record shape: skipped by the caller, the way a catalog skips a
    // row it cannot read rather than failing the whole listing.
  }
  return undefined;
}

function toSummary(composer: ComposerRecord): ExternalSessionSummary {
  const updatedAt = composer.lastUpdatedAt ?? composer.createdAt;
  const id = composer.composerId ?? '';
  return {
    id,
    name: sanitizeExternalSessionTitle(composer.name) || id,
    cwd: '',
    ...(composer.createdAt !== undefined ? { createdAt: composer.createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

function rawValue(row: unknown): unknown {
  return asRecord(row)?.value;
}

function tableColumns(db: CursorDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
  return new Set(
    rows.map((column) => (typeof column.name === 'string' ? column.name : '')).filter(Boolean),
  );
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

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive`);
}
