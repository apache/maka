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

import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { StoredMessage } from '@maka/core/session';
import {
  CODEX_SUPPORTED_THREAD_SOURCES,
  FOREIGN_SESSION_DIGEST_MAX_READ_BYTES,
  FOREIGN_SESSION_SCAN_MAX_SESSIONS,
  codexRolloutMessage,
  createDigestAccumulator,
  finishDigest,
  isSupportedCodexThreadSource,
  pushDigestMessage,
  sanitizeForeignTitle,
  type ForeignSessionDigest,
  type ForeignSessionSummary,
} from '@maka/core/foreign-session';
import type {
  ExternalMakaSession,
  ExternalSessionAdapter,
  ExternalSessionQuery,
  ExternalSessionSummary,
} from '@maka/core/external-session';
import {
  matchesSourceCatalogQuery,
  readBoundedUtf8File,
  readUtf8Prefix,
  readUtf8Tail,
  type ExternalSourceCatalogEntry,
  type ExternalSourceCatalogQuery,
} from './external-source-catalog.js';

export const CODEX_SESSION_ADAPTER_ID = 'codex';
export const CODEX_ROLLOUT_MAX_BYTES = 64 * 1024 * 1024;

const CODEX_ROLLOUT_HEAD_BYTES = 512 * 1024;
const CODEX_CATALOG_CANDIDATE_LIMIT = FOREIGN_SESSION_SCAN_MAX_SESSIONS;
const CODEX_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CODEX_UNSAFE_PATH_CHARS =
  /[\u0000-\u001F\u007F\u0080-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
export interface CodexSessionAdapterOptions {
  /** Codex's state root. Defaults to `$CODEX_HOME`, then `~/.codex`. */
  codexHome?: string;
  /** Test/host override for the bounded transcript read. */
  maxRolloutBytes?: number;
}

interface CodexCatalogEntry extends ExternalSourceCatalogEntry {
  source: 'codex';
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
}

type JsonRecord = Record<string, unknown>;

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

  constructor(options: CodexSessionAdapterOptions = {}) {
    this.codexHome = resolve(
      options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    );
    this.maxRolloutBytes = options.maxRolloutBytes ?? CODEX_ROLLOUT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxRolloutBytes) || this.maxRolloutBytes <= 0) {
      throw new Error('Codex rollout byte limit must be a positive safe integer');
    }
  }

  async detect(): Promise<boolean> {
    return (
      (await isDirectory(join(this.codexHome, 'sessions'))) ||
      (await isDirectory(join(this.codexHome, 'archived_sessions'))) ||
      (await codexStateDbsNewestFirst(this.codexHome)).length > 0
    );
  }

  async listSessions(query: ExternalSessionQuery = {}): Promise<readonly ExternalSessionSummary[]> {
    const entries = await this.listCatalog(query);
    return entries.map((entry) => ({
      id: entry.id,
      name: entry.title,
      cwd: entry.cwd,
      ...(entry.createdAtMs !== undefined ? { createdAt: entry.createdAtMs } : {}),
      updatedAt: entry.updatedAtMs,
      archived: entry.archived,
    }));
  }

  async listCatalogEntries(
    query: ExternalSourceCatalogQuery = {},
  ): Promise<readonly CodexCatalogEntry[]> {
    return this.listCatalog(query);
  }

  async readSession(sessionId: string): Promise<ExternalMakaSession> {
    assertSafeCodexSessionId(sessionId);
    const catalogEntry = await this.findCatalogEntry(sessionId);
    if (!catalogEntry) throw new Error(`Codex Session not found: ${sessionId}`);

    const rolloutPath = await this.resolveRolloutPath(catalogEntry.transcriptPath, sessionId);
    if (!rolloutPath) throw new Error(`Codex rollout is unavailable: ${sessionId}`);
    const text = await readBoundedUtf8File(rolloutPath, this.maxRolloutBytes);
    const converted = convertCodexRollout(text, sessionId, catalogEntry.title, catalogEntry.cwd);

    return {
      sourceSessionId: sessionId,
      metadata: converted.metadata,
      messages: converted.messages,
    };
  }

  async readDigest(summary: ForeignSessionSummary): Promise<ForeignSessionDigest> {
    if (summary.source !== 'codex') throw new Error('Codex adapter received another source');
    const rolloutPath = await this.resolveRolloutPath(summary.transcriptPath, summary.id);
    if (!rolloutPath) throw new Error(`Codex rollout is unavailable: ${summary.id}`);
    const { text, truncated } = await readUtf8Tail(
      rolloutPath,
      FOREIGN_SESSION_DIGEST_MAX_READ_BYTES,
    );
    const acc = createDigestAccumulator();
    let dropped = 0;
    const records: ParsedRolloutRecord[] = [];
    for (const [index, line] of text.split('\n').entries()) {
      if (line.trim().length === 0) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (!isRecord(value)) throw new Error('record is not an object');
        records.push({ line: index + 1, value });
      } catch {
        dropped += 1;
      }
    }
    for (const message of codexPresentationRecords(records).values()) {
      if (message.kind !== 'reasoning') pushDigestMessage(acc, message.kind, message.text);
    }
    if (truncated) {
      acc.warnings.push(
        `transcript exceeded ${FOREIGN_SESSION_DIGEST_MAX_READ_BYTES} bytes; only its tail was read`,
      );
    }
    if (dropped > 0) acc.warnings.push(`${dropped} malformed transcript lines were skipped`);
    return finishDigest(acc, {
      source: summary.source,
      id: summary.id,
      title: summary.title,
      cwd: summary.cwd,
      gitBranch: summary.gitBranch,
      updatedAtMs: summary.updatedAtMs,
    });
  }

  private async listCatalog(query: ExternalSourceCatalogQuery): Promise<CodexCatalogEntry[]> {
    if (query.limit !== undefined && query.limit <= 0) return [];
    for (const dbPath of await codexStateDbsNewestFirst(this.codexHome)) {
      const entries = await this.readCatalogFromDatabase(dbPath, query);
      if (entries === undefined) continue;
      return entries;
    }

    return this.scanRolloutCatalog(query);
  }

  private async findCatalogEntry(sessionId: string): Promise<CodexCatalogEntry | undefined> {
    for (const dbPath of await codexStateDbsNewestFirst(this.codexHome)) {
      const rows = await readCodexThreadRows(
        dbPath,
        { includeArchived: true },
        { exactId: sessionId },
      );
      if (rows === undefined) continue;
      const entry = rows[0] ? await this.entryFromRow(rows[0]) : undefined;
      return entry?.id === sessionId ? entry : undefined;
    }

    return this.findRolloutEntry(sessionId);
  }

  private async readCatalogFromDatabase(
    dbPath: string,
    query: ExternalSourceCatalogQuery,
  ): Promise<CodexCatalogEntry[] | undefined> {
    const cursor = query.cursor ?? 0;
    const entries: CodexCatalogEntry[] = [];
    let matched = 0;
    const rows = await readCodexThreadRows(dbPath, query, {
      limit: CODEX_CATALOG_CANDIDATE_LIMIT,
    });
    if (rows === undefined) return undefined;
    const candidates: CodexCatalogEntry[] = [];
    for (const row of rows) {
      const entry = await this.entryFromRow(row, false);
      if (entry && matchesSourceCatalogQuery(entry, query)) candidates.push(entry);
    }
    candidates.sort(compareCatalogEntries);
    for (const entry of candidates) {
      const transcriptPath = await this.resolveRolloutPath(entry.transcriptPath, entry.id);
      if (!transcriptPath) continue;
      if (matched < cursor) {
        matched += 1;
        continue;
      }
      entries.push({ ...entry, transcriptPath });
      matched += 1;
      if (query.limit !== undefined && entries.length >= query.limit) break;
    }
    return entries;
  }

  private async findRolloutEntry(sessionId: string): Promise<CodexCatalogEntry | undefined> {
    const candidates = [
      ...(await walkRolloutFiles(join(this.codexHome, 'sessions'), false, sessionId)),
      ...(await walkRolloutFiles(join(this.codexHome, 'archived_sessions'), true, sessionId)),
    ].sort(compareRolloutCandidates);
    for (const candidate of candidates) {
      const head = await readUtf8Prefix(candidate.path, CODEX_ROLLOUT_HEAD_BYTES).catch(
        () => undefined,
      );
      if (head === undefined) continue;
      const entry = catalogEntryFromRolloutHead(head, candidate);
      if (entry?.id === sessionId) {
        const transcriptPath = await this.resolveRolloutPath(entry.transcriptPath, sessionId);
        if (transcriptPath) return { ...entry, transcriptPath };
      }
    }
    return undefined;
  }

  private async entryFromRow(
    row: CodexThreadRow,
    resolvePath = true,
  ): Promise<CodexCatalogEntry | undefined> {
    if (!isSafeCodexSessionId(row.id)) return undefined;
    if (typeof row.rollout_path !== 'string' || row.rollout_path.length === 0) return undefined;
    if (!isSupportedCodexThreadSource(row.source)) return undefined;

    const rolloutPath = resolvePath
      ? await this.resolveRolloutPath(row.rollout_path, row.id)
      : row.rollout_path;
    if (!rolloutPath) return undefined;
    const name =
      firstNonEmptyTitle(row.name, row.title, row.preview, row.first_user_message) ?? row.id;
    const createdAt = normalizeEpochMs(row.created_at_ms) ?? normalizeEpochMs(row.created_at);
    const updatedAt = normalizeEpochMs(row.updated_at_ms) ?? normalizeEpochMs(row.updated_at);

    return {
      source: 'codex',
      id: row.id,
      title: name,
      cwd: safeCodexCwd(row.cwd),
      ...(createdAt !== undefined ? { createdAtMs: createdAt } : {}),
      updatedAtMs: updatedAt ?? 0,
      archived: row.archived === true || row.archived === 1,
      transcriptPath: rolloutPath,
    };
  }

  private async scanRolloutCatalog(
    query: ExternalSourceCatalogQuery,
  ): Promise<CodexCatalogEntry[]> {
    if (query.limit !== undefined && query.limit <= 0) return [];
    const candidateBudget = { remaining: CODEX_CATALOG_CANDIDATE_LIMIT };
    const activeCandidates = await walkRolloutFiles(
      join(this.codexHome, 'sessions'),
      false,
      undefined,
      {
        candidateBudget,
        maxAgeMs: query.maxAgeMs,
        nowMs: query.nowMs,
      },
    );
    const archivedCandidates =
      query.includeArchived && candidateBudget.remaining > 0
        ? await walkRolloutFiles(join(this.codexHome, 'archived_sessions'), true, undefined, {
            candidateBudget,
            maxAgeMs: query.maxAgeMs,
            nowMs: query.nowMs,
          })
        : [];
    const candidates = [...activeCandidates, ...archivedCandidates].sort(compareRolloutCandidates);
    const entries: CodexCatalogEntry[] = [];
    const seenIds = new Set<string>();
    let matched = 0;
    const cursor = query.cursor ?? 0;
    const pageEnd = query.limit === undefined ? undefined : cursor + query.limit;
    for (const candidate of candidates) {
      if (pageEnd !== undefined && matched >= pageEnd) break;
      const head = await readUtf8Prefix(candidate.path, CODEX_ROLLOUT_HEAD_BYTES).catch(
        () => undefined,
      );
      if (head === undefined) continue;
      const entry = catalogEntryFromRolloutHead(head, candidate);
      if (!entry || !matchesSourceCatalogQuery(entry, query) || seenIds.has(entry.id)) continue;
      const transcriptPath = await this.resolveRolloutPath(entry.transcriptPath, entry.id);
      if (!transcriptPath) continue;
      seenIds.add(entry.id);
      if (matched < cursor) {
        matched += 1;
        continue;
      }
      entries.push({ ...entry, transcriptPath });
      matched += 1;
      if (query.limit !== undefined && entries.length >= query.limit) break;
    }
    return entries;
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
  mtimeMs: number;
  archived: boolean;
}

