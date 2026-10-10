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

import { createHash } from 'node:crypto';
import { open, opendir, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { StoredMessage } from '@maka/core/session';
import {
  ExternalSessionCatalogCursorError,
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
import { externalSessionCatalogQueryHash } from './offset-external-session-catalog.js';

export const CODEX_SESSION_ADAPTER_ID = 'codex';
export const CODEX_ROLLOUT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const CODEX_CATALOG_MAX_CANDIDATES = 100_000;

const CODEX_ROLLOUT_HEAD_BYTES = 512 * 1024;
const CODEX_ROLLOUT_READ_BYTES = 64 * 1024;
const CODEX_ROLLOUT_MAX_RECORD_BYTES = 64 * 1024 * 1024;
const CODEX_ROLLOUT_MAX_CONVERTED_BYTES = 256 * 1024 * 1024;
const CODEX_ROLLOUT_MAX_MESSAGES = 250_000;
const CODEX_EPOCH_MS_SQL_FUNCTION = 'maka_codex_epoch_ms';
const CODEX_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CODEX_SUPPORTED_THREAD_SOURCES = ['cli', 'exec', 'vscode', 'atlas', 'chatgpt'] as const;
const CODEX_UNSAFE_PATH_CHARS =
  /[\u0000-\u001F\u007F\u0080-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

export interface CodexSessionAdapterOptions {
  /** Codex's state root. Defaults to `$CODEX_HOME`, then `~/.codex`. */
  codexHome?: string;
  /** Maximum source bytes scanned from one fixed rollout snapshot. */
  maxRolloutBytes?: number;
  /** Maximum bytes buffered for one JSONL record. */
  maxRecordBytes?: number;
  /** Maximum serialized bytes retained across converted messages. */
  maxConvertedBytes?: number;
  /** Maximum number of converted messages retained in memory. */
  maxMessages?: number;
  /** Maximum rollout files examined by one filesystem catalog query. */
  maxCatalogCandidates?: number;
}

interface CodexCatalogEntry extends ExternalSessionSummary {
  rolloutPath: string;
}

interface CodexThreadRow {
  id?: unknown;
  rollout_path?: unknown;
  cwd?: unknown;
  name?: unknown;
  title?: unknown;
  preview?: unknown;
  first_user_message?: unknown;
  created_at_ms?: unknown;
  created_at?: unknown;
  updated_at_ms?: unknown;
  updated_at?: unknown;
  archived?: unknown;
  source?: unknown;
  sort_key?: unknown;
}

interface CodexThreadQuery {
  readonly sql: string;
  readonly params: readonly (string | number)[];
}

type JsonRecord = Record<string, unknown>;

type CodexCatalogKeyset =
  | {
      readonly kind: 'database';
      readonly stateDatabase: string;
      readonly sortTimestamp: number;
      readonly id: string;
    }
  | { readonly kind: 'filesystem'; readonly mtimeMs: number; readonly pathIdentity: string };

/**
 * Read-only adapter for Codex rollout JSONL.
 *
 * Codex persists presentation history as `event_msg` records and provider
 * protocol facts as `response_item` records. Presentation messages use either
 * the legacy `user_message` / `agent_*` events or the newer `item_completed`
 * event. Reading both shapes from `event_msg` avoids importing their
 * response-item mirrors twice. Tool calls/results come from response items
 * because they own the stable call identity and raw arguments/output.
 */
export class CodexSessionAdapter implements ExternalSessionAdapter {
  readonly id = CODEX_SESSION_ADAPTER_ID;

  private readonly codexHome: string;
  private readonly maxRolloutBytes: number;
  private readonly maxRecordBytes: number;
  private readonly maxConvertedBytes: number;
  private readonly maxMessages: number;
  private readonly maxCatalogCandidates: number;

  constructor(options: CodexSessionAdapterOptions = {}) {
    this.codexHome = resolve(
      options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    );
    this.maxRolloutBytes = options.maxRolloutBytes ?? CODEX_ROLLOUT_MAX_BYTES;
    this.maxRecordBytes = options.maxRecordBytes ?? CODEX_ROLLOUT_MAX_RECORD_BYTES;
    this.maxConvertedBytes = options.maxConvertedBytes ?? CODEX_ROLLOUT_MAX_CONVERTED_BYTES;
    this.maxMessages = options.maxMessages ?? CODEX_ROLLOUT_MAX_MESSAGES;
    this.maxCatalogCandidates = options.maxCatalogCandidates ?? CODEX_CATALOG_MAX_CANDIDATES;
    assertPositiveSafeInteger(this.maxRolloutBytes, 'Codex rollout byte limit');
    assertPositiveSafeInteger(this.maxRecordBytes, 'Codex rollout record byte limit');
    assertPositiveSafeInteger(this.maxConvertedBytes, 'Codex converted message byte limit');
    assertPositiveSafeInteger(this.maxMessages, 'Codex converted message count limit');
    assertPositiveSafeInteger(this.maxCatalogCandidates, 'Codex catalog candidate limit');
  }

  async detect(): Promise<boolean> {
    return (
      (await isDirectory(join(this.codexHome, 'sessions'))) ||
      (await isDirectory(join(this.codexHome, 'archived_sessions'))) ||
      (await codexStateDbsNewestFirst(this.codexHome)).length > 0
    );
  }

  async listSessionPage(
    query: ExternalSessionCatalogPageQuery,
  ): Promise<ExternalSessionCatalogPage> {
    const limit = query.limit ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid Codex catalog page');
    if (limit === 0) return { items: [], hasMore: false };
    return this.listCatalogKeysetPage(query, limit);
  }

  async readSession(sessionId: string): Promise<ExternalMakaSession> {
    assertSafeCodexSessionId(sessionId);
    const found = await this.findCatalogEntry(sessionId);
    if (!found) throw new ExternalSessionNotFoundError();
    const { entry: catalogEntry, fromStateDatabase } = found;

    const rollouts = lazyRolloutIndex(this.codexHome);
    // Codex's state row selects the thread's current rollout. Without one,
    // Codex takes the newest file named for the thread, and so does this.
    const current = fromStateDatabase
      ? catalogEntry.rolloutPath
      : ((await this.newestThreadRollout(sessionId, rollouts)) ?? catalogEntry.rolloutPath);
    const segments = await this.rolloutLineage(current, sessionId, rollouts);
    return convertCodexRollout(segments, sessionId, catalogEntry.name, catalogEntry.cwd, {
      maxRolloutBytes: this.maxRolloutBytes,
      maxRecordBytes: this.maxRecordBytes,
      maxConvertedBytes: this.maxConvertedBytes,
      maxMessages: this.maxMessages,
    });
  }

  /**
   * The rollout ranges that make up a thread's history, oldest first.
   *
   * Codex never rewrites a rollout. `thread/revert` starts a new file for the
   * same thread, `rollout-<ts>-<threadId>_<rolloutId>.jsonl`, whose
   * `session_meta.history_base` names the rollout it continues and the byte
   * offset where the kept history ends, then moves the state row to it. What
   * follows that offset was reverted (typically an interrupted turn whose
   * message was then edited and sent again) and is no longer part of the
   * thread. Codex rebuilds history by following those pointers, and so does
   * this; the older files are never read past the offset their successor keeps.
   */
  private async rolloutLineage(
    currentPath: string,
    sessionId: string,
    rollouts: () => Promise<Map<string, IndexedRollout>>,
  ): Promise<RolloutSegment[]> {
    const segments: RolloutSegment[] = [];
    let path = await this.resolveRolloutPath(currentPath, sessionId);
    if (!path) throw new ExternalSessionNotFoundError();
    // Every later rollout of a thread is one a revert started, so a history
    // base in the opening rollout can only be a fork's, into its parent. The
    // converter still checks that the file names the thread.
    if (isOpeningRolloutFilename(basename(path), sessionId)) return [{ path }];
    let endByteOffset: number | undefined;
    for (;;) {
      if (segments.some((segment) => segment.path === path)) {
        throw new Error(`Codex rollout history loops back on itself: expected ${sessionId}`);
      }
      // A file name is not proof of what a rollout holds, and the file the
      // state row names is no exception: each range must name the thread.
      const meta = await readRolloutHeadMeta(path, sessionId);
      if (meta?.id !== sessionId) {
        throw new Error(`Codex rollout Session id mismatch: expected ${sessionId}`);
      }
      segments.push(endByteOffset === undefined ? { path } : { path, endByteOffset });
      const base = meta.historyBase;
      if (!base) break;
      // No candidate cap here: the catalog cap guards a listing that would
      // otherwise grow without bound, whereas this lookup keeps one file per
      // rollout, and a store too large to list must not also become a store
      // whose reverted threads cannot be imported.
      const located = (await rollouts()).get(base.rolloutId);
      // Missing history fails the import rather than quietly shortening it.
      if (!located) throw new Error(`Codex rollout history base is missing: expected ${sessionId}`);
      // A fork's history starts in its parent's rollout, which belongs to the
      // parent thread; this thread's own history ends here.
      if (located.threadId !== sessionId) break;
      path = await this.resolveRolloutPath(located.path, sessionId);
      if (!path) throw new Error(`Codex rollout history base is missing: expected ${sessionId}`);
      endByteOffset = base.endByteOffset;
    }
    return segments.reverse();
  }

  private async newestThreadRollout(
    sessionId: string,
    rollouts: () => Promise<Map<string, IndexedRollout>>,
  ): Promise<string | undefined> {
    // The timestamps in the names make a code-unit sort chronological.
    const named = [...(await rollouts()).values()]
      .filter((rollout) => rollout.threadId === sessionId)
      .map((rollout) => rollout.path)
      .sort((left, right) => (basename(left) < basename(right) ? 1 : -1));
    for (const candidate of named) {
      const path = await this.resolveRolloutPath(candidate, sessionId);
      if (path && (await readRolloutHeadMeta(path, sessionId))?.id === sessionId) return path;
    }
    return undefined;
  }

  private async findCatalogEntry(
    sessionId: string,
  ): Promise<{ entry: CodexCatalogEntry; fromStateDatabase: boolean } | undefined> {
    for (const dbPath of await codexStateDbsNewestFirst(this.codexHome)) {
      const rows = await readCodexThreadRows(dbPath, { includeArchived: true }, sessionId);
      if (rows === undefined) continue;
      for (const row of rows) {
        const entry = await this.entryFromRow(row);
        if (entry?.id === sessionId) return { entry, fromStateDatabase: true };
      }
      break;
    }

    const entry = await this.findRolloutEntry(sessionId);
    return entry ? { entry, fromStateDatabase: false } : undefined;
  }

  private async entryFromRow(row: CodexThreadRow): Promise<CodexCatalogEntry | undefined> {
    if (!isSafeCodexSessionId(row.id)) return undefined;
    if (typeof row.rollout_path !== 'string' || row.rollout_path.length === 0) return undefined;
    if (!isSupportedCodexThreadSource(row.source)) return undefined;

    const rolloutPath = await this.resolveRolloutPath(row.rollout_path, row.id);
    if (!rolloutPath) return undefined;
    const name =
      firstNonEmptyTitle(row.name, row.title, row.preview, row.first_user_message) ?? row.id;
    const createdAt = normalizeEpochMs(row.created_at_ms) ?? normalizeEpochMs(row.created_at);
    const updatedAt = normalizeEpochMs(row.updated_at_ms) ?? normalizeEpochMs(row.updated_at);

    return {
      id: row.id,
      name,
      cwd: safeCodexCwd(row.cwd),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      archived: row.archived === true || row.archived === 1,
      rolloutPath,
    };
  }

  private async listCatalogKeysetPage(
    query: ExternalSessionCatalogPageQuery,
    limit: number,
  ): Promise<ExternalSessionCatalogPage> {
    const keyset = decodeCatalogKeyset(query.cursor, query);
    if (keyset?.kind === 'database') {
      const stateDatabases = await codexStateDbsNewestFirst(this.codexHome);
      const dbPath = stateDatabases.find(
        (candidate) => basename(candidate) === keyset.stateDatabase,
      );
      if (!dbPath) throw new ExternalSessionCatalogCursorError();
      const page = await this.readStateCatalogKeysetPage(dbPath, query, keyset, limit);
      if (!page) throw new ExternalSessionCatalogCursorError();
      return page;
    }
    if (!keyset) {
      for (const dbPath of await codexStateDbsNewestFirst(this.codexHome)) {
        let page: ExternalSessionCatalogPage | undefined;
        try {
          page = await this.readStateCatalogKeysetPage(dbPath, query, keyset, limit);
        } catch {
          // Stop the whole ladder, not just this generation. A `state_*.sqlite`
          // Codex is rewriting can be unreadable this instant, and the answer
          // is not to settle for an older one: a lower generation is the
          // snapshot frozen at the last bump, so everything created since is
          // missing from it. Continuing would turn a transient read failure
          // into a quietly truncated list. The rollout scan below is the one
          // source still known to be complete, so the page belongs to it.
          // The `d:` cursor branch above stays loud — a cursor names its
          // generation and must fail rather than switch corpora.
          break;
        }
        if (page !== undefined) return page;
      }
    }

    const candidates = await nextRolloutCatalogBatch(
      this.codexHome,
      query,
      keyset?.kind === 'filesystem' ? keyset : undefined,
      limit + 1,
      this.maxCatalogCandidates,
      (candidate, id) => this.resolveRolloutPath(candidate.path, id),
    );
    const items = candidates.slice(0, limit).map(({ candidate, summary }) => ({
      summary,
      nextCursor: encodeCatalogKeyset(query, candidateKeyset(candidate)),
    }));
    return { items, hasMore: candidates.length > items.length };
  }

  private async readStateCatalogKeysetPage(
    dbPath: string,
    query: ExternalSessionCatalogPageQuery,
    keyset: CodexCatalogKeyset | undefined,
    limit: number,
  ): Promise<ExternalSessionCatalogPage | undefined> {
    if (keyset?.kind === 'filesystem') return undefined;
    let db: DatabaseSync | undefined;
    try {
      const sqlite = await import('node:sqlite');
      db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      registerCodexEpochNormalization(db);
      const spec = codexThreadQuery(db, query, undefined, keyset);
      if (!spec) return undefined;
      const items: ExternalSessionCatalogPage['items'][number][] = [];
      for (const row of db.prepare(spec.sql).iterate(...spec.params) as Iterable<CodexThreadRow>) {
        const entry = await this.entryFromRow(row);
        if (!entry || !matchesQuery(entry, query)) continue;
        if (items.length === limit) return { items, hasMore: true };
        const { rolloutPath: _rolloutPath, ...summary } = entry;
        items.push({
          summary,
          nextCursor: encodeCatalogKeyset(query, {
            kind: 'database',
            stateDatabase: basename(dbPath),
            sortTimestamp: codexRowSortTimestamp(row),
            id: entry.id,
          }),
        });
      }
      return { items, hasMore: false };
    } finally {
      db?.close();
    }
  }

  private async findRolloutEntry(sessionId: string): Promise<CodexCatalogEntry | undefined> {
    for (const [root, archived] of [
      [join(this.codexHome, 'sessions'), false],
      [join(this.codexHome, 'archived_sessions'), true],
    ] as const) {
      for await (const candidate of iterateRolloutFiles(root, archived)) {
        if (!isOpeningRolloutFilename(basename(candidate.path), sessionId)) continue;
        const head = await readUtf8Prefix(candidate.path, CODEX_ROLLOUT_HEAD_BYTES).catch(
          () => undefined,
        );
        if (head === undefined) continue;
        const entry = catalogEntryFromRolloutHead(head, candidate);
        if (entry?.id !== sessionId) continue;
        const rolloutPath = await this.resolveRolloutPath(candidate.path, sessionId);
        if (rolloutPath) return { ...entry, rolloutPath };
      }
    }
    return undefined;
  }

  private async resolveRolloutPath(
    candidatePath: string,
    expectedId: string,
  ): Promise<string | undefined> {
    try {
      const root = await realpath(this.codexHome);
      const candidate = await realpath(resolve(candidatePath));
      if (candidate !== root && !candidate.startsWith(root + sep)) return undefined;
      if (!rolloutFilenameMatchesId(basename(candidate), expectedId)) return undefined;
      if (!(await stat(candidate)).isFile()) return undefined;
      return candidate;
    } catch {
      return undefined;
    }
  }
}

interface RolloutCandidate {
  path: string;
  catalogIdentity: string;
  mtimeMs: number;
  archived: boolean;
}

interface CodexRolloutLimits {
  maxRolloutBytes: number;
  maxRecordBytes: number;
  maxConvertedBytes: number;
  maxMessages: number;
}

interface ParsedRolloutRecord {
  line: number;
  value: JsonRecord;
}

interface RolloutReadCursor {
  line: number;
  bytes: number;
}

interface RolloutSegment {
  path: string;
  /** Where the thread's history leaves this rollout; the whole file when absent. */
  endByteOffset?: number;
}

interface IndexedRollout {
  threadId: string;
  path: string;
}

interface RolloutHeadMeta {
  id: string | undefined;
  historyBase: { rolloutId: string; endByteOffset: number } | undefined;
}

async function convertCodexRollout(
  segments: readonly RolloutSegment[],
  expectedSessionId: string,
  fallbackName: string,
  fallbackCwd: string,
  limits: CodexRolloutLimits,
): Promise<ExternalMakaSession> {
  const converter = new CodexRolloutConverter(expectedSessionId, fallbackName, fallbackCwd, limits);
  // Line numbers and the byte budget run across the whole lineage: generated
  // message ids are keyed by line, so restarting per file would collide.
  const cursor: RolloutReadCursor = { line: 0, bytes: 0 };
  for (const { path, endByteOffset } of segments) {
    converter.beginRollout();
    for await (const record of readCodexRolloutRecords(
      path,
      expectedSessionId,
      limits,
      cursor,
      endByteOffset,
    )) {
      converter.accept(record);
    }
  }
  return converter.finish();
}

class CodexRolloutConverter {
  private readonly messages: StoredMessage[] = [];
  private readonly failedTurnIds = new Set<string>();
  private activeTurnId: string | undefined;
  private activeTurnIsExplicit = false;
  private activeModel = 'codex';
  private lastTimestamp = 0;
  private firstUserText: string | undefined;
  private metaCwd = '';
  private hasSessionMeta = false;
  private awaitingRolloutMeta = false;
  private convertedBytes = 0;

  constructor(
    private readonly expectedSessionId: string,
    private readonly fallbackName: string,
    private readonly fallbackCwd: string,
    private readonly limits: CodexRolloutLimits,
  ) {}

  /**
   * Marks the start of the next rollout file of the thread, whose own
   * `session_meta` must name the thread too: an earlier rollout is located by
   * file name, and a name is not proof of ownership.
   */
  beginRollout(): void {
    this.awaitingRolloutMeta = true;
  }

  accept(record: ParsedRolloutRecord): void {
    const envelope = record.value;
    if (envelope.type === 'session_meta' && this.awaitingRolloutMeta) {
      this.awaitingRolloutMeta = false;
      const metaPayload = asRecord(envelope.payload);
      const actualSessionId =
        stringField(metaPayload, 'session_id') ?? stringField(metaPayload, 'id');
      if (actualSessionId !== this.expectedSessionId) {
        throw new Error(`Codex rollout Session id mismatch: expected ${this.expectedSessionId}`);
      }
      if (this.hasSessionMeta) return;
      this.hasSessionMeta = true;
      this.metaCwd = safeCodexCwd(metaPayload?.cwd);
      this.activeModel = stringField(metaPayload, 'model_provider') ?? this.activeModel;
      const timestamp = normalizeEpochMs(envelope.timestamp);
      if (timestamp !== undefined) this.lastTimestamp = Math.max(this.lastTimestamp, timestamp);
      return;
    }

    // `hasSessionMeta` is lineage-wide, so the opening file's metadata would
    // otherwise vouch for every later file. Each rollout proves its own.
    if (this.awaitingRolloutMeta) {
      throw new Error(
        `Codex rollout records precede its Session metadata: expected ${this.expectedSessionId}`,
      );
    }

    const payload = asRecord(envelope.payload);
    if (!payload) return;

    if (envelope.type === 'turn_context') {
      this.activeTurnId = stringField(payload, 'turn_id') ?? this.activeTurnId;
      this.activeModel = stringField(payload, 'model') ?? this.activeModel;
      return;
    }

    if (envelope.type === 'event_msg') {
      const eventType = stringField(payload, 'type');
      if (eventType === 'task_started' || eventType === 'turn_started') {
        const turnId = stringField(payload, 'turn_id');
        if (turnId) {
          this.activeTurnId = turnId;
          this.activeTurnIsExplicit = true;
        }
        return;
      }

      if (eventType === 'item_completed') {
        const item = asRecord(payload.item);
        const itemType = stringField(item, 'type')?.toLowerCase();
        const eventTurnId = stringField(payload, 'turn_id');
        if (eventTurnId) {
          this.activeTurnId = eventTurnId;
          this.activeTurnIsExplicit = true;
        }

        if (itemType === 'usermessage') {
          if (!this.activeTurnIsExplicit) {
            this.activeTurnId = generatedCodexId(this.expectedSessionId, 'turn', record.line);
          }
          const text = codexCompletedItemText(item) || codexCompletedItemMediaText(item);
          if (text.length === 0) return;
          this.firstUserText ??= text;
          this.append({
            type: 'user',
            id:
              stringField(item, 'client_id') ??
              stringField(item, 'id') ??
              generatedCodexId(this.expectedSessionId, 'user', record.line),
            turnId: this.ensureTurnId(record.line),
            ts: this.timestampFor(record),
            text,
          });
          return;
        }

        if (itemType === 'agentmessage') {
          const text = codexCompletedItemText(item);
          if (text.length === 0) return;
          const providerOptions = codexAssistantProviderOptions(item);
          this.append({
            type: 'assistant',
            id:
              stringField(item, 'id') ??
              generatedCodexId(this.expectedSessionId, 'assistant', record.line),
            turnId: this.ensureTurnId(record.line),
            ts: this.timestampFor(record),
            text,
            ...(providerOptions !== undefined ? { providerOptions } : {}),
            modelId: this.activeModel,
            contentOrder: ['text'],
          });
          return;
        }

        if (itemType === 'reasoning') {
          const reasoning = codexCompletedReasoningText(item);
          if (reasoning.length === 0) return;
          this.append({
            type: 'assistant',
            id:
              stringField(item, 'id') ??
              generatedCodexId(this.expectedSessionId, 'reasoning', record.line),
            turnId: this.ensureTurnId(record.line),
            ts: this.timestampFor(record),
            text: '',
            thinking: { text: reasoning },
            contentOrder: ['thinking'],
            modelId: this.activeModel,
          });
          return;
        }
      }

      if (eventType === 'user_message') {
        if (!this.activeTurnIsExplicit) {
          this.activeTurnId = generatedCodexId(this.expectedSessionId, 'turn', record.line);
        }
        const text = stringField(payload, 'message') ?? mediaOnlyUserText(payload);
        if (text.length === 0) return;
        this.firstUserText ??= text;
        const turnId = this.ensureTurnId(record.line);
        this.append({
          type: 'user',
          id:
            stringField(payload, 'client_id') ??
            generatedCodexId(this.expectedSessionId, 'user', record.line),
          turnId,
          ts: this.timestampFor(record),
          text,
        });
        return;
      }

      if (eventType === 'agent_message') {
        const text = stringField(payload, 'message');
        if (!text) return;
        const providerOptions = codexAssistantProviderOptions(payload);
        this.append({
          type: 'assistant',
          id: generatedCodexId(this.expectedSessionId, 'assistant', record.line),
          turnId: this.ensureTurnId(record.line),
          ts: this.timestampFor(record),
          text,
          ...(providerOptions !== undefined ? { providerOptions } : {}),
          modelId: this.activeModel,
          contentOrder: ['text'],
        });
        return;
      }

      if (eventType === 'agent_reasoning') {
        const reasoning = stringField(payload, 'text');
        if (!reasoning) return;
        this.append({
          type: 'assistant',
          id: generatedCodexId(this.expectedSessionId, 'reasoning', record.line),
          turnId: this.ensureTurnId(record.line),
          ts: this.timestampFor(record),
          text: '',
          thinking: { text: reasoning },
          contentOrder: ['thinking'],
          modelId: this.activeModel,
        });
        return;
      }

      if (eventType === 'context_compacted') {
        this.append({
          type: 'system_note',
          id: generatedCodexId(this.expectedSessionId, 'compact', record.line),
          turnId: this.activeTurnId,
          ts: this.timestampFor(record),
          kind: 'context_compacted',
        });
        return;
      }

      if (eventType === 'error') {
        if (this.activeTurnId && codexErrorAffectsTurnStatus(payload)) {
          this.failedTurnIds.add(this.activeTurnId);
        }
        this.append({
          type: 'system_note',
          id: generatedCodexId(this.expectedSessionId, 'error', record.line),
          turnId: this.activeTurnId,
          ts: this.timestampFor(record),
          kind: 'error',
          data: JSON.parse(JSON.stringify(payload)) as unknown,
        });
        return;
      }

      if (eventType === 'task_complete' || eventType === 'turn_complete') {
        const turnId = stringField(payload, 'turn_id') ?? this.ensureTurnId(record.line);
        const failed = this.failedTurnIds.has(turnId) || payload.error != null;
        this.append({
          type: 'turn_state',
          id: generatedCodexId(this.expectedSessionId, 'turn-state', record.line),
          turnId,
          ts: this.timestampFor(record),
          status: failed ? 'failed' : 'completed',
          ...(failed ? { errorClass: 'codex_error' } : {}),
        });
        this.failedTurnIds.delete(turnId);
        if (this.activeTurnId === turnId) {
          this.activeTurnId = undefined;
          this.activeTurnIsExplicit = false;
        }
        return;
      }

      if (eventType === 'turn_aborted') {
        const turnId = stringField(payload, 'turn_id') ?? this.ensureTurnId(record.line);
        const ts = this.timestampFor(record);
        this.append({
          type: 'turn_state',
          id: generatedCodexId(this.expectedSessionId, 'turn-state', record.line),
          turnId,
          ts,
          status: 'aborted',
          abortedAt: normalizeEpochMs(payload.completed_at) ?? ts,
          abortSource: stringField(payload, 'reason') ?? 'codex',
        });
        if (this.activeTurnId === turnId) {
          this.activeTurnId = undefined;
          this.activeTurnIsExplicit = false;
        }
        return;
      }
    }

    if (envelope.type !== 'response_item') return;
    const itemType = stringField(payload, 'type');
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const callId = stringField(payload, 'call_id');
      const toolName = namespacedToolName(payload);
      if (!callId || !toolName) return;
      const rawArgs =
        itemType === 'function_call'
          ? stringField(payload, 'arguments')
          : stringField(payload, 'input');
      this.append({
        type: 'tool_call',
        id: callId,
        turnId: this.ensureTurnId(record.line),
        ts: this.timestampFor(record),
        toolName,
        args: parseJsonString(rawArgs),
      });
      return;
    }

    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      const callId = stringField(payload, 'call_id');
      if (!callId) return;
      this.append({
        type: 'tool_result',
        id:
          stringField(payload, 'id') ??
          generatedCodexId(this.expectedSessionId, 'tool-result', record.line),
        turnId: this.ensureTurnId(record.line),
        ts: this.timestampFor(record),
        toolUseId: callId,
        // Codex persists the output body but not FunctionCallOutputPayload.success.
        // Preserve the raw body and avoid guessing failure from its text.
        isError: false,
        content: { kind: 'text', text: codexToolOutputText(payload.output) },
      });
    }
  }

  finish(): ExternalMakaSession {
    if (!this.hasSessionMeta) {
      throw new Error(`Codex rollout Session id mismatch: expected ${this.expectedSessionId}`);
    }
    const name =
      sanitizeExternalSessionTitle(this.fallbackName) ||
      sanitizeExternalSessionTitle(this.firstUserText) ||
      this.expectedSessionId;
    return {
      sourceSessionId: this.expectedSessionId,
      metadata: { name, cwd: this.metaCwd || this.fallbackCwd },
      messages: this.messages,
    };
  }

  private timestampFor(record: ParsedRolloutRecord): number {
    const parsed = normalizeEpochMs(record.value.timestamp);
    if (parsed !== undefined) this.lastTimestamp = Math.max(this.lastTimestamp, parsed);
    else this.lastTimestamp += 1;
    return parsed ?? this.lastTimestamp;
  }

  private ensureTurnId(line: number): string {
    this.activeTurnId ??= generatedCodexId(this.expectedSessionId, 'turn', line);
    return this.activeTurnId;
  }

  private append(message: StoredMessage): void {
    if (this.messages.length >= this.limits.maxMessages) {
      throw new ExternalSessionLimitError(
        'messages',
        this.limits.maxMessages,
        `Codex rollout converts to more than ${this.limits.maxMessages} messages`,
      );
    }
    const encodedBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (encodedBytes > this.limits.maxConvertedBytes - this.convertedBytes) {
      throw new ExternalSessionLimitError(
        'converted_bytes',
        this.limits.maxConvertedBytes,
        `Codex rollout converts to more than ${this.limits.maxConvertedBytes} bytes`,
      );
    }
    this.convertedBytes += encodedBytes;
    this.messages.push(message);
  }
}

async function* readCodexRolloutRecords(
  path: string,
  sessionId: string,
  limits: CodexRolloutLimits,
  cursor: RolloutReadCursor = { line: 0, bytes: 0 },
  endByteOffset?: number,
): AsyncGenerator<ParsedRolloutRecord> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('Codex rollout is not a regular file');
    if (endByteOffset !== undefined && endByteOffset > metadata.size) {
      throw new Error(`Codex rollout history base ends past its rollout: expected ${sessionId}`);
    }
    const snapshotBytes = endByteOffset ?? metadata.size;
    if (cursor.bytes + snapshotBytes > limits.maxRolloutBytes) {
      throw new ExternalSessionLimitError(
        'transcript_bytes',
        limits.maxRolloutBytes,
        `Codex rollout exceeds ${limits.maxRolloutBytes} bytes`,
      );
    }
    cursor.bytes += snapshotBytes;

    const pending: Buffer[] = [];
    let pendingBytes = 0;
    let observedBytes = 0;
    let line = cursor.line;
    if (snapshotBytes > 0) {
      for await (const value of handle.createReadStream({
        autoClose: false,
        emitClose: false,
        start: 0,
        end: snapshotBytes - 1,
        highWaterMark: CODEX_ROLLOUT_READ_BYTES,
      })) {
        const chunk = Buffer.from(value);
        observedBytes += chunk.byteLength;
        if (observedBytes > snapshotBytes) {
          throw new Error('Codex rollout changed while being read');
        }
        let start = 0;
        for (;;) {
          const newline = chunk.indexOf(0x0a, start);
          if (newline === -1) break;
          const segment = chunk.subarray(start, newline);
          assertCodexRecordSize(pendingBytes + segment.byteLength, limits.maxRecordBytes, line + 1);
          line += 1;
          const record = parseCodexRolloutLine(
            pending.length === 0
              ? segment
              : Buffer.concat([...pending, segment], pendingBytes + segment.byteLength),
            sessionId,
            line,
            false,
          );
          if (record) yield record;
          pending.length = 0;
          pendingBytes = 0;
          start = newline + 1;
        }
        if (start < chunk.byteLength) {
          const segment = chunk.subarray(start);
          assertCodexRecordSize(pendingBytes + segment.byteLength, limits.maxRecordBytes, line + 1);
          pending.push(segment);
          pendingBytes += segment.byteLength;
        }
      }
    }
    if (observedBytes !== snapshotBytes) throw new Error('Codex rollout changed while being read');

    if (pendingBytes > 0) {
      line += 1;
      // Only the rollout still being written can end mid-record; a history
      // base's offset lands on a record boundary, so a partial record there
      // is corrupt.
      const record = parseCodexRolloutLine(
        pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes),
        sessionId,
        line,
        endByteOffset === undefined,
      );
      if (record) yield record;
    }
    cursor.line = line;
  } finally {
    await handle.close();
  }
}

