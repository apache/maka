import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  PlanConflictError,
  activePlanExecution,
  type AbandonPlanProposalInput,
  emptyPlanSessionState,
  latestPlanProposal,
  type ApprovePlanProposalInput,
  type CancelPlanExecutionInput,
  type PlanEvent,
  type PlanExecution,
  type PlanExecutionStep,
  type PlanMutationResult,
  type PlanProposal,
  type PlanSessionState,
  type PlanStepDefinition,
  type PlanStore,
  type RequestPlanRevisionInput,
  type SubmitPlanProposalInput,
  type UpdatePlanExecutionInput,
} from '@maka/core/plan';
import { appendJsonl } from './jsonl-append.js';
import { classifyJsonRecord } from './json-prefix.js';
import { chainWrite } from './write-queue.js';
import {
  acquireOperationalStateDatabase,
  completeOperationalStoreCutover,
  type OperationalStateDatabaseLease,
  type OperationalStoreCutoverFailpoint,
} from './operational-state-store.js';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface CreatePlanStoreOptions {
  newId?: () => string;
  now?: () => number;
}

export function createPlanStore(
  workspaceRoot: string,
  options: CreatePlanStoreOptions = {},
): PlanStore {
  return new FilePlanStore(workspaceRoot, options);
}

export interface SqlitePlanStore extends PlanStore {
  ready(): Promise<void>;
  close(): void;
}

export interface CreateSqlitePlanStoreOptions extends CreatePlanStoreOptions {
  failpoint?: (point: OperationalStoreCutoverFailpoint) => void;
}

export function createSqlitePlanStore(
  workspaceRoot: string,
  options: CreateSqlitePlanStoreOptions = {},
): SqlitePlanStore {
  return new SqlitePlanStoreImpl(workspaceRoot, options);
}