interface RolloutWalkOptions {
  candidateBudget?: { remaining: number };
  maxCandidates?: number;
  maxAgeMs?: number;
  nowMs?: number;
}

interface CodexThreadReadOptions {
  exactId?: string;
  limit?: number;
}

function convertCodexRollout(
  text: string,
  expectedSessionId: string,
  fallbackName: string,
  fallbackCwd: string,
): ExternalMakaSession {
  const records = parseRolloutRecords(text, expectedSessionId);
  const presentationByLine = codexPresentationRecords(records);
  const sessionMeta = records.find((record) => record.value.type === 'session_meta')?.value;
  const metaPayload = asRecord(sessionMeta?.payload);
  const actualSessionId = stringField(metaPayload, 'session_id') ?? stringField(metaPayload, 'id');
  if (actualSessionId !== expectedSessionId) {
    throw new Error(`Codex rollout Session id mismatch: expected ${expectedSessionId}`);
  }

  const messages: StoredMessage[] = [];
  let activeTurnId: string | undefined;
  let activeTurnIsExplicit = false;
  let activeModel = stringField(metaPayload, 'model_provider') ?? 'codex';
  let lastTimestamp = normalizeEpochMs(sessionMeta?.timestamp) ?? 0;
  let firstUserText: string | undefined;
  const failedTurnIds = new Set<string>();

  const timestampFor = (record: ParsedRolloutRecord): number => {
    const parsed = normalizeEpochMs(record.value.timestamp);
    if (parsed !== undefined) lastTimestamp = Math.max(lastTimestamp, parsed);
    else lastTimestamp += 1;
    return parsed ?? lastTimestamp;
  };
  const ensureTurnId = (line: number): string => {
    activeTurnId ??= generatedCodexId(expectedSessionId, 'turn', line);
    return activeTurnId;
  };

  for (const record of records) {
    const envelope = record.value;
    const payload = asRecord(envelope.payload);
    if (!payload) continue;

    if (envelope.type === 'turn_context') {
      activeTurnId = stringField(payload, 'turn_id') ?? activeTurnId;
      activeModel = stringField(payload, 'model') ?? activeModel;
      continue;
    }

    const presentation = presentationByLine.get(record.line);
    if (presentation) {
      const eventTurnId = stringField(payload, 'turn_id');
      if (eventTurnId) {
        activeTurnId = eventTurnId;
        activeTurnIsExplicit = true;
      } else if (presentation.kind === 'user' && !activeTurnIsExplicit) {
        activeTurnId = generatedCodexId(expectedSessionId, 'turn', record.line);
      }
      const turnId = ensureTurnId(record.line);
      const ts = timestampFor(record);
      if (presentation.kind === 'user') {
        firstUserText ??= presentation.text;
        messages.push({
          type: 'user',
          id: presentation.id ?? generatedCodexId(expectedSessionId, 'user', record.line),
          turnId,
          ts,
          text: presentation.text,
        });
      } else if (presentation.kind === 'assistant') {
        messages.push({
          type: 'assistant',
          id: presentation.id ?? generatedCodexId(expectedSessionId, 'assistant', record.line),
          turnId,
          ts,
          text: presentation.text,
          ...(presentation.providerOptions !== undefined
            ? { providerOptions: presentation.providerOptions }
            : {}),
          modelId: activeModel,
          contentOrder: ['text'],
        });
      } else {
        messages.push({
          type: 'assistant',
          id: presentation.id ?? generatedCodexId(expectedSessionId, 'reasoning', record.line),
          turnId,
          ts,
          text: '',
          thinking: { text: presentation.text },
          contentOrder: ['thinking'],
          modelId: activeModel,
        });
      }
      continue;
    }

    if (envelope.type === 'event_msg') {
      const eventType = stringField(payload, 'type');
      if (eventType === 'task_started' || eventType === 'turn_started') {
        const turnId = stringField(payload, 'turn_id');
        if (turnId) {
          activeTurnId = turnId;
          activeTurnIsExplicit = true;
        }
        continue;
      }

      if (eventType === 'context_compacted') {
        messages.push({
          type: 'system_note',
          id: generatedCodexId(expectedSessionId, 'compact', record.line),
          turnId: activeTurnId,
          ts: timestampFor(record),
          kind: 'context_compacted',
        });
        continue;
      }

      if (eventType === 'error') {
        if (activeTurnId && codexErrorAffectsTurnStatus(payload)) {
          failedTurnIds.add(activeTurnId);
        }
        messages.push({
          type: 'system_note',
          id: generatedCodexId(expectedSessionId, 'error', record.line),
          turnId: activeTurnId,
          ts: timestampFor(record),
          kind: 'error',
          data: JSON.parse(JSON.stringify(payload)) as unknown,
        });
        continue;
      }

      if (eventType === 'task_complete' || eventType === 'turn_complete') {
        const turnId = stringField(payload, 'turn_id') ?? ensureTurnId(record.line);
        const failed = failedTurnIds.has(turnId) || payload.error != null;
        messages.push({
          type: 'turn_state',
          id: generatedCodexId(expectedSessionId, 'turn-state', record.line),
          turnId,
          ts: timestampFor(record),
          status: failed ? 'failed' : 'completed',
          ...(failed ? { errorClass: 'codex_error' } : {}),
          partialOutputRetained: true,
        });
        failedTurnIds.delete(turnId);
        if (activeTurnId === turnId) {
          activeTurnId = undefined;
          activeTurnIsExplicit = false;
        }
        continue;
      }

      if (eventType === 'turn_aborted') {
        const turnId = stringField(payload, 'turn_id') ?? ensureTurnId(record.line);
        const ts = timestampFor(record);
        messages.push({
          type: 'turn_state',
          id: generatedCodexId(expectedSessionId, 'turn-state', record.line),
          turnId,
          ts,
          status: 'aborted',
          abortedAt: normalizeEpochMs(payload.completed_at) ?? ts,
          abortSource: stringField(payload, 'reason') ?? 'codex',
          partialOutputRetained: true,
        });
        if (activeTurnId === turnId) {
          activeTurnId = undefined;
          activeTurnIsExplicit = false;
        }
        continue;
      }
    }

    if (envelope.type !== 'response_item') continue;
    const itemType = stringField(payload, 'type');
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const callId = stringField(payload, 'call_id');
      const toolName = namespacedToolName(payload);
      if (!callId || !toolName) continue;
      const rawArgs =
        itemType === 'function_call'
          ? stringField(payload, 'arguments')
          : stringField(payload, 'input');
      messages.push({
        type: 'tool_call',
        id: callId,
        turnId: ensureTurnId(record.line),
        ts: timestampFor(record),
        toolName,
        args: parseJsonString(rawArgs),
      });
      continue;
    }

    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      const callId = stringField(payload, 'call_id');
      if (!callId) continue;
      messages.push({
        type: 'tool_result',
        id:
          stringField(payload, 'id') ??
          generatedCodexId(expectedSessionId, 'tool-result', record.line),
        turnId: ensureTurnId(record.line),
        ts: timestampFor(record),
        toolUseId: callId,
        // Codex persists the output body but not FunctionCallOutputPayload.success.
        // Preserve the raw body and avoid guessing failure from its text.
        isError: false,
        content: { kind: 'text', text: codexToolOutputText(payload.output) },
      });
    }
  }

  const name =
    sanitizeForeignTitle(fallbackName) || sanitizeForeignTitle(firstUserText) || expectedSessionId;
  return {
    sourceSessionId: expectedSessionId,
    metadata: { name, cwd: fallbackCwd },
    messages,
  };
}