function parseCodexRolloutLine(
  bytes: Buffer,
  sessionId: string,
  line: number,
  tolerateTornTail: boolean,
): ParsedRolloutRecord | undefined {
  const text = bytes.toString('utf8');
  if (text.trim().length === 0) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value)) throw new Error('record is not an object');
    return { line, value };
  } catch (error) {
    if (tolerateTornTail) return undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Codex rollout ${sessionId} at line ${line}: ${detail}`);
  }
}

function assertCodexRecordSize(actualBytes: number, maxBytes: number, line: number): void {
  if (actualBytes > maxBytes) {
    throw new ExternalSessionLimitError(
      'record_bytes',
      maxBytes,
      `Codex rollout record at line ${line} exceeds ${maxBytes} bytes`,
    );
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function catalogEntryFromRolloutHead(
  text: string,
  candidate: RolloutCandidate,
): Omit<CodexCatalogEntry, 'rolloutPath'> | undefined {
  const lines = text.split('\n');
  let id: string | undefined;
  let cwd = '';
  let createdAt: number | undefined;
  let firstUserText: string | undefined;
  for (const line of lines) {
    let record: JsonRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      record = parsed;
    } catch {
      continue;
    }
    const payload = asRecord(record.payload);
    if (!payload) continue;
    if (record.type === 'session_meta') {
      if (!isSupportedCodexThreadSource(payload.source)) return undefined;
      id = stringField(payload, 'session_id') ?? stringField(payload, 'id') ?? id;
      cwd = safeCodexCwd(payload.cwd) || cwd;
      createdAt =
        normalizeEpochMs(record.timestamp) ?? normalizeEpochMs(payload.timestamp) ?? createdAt;
    } else if (record.type === 'event_msg' && firstUserText === undefined) {
      if (payload.type === 'user_message') {
        firstUserText = stringField(payload, 'message');
      } else if (payload.type === 'item_completed') {
        const item = asRecord(payload.item);
        if (stringField(item, 'type')?.toLowerCase() === 'usermessage') {
          firstUserText = codexCompletedItemText(item) || codexCompletedItemMediaText(item);
        }
      }
    }
    if (id && firstUserText !== undefined) break;
  }
  if (!isSafeCodexSessionId(id)) return undefined;
  if (!rolloutFilenameMatchesId(basename(candidate.path), id)) return undefined;
  return {
    id,
    name: sanitizeExternalSessionTitle(firstUserText) || id,
    cwd,
    ...(createdAt !== undefined ? { createdAt } : {}),
    updatedAt: candidate.mtimeMs,
    archived: candidate.archived,
  };
}

async function readCodexThreadRows(
  dbPath: string,
  query: ExternalSessionQuery,
  exactId?: string,
): Promise<CodexThreadRow[] | undefined> {
  try {
    const sqlite = await import('node:sqlite');
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      registerCodexEpochNormalization(db);
      const spec = codexThreadQuery(db, query, exactId);
      if (!spec) return undefined;
      return db.prepare(spec.sql).all(...spec.params) as CodexThreadRow[];
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function codexThreadQuery(
  db: DatabaseSync,
  query: ExternalSessionQuery,
  exactId?: string,
  keyset?: Extract<CodexCatalogKeyset, { kind: 'database' }>,
): CodexThreadQuery | undefined {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(threads)').all() as { name?: unknown }[])
      .map((column) => (typeof column.name === 'string' ? column.name : ''))
      .filter(Boolean),
  );
  if (!columns.has('id') || !columns.has('rollout_path')) return undefined;
  const wanted = [
    'id',
    'rollout_path',
    'cwd',
    'name',
    'title',
    'preview',
    'first_user_message',
    'created_at_ms',
    'created_at',
    'updated_at_ms',
    'updated_at',
    'archived',
    'source',
  ].filter((column) => columns.has(column));
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (exactId !== undefined) {
    where.push('id = ?');
    params.push(exactId);
  }
  if (!query.includeArchived && columns.has('archived')) {
    where.push('(archived IS NULL OR archived = 0)');
  }
  // No cwd clause. SQLite cannot express the matcher's cross-platform path
  // equivalence, so the shared matcher remains the only workspace authority.
  const orderColumns = ['updated_at_ms', 'updated_at', 'created_at_ms', 'created_at'].filter(
    (column) => columns.has(column),
  );
  // The same normalizer owns displayed timestamps and this SQL ordering key.
  // Selecting the key with the row then makes the cursor name exactly the
  // position the query used, including ISO text stored in an INTEGER-affinity
  // column.
  const orderValues = orderColumns.map((column) => `${CODEX_EPOCH_MS_SQL_FUNCTION}(${column})`);
  const orderExpression = orderValues.length > 0 ? `coalesce(${orderValues.join(', ')}, 0)` : '0';
  if (keyset) {
    where.push(`(${orderExpression} < ? OR (${orderExpression} = ? AND id < ?))`);
    params.push(keyset.sortTimestamp, keyset.sortTimestamp, keyset.id);
  }
  return {
    sql:
      `SELECT ${[...wanted, `${orderExpression} AS sort_key`].join(', ')} FROM threads` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY ${orderExpression} DESC, id DESC`,
    params,
  };
}

