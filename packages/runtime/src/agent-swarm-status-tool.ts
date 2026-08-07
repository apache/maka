import { z } from 'zod';
import type { MakaTool } from './tool-runtime.js';
import type {
  AgentGraphClientOperator,
  AgentGraphClientSnapshot,
  AgentGraphClientScheduledWork,
} from './stream-graph-read-model.js';

export const AGENT_SWARM_STATUS_TOOL_NAME = 'agent_swarm_status';

export type AgentSwarmItemStatus =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'cancelled'
  | 'stopped'
  | 'superseded';

export interface AgentSwarmStatusItem {
  workId: string;
  status: AgentSwarmItemStatus;
  operatorId?: string;
  childSessionId?: string;
  runId?: string;
}

export interface AgentSwarmStatusResult {
  kind: 'agent_swarm_status';
  swarmId: string;
  status: 'running' | 'needs_attention' | 'settled';
  counts: Record<AgentSwarmItemStatus, number>;
  items: AgentSwarmStatusItem[];
}

const terminalStatuses = new Set<AgentSwarmItemStatus>([
  'completed',
  'failed',
  'aborted',
  'cancelled',
  'stopped',
  'superseded',
]);

const attentionStatuses = new Set<AgentSwarmItemStatus>([
  'blocked',
  'failed',
  'aborted',
  'cancelled',
]);

export function projectAgentSwarmStatus(
  snapshot: AgentGraphClientSnapshot,
): AgentSwarmStatusResult {
  const operatorByWorkId = new Map<string, AgentGraphClientOperator>();
  for (const operator of snapshot.operators) {
    for (const workId of operator.scheduledWorkIds) operatorByWorkId.set(workId, operator);
  }
  const items = snapshot.work.map((work) => swarmItem(work, operatorByWorkId.get(work.workId)));
  const counts = emptyCounts();
  for (const item of items) counts[item.status] += 1;
  const status = items.some((item) => attentionStatuses.has(item.status))
    ? 'needs_attention'
    : items.length > 0 && items.every((item) => terminalStatuses.has(item.status))
      ? 'settled'
      : 'running';
  return {
    kind: 'agent_swarm_status',
    swarmId: snapshot.graphId,
    status,
    counts,
    items,
  };
}

export function isAgentSwarmSupervisorCheckpoint(snapshot: AgentGraphClientSnapshot): boolean {
  return projectAgentSwarmStatus(snapshot).status !== 'running';
}

export function buildAgentSwarmStatusTool(input: {
  readSnapshot(): Promise<AgentGraphClientSnapshot>;
}): MakaTool<Record<string, never>, AgentSwarmStatusResult> {
  return {
    name: AGENT_SWARM_STATUS_TOOL_NAME,
    displayName: 'Agent swarm status',
    description:
      'Read compact status-only progress for the asynchronous swarm. This omits child logs, tool activity, reasoning, and partial output.',
    parameters: z.object({}).strip(),
    categoryHint: 'read',
    nesting: 'direct_only',
    recoveryMode: 'replay_safe',
    impl: async () => projectAgentSwarmStatus(await input.readSnapshot()),
  };
}

function swarmItem(
  work: AgentGraphClientScheduledWork,
  operator: AgentGraphClientOperator | undefined,
): AgentSwarmStatusItem {
  if (work.status !== 'requested') {
    return { workId: work.workId, status: work.status };
  }
  const status = operatorStatus(operator);
  return {
    workId: work.workId,
    status,
    ...(operator
      ? {
          operatorId: operator.operatorId,
          childSessionId: operator.childSessionId,
          ...(operator.currentActivation
            ? { runId: operator.currentActivation.run.agentRunId }
            : {}),
        }
      : {}),
  };
}

function operatorStatus(operator: AgentGraphClientOperator | undefined): AgentSwarmItemStatus {
  if (!operator) return 'queued';
  const activationStatus = operator.currentActivation?.status;
  if (activationStatus) return activationStatus;
  if (operator.status === 'running') return 'running';
  if (operator.status === 'blocked') return 'blocked';
  if (
    operator.status === 'completed' ||
    operator.status === 'failed' ||
    operator.status === 'aborted' ||
    operator.status === 'cancelled'
  ) {
    return operator.status;
  }
  return 'queued';
}

function emptyCounts(): Record<AgentSwarmItemStatus, number> {
  return {
    queued: 0,
    running: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    aborted: 0,
    cancelled: 0,
    stopped: 0,
    superseded: 0,
  };
}
