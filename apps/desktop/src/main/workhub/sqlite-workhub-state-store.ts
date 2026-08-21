import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isPermissionMode } from '@maka/core/permission';
import { decodeInteractionRequest } from '@maka/core/interaction';
import type {
  WorkHubDiscussionItem,
  WorkHubCoordinationItem,
  WorkHubCoordinationNode,
  WorkHubItem,
  WorkHubMetricName,
  WorkHubMetrics,
  WorkHubModelSelection,
  WorkHubRouteSummary,
  WorkHubSnapshot,
  WorkHubWorkMemory,
  WorkHubWorkBlock,
  WorkHubWorkRef,
} from '@maka/core/workhub';
import type { WorkHubStateStore } from './work-orchestrator.js';

const WORKHUB_SCHEMA_VERSION = 1;

export interface SqliteWorkHubStateStore extends WorkHubStateStore {
  close(): void;
}

/** Client-global projection authority. Target Sessions remain Host-owned. */
export function createSqliteWorkHubStateStore(databasePath: string): SqliteWorkHubStateStore {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  let closed = false;
  try {
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA synchronous = FULL');
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec(`
      CREATE TABLE IF NOT EXISTS workhub_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workhub_projection (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        snapshot_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workhub_metrics (
        name TEXT PRIMARY KEY CHECK (
          name IN ('workhub_opened', 'submission', 'clarification', 'manual_session_switch')
        ),
        value INTEGER NOT NULL CHECK (value >= 0)
      ) STRICT;
    `);
    const version = database
      .prepare('SELECT schema_version AS schemaVersion FROM workhub_meta WHERE singleton = 1')
      .get() as { schemaVersion?: unknown } | undefined;
    if (version && version.schemaVersion !== WORKHUB_SCHEMA_VERSION) {
      throw new Error(`Unsupported WorkHub schema version: ${String(version.schemaVersion)}`);
    }
    database
      .prepare('INSERT OR IGNORE INTO workhub_meta(singleton, schema_version) VALUES (1, ?)')
      .run(WORKHUB_SCHEMA_VERSION);
    const empty: WorkHubSnapshot = { revision: 0, items: [] };
    database
      .prepare(
        'INSERT OR IGNORE INTO workhub_projection(singleton, revision, snapshot_json) VALUES (1, 0, ?)',
      )
      .run(JSON.stringify(empty));
  } catch (error) {
    database.close();
    throw error;
  }

  function assertOpen(): void {
    if (closed) throw new Error('WorkHub state store is closed');
  }

  return {
    async read() {
      assertOpen();
      return readSnapshot(database);
    },
    async write(expectedRevision, snapshot) {
      assertOpen();
      const normalized = decodeWorkHubSnapshot(snapshot);
      if (normalized.revision !== expectedRevision + 1) {
        throw new Error('WorkHub snapshot revision must advance exactly once');
      }
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = database
          .prepare(
            `UPDATE workhub_projection
             SET revision = ?, snapshot_json = ?
             WHERE singleton = 1 AND revision = ?`,
          )
          .run(normalized.revision, JSON.stringify(normalized), expectedRevision);
        if (Number(result.changes) !== 1) throw new Error('WORKHUB_REVISION_CONFLICT');
        database.exec('COMMIT');
      } catch (error) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // Preserve the original write failure.
        }
        throw error;
      }
    },
    async readMetrics() {
      assertOpen();
      return readMetrics(database);
    },
    async incrementMetric(metric) {
      assertOpen();
      database
        .prepare(
          `INSERT INTO workhub_metrics(name, value) VALUES (?, 1)
           ON CONFLICT(name) DO UPDATE SET value = value + 1`,
        )
        .run(metric);
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}