function codexRowSortTimestamp(row: CodexThreadRow): number {
  // Reads the key the query ordered by rather than recomputing it. The SQL
  // expression is the single authority; `sort_key` is coalesced, so the only
  // way to land on the fallback is a row shape the query cannot produce.
  return finiteNumber(row.sort_key) ?? 0;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return undefined;
}

function registerCodexEpochNormalization(db: DatabaseSync): void {
  db.function(
    CODEX_EPOCH_MS_SQL_FUNCTION,
    { deterministic: true, directOnly: true },
    (value) => normalizeEpochMs(value) ?? null,
  );
}

async function codexStateDbsNewestFirst(codexHome: string): Promise<string[]> {
  try {
    const root = await realpath(codexHome);
    const candidates = (await readdir(codexHome))
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => stateGeneration(b) - stateGeneration(a));
    const databases: string[] = [];
    for (const name of candidates) {
      const candidate = await realpath(join(codexHome, name)).catch(() => undefined);
      if (!candidate || (candidate !== root && !candidate.startsWith(root + sep))) continue;
      if ((await stat(candidate).catch(() => undefined))?.isFile()) databases.push(candidate);
    }
    return databases;
  } catch {
    return [];
  }
}

async function* iterateRolloutFiles(
  root: string,
  archived: boolean,
  relativeRoot = '',
): AsyncGenerator<RolloutCandidate> {
  let directory;
  try {
    directory = await opendir(root);
  } catch {
    return;
  }
  for await (const entry of directory) {
    const path = join(root, entry.name);
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* iterateRolloutFiles(path, archived, relativePath);
    } else if (
      entry.isFile() &&
      entry.name.startsWith('rollout-') &&
      entry.name.endsWith('.jsonl')
    ) {
      try {
        const catalogKey = `${archived ? 'a' : 's'}/${relativePath}`;
        yield {
          path,
          catalogIdentity: createHash('sha256').update(catalogKey).digest('base64url'),
          mtimeMs: (await stat(path)).mtimeMs,
          archived,
        };
      } catch {
        // The external store may change while it is being scanned.
      }
    }
  }
}