interface ParsedRolloutRecord {
  line: number;
  value: JsonRecord;
}

interface CodexPresentationMessage {
  kind: 'user' | 'assistant' | 'reasoning';
  text: string;
  id?: string;
  providerOptions?: Record<string, unknown>;
}

function codexPresentationRecords(
  records: readonly ParsedRolloutRecord[],
): Map<number, CodexPresentationMessage> {
  const eventMessages = new Map<number, CodexPresentationMessage>();
  const responseMessages = new Map<number, CodexPresentationMessage>();
  const seenCompletedItemIds = new Set<string>();
  for (const record of records) {
    const envelope = record.value;
    if (envelope.type === 'response_item') {
      const message = codexRolloutMessage(envelope);
      if (message) {
        responseMessages.set(record.line, {
          kind: message.role,
          text: message.text,
        });
      }
      continue;
    }
    if (envelope.type !== 'event_msg') continue;
    const payload = asRecord(envelope.payload);
    const eventType = stringField(payload, 'type');
    if (!payload || !eventType) continue;

    if (eventType === 'user_message') {
      const text = stringField(payload, 'message') ?? mediaOnlyUserText(payload);
      if (text.length > 0) {
        eventMessages.set(record.line, {
          kind: 'user',
          text,
          ...(stringField(payload, 'client_id') ? { id: stringField(payload, 'client_id') } : {}),
        });
      }
      continue;
    }
    if (eventType === 'agent_message') {
      const text = stringField(payload, 'message');
      if (text) {
        const providerOptions = codexAssistantProviderOptions(payload);
        eventMessages.set(record.line, {
          kind: 'assistant',
          text,
          ...(providerOptions !== undefined ? { providerOptions } : {}),
        });
      }
      continue;
    }
    if (eventType === 'agent_reasoning') {
      const text = stringField(payload, 'text');
      if (text) eventMessages.set(record.line, { kind: 'reasoning', text });
      continue;
    }
    if (eventType !== 'item_completed') continue;

    const item = asRecord(payload.item);
    const itemType = stringField(item, 'type')?.toLowerCase();
    const itemId = stringField(item, 'id') ?? stringField(item, 'client_id');
    if (itemId !== undefined) {
      if (seenCompletedItemIds.has(itemId)) continue;
      seenCompletedItemIds.add(itemId);
    }
    if (itemType === 'usermessage') {
      const text = codexCompletedItemText(item) || codexCompletedItemMediaText(item);
      if (text.length > 0) {
        eventMessages.set(record.line, {
          kind: 'user',
          text,
          ...((stringField(item, 'client_id') ?? stringField(item, 'id'))
            ? { id: stringField(item, 'client_id') ?? stringField(item, 'id') }
            : {}),
        });
      }
    } else if (itemType === 'agentmessage') {
      const text = codexCompletedItemText(item);
      if (text.length > 0) {
        const providerOptions = codexAssistantProviderOptions(item);
        eventMessages.set(record.line, {
          kind: 'assistant',
          text,
          ...(stringField(item, 'id') ? { id: stringField(item, 'id') } : {}),
          ...(providerOptions !== undefined ? { providerOptions } : {}),
        });
      }
    } else if (itemType === 'reasoning') {
      const text = codexCompletedReasoningText(item);
      if (text.length > 0) {
        eventMessages.set(record.line, {
          kind: 'reasoning',
          text,
          ...(stringField(item, 'id') ? { id: stringField(item, 'id') } : {}),
        });
      }
    }
  }
  if (eventMessages.size === 0) return responseMessages;
  const merged = new Map(eventMessages);
  const eventKinds = new Set([...eventMessages.values()].map((message) => message.kind));
  for (const [line, responseMessage] of responseMessages) {
    if (!eventKinds.has(responseMessage.kind)) merged.set(line, responseMessage);
  }
  return merged;
}

