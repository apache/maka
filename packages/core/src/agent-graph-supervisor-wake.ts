export const AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION = 1 as const;

export type AgentGraphSupervisorWakeStatus =
  | 'pending'
  | 'running'
  | 'waiting_permission'
  | 'delivered'
  | 'retryable_failed';

export interface AgentGraphSupervisorWakeRecord {
  schemaVersion: typeof AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION;
  graphId: string;
  wakeId: string;
  snapshotVersion: string;
  rootSessionId: string;
  status: AgentGraphSupervisorWakeStatus;
  attemptCount: number;
  currentAttemptId?: string;
  currentTurnId?: string;
  failureReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentGraphSupervisorWakeAttemptRecord {
  graphId: string;
  wakeId: string;
  attemptId: string;
  turnId: string;
  status: 'running' | 'waiting_permission' | 'delivered' | 'retryable_failed';
  failureReason?: string;
  startedAt: number;
  completedAt?: number;
}

export interface ClaimAgentGraphSupervisorWakeRequest {
  schemaVersion: typeof AGENT_GRAPH_SUPERVISOR_WAKE_SCHEMA_VERSION;
  graphId: string;
  wakeId: string;
  snapshotVersion: string;
  rootSessionId: string;
}

export interface BeginAgentGraphSupervisorWakeAttemptRequest {
  graphId: string;
  wakeId: string;
  attemptId: string;
  turnId: string;
}

export interface CompleteAgentGraphSupervisorWakeAttemptRequest {
  graphId: string;
  wakeId: string;
  attemptId: string;
  status: 'waiting_permission' | 'delivered' | 'retryable_failed';
  failureReason?: string;
}

export interface AgentGraphSupervisorWakeStore {
  claimAgentGraphSupervisorWake(
    request: ClaimAgentGraphSupervisorWakeRequest,
  ): Promise<{ wake: AgentGraphSupervisorWakeRecord; created: boolean }>;
  beginAgentGraphSupervisorWakeAttempt(
    request: BeginAgentGraphSupervisorWakeAttemptRequest,
  ): Promise<{
    wake: AgentGraphSupervisorWakeRecord;
    attempt?: AgentGraphSupervisorWakeAttemptRecord;
    acquired: boolean;
  }>;
  completeAgentGraphSupervisorWakeAttempt(
    request: CompleteAgentGraphSupervisorWakeAttemptRequest,
  ): Promise<AgentGraphSupervisorWakeRecord>;
  readAgentGraphSupervisorWake(
    graphId: string,
    wakeId: string,
  ): Promise<AgentGraphSupervisorWakeRecord | undefined>;
  listAgentGraphSupervisorWakeAttempts(
    graphId: string,
    wakeId: string,
  ): Promise<AgentGraphSupervisorWakeAttemptRecord[]>;
  listUnsettledAgentGraphSupervisorWakes(): Promise<AgentGraphSupervisorWakeRecord[]>;
  listRetryableAgentGraphSupervisorWakes(): Promise<AgentGraphSupervisorWakeRecord[]>;
  recoverAgentGraphSupervisorWakes(): Promise<number>;
}