async function nextRolloutCatalogBatch(
  codexHome: string,
  query: ExternalSessionCatalogPageQuery,
  keyset: Extract<CodexCatalogKeyset, { kind: 'filesystem' }> | undefined,
  limit: number,
  maxCandidates: number,
  resolvePath: (candidate: RolloutCandidate, id: string) => Promise<string | undefined>,
): Promise<ReadonlyArray<{ candidate: RolloutCandidate; summary: ExternalSessionSummary }>> {
  const page: Array<{ candidate: RolloutCandidate; summary: ExternalSessionSummary }> = [];
  let candidatesSeen = 0;
  const roots = [
    [join(codexHome, 'sessions'), false],
    ...(query.includeArchived ? [[join(codexHome, 'archived_sessions'), true] as const] : []),
  ] as const;
  for (const [root, archived] of roots) {
    for await (const candidate of iterateRolloutFiles(root, archived)) {
      candidatesSeen += 1;
      if (candidatesSeen > maxCandidates) {
        throw new ExternalSessionLimitError(
          'records',
          maxCandidates,
          `Codex catalog contains more than ${maxCandidates} rollout files`,
        );
      }
      if (keyset && !rolloutCandidateIsAfter(candidate, keyset)) continue;
      // Once the page is full, a candidate ordered after its current tail
      // cannot enter the result even if its rollout metadata matches.
      const tail = page.at(-1);
      if (
        tail &&
        page.length === limit &&
        compareRolloutCandidates(candidate, tail.candidate) >= 0
      ) {
        continue;
      }
      const head = await readUtf8Prefix(candidate.path, CODEX_ROLLOUT_HEAD_BYTES).catch(
        () => undefined,
      );
      if (head === undefined) continue;
      const entry = catalogEntryFromRolloutHead(head, candidate);
      if (!entry || !matchesQuery(entry, query)) continue;
      // A reverted thread's later rollouts repeat its `session_meta`; list the
      // thread once, from its opening rollout.
      if (!isOpeningRolloutFilename(basename(candidate.path), entry.id)) continue;
      const rolloutPath = await resolvePath(candidate, entry.id);
      if (!rolloutPath) continue;
      const { rolloutPath: _rolloutPath, ...summary } = { ...entry, rolloutPath };
      const insertionIndex = page.findIndex(
        (current) => compareRolloutCandidates(candidate, current.candidate) < 0,
      );
      if (insertionIndex === -1) page.push({ candidate, summary });
      else page.splice(insertionIndex, 0, { candidate, summary });
      if (page.length > limit) page.pop();
    }
  }
  return page;
}