function parseRolloutRecords(text: string, sessionId: string): ParsedRolloutRecord[] {
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsWithNewline) lines.pop();
  const records: ParsedRolloutRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRecord(value)) throw new Error('record is not an object');
      records.push({ line: index + 1, value });
    } catch (error) {
      if (!endsWithNewline && index === lines.length - 1) break;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid Codex rollout ${sessionId} at line ${index + 1}: ${detail}`);
    }
  }
  return records;
}

function catalogEntryFromRolloutHead(
  text: string,
  candidate: RolloutCandidate,
): CodexCatalogEntry | undefined {
  const lines = text.split('\n');
  let id: string | undefined;
  let cwd = '';
  let createdAt: number | undefined;
  let firstUserText: string | undefined;
  let responseUserText: string | undefined;
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
    } else if (firstUserText === undefined) {
      if (record.type === 'event_msg' && payload.type === 'user_message') {
        firstUserText = stringField(payload, 'message');
      } else if (record.type === 'event_msg' && payload.type === 'item_completed') {
        const item = asRecord(payload.item);
        if (stringField(item, 'type')?.toLowerCase() === 'usermessage') {
          firstUserText = codexCompletedItemText(item) || codexCompletedItemMediaText(item);
        }
      } else {
        const message = codexRolloutMessage(record);
        if (message?.role === 'user') responseUserText ??= message.text;
      }
    }
    if (id && firstUserText !== undefined) break;
  }
  firstUserText ??= responseUserText;
  if (!isSafeCodexSessionId(id)) return undefined;
  if (!rolloutFilenameMatchesId(basename(candidate.path), id)) return undefined;
  return {
    source: 'codex',
    id,
    title: sanitizeForeignTitle(firstUserText) || id,
    cwd,
    ...(createdAt !== undefined ? { createdAtMs: createdAt } : {}),
    updatedAtMs: candidate.mtimeMs,
    archived: candidate.archived,
    transcriptPath: candidate.path,
  };
}

async function readCodexThreadRows(
  dbPath: string,
  query: ExternalSourceCatalogQuery,
  options: CodexThreadReadOptions = {},
): Promise<CodexThreadRow[] | undefined> {
  try {
    const sqlite = await import('node:sqlite');
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
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
      if (!query.includeArchived && columns.has('archived')) {
        where.push('(archived IS NULL OR archived = 0)');
      }
      if (columns.has('source')) {
        const placeholders = CODEX_SUPPORTED_THREAD_SOURCES.map(() => '?').join(', ');
        where.push(
          `(
            source IS NULL
            OR source IN (${placeholders})
            OR CASE WHEN json_valid(source)
              THEN json_extract(source, '$.custom')
            END IN (${placeholders})
          )`,
        );
        params.push(...CODEX_SUPPORTED_THREAD_SOURCES, ...CODEX_SUPPORTED_THREAD_SOURCES);
      }
      if (query.cwd !== undefined && columns.has('cwd')) {
        const variants = codexCwdSqlVariants(query.cwd);
        const placeholders = variants.map(() => '?').join(', ');
        const clause = /^[A-Za-z]:[\\/]/u.test(query.cwd)
          ? `(cwd IN (${placeholders}) OR LOWER(REPLACE(cwd, char(92), '/')) IN (${placeholders}))`
          : `cwd IN (${placeholders})`;
        where.push(clause);
        params.push(...variants);
        if (/^[A-Za-z]:[\\/]/u.test(query.cwd)) params.push(...variants);
      }
      // Keep the coarse cwd prefilter in SQL so unrelated newer rows cannot
      // consume the bounded candidate window. The shared matcher remains the
      // authority for separator, case, and trailing-slash equivalence.
      const orderColumn = columns.has('updated_at_ms')
        ? 'updated_at_ms'
        : columns.has('updated_at')
          ? 'updated_at'
          : 'id';
      if (options?.exactId !== undefined) {
        where.push('id = ?');
        params.push(options.exactId);
      }
      const sql =
        `SELECT ${wanted.join(', ')} FROM threads` +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY ${orderColumn} DESC` +
        (options?.limit !== undefined
          ? ' LIMIT ?'
          : options?.exactId !== undefined
            ? ' LIMIT 1'
            : '');
      if (options?.limit !== undefined) {
        params.push(options.limit);
      }
      return db.prepare(sql).all(...params) as CodexThreadRow[];
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
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

async function walkRolloutFiles(
  root: string,
  archived: boolean,
  expectedId?: string,
  options: RolloutWalkOptions = {},
): Promise<RolloutCandidate[]> {
  const files: RolloutCandidate[] = [];
  let inspectedCandidates = 0;
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    // Apply the hard cap before opening rollout contents. The filesystem
    // fallback cannot globally order by mtime without an unbounded metadata
    // scan, so directory/name order defines this bounded candidate window.
    for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
      if (
        (options.maxCandidates !== undefined && inspectedCandidates >= options.maxCandidates) ||
        (options.candidateBudget !== undefined && options.candidateBudget.remaining <= 0)
      ) {
        return;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (
        entry.isFile() &&
        entry.name.startsWith('rollout-') &&
        entry.name.endsWith('.jsonl') &&
        (expectedId === undefined || rolloutFilenameMatchesId(entry.name, expectedId))
      ) {
        inspectedCandidates += 1;
        if (options.candidateBudget !== undefined) options.candidateBudget.remaining -= 1;
        try {
          const mtimeMs = (await stat(path)).mtimeMs;
          if (
            options.maxAgeMs !== undefined &&
            options.nowMs !== undefined &&
            options.nowMs - mtimeMs > options.maxAgeMs
          ) {
            continue;
          }
          files.push({ path, mtimeMs, archived });
        } catch {
          // The external store may change while it is being scanned.
        }
      }
    }
  };
  await visit(root);
  return files;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
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
    const title = sanitizeForeignTitle(value);
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

function compareCatalogEntries(a: CodexCatalogEntry, b: CodexCatalogEntry): number {
  return (
    b.updatedAtMs - a.updatedAtMs ||
    (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0) ||
    a.transcriptPath.localeCompare(b.transcriptPath)
  );
}

function compareRolloutCandidates(a: RolloutCandidate, b: RolloutCandidate): number {
  return b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path);
}

function codexCwdSqlVariants(cwd: string): string[] {
  const variants = new Set<string>();
  for (const candidate of [cwd, cwd.replaceAll('\\', '/')]) {
    for (const separatorForm of [
      candidate,
      candidate.replaceAll('\\', '/'),
      candidate.replaceAll('/', '\\'),
    ]) {
      const withoutTrailingSeparator = separatorForm.replace(/[\\/]+$/u, '') || separatorForm;
      variants.add(withoutTrailingSeparator);
      variants.add(`${withoutTrailingSeparator}/`);
      variants.add(`${withoutTrailingSeparator}\\`);
      if (/^[A-Za-z]:[\\/]/u.test(withoutTrailingSeparator)) {
        variants.add(withoutTrailingSeparator.toLowerCase());
        variants.add(`${withoutTrailingSeparator.toLowerCase()}/`);
        variants.add(`${withoutTrailingSeparator.toLowerCase()}\\`);
      }
    }
  }
  return [...variants];
}

function stateGeneration(path: string): number {
  return Number(path.match(/\d+/)?.[0] ?? 0);
}

function rolloutFilenameMatchesId(filename: string, sessionId: string): boolean {
  return filename.endsWith(`-${sessionId}.jsonl`);
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
