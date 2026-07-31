import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AGENT_MAILBOX_LIST_MAX,
  AGENT_MAILBOX_MAX_MESSAGES_PER_TEAM_RUN,
  AGENT_MAILBOX_SCHEMA_VERSION,
  isAgentMailboxMessage,
  isAgentMailboxParticipantRef,
  isAgentTeamId,
  isSafeAgentMailboxToken,
  normalizeAgentMailboxContent,
  type AgentMailboxListOptions,
  type AgentMailboxMessage,
  type AgentMailboxSendInput,
  type AgentMailboxStore,
} from '@maka/core/agent-mailbox';
import { assertSafeSessionId } from './session-store.js';
import { chainWrite } from './write-queue.js';
import {
  acquireOperationalStateDatabase,
  completeOperationalStoreCutover,
  type OperationalStateDatabaseLease,
  type OperationalStoreCutoverFailpoint,
} from './operational-state-store.js';

export interface AgentMailboxStoreDeps {
  newId?: () => string;
  now?: () => number;
}

export function createAgentMailboxStore(
  workspaceRoot: string,
  deps: AgentMailboxStoreDeps = {},
): AgentMailboxStore {
  return new FileAgentMailboxStore(workspaceRoot, deps);
}

export interface SqliteAgentMailboxStore extends AgentMailboxStore {
  ready(): Promise<void>;
  close(): void;
}

export interface SqliteAgentMailboxStoreDeps extends AgentMailboxStoreDeps {
  failpoint?: (point: OperationalStoreCutoverFailpoint) => void;
}

export function createSqliteAgentMailboxStore(
  workspaceRoot: string,
  deps: SqliteAgentMailboxStoreDeps = {},
): SqliteAgentMailboxStore {
  return new SqliteAgentMailboxStoreImpl(workspaceRoot, deps);
}

class FileAgentMailboxStore implements AgentMailboxStore {
  private readonly sessionsRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(workspaceRoot: string, deps: AgentMailboxStoreDeps) {
    this.sessionsRoot = join(workspaceRoot, 'sessions');
    this.newId = deps.newId ?? randomUUID;
    this.now = deps.now ?? Date.now;
  }

  async send(
    sessionId: string,
    input: AgentMailboxSendInput,
  ): Promise<{ message: AgentMailboxMessage; total: number }> {
    assertSafeSessionId(sessionId);
    validateSendInput(input);
    const normalized = normalizeAgentMailboxContent(input.content);
    if (!normalized.ok) throw new Error(normalized.message);

    let message: AgentMailboxMessage | undefined;
    let total = 0;
    await chainWrite(this.writeQueues, sessionId, async () => {
      const messages = await this.readAll(sessionId);
      const scope = messages.filter(
        (candidate) =>
          candidate.teamId === input.teamId && candidate.parentRunId === input.parentRunId,
      );
      if (scope.length >= AGENT_MAILBOX_MAX_MESSAGES_PER_TEAM_RUN) {
        throw new Error(
          `Agent mailbox is limited to ${AGENT_MAILBOX_MAX_MESSAGES_PER_TEAM_RUN} messages per team run`,
        );
      }
      const seq = scope.reduce((max, candidate) => Math.max(max, candidate.seq), 0) + 1;
      const id = this.newId();
      if (messages.some((candidate) => candidate.id === id)) {
        throw new Error('Generated agent mailbox message id already exists');
      }
      message = {
        schemaVersion: AGENT_MAILBOX_SCHEMA_VERSION,
        id,
        sessionId,
        teamId: input.teamId,
        parentRunId: input.parentRunId,
        seq,
        kind: input.kind,
        from: input.from,
        ...(input.to ? { to: input.to } : {}),
        content: normalized.value,
        createdAt: this.now(),
      };
      if (!isAgentMailboxMessage(message))
        throw new Error('Generated agent mailbox message is invalid');
      await this.appendMessage(sessionId, message);
      total = scope.length + 1;
    });
    if (!message) throw new Error('Agent mailbox write did not produce a message');
    return { message, total };
  }

  async list(
    sessionId: string,
    options: AgentMailboxListOptions,
  ): Promise<{ messages: AgentMailboxMessage[]; nextSeq: number; total: number }> {
    assertSafeSessionId(sessionId);
    validateListOptions(options);
    const afterSeq = options.afterSeq ?? 0;
    const limit = options.limit ?? AGENT_MAILBOX_LIST_MAX;
    const addressed = (await this.readAll(sessionId)).filter(
      (message) =>
        message.teamId === options.teamId &&
        message.parentRunId === options.parentRunId &&
        ((message.kind === 'message' && message.to?.agentId === options.recipientAgentId) ||
          (message.kind === 'broadcast' && message.from.agentId !== options.recipientAgentId)),
    );
    const messages = addressed.filter((message) => message.seq > afterSeq).slice(0, limit);
    return {
      messages,
      nextSeq: messages.at(-1)?.seq ?? afterSeq,
      total: addressed.length,
    };
  }