function readMetrics(database: DatabaseSync): WorkHubMetrics {
  const values = new Map<WorkHubMetricName, number>();
  const rows = database.prepare('SELECT name, value FROM workhub_metrics').all() as Array<{
    name?: unknown;
    value?: unknown;
  }>;
  for (const row of rows) {
    if (typeof row.name !== 'string' || !Number.isSafeInteger(row.value) || Number(row.value) < 0) {
      throw new Error('WorkHub metrics row is corrupt');
    }
    values.set(row.name as WorkHubMetricName, Number(row.value));
  }
  return {
    workhubOpened: values.get('workhub_opened') ?? 0,
    submissions: values.get('submission') ?? 0,
    clarifications: values.get('clarification') ?? 0,
    manualSessionSwitches: values.get('manual_session_switch') ?? 0,
  };
}

function readSnapshot(database: DatabaseSync): WorkHubSnapshot {
  const row = database
    .prepare('SELECT revision, snapshot_json FROM workhub_projection WHERE singleton = 1')
    .get() as { revision?: unknown; snapshot_json?: unknown } | undefined;
  if (!row || !Number.isSafeInteger(row.revision) || typeof row.snapshot_json !== 'string') {
    throw new Error('WorkHub projection row is corrupt');
  }
  const snapshot = decodeWorkHubSnapshot(JSON.parse(row.snapshot_json));
  if (snapshot.revision !== row.revision) {
    throw new Error('WorkHub projection revision is corrupt');
  }
  return snapshot;
}

export function decodeWorkHubSnapshot(value: unknown): WorkHubSnapshot {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
    throw new Error('Invalid WorkHub snapshot');
  }
  if (!Array.isArray(value.items)) throw new Error('Invalid WorkHub items');
  const items = value.items.map(decodeItem);
  const workFocus = value.workFocus === undefined ? undefined : decodeWorkRef(value.workFocus);
  const routingMemory = value.routingMemory === undefined
    ? undefined
    : decodeRoutingMemory(value.routingMemory);
  return {
    revision: Number(value.revision),
    items,
    ...(workFocus ? { workFocus } : {}),
    ...(routingMemory ? { routingMemory } : {}),
  };
}

function decodeRoutingMemory(value: unknown): NonNullable<WorkHubSnapshot['routingMemory']> {
  if (!isRecord(value) || !Array.isArray(value.recentFocus) || value.recentFocus.length > 8) {
    throw new Error('Invalid WorkHub routing memory');
  }
  const recentFocus = value.recentFocus.map(decodeWorkRef);
  const keys = new Set(recentFocus.map((work) => `${work.workspaceId}\u0000${work.sessionId}`));
  if (keys.size !== recentFocus.length) throw new Error('Duplicate WorkHub recent focus');
  const works = value.works === undefined
    ? []
    : Array.isArray(value.works) && value.works.length <= 128
      ? value.works.map(decodeWorkMemory)
      : (() => { throw new Error('Invalid WorkHub Work memories'); })();
  const corrections = value.corrections === undefined
    ? []
    : Array.isArray(value.corrections) && value.corrections.length <= 32
      ? value.corrections.map(decodeRouteCorrection)
      : (() => { throw new Error('Invalid WorkHub route corrections'); })();
  return { recentFocus, works, corrections };
}

function decodeRouteCorrection(value: unknown): NonNullable<WorkHubSnapshot['routingMemory']>['corrections'][number] {
  if (!isRecord(value) || typeof value.query !== 'string' || !isTimestamp(value.correctedAt)) {
    throw new Error('Invalid WorkHub route correction');
  }
  return {
    query: value.query,
    from: decodeWorkRef(value.from),
    to: decodeWorkRef(value.to),
    correctedAt: Number(value.correctedAt),
  };
}

function decodeWorkMemory(value: unknown): WorkHubWorkMemory {
  if (
    !isRecord(value) ||
    typeof value.projectName !== 'string' ||
    typeof value.workName !== 'string' ||
    !isBoundedStringArray(value.aliases, 12, 1_000) ||
    !isBoundedStringArray(value.entities, 96, 256) ||
    !isBoundedStringArray(value.recentRequests, 6, 1_000) ||
    !isBoundedStringArray(value.recentOutcomes, 6, 1_000) ||
    !isTimestamp(value.lastFocusedAt) ||
    !Number.isSafeInteger(value.focusCount) ||
    Number(value.focusCount) < 1
  ) throw new Error('Invalid WorkHub Work memory');
  return {
    work: decodeWorkRef(value.work),
    projectName: value.projectName,
    workName: value.workName,
    aliases: [...value.aliases],
    entities: [...value.entities],
    recentRequests: [...value.recentRequests],
    recentOutcomes: [...value.recentOutcomes],
    lastFocusedAt: Number(value.lastFocusedAt),
    focusCount: Number(value.focusCount),
  };
}