function compareRolloutCandidates(
  left: Pick<RolloutCandidate, 'mtimeMs' | 'catalogIdentity'>,
  right: Pick<RolloutCandidate, 'mtimeMs' | 'catalogIdentity'>,
): number {
  return right.mtimeMs - left.mtimeMs || left.catalogIdentity.localeCompare(right.catalogIdentity);
}

function rolloutCandidateIsAfter(
  candidate: RolloutCandidate,
  keyset: Extract<CodexCatalogKeyset, { kind: 'filesystem' }>,
): boolean {
  return (
    compareRolloutCandidates(candidate, {
      mtimeMs: keyset.mtimeMs,
      catalogIdentity: keyset.pathIdentity,
    }) > 0
  );
}

function candidateKeyset(
  candidate: RolloutCandidate,
): Extract<CodexCatalogKeyset, { kind: 'filesystem' }> {
  return {
    kind: 'filesystem',
    mtimeMs: candidate.mtimeMs,
    pathIdentity: candidate.catalogIdentity,
  };
}

function encodeCatalogKeyset(
  query: ExternalSessionCatalogPageQuery,
  keyset: CodexCatalogKeyset,
): string {
  const queryHash = externalSessionCatalogQueryHash(query);
  if (keyset.kind === 'database') {
    return `d:${queryHash}:${Buffer.from(keyset.stateDatabase).toString('base64url')}:${encodeCursorNumber(keyset.sortTimestamp)}:${Buffer.from(keyset.id).toString('base64url')}`;
  }
  return `f2:${queryHash}:${encodeCursorNumber(keyset.mtimeMs)}:${keyset.pathIdentity}`;
}

