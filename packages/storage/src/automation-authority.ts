import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isCollaborationMode } from '@maka/core/collaboration';
import { isOrchestrationMode } from '@maka/core/orchestration';
import { isThinkingLevel } from '@maka/core/model-thinking';
import {
  AUTOMATION_CRON_EXPRESSION_LIMIT,
  AUTOMATION_LAST_ERROR_LIMIT,
  AUTOMATION_NAME_LIMIT,
  AUTOMATION_PROMPT_LIMIT,
  isAutomationTextWithinLimit,
  truncateAutomationText,
  type AutomationAuthoritySnapshot,
  type AutomationDefinition,
  type AutomationExecutionTemplate,
  type AutomationPendingFire,
  type AutomationSchedule,
} from '@maka/core/automation';
import {
  completeOperationalStoreCutover,
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
  type OperationalStoreCutoverFailpoint,
} from './operational-state-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';

export const LEGACY_AUTOMATION_FILE = 'automations.json';
const MAX_AUTOMATIONS = 10_000;
const MAX_PENDING_FIRES = 10_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFINITION_KEYS = new Set([
  'id',
  'kind',
  'name',
  'status',
  'prompt',
  'sessionId',
  'schedule',
  'createdAt',
  'updatedAt',
  'nextFireAt',
  'lastFireAt',
  'lastRunId',
  'fireCount',
  'maxFires',
  'expiresAt',
  'lastError',
  'consecutiveFailures',
  'durable',
  'deferredFireCount',
  'execution',
]);
const PENDING_FIRE_KEYS = new Set([
  'id',
  'automationId',
  'automationKind',
  'automationName',
  'prompt',
  'scheduledFor',
  'targetSessionId',
  'turnId',
  'runId',
  'userMessageId',
  'status',
  'admittedAt',
  'updatedAt',
  'startedAt',
  'execution',
]);

const writerBrand: unique symbol = Symbol('InteractiveAutomationAuthorityWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveAutomationAuthorityWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveAutomationAuthorityWriter>>();

export interface CommitAutomationAuthorityInput {
  readonly expectedRevision: number;
  readonly automations: readonly AutomationDefinition[];
  readonly pendingFires: readonly AutomationPendingFire[];
}

export type CommitAutomationAuthorityResult =
  | { readonly kind: 'committed'; readonly snapshot: AutomationAuthoritySnapshot }
  | { readonly kind: 'revision_conflict'; readonly actualRevision: number };

export interface InteractiveAutomationAuthorityWriter {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
  read(): Promise<AutomationAuthoritySnapshot>;
  commit(input: CommitAutomationAuthorityInput): Promise<CommitAutomationAuthorityResult>;
  close(): void;
}

export interface OpenAutomationAuthorityOptions {
  readonly failpoint?: (point: OperationalStoreCutoverFailpoint) => void;
}

export function authenticateInteractiveAutomationAuthorityWriter(
  writer: InteractiveAutomationAuthorityWriter,
): InteractiveAutomationAuthorityWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive Automation authority writer',
    );
  }
  return writer;
}

export async function openInteractiveAutomationAuthorityForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
  options: OpenAutomationAuthorityOptions = {},
): Promise<InteractiveAutomationAuthorityWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;

  const pending = Promise.resolve().then(async () => {
    let store: SqliteAutomationAuthority | undefined;
    try {
      store = await runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
        const opened = new SqliteAutomationAuthority(root, options);
        await opened.ready();
        return opened;
      });
      await assertStorageRootLease(lease, 'interactive', 'write');
      const recoveredExisting = writerByLease.get(lease);
      if (recoveredExisting) {
        store.close();
        return recoveredExisting;
      }
      const writer = createWriterFacade(lease, store);
      writers.add(writer);
      writerByLease.set(lease, writer);
      return writer;
    } catch (error) {
      store?.close();
      throw error;
    }
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  store: SqliteAutomationAuthority,
): InteractiveAutomationAuthorityWriter {
  let closed = false;
  const run = <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'Automation authority writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', async () => operation());
  };
  const writer: InteractiveAutomationAuthorityWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    read: () => run(() => store.read()),
    commit: (input) => {
      const accepted = normalizeCommitInput(input);
      return run(() => store.commit(accepted));
    },
    close: () => {
      if (closed) return;
      closed = true;
      if (writerByLease.get(lease) === writer) writerByLease.delete(lease);
      writers.delete(writer);
      store.close();
    },
  };
  return Object.freeze(writer);
}

