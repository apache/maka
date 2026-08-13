export const AGENT_GRAPH_INSTANCE_SCHEMA_VERSION = 1 as const;

export type AgentGraphInstanceStatus = 'open' | 'finished';

/**
 * One independently closable graph owned by a long-lived root Session.
 *
 * A root Session may own several sequential instances. `finish` closes one
 * instance permanently; later work is admitted into a newly created instance.
 */
export interface AgentGraphInstance {
  schemaVersion: typeof AGENT_GRAPH_INSTANCE_SCHEMA_VERSION;
  graphId: string;
  rootSessionId: string;
  sequence: number;
  status: AgentGraphInstanceStatus;
  createdAt: number;
  finishedAt?: number;
}

export interface CreateAgentGraphInstanceRequest {
  schemaVersion: typeof AGENT_GRAPH_INSTANCE_SCHEMA_VERSION;
  graphId: string;
  rootSessionId: string;
}

export interface AgentGraphInstanceResult {
  instance: AgentGraphInstance;
  created: boolean;
}

export interface AgentGraphInstanceStore {
  getOrCreateActiveAgentGraphInstance(
    request: CreateAgentGraphInstanceRequest,
  ): Promise<AgentGraphInstanceResult>;
  readActiveAgentGraphInstance(rootSessionId: string): Promise<AgentGraphInstance | undefined>;
  readLatestAgentGraphInstance(rootSessionId: string): Promise<AgentGraphInstance | undefined>;
  listAgentGraphInstances(rootSessionId: string): Promise<AgentGraphInstance[]>;
}

export function isAgentGraphInstance(value: unknown): value is AgentGraphInstance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const instance = value as Record<string, unknown>;
  const expectedKeys = [
    'schemaVersion',
    'graphId',
    'rootSessionId',
    'sequence',
    'status',
    'createdAt',
    ...(Object.prototype.hasOwnProperty.call(instance, 'finishedAt') ? ['finishedAt'] : []),
  ].sort();
  const actualKeys = Object.keys(instance).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    instance.schemaVersion === AGENT_GRAPH_INSTANCE_SCHEMA_VERSION &&
    isIdentity(instance.graphId) &&
    isIdentity(instance.rootSessionId) &&
    isPositiveSafeInteger(instance.sequence) &&
    (instance.status === 'open' || instance.status === 'finished') &&
    isNonNegativeSafeInteger(instance.createdAt) &&
    (instance.finishedAt === undefined || isNonNegativeSafeInteger(instance.finishedAt)) &&
    (instance.status === 'open'
      ? instance.finishedAt === undefined
      : instance.finishedAt !== undefined && instance.finishedAt >= instance.createdAt)
  );
}

export function decodeAgentGraphInstance(value: unknown): AgentGraphInstance {
  if (!isAgentGraphInstance(value)) throw new Error('Invalid agent graph instance');
  return { ...value };
}

export function assertCreateAgentGraphInstanceRequest(
  value: unknown,
): asserts value is CreateAgentGraphInstanceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid agent graph instance request');
  }
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).sort().join(',') !== 'graphId,rootSessionId,schemaVersion' ||
    request.schemaVersion !== AGENT_GRAPH_INSTANCE_SCHEMA_VERSION ||
    !isIdentity(request.graphId) ||
    !isIdentity(request.rootSessionId)
  ) {
    throw new Error('Invalid agent graph instance request');
  }
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