function decodeCatalogKeyset(
  cursor: string | undefined,
  query: ExternalSessionCatalogPageQuery,
): CodexCatalogKeyset | undefined {
  if (cursor === undefined) return undefined;
  const parts = cursor.split(':');
  if (parts[1] !== externalSessionCatalogQueryHash(query)) {
    throw new ExternalSessionCatalogCursorError();
  }
  if (parts[0] === 'd') {
    if (parts.length !== 5) throw new ExternalSessionCatalogCursorError();
    const encodedStateDatabase = parts[2]!;
    const stateDatabase = Buffer.from(encodedStateDatabase, 'base64url').toString('utf8');
    if (
      !/^state_\d+\.sqlite$/.test(stateDatabase) ||
      Buffer.from(stateDatabase).toString('base64url') !== encodedStateDatabase
    ) {
      throw new ExternalSessionCatalogCursorError();
    }
    const sortTimestamp = decodeCursorNumber(parts[3]!);
    const encodedId = parts[4]!;
    const id = Buffer.from(encodedId, 'base64url').toString('utf8');
    if (!isSafeCodexSessionId(id) || Buffer.from(id).toString('base64url') !== encodedId) {
      throw new ExternalSessionCatalogCursorError();
    }
    return { kind: 'database', stateDatabase, sortTimestamp, id };
  }
  if (parts[0] === 'f2') {
    if (parts.length !== 4) throw new ExternalSessionCatalogCursorError();
    const mtimeMs = decodeCursorNumber(parts[2]!);
    const pathIdentity = parts[3]!;
    if (!/^[A-Za-z0-9_-]{43}$/.test(pathIdentity)) {
      throw new ExternalSessionCatalogCursorError();
    }
    return { kind: 'filesystem', mtimeMs, pathIdentity };
  }
  throw new ExternalSessionCatalogCursorError();
}