function decodeItem(value: unknown): WorkHubItem {
  if (!isRecord(value)) throw new Error('Invalid WorkHub item');
  if (value.kind === 'discussion') return decodeDiscussion(value);
  if (value.kind === 'clarification') {
    if (
      !isId(value.id) ||
      !isId(value.sourceRequestId) ||
      typeof value.text !== 'string' ||
      typeof value.question !== 'string' ||
      !Array.isArray(value.options) ||
      (value.resolvedTo !== undefined && !isRecord(value.resolvedTo)) ||
      (value.resolvedAt !== undefined && !isTimestamp(value.resolvedAt)) ||
      !isTimestamp(value.createdAt)
    ) {
      throw new Error('Invalid WorkHub clarification');
    }
    return {
      kind: 'clarification',
      id: value.id,
      sourceRequestId: value.sourceRequestId,
      text: value.text,
      question: value.question,
      options: value.options.map((option) => {
        if (
          !isRecord(option) ||
          !isId(option.candidateId) ||
          typeof option.projectName !== 'string' ||
          typeof option.workName !== 'string' ||
          typeof option.archived !== 'boolean'
        ) {
          throw new Error('Invalid WorkHub target option');
        }
        return {
          candidateId: option.candidateId,
          work: decodeWorkRef(option.work),
          projectName: option.projectName,
          workName: option.workName,
          archived: option.archived,
        };
      }),
      ...(value.routing === undefined
        ? {}
        : { routing: decodeRoutingSummary(value.routing, false) }),
      ...(value.resolvedTo === undefined
        ? {}
        : { resolvedTo: decodeWorkRef(value.resolvedTo) }),
      ...(value.resolvedAt === undefined
        ? {}
        : { resolvedAt: Number(value.resolvedAt) }),
      createdAt: Number(value.createdAt),
    };
  }
  if (value.kind === 'coordination') return decodeCoordination(value);
  if (value.kind === 'work') return decodeWorkBlock(value);
  throw new Error('Invalid WorkHub item kind');
}

function decodeDiscussion(value: Record<string, unknown>): WorkHubDiscussionItem {
  if (
    !isId(value.id) ||
    !isId(value.sourceRequestId) ||
    (value.role !== 'user' && value.role !== 'assistant') ||
    typeof value.text !== 'string' ||
    (value.status !== 'running' && value.status !== 'completed' && value.status !== 'failed') ||
    (value.replyToItemId !== undefined && !isId(value.replyToItemId)) ||
    !isTimestamp(value.createdAt)
  ) {
    throw new Error('Invalid WorkHub discussion');
  }
  return {
    kind: 'discussion',
    id: value.id,
    sourceRequestId: value.sourceRequestId,
    role: value.role,
    text: value.text,
    status: value.status,
    ...(value.replyToItemId ? { replyToItemId: value.replyToItemId } : {}),
    createdAt: Number(value.createdAt),
  };
}

