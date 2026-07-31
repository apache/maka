import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  isDeepResearchEvent,
  isDeepResearchScopeLevel,
  normalizeDeepResearchObjective,
  projectDeepResearchEvents,
  type DeepResearchArtifactRef,
  type DeepResearchChecklistItem,
  type DeepResearchChangedEvent,
  type DeepResearchCheckpoint,
  type DeepResearchEvent,
  type DeepResearchEventRefs,
  type DeepResearchHandoff,
  type DeepResearchMutationContext,
  type DeepResearchRun,
  type DeepResearchScopeLevel,
  type DeepResearchStep,
  type DeepResearchStore,
} from '@maka/core/deep-research-run';
import { assertSafeSessionId } from './session-store.js';
import { appendJsonl } from './jsonl-append.js';
import { chainWrite } from './write-queue.js';
import {
  acquireOperationalStateDatabase,
  completeOperationalStoreCutover,
  type OperationalStateDatabaseLease,
  type OperationalStoreCutoverFailpoint,
} from './operational-state-store.js';

export type { DeepResearchStore } from '@maka/core/deep-research-run';

export interface CreateDeepResearchStoreOptions {
  newId?: () => string;
  now?: () => number;
}

export function createDeepResearchStore(
  workspaceRoot: string,
  options: CreateDeepResearchStoreOptions = {},
): DeepResearchStore {
  return new FileDeepResearchStore(
    workspaceRoot,
    options.newId ?? randomUUID,
    options.now ?? Date.now,
  );
}

export interface SqliteDeepResearchStore extends DeepResearchStore {
  ready(): Promise<void>;
  close(): void;
}

export interface CreateSqliteDeepResearchStoreOptions extends CreateDeepResearchStoreOptions {
  failpoint?: (point: OperationalStoreCutoverFailpoint) => void;
}

export function createSqliteDeepResearchStore(
  workspaceRoot: string,
  options: CreateSqliteDeepResearchStoreOptions = {},
): SqliteDeepResearchStore {
  return new SqliteDeepResearchStoreImpl(workspaceRoot, options);
}

class FileDeepResearchStore implements DeepResearchStore {
  private readonly sessionsRoot: string;
  private readonly durabilityRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly subscribers = new Set<(event: DeepResearchChangedEvent) => void>();

  constructor(
    workspaceRoot: string,
    private readonly newId: () => string,
    private readonly now: () => number,
  ) {
    this.sessionsRoot = join(workspaceRoot, 'sessions');
    this.durabilityRoot = workspaceRoot;
  }

  async read(sessionId: string): Promise<DeepResearchRun | undefined> {
    const events = await this.readEvents(sessionId);
    return this.project(events);
  }