function encodeCursorNumber(value: number): string {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeDoubleBE(value);
  return buffer.toString('base64url');
}

function decodeCursorNumber(value: string): number {
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.length !== 8 || buffer.toString('base64url') !== value) {
    throw new ExternalSessionCatalogCursorError();
  }
  const number = buffer.readDoubleBE();
  if (!Number.isFinite(number)) throw new ExternalSessionCatalogCursorError();
  return number;
}

async function readUtf8Prefix(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Codex rollout is not a regular file');
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function codexSourceToken(value: unknown): string | undefined {
  if (typeof value === 'string') {
    if (value.length === 0) return undefined;
    if ((CODEX_SUPPORTED_THREAD_SOURCES as readonly string[]).includes(value)) return value;
    if (!value.startsWith('{')) return undefined;
    try {
      return codexSourceToken(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'object' && value !== null) {
    const custom = (value as Record<string, unknown>).custom;
    return typeof custom === 'string' &&
      (CODEX_SUPPORTED_THREAD_SOURCES as readonly string[]).includes(custom)
      ? custom
      : undefined;
  }
  return undefined;
}

function isSupportedCodexThreadSource(value: unknown): boolean {
  return value === undefined || value === null || codexSourceToken(value) !== undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function codexAssistantProviderOptions(
  record: JsonRecord | undefined,
): Record<string, unknown> | undefined {
  const phase = record?.phase;
  if (phase !== 'commentary' && phase !== 'final_answer') return undefined;
  return {
    openai: {
      phase,
    },
  };
}

function isSafeCodexSessionId(value: unknown): value is string {
  return typeof value === 'string' && CODEX_SESSION_ID_PATTERN.test(value);
}

function assertSafeCodexSessionId(value: string): void {
  if (!isSafeCodexSessionId(value)) throw new Error(`Invalid Codex Session id: ${value}`);
}

function safeCodexCwd(value: unknown): string {
  return typeof value === 'string' && !CODEX_UNSAFE_PATH_CHARS.test(value) ? value : '';
}

function firstNonEmptyTitle(...values: unknown[]): string | undefined {
  for (const value of values) {
    const title = sanitizeExternalSessionTitle(value);
    if (title.length > 0) return title;
  }
  return undefined;
}

function codexErrorAffectsTurnStatus(payload: JsonRecord): boolean {
  const info = payload.codex_error_info;
  if (info === 'thread_rollback_failed' || info === 'active_turn_not_steerable') return false;
  return !(isRecord(info) && Object.hasOwn(info, 'active_turn_not_steerable'));
}

function normalizeEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeEpochMs(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function matchesQuery(entry: ExternalSessionSummary, query: ExternalSessionQuery): boolean {
  // The single authority on whether a row answers a query, shared with every
  // other adapter. The local path helpers this file used to keep were only
  // reachable from the SQL prefilter that has been removed.
  return externalSessionMatchesQuery(entry, query);
}

function stateGeneration(path: string): number {
  return Number(path.match(/\d+/)?.[0] ?? 0);
}

/**
 * Codex names a thread's opening rollout `rollout-<ts>-<id>.jsonl` and each
 * rollout a revert starts for it `rollout-<ts>-<id>_<rolloutId>.jsonl`; every
 * one records the thread's own id in `session_meta`. Only `_` separates the
 * two ids, since the timestamp and the thread id are `-`-joined.
 */
function rolloutFilenameMatchesId(filename: string, sessionId: string): boolean {
  if (!filename.startsWith('rollout-') || !filename.endsWith('.jsonl')) return false;
  const stem = filename.slice(0, -'.jsonl'.length);
  if (stem.endsWith(`-${sessionId}`)) return true;
  const marker = `-${sessionId}_`;
  const childStart = stem.lastIndexOf(marker) + marker.length;
  return childStart >= marker.length && childStart < stem.length && !stem.includes('_', childStart);
}

function isOpeningRolloutFilename(filename: string, sessionId: string): boolean {
  return filename.endsWith(`-${sessionId}.jsonl`);
}

/**
 * The thread and rollout ids in a rollout file name, split as Codex splits
 * them: at the first `_` after the timestamp. An opening rollout's id is its
 * thread's.
 */
function rolloutFileIds(filename: string): { threadId: string; rolloutId: string } | undefined {
  const ids = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(filename)?.[1];
  if (ids === undefined) return undefined;
  const split = ids.indexOf('_');
  const threadId = split === -1 ? ids : ids.slice(0, split);
  const rolloutId = split === -1 ? ids : ids.slice(split + 1);
  if (!isSafeCodexSessionId(threadId) || !isSafeCodexSessionId(rolloutId)) return undefined;
  return { threadId, rolloutId };
}

/**
 * Every rollout file by rollout id, built from names alone on first use. The
 * `sessions` copy wins over an `archived_sessions` one, as in Codex, so a
 * rollout seen in both mid-archive is read once.
 */
function lazyRolloutIndex(codexHome: string): () => Promise<Map<string, IndexedRollout>> {
  let index: Promise<Map<string, IndexedRollout>> | undefined;
  return () => (index ??= indexRollouts(codexHome));
}

async function indexRollouts(codexHome: string): Promise<Map<string, IndexedRollout>> {
  const index = new Map<string, IndexedRollout>();
  for (const [root, archived] of [
    [join(codexHome, 'sessions'), false],
    [join(codexHome, 'archived_sessions'), true],
  ] as const) {
    for await (const candidate of iterateRolloutFiles(root, archived)) {
      const ids = rolloutFileIds(basename(candidate.path));
      if (!ids || index.has(ids.rolloutId)) continue;
      index.set(ids.rolloutId, { threadId: ids.threadId, path: candidate.path });
    }
  }
  return index;
}

/**
 * The first `session_meta` in a rollout's head: the thread it names and the
 * history it continues. Reading only the head is enough because Codex writes
 * that record first, and a rollout that buries it behind other records is
 * refused while converting rather than trusted here.
 */
async function readRolloutHeadMeta(
  path: string,
  sessionId: string,
): Promise<RolloutHeadMeta | undefined> {
  const head = await readUtf8Prefix(path, CODEX_ROLLOUT_HEAD_BYTES).catch(() => undefined);
  if (head === undefined) return undefined;
  for (const line of head.split('\n')) {
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== 'session_meta') continue;
    const payload = asRecord(record.payload);
    return {
      id: stringField(payload, 'session_id') ?? stringField(payload, 'id'),
      historyBase: codexHistoryBase(payload?.history_base, sessionId),
    };
  }
  return undefined;
}

function codexHistoryBase(value: unknown, sessionId: string): RolloutHeadMeta['historyBase'] {
  if (value === undefined || value === null) return undefined;
  const base = asRecord(value);
  const rolloutId = stringField(base, 'thread_id');
  const endByteOffset = base?.end_byte_offset;
  if (
    !isSafeCodexSessionId(rolloutId) ||
    typeof endByteOffset !== 'number' ||
    !Number.isSafeInteger(endByteOffset) ||
    endByteOffset <= 0
  ) {
    throw new Error(`Invalid Codex rollout history base: expected ${sessionId}`);
  }
  return { rolloutId, endByteOffset };
}

function generatedCodexId(sessionId: string, kind: string, line: number): string {
  return `codex-${sessionId}-${kind}-${line}`;
}

function namespacedToolName(payload: JsonRecord): string | undefined {
  const name = stringField(payload, 'name');
  if (!name) return undefined;
  const namespace = stringField(payload, 'namespace');
  return namespace ? `${namespace}.${name}` : name;
}

function parseJsonString(value: string | undefined): unknown {
  if (value === undefined) return '';
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function codexToolOutputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const texts = value.flatMap((item) => {
      const record = asRecord(item);
      return record?.type === 'input_text' && typeof record.text === 'string' ? [record.text] : [];
    });
    if (texts.length > 0) return texts.join('\n');
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function codexCompletedItemText(item: JsonRecord | undefined): string {
  if (!item) return '';
  const direct = stringField(item, 'content');
  if (direct) return direct;
  if (!Array.isArray(item.content)) return '';
  return item.content
    .flatMap((part) => {
      const record = asRecord(part);
      const type = stringField(record, 'type')?.toLowerCase();
      return type === 'text' || type === 'input_text' || type === 'output_text'
        ? [stringField(record, 'text') ?? '']
        : [];
    })
    .filter((text) => text.length > 0)
    .join('');
}

function codexCompletedReasoningText(item: JsonRecord | undefined): string {
  if (!item) return '';
  const summary = codexTextFragments(item.summary_text);
  if (summary.length > 0) return summary.join('\n');
  return codexCompletedItemText(item);
}

function codexTextFragments(value: unknown): string[] {
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (typeof part === 'string') return part.length > 0 ? [part] : [];
    const text = stringField(asRecord(part), 'text');
    return text ? [text] : [];
  });
}

function codexCompletedItemMediaText(item: JsonRecord | undefined): string {
  if (!item || !Array.isArray(item.content)) return '';
  const contentTypes = item.content.flatMap((part) => {
    const type = stringField(asRecord(part), 'type')?.toLowerCase();
    return type ? [type] : [];
  });
  if (contentTypes.some((type) => type.includes('image'))) return '[Image]';
  return contentTypes.some((type) => type.includes('audio')) ? '[Audio]' : '';
}

function mediaOnlyUserText(payload: JsonRecord): string {
  const images = Array.isArray(payload.images) ? payload.images : [];
  const localImages = Array.isArray(payload.local_images) ? payload.local_images : [];
  if (images.length > 0 || localImages.length > 0) return '[Image]';
  const audio = Array.isArray(payload.audio) ? payload.audio : [];
  const localAudio = Array.isArray(payload.local_audio) ? payload.local_audio : [];
  return audio.length > 0 || localAudio.length > 0 ? '[Audio]' : '';
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
