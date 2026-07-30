export const AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION = 1 as const;

export interface AgentGraphIntentClaimRequest {
  schemaVersion: typeof AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION;
  claimId: string;
  graphId: string;
  intentId: string;
  intentFingerprint: string;
  readinessContextFingerprint: string;
  targetOperatorId: string;
  targetSessionId: string;
  targetTurnId: string;
  targetRunId: string;
}

/**
 * Durable admission authority for one runnable graph intent.
 *
 * The target turn/run ids are allocated before any Agent runtime action. A
 * retry therefore observes the same activation identity instead of starting a
 * second activation.
 */
export interface AgentGraphIntentClaim extends AgentGraphIntentClaimRequest {
  claimedAt: number;
}

export interface AgentGraphIntentClaimResult {
  claim: AgentGraphIntentClaim;
  created: boolean;
}

export interface AgentGraphIntentClaimStore {
  claimAgentGraphIntent(
    request: AgentGraphIntentClaimRequest,
  ): Promise<AgentGraphIntentClaimResult>;
  readAgentGraphIntentClaim(
    graphId: string,
    intentId: string,
  ): Promise<AgentGraphIntentClaim | undefined>;
  listAgentGraphIntentClaims(graphId?: string): Promise<AgentGraphIntentClaim[]>;
}

export function isAgentGraphIntentClaimRequest(
  value: unknown,
): value is AgentGraphIntentClaimRequest {
  return (
    isExactRecord(value, [
      'schemaVersion',
      'claimId',
      'graphId',
      'intentId',
      'intentFingerprint',
      'readinessContextFingerprint',
      'targetOperatorId',
      'targetSessionId',
      'targetTurnId',
      'targetRunId',
    ]) &&
    value.schemaVersion === AGENT_GRAPH_INTENT_CLAIM_SCHEMA_VERSION &&
    /^graph_claim_[a-f0-9]{32}$/.test(value.claimId as string) &&
    /^graph_intent_[a-f0-9]{32}$/.test(value.intentId as string) &&
    isOpaqueIdentity(value.graphId) &&
    isSha256Fingerprint(value.intentFingerprint) &&
    isSha256Fingerprint(value.readinessContextFingerprint) &&
    isOpaqueIdentity(value.targetOperatorId) &&
    isOpaqueIdentity(value.targetSessionId) &&
    isOpaqueIdentity(value.targetTurnId) &&
    isOpaqueIdentity(value.targetRunId)
  );
}

export function isAgentGraphIntentClaim(value: unknown): value is AgentGraphIntentClaim {
  if (
    !isExactRecord(value, [
      'schemaVersion',
      'claimId',
      'graphId',
      'intentId',
      'intentFingerprint',
      'readinessContextFingerprint',
      'targetOperatorId',
      'targetSessionId',
      'targetTurnId',
      'targetRunId',
      'claimedAt',
    ])
  ) {
    return false;
  }
  const { claimedAt, ...request } = value;
  return (
    isAgentGraphIntentClaimRequest(request) &&
    typeof claimedAt === 'number' &&
    Number.isSafeInteger(claimedAt) &&
    claimedAt >= 0
  );
}

export function assertAgentGraphIntentClaimRequest(
  value: unknown,
): asserts value is AgentGraphIntentClaimRequest {
  if (!isAgentGraphIntentClaimRequest(value)) {
    throw new Error('Invalid agent graph intent claim request');
  }
}

export function decodeAgentGraphIntentClaim(value: unknown): AgentGraphIntentClaim {
  if (!isAgentGraphIntentClaim(value)) {
    throw new Error('Invalid agent graph intent claim');
  }
  return {
    schemaVersion: value.schemaVersion,
    claimId: value.claimId,
    graphId: value.graphId,
    intentId: value.intentId,
    intentFingerprint: value.intentFingerprint,
    readinessContextFingerprint: value.readinessContextFingerprint,
    targetOperatorId: value.targetOperatorId,
    targetSessionId: value.targetSessionId,
    targetTurnId: value.targetTurnId,
    targetRunId: value.targetRunId,
    claimedAt: value.claimedAt,
  };
}

function isOpaqueIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSha256Fingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
