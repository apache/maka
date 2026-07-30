import type { AgentGraphIntentClaim } from './agent-graph-control.js';
import type {
  AgentGraphIntentAdmissionState,
  AgentGraphScheduleUpdate,
} from './agent-graph-schedule.js';
import type { AgentGraphOperatorProvision } from './agent-graph-topology.js';
import type {
  AgentGraphSupervisorWakeAttemptRecord,
  AgentGraphSupervisorWakeRecord,
} from './agent-graph-supervisor-wake.js';

/**
 * Current admission fact stored beside an immutable graph intent claim.
 *
 * This is deliberately named a snapshot: v1 metadata stores retain the
 * current admission state, not every overwritten transition.
 */
export interface AgentGraphIntentAdmissionSnapshot {
  graphId: string;
  intentId: string;
  state: AgentGraphIntentAdmissionState;
  updatedAt: number;
  cancellationReason?: string;
}

export interface AgentGraphSupervisorWakeTimelineSnapshot {
  wake: AgentGraphSupervisorWakeRecord;
  attempts: AgentGraphSupervisorWakeAttemptRecord[];
}

/**
 * One transactionally consistent read of the SQLite graph control plane.
 *
 * AgentRun and RuntimeEvent ledgers remain separate authorities and are joined
 * by the runtime trace reader after this metadata snapshot is acquired.
 */
export interface AgentGraphTimelineMetadataSnapshot {
  graphId: string;
  scheduleUpdates: AgentGraphScheduleUpdate[];
  operatorProvisions: AgentGraphOperatorProvision[];
  intentClaims: AgentGraphIntentClaim[];
  intentAdmissions: AgentGraphIntentAdmissionSnapshot[];
  supervisorWakes: AgentGraphSupervisorWakeTimelineSnapshot[];
}

export interface AgentGraphTimelineMetadataStore {
  readAgentGraphTimelineMetadata(graphId: string): Promise<AgentGraphTimelineMetadataSnapshot>;
}