function decodeWorkBlock(value: Record<string, unknown>): WorkHubWorkBlock {
  if (
    !isId(value.id) ||
    !isId(value.sourceRequestId) ||
    typeof value.projectName !== 'string' ||
    typeof value.workName !== 'string' ||
    typeof value.requestText !== 'string' ||
    !isPermissionMode(value.permissionMode) ||
    !isWorkStatus(value.status) ||
    (value.turnId !== undefined && !isId(value.turnId)) ||
    (value.detail !== undefined && typeof value.detail !== 'string') ||
    (value.interaction !== undefined && !isRecord(value.interaction)) ||
    (value.coordination !== undefined && !isRecord(value.coordination)) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    throw new Error('Invalid WorkHub Work block');
  }
  const interaction = value.interaction as Record<string, unknown> | undefined;
  const coordination = value.coordination as Record<string, unknown> | undefined;
  if (interaction && !isId(interaction.interactionId)) {
    throw new Error('Invalid WorkHub Interaction');
  }
  if (coordination && (!isId(coordination.coordinationId) || !isId(coordination.nodeId))) {
    throw new Error('Invalid WorkHub coordination link');
  }
  return {
    kind: 'work',
    id: value.id,
    sourceRequestId: value.sourceRequestId,
    work: decodeWorkRef(value.work),
    projectName: value.projectName,
    workName: value.workName,
    requestText: value.requestText,
    permissionMode: value.permissionMode,
    status: value.status,
    ...(value.turnId ? { turnId: value.turnId } : {}),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(interaction
      ? {
          interaction: {
            interactionId: interaction.interactionId as string,
            request: decodeInteractionRequest(interaction.request),
          },
        }
      : {}),
    ...(coordination
      ? {
          coordination: {
            coordinationId: coordination.coordinationId as string,
            nodeId: coordination.nodeId as string,
          },
        }
      : {}),
    ...(value.routing === undefined
      ? {}
      : { routing: decodeRoutingSummary(value.routing, true) }),
    createdAt: Number(value.createdAt),
    updatedAt: Number(value.updatedAt),
  };
}

function decodeRoutingSummary(value: unknown, withAlternatives: true): WorkHubRouteSummary;
function decodeRoutingSummary(
  value: unknown,
  withAlternatives: false,
): Pick<WorkHubRouteSummary, 'confidence' | 'source'>;
function decodeRoutingSummary(
  value: unknown,
  withAlternatives: boolean,
): WorkHubRouteSummary | Pick<WorkHubRouteSummary, 'confidence' | 'source'> {
  if (
    !isRecord(value) ||
    !isRouteConfidence(value.confidence) ||
    !isRouteSource(value.source)
  ) throw new Error('Invalid WorkHub routing summary');
  if (!withAlternatives) return { confidence: value.confidence, source: value.source };
  if (!Array.isArray(value.alternatives) || value.alternatives.length > 3) {
    throw new Error('Invalid WorkHub routing alternatives');
  }
  const alternatives = value.alternatives.map(decodeTargetOption);
  const correctedTo = value.correctedTo === undefined ? undefined : decodeWorkRef(value.correctedTo);
  if (value.correctedAt !== undefined && !isTimestamp(value.correctedAt)) {
    throw new Error('Invalid WorkHub correction time');
  }
  return {
    confidence: value.confidence,
    source: value.source,
    alternatives,
    ...(correctedTo ? { correctedTo } : {}),
    ...(value.correctedAt === undefined ? {} : { correctedAt: Number(value.correctedAt) }),
  };
}

function decodeTargetOption(value: unknown): import('@maka/core/workhub').WorkHubTargetOption {
  if (
    !isRecord(value) ||
    !isId(value.candidateId) ||
    typeof value.projectName !== 'string' ||
    typeof value.workName !== 'string' ||
    typeof value.archived !== 'boolean'
  ) throw new Error('Invalid WorkHub target option');
  return {
    candidateId: value.candidateId,
    work: decodeWorkRef(value.work),
    projectName: value.projectName,
    workName: value.workName,
    archived: value.archived,
  };
}