  async readEvents(sessionId: string): Promise<DeepResearchEvent[]> {
    assertSafeSessionId(sessionId);
    const canonical = await this.readCanonicalEvents(sessionId);
    if (canonical) return canonical;
    let text: string;
    try {
      text = await readFile(this.eventsPath(sessionId), 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    const events: DeepResearchEvent[] = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid deep research event JSONL line ${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!isDeepResearchEvent(parsed)) {
        throw new Error(
          `Invalid deep research event JSONL line ${index + 1}: unexpected event shape`,
        );
      }
      events.push(parsed);
    }
    return events;
  }

  subscribe(listener: (event: DeepResearchChangedEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async start(
    sessionId: string,
    objective: string,
    scopeLevel: DeepResearchScopeLevel,
    context: DeepResearchMutationContext = {},
  ): Promise<DeepResearchRun> {
    const normalized = normalizeDeepResearchObjective(objective);
    if (!normalized) throw new Error('Deep Research objective must be a non-empty bounded string');
    if (!isDeepResearchScopeLevel(scopeLevel)) throw new Error('Invalid Deep Research scope level');
    return this.mutate(
      sessionId,
      'research_started',
      context,
      (events) => {
        if (events.length > 0) throw new Error('Deep Research workspace is already initialized');
        const ts = this.now();
        return {
          eventId: this.newId(),
          type: 'research_started',
          sessionId,
          ts,
          objective: normalized,
          scopeLevel,
          ...refsFromContext(context),
        };
      },
      (event) =>
        event.type === 'research_started' &&
        event.objective === normalized &&
        event.scopeLevel === scopeLevel,
    );
  }

  async recordArtifact(
    sessionId: string,
    artifact: DeepResearchArtifactRef,
    context: DeepResearchMutationContext = {},
  ): Promise<DeepResearchRun> {
    return this.mutate(
      sessionId,
      'research_artifact_recorded',
      context,
      () => ({
        eventId: this.newId(),
        type: 'research_artifact_recorded',
        sessionId,
        ts: this.now(),
        artifact: {
          ...artifact,
          sourceArtifactIds: [...artifact.sourceArtifactIds],
        },
        ...refsFromContext(context),
      }),
      (event) =>
        event.type === 'research_artifact_recorded' && sameArtifact(event.artifact, artifact),
    );
  }

  async updateChecklist(
    sessionId: string,
    item: Omit<DeepResearchChecklistItem, 'title' | 'updatedAt'>,
    context: DeepResearchMutationContext = {},
  ): Promise<DeepResearchRun> {
    return this.mutate(
      sessionId,
      'research_checklist_updated',
      context,
      (events) => {
        const run = this.project(events);
        const current = run?.checklist.find((candidate) => candidate.itemId === item.itemId);
        if (!current) throw new Error(`Unknown Deep Research checklist item ${item.itemId}`);
        return {
          eventId: this.newId(),
          type: 'research_checklist_updated',
          sessionId,
          ts: this.now(),
          item: {
            ...item,
            title: current.title,
            evidenceArtifactIds: [...item.evidenceArtifactIds],
            updatedAt: this.now(),
          },
          ...refsFromContext(context),
        };
      },
      (event) =>
        event.type === 'research_checklist_updated' &&
        event.item.itemId === item.itemId &&
        event.item.status === item.status &&
        event.item.blockedReason === item.blockedReason &&
        sameStrings(event.item.evidenceArtifactIds, item.evidenceArtifactIds),
    );
  }

  async recordStep(
    sessionId: string,
    step: Omit<DeepResearchStep, 'stepId' | 'createdAt'>,
    context: DeepResearchMutationContext = {},
  ): Promise<DeepResearchRun> {
    return this.mutate(
      sessionId,
      'research_step_recorded',
      context,
      () => ({
        eventId: this.newId(),
        type: 'research_step_recorded',
        sessionId,
        ts: this.now(),
        step: {
          ...step,
          stepId: this.newId(),
          roots: [...step.roots],
          keywords: [...step.keywords],
          ignoredPaths: [...step.ignoredPaths],
          evidenceArtifactIds: [...step.evidenceArtifactIds],
          inspectedRefs: step.inspectedRefs.map((ref) => ({ ...ref })),
          workerRunIds: [...step.workerRunIds],
          createdAt: this.now(),
        },
        ...refsFromContext(context),
      }),
      (event) => event.type === 'research_step_recorded' && sameStep(event.step, step),
    );
  }

  async recordCheckpoint(
    sessionId: string,
    checkpoint: Omit<DeepResearchCheckpoint, 'checkpointId' | 'createdAt'>,
    context: DeepResearchMutationContext = {},
  ): Promise<DeepResearchRun> {
    return this.mutate(
      sessionId,
      'research_checkpoint_recorded',
      context,
      () => ({
        eventId: this.newId(),
        type: 'research_checkpoint_recorded',
        sessionId,
        ts: this.now(),
        checkpoint: {
          ...checkpoint,
          checkpointId: this.newId(),
          createdAt: this.now(),
          openQuestions: [...checkpoint.openQuestions],
          nextSteps: [...checkpoint.nextSteps],
          taskIds: [...checkpoint.taskIds],
          artifactIds: [...checkpoint.artifactIds],
        },
        ...refsFromContext(context),
      }),
      (event) =>
        event.type === 'research_checkpoint_recorded' &&
        sameCheckpoint(event.checkpoint, checkpoint),
    );
  }

  async complete(
    sessionId: string,
    reportArtifactId: string,
    handoff: DeepResearchHandoff,
    context: DeepResearchMutationContext = {},
  ): Promise<DeepResearchRun> {
    return this.mutate(
      sessionId,
      'research_completed',
      context,
      () => ({
        eventId: this.newId(),
        type: 'research_completed',
        sessionId,
        ts: this.now(),
        reportArtifactId,
        handoff: {
          ...handoff,
          implementationTasks: [...handoff.implementationTasks],
          recommendedIssues: [...handoff.recommendedIssues],
          recommendedPullRequests: [...handoff.recommendedPullRequests],
          verificationCommands: [...handoff.verificationCommands],
        },
        ...refsFromContext(context),
      }),
      (event) =>
        event.type === 'research_completed' &&
        event.reportArtifactId === reportArtifactId &&
        sameHandoff(event.handoff, handoff),
    );
  }

  private async mutate(
    sessionId: string,
    expectedType: DeepResearchEvent['type'],
    context: DeepResearchMutationContext,
    buildEvent: (events: readonly DeepResearchEvent[]) => DeepResearchEvent,
    replayMatches?: (event: DeepResearchEvent) => boolean,
  ): Promise<DeepResearchRun> {
    assertSafeSessionId(sessionId);
    let nextRun: DeepResearchRun | undefined;
    await chainWrite(this.writeQueues, sessionId, async () => {
      const current = await this.readEvents(sessionId);
      if (context.toolCallId) {
        const replay = current.find((event) => event.refs?.toolCallId === context.toolCallId);
        if (replay) {
          if (replay.type !== expectedType) {
            throw new Error(
              `Deep Research tool call ${context.toolCallId} was already used for ${replay.type}`,
            );
          }
          if (replayMatches && !replayMatches(replay)) {
            throw new Error(
              `Deep Research tool call ${context.toolCallId} was retried with different input`,
            );
          }
          nextRun = this.project(current);
          return;
        }
      }
      const event = buildEvent(current);
      if (!isDeepResearchEvent(event)) {
        throw new Error('Invalid Deep Research mutation event');
      }
      const next = projectDeepResearchEvents([...current, event]);
      if (next.diagnostics.length > 0 || !next.run) {
        throw new Error(
          `Deep Research mutation rejected: ${next.diagnostics.join('; ') || 'missing run projection'}`,
        );
      }
      await this.appendEvent(sessionId, event);
      nextRun = next.run;
      const changed = { sessionId, ts: event.ts };
      for (const subscriber of this.subscribers) {
        try {
          subscriber(changed);
        } catch {
          // Durable mutation success must not depend on a best-effort UI subscriber.
        }
      }
    });
    if (!nextRun) throw new Error('Deep Research mutation did not produce a run');
    return nextRun;
  }

  private project(events: readonly DeepResearchEvent[]): DeepResearchRun | undefined {
    const projection = projectDeepResearchEvents(events);
    if (projection.diagnostics.length > 0) {
      throw new Error(
        `Deep Research ledger projection failed: ${projection.diagnostics.join('; ')}`,
      );
    }
    return projection.run;
  }

  private async appendEvent(sessionId: string, event: DeepResearchEvent): Promise<void> {
    if (await this.appendCanonicalEvent(sessionId, event)) return;
    const path = this.eventsPath(sessionId);
    await mkdir(dirname(path), { recursive: true });
    await appendJsonl(path, `${JSON.stringify(event)}\n`, {
      durable: true,
      durabilityRoot: this.durabilityRoot,
    });
  }

  protected async readCanonicalEvents(
    _sessionId: string,
  ): Promise<DeepResearchEvent[] | undefined> {
    return undefined;
  }

  protected async appendCanonicalEvent(
    _sessionId: string,
    _event: DeepResearchEvent,
  ): Promise<boolean> {
    return false;
  }

  private eventsPath(sessionId: string): string {
    return join(this.sessionsRoot, sessionId, 'deep-research', 'events.jsonl');
  }
}

class SqliteDeepResearchStoreImpl extends FileDeepResearchStore implements SqliteDeepResearchStore {
  readonly #lease: OperationalStateDatabaseLease;
  readonly #ready: Promise<void>;

  constructor(workspaceRoot: string, options: CreateSqliteDeepResearchStoreOptions) {
    super(workspaceRoot, options.newId ?? randomUUID, options.now ?? Date.now);
    const root = resolve(workspaceRoot);
    this.#lease = acquireOperationalStateDatabase(root);
    this.#ready = importLegacyDeepResearchState(root, this.#lease, options.failpoint);
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  close(): void {
    this.#lease.close();
  }

  protected override async readCanonicalEvents(sessionId: string): Promise<DeepResearchEvent[]> {
    await this.#ready;
    return readSqliteDeepResearchEvents(this.#lease.database, sessionId);
  }

  protected override async appendCanonicalEvent(
    sessionId: string,
    event: DeepResearchEvent,
  ): Promise<boolean> {
    await this.#ready;
    this.#lease.transaction('write', () => {
      insertDeepResearchEvent(this.#lease.database, sessionId, event);
    });
    return true;
  }
}

interface LegacyDeepResearchLedger {
  sessionId: string;
  events: DeepResearchEvent[];
}

async function importLegacyDeepResearchState(
  root: string,
  lease: OperationalStateDatabaseLease,
  failpoint?: (point: OperationalStoreCutoverFailpoint) => void,
): Promise<void> {
  const ledgers = await readLegacyDeepResearchLedgers(root);
  const fingerprint = `sha256:${createHash('sha256')
    .update(JSON.stringify(ledgers))
    .digest('hex')}`;
  completeOperationalStoreCutover(lease, {
    storeName: 'workflow_deep_research',
    sourcePath: join(root, 'sessions'),
    sourceFingerprint: fingerprint,
    failpoint,
    importAndValidate: (database) => {
      let eventCount = 0;
      for (const ledger of ledgers) {
        for (const event of ledger.events) {
          insertOrValidateDeepResearchEvent(database, ledger.sessionId, event);
          eventCount += 1;
        }
      }
      const persisted = database
        .prepare('SELECT COUNT(*) AS count FROM workflow_deep_research_events')
        .get() as { count?: unknown };
      if (persisted.count !== eventCount) {
        throw new Error('Deep Research cutover row-count validation failed');
      }
      return { sessions: ledgers.length, events: eventCount };
    },
  });
}

async function readLegacyDeepResearchLedgers(root: string): Promise<LegacyDeepResearchLedger[]> {
  const sessionsRoot = join(root, 'sessions');
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ledgers: LegacyDeepResearchLedger[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    assertSafeSessionId(entry.name);
    let text: string;
    try {
      text = await readFile(
        join(sessionsRoot, entry.name, 'deep-research', 'events.jsonl'),
        'utf8',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const events = decodeLegacyDeepResearchEvents(text, entry.name);
    const projection = projectDeepResearchEvents(events);
    if (projection.diagnostics.length > 0) {
      throw new Error(
        `Deep Research ledger projection failed: ${projection.diagnostics.join('; ')}`,
      );
    }
    ledgers.push({ sessionId: entry.name, events });
  }
  return ledgers;
}

function decodeLegacyDeepResearchEvents(text: string, sessionId: string): DeepResearchEvent[] {
  const events: DeepResearchEvent[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Invalid deep research event JSONL line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!isDeepResearchEvent(parsed) || parsed.sessionId !== sessionId) {
      throw new Error(
        `Invalid deep research event JSONL line ${index + 1}: unexpected event shape`,
      );
    }
    events.push(parsed);
  }
  return events;
}

function readSqliteDeepResearchEvents(
  database: DatabaseSync,
  sessionId: string,
): DeepResearchEvent[] {
  assertSafeSessionId(sessionId);
  const rows = database
    .prepare(`
      SELECT record_json
      FROM workflow_deep_research_events
      WHERE session_id = ?
      ORDER BY sequence
    `)
    .all(sessionId) as Array<{ record_json?: unknown }>;
  return rows.map((row, index) => {
    if (typeof row.record_json !== 'string') {
      throw new Error(`Invalid SQLite Deep Research event at sequence ${index}`);
    }
    const parsed = JSON.parse(row.record_json);
    if (!isDeepResearchEvent(parsed) || parsed.sessionId !== sessionId) {
      throw new Error(`Invalid SQLite Deep Research event at sequence ${index}`);
    }
    return parsed;
  });
}

function insertDeepResearchEvent(
  database: DatabaseSync,
  sessionId: string,
  event: DeepResearchEvent,
): void {
  const row = database
    .prepare(`
      SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence
      FROM workflow_deep_research_events
      WHERE session_id = ?
    `)
    .get(sessionId) as { sequence?: unknown };
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence)) {
    throw new Error('Invalid next Deep Research event sequence');
  }
  database
    .prepare(`
      INSERT INTO workflow_deep_research_events(
        session_id, sequence, event_id, record_json
      ) VALUES (?, ?, ?, ?)
    `)
    .run(sessionId, row.sequence, event.eventId, JSON.stringify(event));
}

function insertOrValidateDeepResearchEvent(
  database: DatabaseSync,
  sessionId: string,
  event: DeepResearchEvent,
): void {
  const existing = database
    .prepare(`
      SELECT record_json
      FROM workflow_deep_research_events
      WHERE session_id = ? AND event_id = ?
    `)
    .get(sessionId, event.eventId) as { record_json?: unknown } | undefined;
  if (existing) {
    if (existing.record_json !== JSON.stringify(event)) {
      throw new Error(`Deep Research cutover conflict: ${event.eventId}`);
    }
    return;
  }
  insertDeepResearchEvent(database, sessionId, event);
}

function refsFromContext(context: DeepResearchMutationContext): { refs?: DeepResearchEventRefs } {
  const refs: DeepResearchEventRefs = {
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
  };
  return Object.keys(refs).length > 0 ? { refs } : {};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameArtifact(left: DeepResearchArtifactRef, right: DeepResearchArtifactRef): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.role === right.role &&
    left.name === right.name &&
    left.summary === right.summary &&
    left.createdAt === right.createdAt &&
    left.locator === right.locator &&
    left.contentHash === right.contentHash &&
    left.reportSectionKey === right.reportSectionKey &&
    left.reportSectionStatus === right.reportSectionStatus &&
    sameStrings(left.sourceArtifactIds, right.sourceArtifactIds)
  );
}

function sameStep(
  left: DeepResearchStep,
  right: Omit<DeepResearchStep, 'stepId' | 'createdAt'>,
): boolean {
  return (
    left.kind === right.kind &&
    left.status === right.status &&
    left.objective === right.objective &&
    left.summary === right.summary &&
    left.stoppingCondition === right.stoppingCondition &&
    left.expectedEvidence === right.expectedEvidence &&
    left.blockedReason === right.blockedReason &&
    sameStrings(left.roots, right.roots) &&
    sameStrings(left.keywords, right.keywords) &&
    sameStrings(left.ignoredPaths, right.ignoredPaths) &&
    sameStrings(left.evidenceArtifactIds, right.evidenceArtifactIds) &&
    sameStrings(left.workerRunIds, right.workerRunIds) &&
    left.inspectedRefs.length === right.inspectedRefs.length &&
    left.inspectedRefs.every((ref, index) => {
      const candidate = right.inspectedRefs[index];
      return (
        candidate !== undefined &&
        ref.kind === candidate.kind &&
        ref.locator === candidate.locator &&
        ref.label === candidate.label &&
        ref.sourceArtifactId === candidate.sourceArtifactId
      );
    })
  );
}

function sameCheckpoint(
  left: DeepResearchCheckpoint,
  right: Omit<DeepResearchCheckpoint, 'checkpointId' | 'createdAt'>,
): boolean {
  return (
    left.round === right.round &&
    left.stage === right.stage &&
    left.status === right.status &&
    left.summary === right.summary &&
    sameStrings(left.openQuestions, right.openQuestions) &&
    sameStrings(left.nextSteps, right.nextSteps) &&
    sameStrings(left.taskIds, right.taskIds) &&
    sameStrings(left.artifactIds, right.artifactIds)
  );
}

function sameHandoff(left: DeepResearchHandoff, right: DeepResearchHandoff): boolean {
  return (
    left.artifactId === right.artifactId &&
    sameStrings(left.implementationTasks, right.implementationTasks) &&
    sameStrings(left.recommendedIssues, right.recommendedIssues) &&
    sameStrings(left.recommendedPullRequests, right.recommendedPullRequests) &&
    sameStrings(left.verificationCommands, right.verificationCommands)
  );
}