class SqliteAutomationAuthority {
  readonly #lease: OperationalStateDatabaseLease;
  readonly #ready: Promise<void>;

  constructor(root: string, options: OpenAutomationAuthorityOptions) {
    this.#lease = acquireOperationalStateDatabase(root);
    this.#ready = importLegacyAutomations(root, this.#lease, options);
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  read(): AutomationAuthoritySnapshot {
    const revision = readRevision(this.#lease);
    const automations = this.#lease.database
      .prepare(`
        SELECT automation_id, session_id, created_at, status, durable, record_json
        FROM automation_definitions
        ORDER BY created_at, automation_id
      `)
      .all()
      .map((row) => readDefinitionRow(row));
    const pendingFires = this.#lease.database
      .prepare(`
        SELECT fire_id, automation_id, target_session_id, admitted_at, record_json
        FROM automation_pending_fires
        ORDER BY admitted_at, fire_id
      `)
      .all()
      .map((row) => readPendingFireRow(row));
    assertSnapshotRelationships(automations, pendingFires);
    return cloneSnapshot({ revision, automations, pendingFires });
  }

  commit(input: CommitAutomationAuthorityInput): CommitAutomationAuthorityResult {
    return this.#lease.transaction('write', () => {
      const actualRevision = readRevision(this.#lease);
      if (actualRevision !== input.expectedRevision) {
        return { kind: 'revision_conflict', actualRevision };
      }
      const existingDefinitions = new Map(
        this.#lease.database
          .prepare('SELECT automation_id, record_json FROM automation_definitions')
          .all()
          .map((row) => readRecordJsonIndexRow(row, 'automation_id')),
      );
      const existingFires = new Map(
        this.#lease.database
          .prepare('SELECT fire_id, record_json FROM automation_pending_fires')
          .all()
          .map((row) => readRecordJsonIndexRow(row, 'fire_id')),
      );
      const desiredDefinitionIds = new Set(input.automations.map((automation) => automation.id));
      const desiredFireIds = new Set(input.pendingFires.map((fire) => fire.id));
      const deleteFire = this.#lease.database.prepare(
        'DELETE FROM automation_pending_fires WHERE fire_id = ?',
      );
      for (const fireId of existingFires.keys()) {
        if (!desiredFireIds.has(fireId)) deleteFire.run(fireId);
      }
      const deleteDefinition = this.#lease.database.prepare(
        'DELETE FROM automation_definitions WHERE automation_id = ?',
      );
      for (const automationId of existingDefinitions.keys()) {
        if (!desiredDefinitionIds.has(automationId)) deleteDefinition.run(automationId);
      }
      const upsertDefinition = this.#lease.database.prepare(`
        INSERT INTO automation_definitions(
          automation_id, session_id, created_at, status, durable, record_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(automation_id) DO UPDATE SET
          session_id = excluded.session_id,
          created_at = excluded.created_at,
          status = excluded.status,
          durable = excluded.durable,
          record_json = excluded.record_json
      `);
      for (const automation of input.automations) {
        const encoded = JSON.stringify(automation);
        if (existingDefinitions.get(automation.id) === encoded) continue;
        upsertDefinition.run(
          automation.id,
          automation.sessionId,
          automation.createdAt,
          automation.status,
          automation.durable === true ? 1 : 0,
          encoded,
        );
      }
      const changedFires = input.pendingFires
        .map((fire) => ({ fire, encoded: JSON.stringify(fire) }))
        .filter(({ fire, encoded }) => existingFires.get(fire.id) !== encoded);
      for (const { fire } of changedFires) {
        if (existingFires.has(fire.id)) deleteFire.run(fire.id);
      }
      const insertFire = this.#lease.database.prepare(`
        INSERT INTO automation_pending_fires(
          fire_id, automation_id, target_session_id, admitted_at, record_json
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const { fire, encoded } of changedFires) {
        insertFire.run(fire.id, fire.automationId, fire.targetSessionId, fire.admittedAt, encoded);
      }
      const revision = actualRevision + 1;
      const updated = this.#lease.database
        .prepare('UPDATE automation_authority_state SET revision = ? WHERE singleton = 1')
        .run(revision);
      if (updated.changes !== 1) throw new Error('Unable to advance Automation revision');
      return {
        kind: 'committed',
        snapshot: cloneSnapshot({
          revision,
          automations: input.automations,
          pendingFires: input.pendingFires,
        }),
      };
    });
  }