class FilePlanStore implements PlanStore {
  private readonly durabilityRoot: string;
  private readonly sessionsRoot: string;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(workspaceRoot: string, options: CreatePlanStoreOptions) {
    this.durabilityRoot = resolve(workspaceRoot);
    this.sessionsRoot = join(this.durabilityRoot, 'sessions');
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  async readState(sessionId: string): Promise<PlanSessionState> {
    return (await this.readLedger(sessionId)).state;
  }

  async submitProposal(input: SubmitPlanProposalInput): Promise<PlanMutationResult> {
    return this.mutate(input.sessionId, async (state) => {
      const title = requiredText(input.title, 'Plan title');
      const steps = normalizeDefinitions(input.steps);
      const latest = latestPlanProposal(state);
      if (state.activeExecutionId) {
        throw new PlanConflictError('Cannot submit a new proposal while a plan is executing');
      }
      const sourceExecution = input.sourceExecutionId
        ? executionById(state, input.sourceExecutionId)
        : undefined;
      if (sourceExecution && sourceExecution.status !== 'interrupted') {
        throw new PlanConflictError('Only an interrupted execution can be replanned');
      }
      const revisesLatest =
        latest !== undefined &&
        (latest.status !== 'approved' || sourceExecution?.proposalId === latest.proposalId);
      const planId = revisesLatest ? latest.planId : this.newId();
      const proposalId = this.newId();
      const submittedAt = this.now();
      const proposal: PlanProposal = {
        planId,
        proposalId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        revision: revisesLatest ? latest.revision + 1 : 1,
        ...(revisesLatest ? { supersedesProposalId: latest.proposalId } : {}),
        ...(sourceExecution ? { sourceExecutionId: sourceExecution.executionId } : {}),
        title,
        ...(optionalText(input.overview) ? { overview: optionalText(input.overview) } : {}),
        steps,
        ...(input.risks && input.risks.length > 0
          ? { risks: input.risks.map((risk) => requiredText(risk, 'Plan risk')) }
          : {}),
        status: 'pending_approval',
        submittedAt,
      };
      return {
        type: 'plan_submitted',
        id: this.newId(),
        sessionId: input.sessionId,
        ts: submittedAt,
        storeVersion: state.storeVersion + 1,
        proposal,
      };
    });
  }

  async requestRevision(input: RequestPlanRevisionInput): Promise<PlanMutationResult> {
    return this.mutate(input.sessionId, async (state) => {
      const proposal = proposalById(state, input.proposalId);
      if (proposal.status === 'stale') {
        throw new PlanConflictError('Plan proposal is already stale');
      }
      if (proposal.status === 'approved') {
        throw new PlanConflictError('An approved plan proposal cannot be revised');
      }
      if (state.latestProposalId !== proposal.proposalId) {
        throw new PlanConflictError('Only the latest plan proposal can be revised');
      }
      return {
        type: 'plan_revision_requested',
        id: this.newId(),
        sessionId: input.sessionId,
        ts: this.now(),
        storeVersion: state.storeVersion + 1,
        proposalId: proposal.proposalId,
      };
    });
  }

  async abandonProposal(input: AbandonPlanProposalInput): Promise<PlanMutationResult> {
    return this.mutate(input.sessionId, async (state) => {
      const proposal = proposalById(state, input.proposalId);
      if (
        proposal.status !== 'pending_approval' ||
        state.latestProposalId !== proposal.proposalId
      ) {
        throw new PlanConflictError('Only the latest pending plan proposal can be abandoned');
      }
      return {
        type: 'plan_abandoned',
        id: this.newId(),
        sessionId: input.sessionId,
        ts: this.now(),
        storeVersion: state.storeVersion + 1,
        proposalId: proposal.proposalId,
        reason: requiredText(input.reason, 'Plan abandonment reason'),
      };
    });
  }

  async approveProposal(input: ApprovePlanProposalInput): Promise<PlanMutationResult> {
    let duplicate: PlanMutationResult | undefined;
    const result = await this.mutateOptional(input.sessionId, async (state, events) => {
      const proposal = proposalById(state, input.proposalId);
      if (proposal.revision !== input.expectedRevision) {
        throw new PlanConflictError('Plan proposal revision does not match');
      }
      if (proposal.status === 'approved') {
        const prior = [...events]
          .reverse()
          .find(
            (event): event is Extract<PlanEvent, { type: 'plan_approved' }> =>
              event.type === 'plan_approved' && event.proposalId === proposal.proposalId,
          );
        if (!prior) throw new PlanConflictError('Approved plan execution is missing');
        duplicate = { event: prior, state };
        return null;
      }
      if (
        input.expectedStoreVersion !== undefined &&
        state.storeVersion !== input.expectedStoreVersion
      ) {
        throw new PlanConflictError('Plan state changed before approval');
      }
      if (
        proposal.status !== 'pending_approval' ||
        state.latestProposalId !== proposal.proposalId
      ) {
        throw new PlanConflictError('Only the latest pending plan proposal can be approved');
      }
      if (state.activeExecutionId) {
        throw new PlanConflictError('This session already has an active plan execution');
      }
      if (proposal.sourceExecutionId) {
        const sourceExecution = executionById(state, proposal.sourceExecutionId);
        if (sourceExecution.status !== 'interrupted') {
          throw new PlanConflictError('The execution being replanned is no longer interrupted');
        }
      }
      const startedAt = this.now();
      const execution: PlanExecution = {
        executionId: this.newId(),
        planId: proposal.planId,
        proposalId: proposal.proposalId,
        sessionId: input.sessionId,
        status: 'active',
        steps: proposal.steps.map((step) => ({
          ...structuredClone(step),
          status: 'pending',
          updatedAt: startedAt,
        })),
        startedAt,
        updatedAt: startedAt,
      };
      return {
        type: 'plan_approved',
        id: this.newId(),
        sessionId: input.sessionId,
        ts: startedAt,
        storeVersion: state.storeVersion + 1,
        proposalId: proposal.proposalId,
        execution,
      };
    });
    if (duplicate) return duplicate;
    if (!result) throw new Error('Plan approval completed without a result');
    return result;
  }

  async updateExecution(input: UpdatePlanExecutionInput): Promise<PlanMutationResult> {
    return this.mutate(input.sessionId, async (state) => {
      const execution = requireActiveExecution(state, input.executionId);
      const steps = mergeExecutionSteps(execution, input.steps, this.now());
      const completed = steps.every(
        (step) => step.status === 'completed' || step.status === 'skipped',
      );
      return completed
        ? {
            type: 'plan_execution_completed',
            id: this.newId(),
            sessionId: input.sessionId,
            ts: this.now(),
            storeVersion: state.storeVersion + 1,
            executionId: execution.executionId,
            steps,
          }
        : {
            type: 'plan_progress_updated',
            id: this.newId(),
            sessionId: input.sessionId,
            ts: this.now(),
            storeVersion: state.storeVersion + 1,
            executionId: execution.executionId,
            steps,
            ...(optionalText(input.explanation)
              ? { explanation: optionalText(input.explanation) }
              : {}),
          };
    });
  }

  async cancelExecution(input: CancelPlanExecutionInput): Promise<PlanMutationResult> {
    return this.mutate(input.sessionId, async (state) => {
      const execution = requireCancellableExecution(state, input.executionId);
      return {
        type: 'plan_execution_cancelled',
        id: this.newId(),
        sessionId: input.sessionId,
        ts: this.now(),
        storeVersion: state.storeVersion + 1,
        executionId: execution.executionId,
        reason: requiredText(input.reason, 'Plan cancellation reason'),
      };
    });
  }

  async interruptActiveExecution(
    sessionId: string,
    reason: string,
  ): Promise<PlanMutationResult | null> {
    return this.mutateOptional(sessionId, async (fresh) => {
      const execution = activePlanExecution(fresh);
      if (!execution) return null;
      return {
        type: 'plan_execution_interrupted',
        id: this.newId(),
        sessionId,
        ts: this.now(),
        storeVersion: fresh.storeVersion + 1,
        executionId: execution.executionId,
        reason: requiredText(reason, 'Plan interruption reason'),
      };
    });
  }

  async resumeExecution(sessionId: string, executionId: string): Promise<PlanMutationResult> {
    return this.mutate(sessionId, async (state) => {
      if (state.activeExecutionId) {
        throw new PlanConflictError('This session already has an active plan execution');
      }
      const execution = executionById(state, executionId);
      if (execution.status !== 'interrupted') {
        throw new PlanConflictError('Only an interrupted plan execution can be resumed');
      }
      return {
        type: 'plan_execution_resumed',
        id: this.newId(),
        sessionId,
        ts: this.now(),
        storeVersion: state.storeVersion + 1,
        executionId,
      };
    });
  }

  private async mutate(
    sessionId: string,
    build: (state: PlanSessionState, events: readonly PlanEvent[]) => Promise<PlanEvent | null>,
  ): Promise<PlanMutationResult> {
    const result = await this.mutateOptional(sessionId, build);
    if (!result) throw new Error('Plan mutation completed without a result');
    return result;
  }

  private async mutateOptional(
    sessionId: string,
    build: (state: PlanSessionState, events: readonly PlanEvent[]) => Promise<PlanEvent | null>,
  ): Promise<PlanMutationResult | null> {
    assertSafeId(sessionId);
    let result: PlanMutationResult | null = null;
    await chainWrite(this.queues, sessionId, async () => {
      const ledger = await this.readLedger(sessionId);
      const event = await build(ledger.state, ledger.events);
      if (!event) return;
      const state = applyPlanEvent(ledger.state, event);
      await this.appendCanonicalEvent(sessionId, event, state);
      result = { event, state };
    });
    return result;
  }

  private async readLedger(
    sessionId: string,
  ): Promise<{ events: PlanEvent[]; state: PlanSessionState }> {
    assertSafeId(sessionId);
    const canonical = await this.readCanonicalLedger(sessionId);
    if (canonical) return canonical;
    let text: string;
    try {
      text = await readFile(this.eventsPath(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { events: [], state: emptyPlanSessionState(sessionId) };
      }
      throw error;
    }
    const rawLines = text.split('\n');
    const events: PlanEvent[] = [];
    for (let index = 0; index < rawLines.length; index += 1) {
      const line = rawLines[index]!;
      if (!line.trim()) continue;
      try {
        events.push(decodePlanEvent(JSON.parse(line), sessionId));
      } catch (error) {
        const isLast = index === rawLines.length - 1;
        if (isLast && !text.endsWith('\n') && classifyJsonRecord(line) === 'incomplete-prefix') {
          continue;
        }
        throw new Error(`Invalid Plan event at line ${index + 1}`, { cause: error });
      }
    }
    let state = emptyPlanSessionState(sessionId);
    for (const event of events) state = applyPlanEvent(state, event);
    return { events, state };
  }

  protected async readCanonicalLedger(
    _sessionId: string,
  ): Promise<{ events: PlanEvent[]; state: PlanSessionState } | undefined> {
    return undefined;
  }

  protected async appendCanonicalEvent(
    sessionId: string,
    event: PlanEvent,
    state: PlanSessionState,
  ): Promise<void> {
    await mkdir(this.sessionDir(sessionId), { recursive: true });
    await appendJsonl(this.eventsPath(sessionId), `${JSON.stringify(event)}\n`, {
      durable: true,
      durabilityRoot: this.durabilityRoot,
    });
    await this.writeProjection(sessionId, state).catch(() => {
      // Derived cache only. The append-only event ledger remains authoritative.
    });
  }

  private async writeProjection(sessionId: string, state: PlanSessionState): Promise<void> {
    const path = this.projectionPath(sessionId);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${this.newId()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  private sessionDir(sessionId: string): string {
    return join(this.sessionsRoot, sessionId);
  }

  private eventsPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'plan-events.jsonl');
  }

  private projectionPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'plans.json');
  }
}

