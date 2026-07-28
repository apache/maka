import { TOOL_BOUNDARY_PROTOCOL_V1, type ToolBoundaryProtocol } from '@maka/core/runtime-event';

declare const runtimeContinuationStartAdmissionProofBrand: unique symbol;

/**
 * Package-internal proof that a live continuation-start was newly committed.
 * The proof is opaque, one-shot, and deliberately unavailable from the public
 * package barrel.
 */
export interface RuntimeContinuationStartAdmissionProof {
  readonly [runtimeContinuationStartAdmissionProofBrand]: true;
}

export interface RuntimeContinuationStartAdmissionIdentity {
  startEventId: string;
  claimId: string;
  boundaryDigest: `sha256:${string}`;
  providerProjectionVersion: 1;
  providerReplayDigest: `sha256:${string}`;
  toolBoundaryProtocol?: ToolBoundaryProtocol;
  target: {
    sessionId: string;
    invocationId: string;
    runId: string;
    turnId: string;
  };
}

const pendingStartAdmissions = new WeakMap<object, RuntimeContinuationStartAdmissionIdentity>();

export function createRuntimeContinuationStartAdmissionProof(
  identity: RuntimeContinuationStartAdmissionIdentity,
): RuntimeContinuationStartAdmissionProof {
  if (
    identity.startEventId.length === 0 ||
    identity.claimId.length === 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(identity.boundaryDigest) ||
    identity.providerProjectionVersion !== 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(identity.providerReplayDigest) ||
    (identity.toolBoundaryProtocol !== undefined &&
      identity.toolBoundaryProtocol !== TOOL_BOUNDARY_PROTOCOL_V1) ||
    Object.values(identity.target).some((value) => value.length === 0)
  ) {
    throw new Error('Runtime continuation start admission identity is incomplete');
  }
  const proof = Object.freeze(Object.create(null)) as RuntimeContinuationStartAdmissionProof;
  pendingStartAdmissions.set(proof as object, structuredClone(identity));
  return proof;
}

export function consumeRuntimeContinuationStartAdmissionProof(
  proof: RuntimeContinuationStartAdmissionProof,
): RuntimeContinuationStartAdmissionIdentity {
  const admission = pendingStartAdmissions.get(proof as object);
  if (!admission) {
    throw new Error('Runtime continuation start admission proof is invalid or already consumed');
  }
  pendingStartAdmissions.delete(proof as object);
  return admission;
}