  private filePath(sessionId: string): string {
    return join(this.sessionsRoot, sessionId, 'agent-mailbox.jsonl');
  }

  protected async readAll(sessionId: string): Promise<AgentMailboxMessage[]> {
    const canonical = await this.readCanonicalMessages(sessionId);
    if (canonical) return canonical;
    let text: string;
    try {
      text = await readFile(this.filePath(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const messages: AgentMailboxMessage[] = [];
    const seenMessageIds = new Set<string>();
    const lastSeqByScope = new Map<string, number>();
    for (const [index, line] of text.split(/\n/).entries()) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid agent mailbox JSONL line ${index + 1}: ${String(error)}`);
      }
      if (!isAgentMailboxMessage(parsed) || parsed.sessionId !== sessionId) {
        throw new Error(`Invalid agent mailbox JSONL line ${index + 1}: unexpected message shape`);
      }
      if (seenMessageIds.has(parsed.id)) {
        throw new Error(`Invalid agent mailbox JSONL line ${index + 1}: duplicate message id`);
      }
      seenMessageIds.add(parsed.id);
      const scope = `${parsed.teamId}\u0000${parsed.parentRunId}`;
      const prior = lastSeqByScope.get(scope) ?? 0;
      if (parsed.seq <= prior) {
        throw new Error(`Invalid agent mailbox JSONL line ${index + 1}: non-monotonic sequence`);
      }
      lastSeqByScope.set(scope, parsed.seq);
      messages.push(parsed);
    }
    return messages;
  }

  protected async readCanonicalMessages(
    _sessionId: string,
  ): Promise<AgentMailboxMessage[] | undefined> {
    return undefined;
  }

  protected async appendMessage(sessionId: string, message: AgentMailboxMessage): Promise<void> {
    const path = this.filePath(sessionId);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(message)}\n`, 'utf8');
  }
}

class SqliteAgentMailboxStoreImpl extends FileAgentMailboxStore implements SqliteAgentMailboxStore {
  readonly #lease: OperationalStateDatabaseLease;
  readonly #ready: Promise<void>;

  constructor(workspaceRoot: string, deps: SqliteAgentMailboxStoreDeps) {
    super(workspaceRoot, deps);
    const root = resolve(workspaceRoot);
    this.#lease = acquireOperationalStateDatabase(root);
    this.#ready = importLegacyAgentMailboxState(root, this.#lease, deps.failpoint);
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  close(): void {
    this.#lease.close();
  }

  protected override async readCanonicalMessages(
    sessionId: string,
  ): Promise<AgentMailboxMessage[]> {
    await this.#ready;
    return readSqliteAgentMailboxMessages(this.#lease.database, sessionId);
  }

  protected override async appendMessage(
    sessionId: string,
    message: AgentMailboxMessage,
  ): Promise<void> {
    await this.#ready;
    this.#lease.transaction('write', () => {
      insertAgentMailboxMessage(this.#lease.database, sessionId, message);
    });
  }
}

interface LegacyAgentMailbox {
  sessionId: string;
  messages: AgentMailboxMessage[];
}

async function importLegacyAgentMailboxState(
  root: string,
  lease: OperationalStateDatabaseLease,
  failpoint?: (point: OperationalStoreCutoverFailpoint) => void,
): Promise<void> {
  const ledgers = await readLegacyAgentMailboxes(root);
  const fingerprint = `sha256:${createHash('sha256')
    .update(JSON.stringify(ledgers))
    .digest('hex')}`;
  completeOperationalStoreCutover(lease, {
    storeName: 'workflow_agent_mailbox',
    sourcePath: join(root, 'sessions'),
    sourceFingerprint: fingerprint,
    failpoint,
    importAndValidate: (database) => {
      let messageCount = 0;
      for (const ledger of ledgers) {
        for (const message of ledger.messages) {
          insertOrValidateAgentMailboxMessage(database, ledger.sessionId, message);
          messageCount += 1;
        }
      }
      const persisted = database
        .prepare('SELECT COUNT(*) AS count FROM workflow_agent_mailbox_messages')
        .get() as { count?: unknown };
      if (persisted.count !== messageCount) {
        throw new Error('Agent mailbox cutover row-count validation failed');
      }
      return { sessions: ledgers.length, messages: messageCount };
    },
  });
}

async function readLegacyAgentMailboxes(root: string): Promise<LegacyAgentMailbox[]> {
  const sessionsRoot = join(root, 'sessions');
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: LegacyAgentMailbox[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    assertSafeSessionId(entry.name);
    let text: string;
    try {
      text = await readFile(join(sessionsRoot, entry.name, 'agent-mailbox.jsonl'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    result.push({
      sessionId: entry.name,
      messages: decodeAgentMailboxText(text, entry.name),
    });
  }
  return result;
}

function decodeAgentMailboxText(text: string, sessionId: string): AgentMailboxMessage[] {
  const messages: AgentMailboxMessage[] = [];
  const seen = new Set<string>();
  const lastByScope = new Map<string, number>();
  for (const [index, line] of text.split(/\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid agent mailbox JSONL line ${index + 1}: ${String(error)}`);
    }
    if (!isAgentMailboxMessage(parsed) || parsed.sessionId !== sessionId || seen.has(parsed.id)) {
      throw new Error(`Invalid agent mailbox JSONL line ${index + 1}: unexpected message shape`);
    }
    const scope = `${parsed.teamId}\u0000${parsed.parentRunId}`;
    if (parsed.seq <= (lastByScope.get(scope) ?? 0)) {
      throw new Error(`Invalid agent mailbox JSONL line ${index + 1}: non-monotonic sequence`);
    }
    seen.add(parsed.id);
    lastByScope.set(scope, parsed.seq);
    messages.push(parsed);
  }
  return messages;
}

function readSqliteAgentMailboxMessages(
  database: DatabaseSync,
  sessionId: string,
): AgentMailboxMessage[] {
  assertSafeSessionId(sessionId);
  const rows = database
    .prepare(`
      SELECT record_json
      FROM workflow_agent_mailbox_messages
      WHERE session_id = ?
      ORDER BY sequence
    `)
    .all(sessionId) as Array<{ record_json?: unknown }>;
  return rows.map((row, index) => {
    if (typeof row.record_json !== 'string') {
      throw new Error(`Invalid SQLite agent mailbox message at sequence ${index}`);
    }
    const parsed = JSON.parse(row.record_json);
    if (!isAgentMailboxMessage(parsed) || parsed.sessionId !== sessionId) {
      throw new Error(`Invalid SQLite agent mailbox message at sequence ${index}`);
    }
    return parsed;
  });
}

function insertAgentMailboxMessage(
  database: DatabaseSync,
  sessionId: string,
  message: AgentMailboxMessage,
): void {
  const row = database
    .prepare(`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
      FROM workflow_agent_mailbox_messages
      WHERE session_id = ?
    `)
    .get(sessionId) as { sequence?: unknown };
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence)) {
    throw new Error('Invalid next agent mailbox sequence');
  }
  database
    .prepare(`
      INSERT INTO workflow_agent_mailbox_messages(
        session_id, sequence, message_id, team_id, parent_run_id,
        scope_sequence, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      sessionId,
      row.sequence,
      message.id,
      message.teamId,
      message.parentRunId,
      message.seq,
      JSON.stringify(message),
    );
}

function insertOrValidateAgentMailboxMessage(
  database: DatabaseSync,
  sessionId: string,
  message: AgentMailboxMessage,
): void {
  const existing = database
    .prepare(`
      SELECT record_json
      FROM workflow_agent_mailbox_messages
      WHERE session_id = ? AND message_id = ?
    `)
    .get(sessionId, message.id) as { record_json?: unknown } | undefined;
  if (existing) {
    if (existing.record_json !== JSON.stringify(message)) {
      throw new Error(`Agent mailbox cutover conflict: ${message.id}`);
    }
    return;
  }
  insertAgentMailboxMessage(database, sessionId, message);
}

function validateSendInput(input: AgentMailboxSendInput): void {
  if (!isAgentTeamId(input.teamId)) throw new Error('Invalid agent team id');
  if (!isSafeAgentMailboxToken(input.parentRunId)) throw new Error('Invalid parent AgentRun id');
  if (!isAgentMailboxParticipantRef(input.from)) throw new Error('Invalid agent mailbox sender');
  if (input.from.role === 'lead' && input.from.runId !== input.parentRunId) {
    throw new Error('Lead mailbox messages must be scoped to the lead AgentRun');
  }
  if (input.kind === 'broadcast') {
    if (input.to !== undefined)
      throw new Error('Broadcast messages cannot have a direct recipient');
    return;
  }
  if (
    input.kind !== 'message' ||
    !input.to ||
    (input.to.role !== 'lead' && input.to.role !== 'member') ||
    !isSafeAgentMailboxToken(input.to.agentId)
  )
    throw new Error('Direct agent mailbox messages require a valid recipient');
  if (input.to.agentId === input.from.agentId)
    throw new Error('Agent mailbox messages cannot target the sender');
}

function validateListOptions(options: AgentMailboxListOptions): void {
  if (!isAgentTeamId(options.teamId)) throw new Error('Invalid agent team id');
  if (!isSafeAgentMailboxToken(options.parentRunId)) throw new Error('Invalid parent AgentRun id');
  if (!isSafeAgentMailboxToken(options.recipientAgentId))
    throw new Error('Invalid recipient agent id');
  if (
    options.afterSeq !== undefined &&
    (!Number.isSafeInteger(options.afterSeq) || options.afterSeq < 0)
  ) {
    throw new Error('afterSeq must be a non-negative safe integer');
  }
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > AGENT_MAILBOX_LIST_MAX)
  ) {
    throw new Error(`Agent mailbox list limit must be between 1 and ${AGENT_MAILBOX_LIST_MAX}`);
  }
}