function isRouteConfidence(value: unknown): value is WorkHubRouteSummary['confidence'] {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isRouteSource(value: unknown): value is WorkHubRouteSummary['source'] {
  return value === 'explicit' || value === 'name' || value === 'focus' || value === 'memory' ||
    value === 'semantic' || value === 'model' || value === 'correction' ||
    value === 'new_work' || value === 'coordination';
}

function decodeCoordination(value: Record<string, unknown>): WorkHubCoordinationItem {
  if (
    !isId(value.id) ||
    !isId(value.sourceRequestId) ||
    typeof value.title !== 'string' ||
    !isCoordinationStatus(value.status) ||
    !Array.isArray(value.nodes) ||
    value.nodes.length < 2 ||
    value.nodes.length > 8 ||
    !Array.isArray(value.edges) ||
    value.edges.length > 64 ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) throw new Error('Invalid WorkHub coordination');
  const nodes = value.nodes.map(decodeCoordinationNode);
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  if (nodeIds.size !== nodes.length) throw new Error('Duplicate WorkHub coordination node');
  const edgeKeys = new Set<string>();
  const edges = value.edges.map((edge) => {
    if (
      !isRecord(edge) ||
      !isId(edge.edgeId) ||
      !isId(edge.fromNodeId) ||
      !isId(edge.toNodeId) ||
      edge.fromNodeId === edge.toNodeId ||
      !nodeIds.has(edge.fromNodeId) ||
      !nodeIds.has(edge.toNodeId)
    ) throw new Error('Invalid WorkHub coordination edge');
    const key = `${edge.fromNodeId}\u0000${edge.toNodeId}`;
    if (edgeKeys.has(key)) throw new Error('Duplicate WorkHub coordination edge');
    edgeKeys.add(key);
    return { edgeId: edge.edgeId, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId };
  });
  return {
    kind: 'coordination',
    id: value.id,
    sourceRequestId: value.sourceRequestId,
    title: value.title,
    status: value.status,
    nodes,
    edges,
    ...(value.modelSelection === undefined
      ? {}
      : { modelSelection: decodeModelSelection(value.modelSelection) }),
    createdAt: Number(value.createdAt),
    updatedAt: Number(value.updatedAt),
  };
}

function decodeModelSelection(value: unknown): WorkHubModelSelection {
  if (
    !isRecord(value) ||
    !isBoundedString(value.llmConnectionSlug, 512) ||
    !isBoundedString(value.model, 1024)
  ) throw new Error('Invalid WorkHub model selection');
  return { llmConnectionSlug: value.llmConnectionSlug, model: value.model };
}

function decodeCoordinationNode(value: unknown): WorkHubCoordinationNode {
  if (
    !isRecord(value) ||
    !isId(value.nodeId) ||
    typeof value.projectName !== 'string' ||
    typeof value.workName !== 'string' ||
    typeof value.instruction !== 'string' ||
    !isCoordinationNodeStatus(value.status) ||
    (value.blockId !== undefined && !isId(value.blockId)) ||
    (value.detail !== undefined && typeof value.detail !== 'string')
  ) throw new Error('Invalid WorkHub coordination node');
  return {
    nodeId: value.nodeId,
    work: decodeWorkRef(value.work),
    projectName: value.projectName,
    workName: value.workName,
    instruction: value.instruction,
    status: value.status,
    ...(value.blockId ? { blockId: value.blockId } : {}),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  };
}

function isCoordinationStatus(value: unknown): value is WorkHubCoordinationItem['status'] {
  return value === 'active' || value === 'waiting_for_user' || value === 'completed' || value === 'failed' || value === 'stopped';
}

function isCoordinationNodeStatus(value: unknown): value is WorkHubCoordinationNode['status'] {
  return value === 'pending' || value === 'running' || value === 'waiting_for_user' || value === 'completed' || value === 'failed' || value === 'stopped' || value === 'blocked';
}

function decodeWorkRef(value: unknown): WorkHubWorkRef {
  if (!isRecord(value) || !isId(value.workspaceId) || !isId(value.sessionId)) {
    throw new Error('Invalid WorkHub Work reference');
  }
  return { workspaceId: value.workspaceId, sessionId: value.sessionId };
}

function isWorkStatus(value: unknown): value is WorkHubWorkBlock['status'] {
  return (
    value === 'running' ||
    value === 'waiting_for_user' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'stopped'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isBoundedStringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): value is string[] {
  return Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((item) => isBoundedString(item, maximumLength));
}

function isTimestamp(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
