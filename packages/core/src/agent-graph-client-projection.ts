import type { AgentGraphIntentAdmissionState } from './agent-graph-schedule.js';

export const AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION = 1 as const;

export interface AgentGraphClientProjectionRecord {
  schemaVersion: typeof AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION;
  graphId: string;
  rootSessionId: string;
  snapshotVersion: string;
  payload: unknown;
  materializedAt: number;
}

export interface AgentGraphClientProjectionWithOperator {
  projection: AgentGraphClientProjectionRecord;
  /**
   * The operator row may have an older content version when another operator
   * advanced the graph. Both rows are nevertheless read from one DB snapshot.
   */
  operator?: AgentGraphClientOperatorProjectionRecord;
}

export interface AgentGraphClientOperatorProjectionRecord {
  graphId: string;
  operatorId: string;
  snapshotVersion: string;
  payload: unknown;
  materializedAt: number;
}

export interface AgentGraphClientTerminalActivityRecord {
  graphId: string;
  recordId: string;
  eventTime: number;
  payload: unknown;
}

export interface AgentGraphClientTerminalActivityKey {
  eventTime: number;
  recordId: string;
}

export interface AgentGraphClientTerminalActivityPage {
  records: AgentGraphClientTerminalActivityRecord[];
  hasMore: boolean;
}

export interface AgentGraphClientClaimAdmission {
  intentId: string;
  state: AgentGraphIntentAdmissionState;
}

export class AgentGraphClientProjectionConflictError extends Error {
  readonly name = 'AgentGraphClientProjectionConflictError';
}

export interface CommitAgentGraphClientProjectionRequest {
  schemaVersion: typeof AGENT_GRAPH_CLIENT_PROJECTION_SCHEMA_VERSION;
  graphId: string;
  rootSessionId: string;
  /**
   * Compare-and-set fence for the graph projection.
   * `null` is create-only; otherwise the current snapshot version must match.
   */
  expectedSnapshotVersion: string | null;
  snapshotVersion: string;
  snapshot: unknown;
  replaceOperators: boolean;
  operators: Array<{
    operatorId: string;
    payload: unknown;
  }>;
  terminalActivities: Array<{
    recordId: string;
    eventTime: number;
    payload: unknown;
  }>;
  activityRecords: Array<{
    recordId: string;
    eventTime: number;
  }>;
  /**
   * Marks an incremental delivery. If this durable record was already applied,
   * the whole transaction is an idempotent no-op.
   */
  incrementalRecordId?: string;
}

/**
 * Durable derived read side for graph clients.
 *
 * Canonical schedule, Session, AgentRun, and RuntimeEvent ledgers remain the
 * authority. This projection exists so presentation clients never replay those
 * ledgers or synchronously scan JSONL on every refresh.
 */
export interface AgentGraphClientProjectionStore {
  commitAgentGraphClientProjection(
    request: CommitAgentGraphClientProjectionRequest,
  ): Promise<AgentGraphClientProjectionRecord>;
  readAgentGraphClientProjection(
    graphId: string,
  ): Promise<AgentGraphClientProjectionRecord | undefined>;
  readAgentGraphClientOperatorProjection(
    graphId: string,
    operatorId: string,
  ): Promise<AgentGraphClientOperatorProjectionRecord | undefined>;
  readAgentGraphClientProjectionWithOperator(
    graphId: string,
    operatorId: string,
  ): Promise<AgentGraphClientProjectionWithOperator | undefined>;
  listAgentGraphClientTerminalActivities(
    graphId: string,
    input: {
      limit: number;
      before?: AgentGraphClientTerminalActivityKey;
    },
  ): Promise<AgentGraphClientTerminalActivityPage>;
  listAgentGraphClientClaimAdmissions(graphId: string): Promise<AgentGraphClientClaimAdmission[]>;
}