class SqlitePlanStoreImpl extends FilePlanStore implements SqlitePlanStore {
  readonly #root: string;
  readonly #lease: OperationalStateDatabaseLease;
  readonly #ready: Promise<void>;

  constructor(workspaceRoot: string, options: CreateSqlitePlanStoreOptions) {
    super(workspaceRoot, options);
    this.#root = resolve(workspaceRoot);
    this.#lease = acquireOperationalStateDatabase(this.#root);
    this.#ready = importLegacyPlanState(this.#root, this.#lease, options.failpoint);
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  close(): void {
    this.#lease.close();
  }

  protected override async appendCanonicalEvent(
    sessionId: string,
    event: PlanEvent,
    state: PlanSessionState,
  ): Promise<void> {
    await this.#ready;
    this.#lease.transaction('write', () => {
      insertPlanEvent(this.#lease.database, event);
      writePlanProjection(this.#lease.database, sessionId, state);
    });
  }

  protected override async readCanonicalLedger(
    sessionId: string,
  ): Promise<{ events: PlanEvent[]; state: PlanSessionState } | undefined> {
    await this.#ready;
    return readSqlitePlanLedger(this.#lease.database, sessionId);
  }
}

interface LegacyPlanLedger {
  sessionId: string;
  events: PlanEvent[];
  state: PlanSessionState;
}

async function importLegacyPlanState(
  root: string,
  lease: OperationalStateDatabaseLease,
  failpoint?: (point: OperationalStoreCutoverFailpoint) => void,
): Promise<void> {
  const ledgers = await readLegacyPlanLedgers(root);
  const fingerprint = `sha256:${createHash('sha256')
    .update(JSON.stringify(ledgers))
    .digest('hex')}`;
  completeOperationalStoreCutover(lease, {
    storeName: 'workflow_plan',
    sourcePath: join(root, 'sessions'),
    sourceFingerprint: fingerprint,
    failpoint,
    importAndValidate: (database) => {
      let eventCount = 0;
      for (const ledger of ledgers) {
        for (const event of ledger.events) {
          insertOrValidatePlanEvent(database, event);
          eventCount += 1;
        }
        writePlanProjection(database, ledger.sessionId, ledger.state);
      }
      const persisted = database
        .prepare('SELECT COUNT(*) AS count FROM workflow_plan_events')
        .get() as { count?: unknown };
      if (persisted.count !== eventCount) {
        throw new Error('Plan cutover row-count validation failed');
      }
      return { sessions: ledgers.length, events: eventCount };
    },
  });
}

async function readLegacyPlanLedgers(root: string): Promise<LegacyPlanLedger[]> {
  const sessionsRoot = join(root, 'sessions');
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: LegacyPlanLedger[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !SAFE_ID_PATTERN.test(entry.name)) continue;
    const eventsPath = join(sessionsRoot, entry.name, 'plan-events.jsonl');
    let text: string | undefined;
    try {
      text = await readFile(eventsPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const events = text === undefined ? [] : decodeLegacyPlanEventText(text, entry.name);
    let state = emptyPlanSessionState(entry.name);
    for (const event of events) state = applyPlanEvent(state, event);
    const projectionPath = join(sessionsRoot, entry.name, 'plans.json');
    try {
      const projection = JSON.parse(await readFile(projectionPath, 'utf8')) as PlanSessionState;
      if (JSON.stringify(projection) !== JSON.stringify(state)) {
        throw new Error(`Plan projection does not match its event ledger for ${entry.name}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (events.length > 0) result.push({ sessionId: entry.name, events, state });
  }
  return result;
}

function decodeLegacyPlanEventText(text: string, sessionId: string): PlanEvent[] {
  const lines = text.split('\n');
  const events: PlanEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      events.push(decodePlanEvent(JSON.parse(line), sessionId));
    } catch (error) {
      const isLast = index === lines.length - 1;
      if (isLast && !text.endsWith('\n') && classifyJsonRecord(line) === 'incomplete-prefix') {
        continue;
      }
      throw new Error(`Invalid Plan event at line ${index + 1}`, { cause: error });
    }
  }
  return events;
}

function readSqlitePlanLedger(
  database: DatabaseSync,
  sessionId: string,
): { events: PlanEvent[]; state: PlanSessionState } {
  assertSafeId(sessionId);
  const rows = database
    .prepare(`
      SELECT record_json
      FROM workflow_plan_events
      WHERE session_id = ?
      ORDER BY sequence
    `)
    .all(sessionId) as Array<{ record_json?: unknown }>;
  const events = rows.map((row, index) => {
    if (typeof row.record_json !== 'string') {
      throw new Error(`Invalid SQLite Plan event at sequence ${index}`);
    }
    return decodePlanEvent(JSON.parse(row.record_json), sessionId);
  });
  let state = emptyPlanSessionState(sessionId);
  for (const event of events) state = applyPlanEvent(state, event);
  return { events, state };
}

function insertPlanEvent(database: DatabaseSync, event: PlanEvent): void {
  const row = database
    .prepare(`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
      FROM workflow_plan_events
      WHERE session_id = ?
    `)
    .get(event.sessionId) as { sequence?: unknown };
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence)) {
    throw new Error('Invalid next Plan event sequence');
  }
  database
    .prepare(`
      INSERT INTO workflow_plan_events(
        session_id, sequence, event_id, store_version, record_json
      ) VALUES (?, ?, ?, ?, ?)
    `)
    .run(event.sessionId, row.sequence, event.id, event.storeVersion, JSON.stringify(event));
}

function insertOrValidatePlanEvent(database: DatabaseSync, event: PlanEvent): void {
  const existing = database
    .prepare(`
      SELECT record_json
      FROM workflow_plan_events
      WHERE session_id = ? AND store_version = ?
    `)
    .get(event.sessionId, event.storeVersion) as { record_json?: unknown } | undefined;
  if (existing) {
    if (existing.record_json !== JSON.stringify(event)) {
      throw new Error(`Plan cutover conflict: ${event.sessionId}:${event.storeVersion}`);
    }
    return;
  }
  insertPlanEvent(database, event);
}

function writePlanProjection(
  database: DatabaseSync,
  sessionId: string,
  state: PlanSessionState,
): void {
  database
    .prepare(`
      INSERT INTO workflow_plan_projections(session_id, store_version, record_json)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        store_version = excluded.store_version,
        record_json = excluded.record_json
    `)
    .run(sessionId, state.storeVersion, JSON.stringify(state));
}

export function applyPlanEvent(state: PlanSessionState, event: PlanEvent): PlanSessionState {
  if (event.sessionId !== state.sessionId) throw new Error('Plan event session mismatch');
  if (event.storeVersion !== state.storeVersion + 1) {
    throw new Error('Plan event storeVersion is not contiguous');
  }
  const next = structuredClone(state);
  next.storeVersion = event.storeVersion;
  switch (event.type) {
    case 'plan_submitted': {
      const prior = latestPlanProposal(next);
      if (prior && prior.status === 'pending_approval') prior.status = 'stale';
      next.proposals.push(structuredClone(event.proposal));
      next.latestProposalId = event.proposal.proposalId;
      break;
    }
    case 'plan_revision_requested':
      proposalById(next, event.proposalId).status = 'stale';
      break;
    case 'plan_abandoned':
      proposalById(next, event.proposalId).status = 'stale';
      break;
    case 'plan_approved': {
      const proposal = proposalById(next, event.proposalId);
      proposal.status = 'approved';
      if (proposal.sourceExecutionId) {
        const sourceExecution = executionById(next, proposal.sourceExecutionId);
        sourceExecution.status = 'cancelled';
        sourceExecution.updatedAt = event.ts;
        sourceExecution.cancelledAt = event.ts;
        sourceExecution.cancelReason = `Replanned by proposal ${proposal.proposalId}`;
        delete sourceExecution.interruptedAt;
        delete sourceExecution.interruptionReason;
      }
      next.executions.push(structuredClone(event.execution));
      next.activeExecutionId = event.execution.executionId;
      break;
    }
    case 'plan_progress_updated': {
      const execution = executionById(next, event.executionId);
      execution.steps = structuredClone(event.steps);
      execution.updatedAt = event.ts;
      break;
    }
    case 'plan_execution_completed': {
      const execution = executionById(next, event.executionId);
      execution.steps = structuredClone(event.steps);
      execution.status = 'completed';
      execution.updatedAt = event.ts;
      execution.completedAt = event.ts;
      if (next.activeExecutionId === execution.executionId) delete next.activeExecutionId;
      break;
    }
    case 'plan_execution_cancelled': {
      const execution = executionById(next, event.executionId);
      execution.status = 'cancelled';
      execution.updatedAt = event.ts;
      execution.cancelledAt = event.ts;
      execution.cancelReason = event.reason;
      if (next.activeExecutionId === execution.executionId) delete next.activeExecutionId;
      break;
    }
    case 'plan_execution_interrupted': {
      const execution = executionById(next, event.executionId);
      execution.status = 'interrupted';
      execution.updatedAt = event.ts;
      execution.interruptedAt = event.ts;
      execution.interruptionReason = event.reason;
      if (next.activeExecutionId === execution.executionId) delete next.activeExecutionId;
      break;
    }
    case 'plan_execution_resumed': {
      const execution = executionById(next, event.executionId);
      execution.status = 'active';
      execution.updatedAt = event.ts;
      delete execution.interruptedAt;
      delete execution.interruptionReason;
      next.activeExecutionId = execution.executionId;
      break;
    }
  }
  return next;
}

function mergeExecutionSteps(
  execution: PlanExecution,
  updates: UpdatePlanExecutionInput['steps'],
  now: number,
): PlanExecutionStep[] {
  if (updates.length !== execution.steps.length) {
    throw new PlanConflictError('update_plan must include every execution step');
  }
  const byId = new Map(updates.map((step) => [step.id, step]));
  if (byId.size !== updates.length) throw new PlanConflictError('Plan step ids must be unique');
  const merged = execution.steps.map((step) => {
    const update = byId.get(step.id);
    if (!update) throw new PlanConflictError(`Plan step ${step.id} is missing`);
    if (
      (step.status === 'completed' || step.status === 'skipped') &&
      update.status !== step.status
    ) {
      throw new PlanConflictError(`Terminal plan step ${step.id} cannot be reopened`);
    }
    return {
      ...structuredClone(step),
      status: update.status,
      ...(optionalText(update.note) ? { note: optionalText(update.note) } : {}),
      updatedAt: now,
    };
  });
  if (merged.filter((step) => step.status === 'in_progress').length > 1) {
    throw new PlanConflictError('Only one plan step may be in progress');
  }
  return merged;
}

function normalizeDefinitions(steps: PlanStepDefinition[]): PlanStepDefinition[] {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 50) {
    throw new PlanConflictError('A plan must contain between 1 and 50 steps');
  }
  const normalized = steps.map((step, index) => ({
    id: optionalText(step.id) ?? `step-${index + 1}`,
    title: requiredPlainText(step.title, 'Plan step title', 30),
    description: requiredPlainText(step.description, 'Plan step description'),
    ...(step.files && step.files.length > 0
      ? { files: step.files.map((file) => requiredText(file, 'Plan step file')) }
      : {}),
    ...(step.complexity ? { complexity: step.complexity } : {}),
  }));
  if (new Set(normalized.map((step) => step.id)).size !== normalized.length) {
    throw new PlanConflictError('Plan step ids must be unique');
  }
  return normalized;
}

function proposalById(state: PlanSessionState, proposalId: string): PlanProposal {
  const proposal = state.proposals.find((candidate) => candidate.proposalId === proposalId);
  if (!proposal) throw new PlanConflictError(`Unknown plan proposal: ${proposalId}`);
  return proposal;
}

function executionById(state: PlanSessionState, executionId: string): PlanExecution {
  const execution = state.executions.find((candidate) => candidate.executionId === executionId);
  if (!execution) throw new PlanConflictError(`Unknown plan execution: ${executionId}`);
  return execution;
}

function requireActiveExecution(state: PlanSessionState, executionId: string): PlanExecution {
  if (state.activeExecutionId !== executionId) {
    throw new PlanConflictError('The plan tool is bound to a stale execution');
  }
  const execution = executionById(state, executionId);
  if (execution.status !== 'active') {
    throw new PlanConflictError('Plan execution is not active');
  }
  return execution;
}

function requireCancellableExecution(state: PlanSessionState, executionId: string): PlanExecution {
  const execution = executionById(state, executionId);
  if (execution.status !== 'active' && execution.status !== 'interrupted') {
    throw new PlanConflictError('Plan execution cannot be cancelled');
  }
  if (execution.status === 'active' && state.activeExecutionId !== executionId) {
    throw new PlanConflictError('The plan tool is bound to a stale execution');
  }
  return execution;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new PlanConflictError(`${label} cannot be empty`);
  return normalized;
}

function requiredPlainText(value: string, label: string, maxLength?: number): string {
  const normalized = requiredText(value, label);
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw new PlanConflictError(`${label} must be ${maxLength} characters or fewer`);
  }
  if (
    /(^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~)|!?(?:\[[^\]\n]+\]\([^)\n]+\))|(?:\*\*|__|`)/.test(
      normalized,
    )
  ) {
    throw new PlanConflictError(`${label} must be plain text without Markdown formatting`);
  }
  return normalized;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function assertSafeId(value: string): void {
  if (!SAFE_ID_PATTERN.test(value)) throw new Error('Invalid session id');
}

function decodePlanEvent(value: unknown, sessionId: string): PlanEvent {
  if (!value || typeof value !== 'object') throw new Error('Plan event must be an object');
  const event = value as Partial<PlanEvent>;
  if (
    typeof event.id !== 'string' ||
    event.sessionId !== sessionId ||
    typeof event.ts !== 'number' ||
    !Number.isFinite(event.ts) ||
    typeof event.storeVersion !== 'number' ||
    !Number.isSafeInteger(event.storeVersion) ||
    event.storeVersion < 1 ||
    ![
      'plan_submitted',
      'plan_revision_requested',
      'plan_abandoned',
      'plan_approved',
      'plan_progress_updated',
      'plan_execution_completed',
      'plan_execution_cancelled',
      'plan_execution_interrupted',
      'plan_execution_resumed',
    ].includes(String(event.type))
  ) {
    throw new Error('Invalid Plan event envelope');
  }
  return value as PlanEvent;
}