  close(): void {
    this.#lease.close();
  }
}

async function importLegacyAutomations(
  root: string,
  lease: OperationalStateDatabaseLease,
  options: OpenAutomationAuthorityOptions,
): Promise<void> {
  const sourcePath = join(root, LEGACY_AUTOMATION_FILE);
  const source = await readLegacyAutomationFile(sourcePath);
  completeOperationalStoreCutover(lease, {
    storeName: 'automations',
    sourcePath,
    sourceFingerprint: source.fingerprint,
    ...(options.failpoint ? { failpoint: options.failpoint } : {}),
    importAndValidate: (database) => {
      const insert = database.prepare(`
        INSERT OR IGNORE INTO automation_definitions(
          automation_id, session_id, created_at, status, durable, record_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const automation of source.automations) {
        const encoded = JSON.stringify(automation);
        const result = insert.run(
          automation.id,
          automation.sessionId,
          automation.createdAt,
          automation.status,
          automation.durable === true ? 1 : 0,
          encoded,
        );
        if (result.changes === 0) {
          const row = database
            .prepare('SELECT record_json FROM automation_definitions WHERE automation_id = ?')
            .get(automation.id) as { record_json?: unknown } | undefined;
          if (!row || row.record_json !== encoded) {
            throw new Error(`Automation cutover conflict: ${automation.id}`);
          }
        }
      }
      if (source.automations.length > 0) {
        database
          .prepare(`
            UPDATE automation_authority_state
            SET revision = CASE WHEN revision = 0 THEN 1 ELSE revision END
            WHERE singleton = 1
          `)
          .run();
      }
      return { automations: source.automations.length };
    },
  });
}

async function readLegacyAutomationFile(
  path: string,
): Promise<{ fingerprint: string; automations: readonly AutomationDefinition[] }> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        fingerprint: `sha256:${createHash('sha256').update('absent').digest('hex')}`,
        automations: [],
      };
    }
    throw error;
  }
  return {
    fingerprint: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
    automations: decodeLegacyAutomationFile(contents),
  };
}

export function decodeLegacyAutomationFile(contents: string): readonly AutomationDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error('Legacy Automation store is not valid JSON', { cause: error });
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.automations)) {
    throw new Error('Legacy Automation store has an unsupported shape or version');
  }
  if (parsed.automations.length > MAX_AUTOMATIONS) {
    throw new Error('Legacy Automation store exceeds the definition limit');
  }
  const automations = parsed.automations.map((automation) =>
    normalizeAutomationDefinition(automation, { legacy: true }),
  );
  assertUnique(
    automations.map((automation) => automation.id),
    'Automation id',
  );
  return automations;
}

function normalizeCommitInput(
  input: CommitAutomationAuthorityInput,
): CommitAutomationAuthorityInput {
  if (!isNonnegativeInteger(input.expectedRevision)) {
    throw new Error('Expected Automation revision must be a non-negative integer');
  }
  if (!Array.isArray(input.automations) || input.automations.length > MAX_AUTOMATIONS) {
    throw new Error('Automation definitions exceed the authority limit');
  }
  if (!Array.isArray(input.pendingFires) || input.pendingFires.length > MAX_PENDING_FIRES) {
    throw new Error('Pending Automation fires exceed the authority limit');
  }
  const automations = input.automations.map((automation) =>
    normalizeAutomationDefinition(automation),
  );
  const pendingFires = input.pendingFires.map(normalizePendingFire);
  assertUnique(
    automations.map((automation) => automation.id),
    'Automation id',
  );
  assertUnique(
    pendingFires.map((fire) => fire.id),
    'Automation fire id',
  );
  assertUnique(
    pendingFires.map((fire) => fire.automationId),
    'pending Automation id',
  );
  assertSnapshotRelationships(automations, pendingFires);
  return { expectedRevision: input.expectedRevision, automations, pendingFires };
}

function assertSnapshotRelationships(
  automations: readonly AutomationDefinition[],
  pendingFires: readonly AutomationPendingFire[],
): void {
  const definitions = new Map(automations.map((automation) => [automation.id, automation]));
  for (const fire of pendingFires) {
    const automation = definitions.get(fire.automationId);
    if (!automation) {
      throw new Error(`Pending Automation fire has no definition: ${fire.id}`);
    }
    if (
      automation.kind !== fire.automationKind ||
      automation.name !== fire.automationName ||
      automation.prompt !== fire.prompt ||
      automation.fireCount === 0 ||
      automation.lastFireAt === null ||
      automation.lastFireAt > fire.admittedAt ||
      (automation.kind === 'heartbeat' && automation.sessionId !== fire.targetSessionId) ||
      (automation.kind === 'cron' &&
        JSON.stringify(automation.execution) !== JSON.stringify(fire.execution))
    ) {
      throw new Error(`Pending Automation fire contradicts its definition: ${fire.id}`);
    }
  }
}

function normalizeAutomationDefinition(
  value: unknown,
  options: { readonly legacy?: boolean } = {},
): AutomationDefinition {
  if (!isRecord(value) || !hasOnlyKeys(value, DEFINITION_KEYS)) {
    throw new Error('Invalid Automation definition');
  }
  const schedule = normalizeSchedule(value.schedule);
  const execution =
    value.execution === undefined ? undefined : normalizeExecutionTemplate(value.execution);
  if (!isId(value.id) || !isId(value.sessionId)) throw new Error('Invalid Automation identity');
  if (value.kind !== 'heartbeat' && value.kind !== 'cron') {
    throw new Error('Invalid Automation kind');
  }
  if (
    (value.status !== 'active' &&
      value.status !== 'paused' &&
      value.status !== 'completed' &&
      value.status !== 'expired') ||
    !isAutomationTextWithinLimit(value.name, AUTOMATION_NAME_LIMIT, { nonblank: true }) ||
    !isAutomationTextWithinLimit(value.prompt, AUTOMATION_PROMPT_LIMIT, { nonblank: true })
  ) {
    throw new Error('Invalid Automation state');
  }
  const lastError = normalizeLastError(value.lastError, options.legacy === true);
  if (
    !isNonnegativeInteger(value.createdAt) ||
    !isNonnegativeInteger(value.updatedAt) ||
    !isNullableNonnegativeInteger(value.nextFireAt) ||
    !isNullableNonnegativeInteger(value.lastFireAt) ||
    !(value.lastRunId === null || isId(value.lastRunId)) ||
    !isNonnegativeInteger(value.fireCount) ||
    !(value.maxFires === null || (isNonnegativeInteger(value.maxFires) && value.maxFires > 0)) ||
    !isNullableNonnegativeInteger(value.expiresAt) ||
    lastError === undefined ||
    !isNonnegativeInteger(value.consecutiveFailures) ||
    !(value.durable === undefined || typeof value.durable === 'boolean') ||
    !(value.deferredFireCount === undefined || isNonnegativeInteger(value.deferredFireCount))
  ) {
    throw new Error('Invalid Automation counters or timestamps');
  }
  if (execution && value.kind !== 'cron') {
    throw new Error('Only cron Automations may carry an execution template');
  }
  return structuredClone({
    id: value.id,
    kind: value.kind,
    name: value.name,
    status: value.status,
    prompt: value.prompt,
    sessionId: value.sessionId,
    schedule,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    nextFireAt: value.nextFireAt,
    lastFireAt: value.lastFireAt,
    lastRunId: value.lastRunId,
    fireCount: value.fireCount,
    maxFires: value.maxFires,
    expiresAt: value.expiresAt,
    lastError,
    consecutiveFailures: value.consecutiveFailures,
    ...(value.durable === undefined ? {} : { durable: value.durable }),
    ...(value.deferredFireCount === undefined
      ? {}
      : { deferredFireCount: value.deferredFireCount }),
    ...(execution ? { execution } : {}),
  } satisfies AutomationDefinition);
}

function normalizePendingFire(value: unknown): AutomationPendingFire {
  if (!isRecord(value) || !hasOnlyKeys(value, PENDING_FIRE_KEYS)) {
    throw new Error('Invalid pending Automation fire');
  }
  if (
    !isId(value.id) ||
    !isId(value.automationId) ||
    !isId(value.targetSessionId) ||
    !isId(value.turnId) ||
    !isId(value.runId) ||
    !isId(value.userMessageId) ||
    (value.automationKind !== 'heartbeat' && value.automationKind !== 'cron') ||
    !isAutomationTextWithinLimit(value.automationName, AUTOMATION_NAME_LIMIT, {
      nonblank: true,
    }) ||
    !isAutomationTextWithinLimit(value.prompt, AUTOMATION_PROMPT_LIMIT, { nonblank: true }) ||
    !isNonnegativeInteger(value.scheduledFor) ||
    !isNonnegativeInteger(value.admittedAt) ||
    !isNonnegativeInteger(value.updatedAt) ||
    (value.status !== 'admitted' && value.status !== 'running')
  ) {
    throw new Error('Invalid pending Automation fire state');
  }
  const startedAt =
    value.startedAt === undefined ? undefined : requireNonnegativeInteger(value.startedAt);
  if ((value.status === 'running') !== (startedAt !== undefined)) {
    throw new Error('Pending Automation fire start state is inconsistent');
  }
  const execution =
    value.execution === undefined ? undefined : normalizeExecutionTemplate(value.execution);
  if ((value.automationKind === 'cron') !== (execution !== undefined)) {
    throw new Error('Pending cron fire must freeze its execution template');
  }
  return structuredClone({
    id: value.id,
    automationId: value.automationId,
    automationKind: value.automationKind,
    automationName: value.automationName,
    prompt: value.prompt,
    scheduledFor: value.scheduledFor,
    targetSessionId: value.targetSessionId,
    turnId: value.turnId,
    runId: value.runId,
    userMessageId: value.userMessageId,
    status: value.status,
    admittedAt: value.admittedAt,
    updatedAt: value.updatedAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(execution ? { execution } : {}),
  } satisfies AutomationPendingFire);
}

function normalizeSchedule(value: unknown): AutomationSchedule {
  if (!isRecord(value)) throw new Error('Invalid Automation schedule');
  if (
    value.type === 'cron' &&
    hasOnlyKeys(value, new Set(['type', 'expression'])) &&
    isAutomationTextWithinLimit(value.expression, AUTOMATION_CRON_EXPRESSION_LIMIT)
  ) {
    return { type: 'cron', expression: value.expression };
  }
  if (
    value.type === 'interval' &&
    hasOnlyKeys(value, new Set(['type', 'seconds'])) &&
    isNonnegativeInteger(value.seconds) &&
    value.seconds >= 10 &&
    value.seconds <= 86_400
  ) {
    return { type: 'interval', seconds: value.seconds };
  }
  if (
    value.type === 'once' &&
    hasOnlyKeys(value, new Set(['type', 'delaySeconds'])) &&
    isNonnegativeInteger(value.delaySeconds) &&
    value.delaySeconds >= 5 &&
    value.delaySeconds <= 86_400
  ) {
    return { type: 'once', delaySeconds: value.delaySeconds };
  }
  throw new Error('Invalid Automation schedule');
}

function normalizeExecutionTemplate(value: unknown): AutomationExecutionTemplate {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set([
        'cwd',
        'projectId',
        'backend',
        'llmConnectionSlug',
        'model',
        'thinkingLevel',
        'collaborationMode',
        'orchestrationMode',
      ]),
    ) ||
    !isBoundedString(value.cwd, 4_096) ||
    !(value.projectId === undefined || value.projectId === null || isId(value.projectId)) ||
    (value.backend !== 'ai-sdk' && value.backend !== 'fake' && value.backend !== 'pi-agent') ||
    !isId(value.llmConnectionSlug) ||
    !isBoundedString(value.model, 256) ||
    !(value.thinkingLevel === undefined || isThinkingLevel(value.thinkingLevel)) ||
    !isCollaborationMode(value.collaborationMode) ||
    !isOrchestrationMode(value.orchestrationMode)
  ) {
    throw new Error('Invalid Automation execution template');
  }
  return {
    cwd: value.cwd,
    ...(value.projectId === undefined ? {} : { projectId: value.projectId }),
    backend: value.backend,
    llmConnectionSlug: value.llmConnectionSlug,
    model: value.model,
    ...(value.thinkingLevel === undefined ? {} : { thinkingLevel: value.thinkingLevel }),
    collaborationMode: value.collaborationMode,
    orchestrationMode: value.orchestrationMode,
  };
}

function readDefinitionRow(value: unknown): AutomationDefinition {
  if (!isRecord(value) || typeof value.record_json !== 'string') {
    throw new Error('Invalid SQLite Automation definition row');
  }
  const definition = normalizeAutomationDefinition(JSON.parse(value.record_json));
  if (
    value.automation_id !== definition.id ||
    value.session_id !== definition.sessionId ||
    value.created_at !== definition.createdAt ||
    value.status !== definition.status ||
    value.durable !== (definition.durable === true ? 1 : 0)
  ) {
    throw new Error(`SQLite Automation definition index mismatch: ${definition.id}`);
  }
  return definition;
}

function readPendingFireRow(value: unknown): AutomationPendingFire {
  if (!isRecord(value) || typeof value.record_json !== 'string') {
    throw new Error('Invalid SQLite pending Automation fire row');
  }
  const fire = normalizePendingFire(JSON.parse(value.record_json));
  if (
    value.fire_id !== fire.id ||
    value.automation_id !== fire.automationId ||
    value.target_session_id !== fire.targetSessionId ||
    value.admitted_at !== fire.admittedAt
  ) {
    throw new Error(`SQLite pending Automation fire index mismatch: ${fire.id}`);
  }
  return fire;
}

function readRevision(lease: OperationalStateDatabaseLease): number {
  const row = lease.database
    .prepare('SELECT revision FROM automation_authority_state WHERE singleton = 1')
    .get() as { revision?: unknown } | undefined;
  if (!row || !isNonnegativeInteger(row.revision)) {
    throw new Error('Invalid Automation authority revision');
  }
  return row.revision;
}

function cloneSnapshot(snapshot: AutomationAuthoritySnapshot): AutomationAuthoritySnapshot {
  return structuredClone(snapshot);
}

function readRecordJsonIndexRow(
  value: unknown,
  key: 'automation_id' | 'fire_id',
): readonly [string, string] {
  if (!isRecord(value) || typeof value[key] !== 'string' || typeof value.record_json !== 'string') {
    throw new Error('Invalid SQLite Automation index row');
  }
  return [value[key], value.record_json];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max;
}

function normalizeLastError(value: unknown, legacy: boolean): string | null | undefined {
  if (value === null) return null;
  if (legacy && value === '') return null;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (legacy) return truncateAutomationText(value, AUTOMATION_LAST_ERROR_LIMIT);
  return isAutomationTextWithinLimit(value, AUTOMATION_LAST_ERROR_LIMIT) ? value : undefined;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableNonnegativeInteger(value: unknown): value is number | null {
  return value === null || isNonnegativeInteger(value);
}

function requireNonnegativeInteger(value: unknown): number {
  if (!isNonnegativeInteger(value)) throw new Error('Expected a non-negative integer');
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}
