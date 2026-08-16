import type { Dirent } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { StoredMessage } from '@maka/core/session';
import { sanitizeForeignTitle } from '@maka/core/foreign-session';
import type {
  ExternalMakaSession,
  ExternalSessionAdapter,
  ExternalSessionQuery,
  ExternalSessionSummary,
} from '@maka/core/external-session';

export const CODEX_SESSION_ADAPTER_ID = 'codex';
export const CODEX_ROLLOUT_MAX_BYTES = 64 * 1024 * 1024;

const CODEX_ROLLOUT_HEAD_BYTES = 512 * 1024;
const CODEX_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CODEX_UNSAFE_PATH_CHARS =
  /[\u0000-\u001F\u007F\u0080-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const CODEX_ROOT_SOURCE_TOKENS = new Set(['cli', 'exec', 'vscode']);

export interface CodexSessionAdapterOptions {
  /** Codex's state root. Defaults to `$CODEX_HOME`, then `~/.codex`. */
  codexHome?: string;
  /** Test/host override for the bounded transcript read. */
  maxRolloutBytes?: number;
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
}

type JsonRecord = Record<string, unknown>;

/**
 * Read-only adapter for Codex rollout JSONL.
 *
 * Codex persists presentation history as `event_msg` records and provider
 * protocol facts as `response_item` records. User, assistant, and reasoning
 * messages come from `event_msg` to avoid importing their response-item
 * mirrors twice. Tool calls/results come from response items because they own
 * the stable call identity and raw arguments/output.
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
    return entries.map(({ rolloutPath: _rolloutPath, ...summary }) => summary);
  }

  async readSession(sessionId: string): Promise<ExternalMakaSession> {
    assertSafeCodexSessionId(sessionId);
    const catalogEntry = await this.findCatalogEntry(sessionId);
    if (!catalogEntry) throw new Error(`Codex Session not found: ${sessionId}`);

    const rolloutPath = await this.resolveRolloutPath(catalogEntry.rolloutPath, sessionId);
    if (!rolloutPath) throw new Error(`Codex rollout is unavailable: ${sessionId}`);
    const text = await readBoundedUtf8File(rolloutPath, this.maxRolloutBytes);
    const converted = convertCodexRollout(text, sessionId, catalogEntry.name, catalogEntry.cwd);

    return {
      sourceSessionId: sessionId,
      metadata: converted.metadata,
      messages: converted.messages,
    };
  }

  private async listCatalog(query: ExternalSessionQuery): Promise<CodexCatalogEntry[]> {
    for (const dbPath of await codexStateDbsNewestFirst(this.codexHome)) {
      const rows = await readCodexThreadRows(dbPath, query);
      if (rows === undefined) continue;
      const entries = await Promise.all(rows.map((row) => this.entryFromRow(row)));
      return entries
        .filter((entry): entry is CodexCatalogEntry => entry !== undefined)
        .filter((entry) => matchesQuery(entry, query))
        .sort(compareCatalogEntries);
    }

    return this.scanRolloutCatalog(query);
  }

  private async findCatalogEntry(sessionId: string): Promise<CodexCatalogEntry | undefined> {
    for (const dbPath of await codexStateDbsNewestFirst(this.codexHome)) {
      const rows = await readCodexThreadRows(dbPath, { includeArchived: true }, sessionId);
      if (rows === undefined) continue;
      for (const row of rows) {
        const entry = await this.entryFromRow(row);
        if (entry?.id === sessionId) return entry;
      }
      break;
    }

    return this.findRolloutEntry(sessionId);
  }

  private async entryFromRow(row: CodexThreadRow): Promise<CodexCatalogEntry | undefined> {
    if (!isSafeCodexSessionId(row.id)) return undefined;
    if (typeof row.rollout_path !== 'string' || row.rollout_path.length === 0) return undefined;
    if (!isRootCodexSource(row.source)) return undefined;

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

  private async scanRolloutCatalog(query: ExternalSessionQuery): Promise<CodexCatalogEntry[]> {
    const candidates = [
      ...(await walkRolloutFiles(join(this.codexHome, 'sessions'), false)),
      ...(query.includeArchived
        ? await walkRolloutFiles(join(this.codexHome, 'archived_sessions'), true)
        : []),
    ].sort((a, b) => b.mtimeMs - a.mtimeMs);
    const entries: CodexCatalogEntry[] = [];
    for (const candidate of candidates) {
      const head = await readUtf8Prefix(candidate.path, CODEX_ROLLOUT_HEAD_BYTES).catch(
        () => undefined,
      );
      if (head === undefined) continue;
      const entry = catalogEntryFromRolloutHead(head, candidate);
      if (!entry || !matchesQuery(entry, query)) continue;
      const rolloutPath = await this.resolveRolloutPath(candidate.path, entry.id);
      if (rolloutPath) entries.push({ ...entry, rolloutPath });
    }
    return entries.sort(compareCatalogEntries);
  }

  private async findRolloutEntry(sessionId: string): Promise<CodexCatalogEntry | undefined> {
    for (const [root, archived] of [
      [join(this.codexHome, 'sessions'), false],
      [join(this.codexHome, 'archived_sessions'), true],
    ] as const) {
      for (const candidate of await walkRolloutFiles(root, archived)) {
        if (!rolloutFilenameMatchesId(basename(candidate.path), sessionId)) continue;
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
  mtimeMs: number;
  archived: boolean;
}

function convertCodexRollout(
  text: string,
  expectedSessionId: string,
  fallbackName: string,
  fallbackCwd: string,
): ExternalMakaSession {
  const records = parseRolloutRecords(text, expectedSessionId);
  const sessionMeta = records.find((record) => record.value.type === 'session_meta')?.value;
  const metaPayload = asRecord(sessionMeta?.payload);
  const actualSessionId = stringField(metaPayload, 'session_id') ?? stringField(metaPayload, 'id');
  if (actualSessionId !== expectedSessionId) {
    throw new Error(`Codex rollout Session id mismatch: expected ${expectedSessionId}`);
  }

  const metaCwd = safeCodexCwd(metaPayload?.cwd);
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

      if (eventType === 'user_message') {
        if (!activeTurnIsExplicit) {
          activeTurnId = generatedCodexId(expectedSessionId, 'turn', record.line);
        }
        const text = stringField(payload, 'message') ?? mediaOnlyUserText(payload);
        if (text.length === 0) continue;
        firstUserText ??= text;
        const turnId = ensureTurnId(record.line);
        messages.push({
          type: 'user',
          id:
            stringField(payload, 'client_id') ??
            generatedCodexId(expectedSessionId, 'user', record.line),
          turnId,
          ts: timestampFor(record),
          text,
        });
        continue;
      }

      if (eventType === 'agent_message') {
        const text = stringField(payload, 'message');
        if (!text) continue;
        messages.push({
          type: 'assistant',
          id: generatedCodexId(expectedSessionId, 'assistant', record.line),
          turnId: ensureTurnId(record.line),
          ts: timestampFor(record),
          text,
          modelId: activeModel,
          contentOrder: ['text'],
        });
        continue;
      }

      if (eventType === 'agent_reasoning') {
        const reasoning = stringField(payload, 'text');
        if (!reasoning) continue;
        messages.push({
          type: 'assistant',
          id: generatedCodexId(expectedSessionId, 'reasoning', record.line),
          turnId: ensureTurnId(record.line),
          ts: timestampFor(record),
          text: '',
          thinking: { text: reasoning },
          contentOrder: ['thinking'],
          modelId: activeModel,
        });
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
    metadata: { name, cwd: metaCwd || fallbackCwd },
    messages,
  };
}

interface ParsedRolloutRecord {
  line: number;
  value: JsonRecord;
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
      if (!isRootCodexSource(payload.source)) return undefined;
      id = stringField(payload, 'session_id') ?? stringField(payload, 'id') ?? id;
      cwd = safeCodexCwd(payload.cwd) || cwd;
      createdAt =
        normalizeEpochMs(record.timestamp) ?? normalizeEpochMs(payload.timestamp) ?? createdAt;
    } else if (
      record.type === 'event_msg' &&
      payload.type === 'user_message' &&
      firstUserText === undefined
    ) {
      firstUserText = stringField(payload, 'message');
    }
    if (id && firstUserText !== undefined) break;
  }
  if (!isSafeCodexSessionId(id)) return undefined;
  if (!rolloutFilenameMatchesId(basename(candidate.path), id)) return undefined;
  return {
    id,
    name: sanitizeForeignTitle(firstUserText) || id,
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
      if (query.cwd !== undefined && columns.has('cwd')) {
        const variants = cwdSqlVariants(query.cwd);
        where.push(`cwd IN (${variants.map(() => '?').join(', ')})`);
        params.push(...variants);
      }
      const orderColumn = columns.has('updated_at_ms')
        ? 'updated_at_ms'
        : columns.has('updated_at')
          ? 'updated_at'
          : 'id';
      const sql =
        `SELECT ${wanted.join(', ')} FROM threads` +
        (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY ${orderColumn} DESC`;
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

async function walkRolloutFiles(root: string, archived: boolean): Promise<RolloutCandidate[]> {
  const files: RolloutCandidate[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (
        entry.isFile() &&
        entry.name.startsWith('rollout-') &&
        entry.name.endsWith('.jsonl')
      ) {
        try {
          files.push({ path, mtimeMs: (await stat(path)).mtimeMs, archived });
        } catch {
          // The external store may change while it is being scanned.
        }
      }
    }
  };
  await visit(root);
  return files;
}

async function readBoundedUtf8File(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('Codex rollout is not a regular file');
    if (metadata.size > maxBytes) throw new Error(`Codex rollout exceeds ${maxBytes} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`Codex rollout exceeds ${maxBytes} bytes`);
      chunks.push(buffer.subarray(0, bytesRead));
      if (total === maxBytes) {
        const probe = Buffer.allocUnsafe(1);
        if ((await handle.read(probe, 0, 1, total)).bytesRead > 0) {
          throw new Error(`Codex rollout exceeds ${maxBytes} bytes`);
        }
        break;
      }
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    await handle.close();
  }
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

function isRootCodexSource(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') {
    if (CODEX_ROOT_SOURCE_TOKENS.has(value)) return true;
    if (!value.startsWith('{')) return false;
    try {
      return isRootCodexSource(JSON.parse(value) as unknown);
    } catch {
      return false;
    }
  }
  if (!isRecord(value)) return false;
  return value.custom === 'atlas' || value.custom === 'chatgpt';
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

function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function cwdSqlVariants(cwd: string): string[] {
  const normalized = normalizePath(cwd);
  const variants = new Set([cwd, normalized]);
  if (/^[A-Za-z]:\//.test(normalized)) variants.add(normalized.replaceAll('/', '\\'));
  if (normalized !== '/') {
    variants.add(`${normalized}/`);
    if (/^[A-Za-z]:\//.test(normalized)) variants.add(`${normalized.replaceAll('/', '\\')}\\`);
  }
  return [...variants];
}

function matchesQuery(entry: ExternalSessionSummary, query: ExternalSessionQuery): boolean {
  if (!query.includeArchived && entry.archived) return false;
  return query.cwd === undefined || normalizePath(entry.cwd) === normalizePath(query.cwd);
}

function compareCatalogEntries(a: CodexCatalogEntry, b: CodexCatalogEntry): number {
  return (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0);
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
