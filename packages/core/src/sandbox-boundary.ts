/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { PermissionMode } from './permission.js';
import type { RuntimeEvent } from './runtime-event.js';
import {
  isNormalizedAbsolutePath,
  pathWithinRoot,
  samePath,
  trimTrailingPathSeparators,
} from './absolute-path.js';
import {
  FILE_SYSTEM_ACCESS_MODES,
  FILE_SYSTEM_PATH_MATCHES,
  FILE_SYSTEM_SPECIAL_PATHS,
  createReadOnlyPermissionProfile,
  createWorkspaceWritePermissionProfile,
  isProtectedMetadataPath,
  isReadOnlyPermissionProfile,
  type FileSystemPathMatch,
  type FileSystemSandboxEntry,
  type PermissionProfileManaged,
  type PermissionProfileMatchContext,
} from './permission-profile.js';
import { serializedByteLength } from './serialized-byte-length.js';

export const SANDBOX_BOUNDARY_ACCESS_MODES = ['read', 'write'] as const;
export type SandboxBoundaryAccess = (typeof SANDBOX_BOUNDARY_ACCESS_MODES)[number];

export const SANDBOX_BOUNDARY_SCOPES = ['exact', 'subtree'] as const;
export type SandboxBoundaryScope = (typeof SANDBOX_BOUNDARY_SCOPES)[number];

/** Maximum number of distinct correction rounds allowed for one negotiation kind. */
export const SANDBOX_BOUNDARY_FAILURE_ROUND_LIMIT = 3;

/**
 * The small amount of sandbox negotiation state that may cross a safe
 * continuation boundary. It is deliberately not an execution authority: the
 * live ExecutionBoundary remains the only source that can grant capability.
 */
export interface SandboxBoundaryNegotiationState {
  readonly denied: boolean;
  readonly invalidRounds: number;
  readonly unresolvedRounds: number;
  readonly finalizationRequested: boolean;
}

/**
 * State used when a continuation's boundary projection cannot be trusted.
 * Callers may report the blocked Turn, but must not reopen negotiation.
 */
export function createSandboxBoundaryFinalizationState(): SandboxBoundaryNegotiationState {
  return {
    denied: false,
    invalidRounds: 0,
    unresolvedRounds: 0,
    finalizationRequested: true,
  };
}

export type SandboxBoundaryNegotiationProjection =
  | { readonly kind: 'valid'; readonly state: SandboxBoundaryNegotiationState }
  | { readonly kind: 'invalid'; readonly reason: string };

export const MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES = 32;
export const MAX_SANDBOX_BOUNDARY_PATH_CHARS = 4096;
export const MAX_SANDBOX_BOUNDARY_SERIALIZED_BYTES = 64 * 1024;
export const MAX_EXECUTION_BOUNDARY_SERIALIZED_BYTES = 1024 * 1024;

export interface SandboxBoundaryFilesystemEntry {
  readonly path: string;
  readonly access: SandboxBoundaryAccess;
  readonly scope: SandboxBoundaryScope;
}

export interface SandboxBoundaryExpansion {
  readonly filesystem?: {
    readonly entries: readonly SandboxBoundaryFilesystemEntry[];
  };
  readonly network?: {
    readonly enabled: true;
  };
}

export const SANDBOX_BOUNDARY_REQUEST_STATUSES = [
  'pending',
  'approved',
  'denied',
  'conflict',
] as const;
export type SandboxBoundaryRequestStatus = (typeof SANDBOX_BOUNDARY_REQUEST_STATUSES)[number];

export interface SandboxBoundaryRequest {
  readonly sessionId: string;
  readonly requestId: string;
  readonly status: SandboxBoundaryRequestStatus;
  readonly baseRevision: number;
  readonly expansion: SandboxBoundaryExpansion;
  readonly justification: string;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly appliedRevision?: number;
  readonly outcomeReason?: string;
  /**
   * Turn that raised the request. Written with the row itself, so it survives
   * every later crash — including one before the matching RuntimeEvent lands.
   * Absent only on rows written before provenance existed.
   */
  readonly turnId?: string;
  /** Run that raised it, when the creating surface had run identity. */
  readonly runId?: string;
}

export interface CreateSandboxBoundaryRequest {
  readonly sessionId: string;
  readonly requestId: string;
  /**
   * Required: a request with no turn cannot be attributed back to the work it
   * interrupted, and the row is the only record guaranteed to exist.
   */
  readonly turnId: string;
  readonly runId?: string;
  readonly expansion: SandboxBoundaryExpansion;
  readonly justification: string;
}

export type SandboxBoundaryDecision = 'allow' | 'deny';

export interface SandboxBoundaryResponse {
  readonly requestId: string;
  readonly decision: SandboxBoundaryDecision;
}

export const SANDBOX_BOUNDARY_CLOSURE_REASONS = [
  'turn_stopped',
  'turn_terminal',
  'host_restarted',
] as const;
export type SandboxBoundaryClosureReason = (typeof SANDBOX_BOUNDARY_CLOSURE_REASONS)[number];
export const SANDBOX_BOUNDARY_HOST_RESTART_CLOSURE_REASON = 'host_restarted';

export interface SettleSandboxBoundaryRequest {
  readonly sessionId: string;
  readonly requestId: string;
  readonly decision: SandboxBoundaryDecision;
  /** Internal fail-closed settlement used when a live request owner cannot continue. */
  readonly closureReason?: SandboxBoundaryClosureReason;
}

/**
 * Turn/run failure class for the `host_restarted` closure above. The settlement
 * is durable in the request row, but only the turn carries it to a surface, so
 * this is the one string runtime writes and every surface reads to explain a
 * boundary prompt the user never got to answer.
 */
export const SANDBOX_BOUNDARY_RESTART_CLOSURE_CLASS = 'sandbox_boundary_closed_by_restart';

/**
 * A settled request that a host restart closed against the user. This is the
 * durable, re-readable fact recovery attributes from: it stays true across any
 * number of interrupted recovery attempts, unlike the pending status it
 * replaces or an in-memory record of what one recovery pass happened to close.
 */
export function isSandboxBoundaryRestartClosure(request: SandboxBoundaryRequest): boolean {
  return (
    request.status === 'denied' &&
    request.outcomeReason === SANDBOX_BOUNDARY_HOST_RESTART_CLOSURE_REASON
  );
}

export interface SandboxBoundarySettlement {
  readonly request: SandboxBoundaryRequest;
  readonly boundary: ExecutionBoundary;
  readonly changed: boolean;
}

/**
 * Rebuild negotiation control state from an authenticated RuntimeEvent
 * projection. Only canonical sandbox request/decision events and structured
 * boundary failures participate; prompt text and unstructured error strings do
 * not. A malformed or incomplete relevant fact returns `invalid`, allowing a
 * caller to fail closed without guessing state.
 */
export function projectSandboxBoundaryNegotiation(
  events: readonly RuntimeEvent[],
  durableRequests: readonly SandboxBoundaryRequest[] = [],
): SandboxBoundaryNegotiationProjection {
  let denied = false;
  let invalidRounds = 0;
  let unresolvedRounds = 0;
  let finalizationRequested = false;
  // RuntimeEvent order is authoritative inside the immutable ledger, but the
  // durable interaction rows live in a separate append/settlement path. When
  // a settlement has no matching decision ack, there is no shared sequence
  // number that can place it relative to later failures or decisions.
  let hasStatefulEvent = false;
  const invalidSteps = new Set<string>();
  const unresolvedSteps = new Set<string>();
  const requests = new Set<string>();
  const requestToolUseIds = new Map<string, string>();
  const requestIdentityKeys = new Map<string, string>();
  const settledRequests = new Set<string>();
  const requestEvents = new Set<string>();
  const decisionEvents = new Map<string, { status: SandboxBoundaryRequestStatus }>();
  const eventTurnIds = new Set<string>();
  const eventRunIds = new Set<string>();
  const eventIdentityPairs = new Set<string>();
  const toolCalls = new Map<string, { name: string; step: string }>();
  const boundaryCalls = new Map<string, { step: string }>();
  const boundaryResponses = new Set<string>();

  const invalid = (reason: string): SandboxBoundaryNegotiationProjection => ({
    kind: 'invalid',
    reason,
  });
  const addFailure = (kind: 'invalid' | 'unresolved', step: string): void => {
    hasStatefulEvent = true;
    const steps = kind === 'invalid' ? invalidSteps : unresolvedSteps;
    if (steps.has(step)) return;
    steps.add(step);
    if (kind === 'invalid') invalidRounds += 1;
    else unresolvedRounds += 1;
    if (
      invalidRounds >= SANDBOX_BOUNDARY_FAILURE_ROUND_LIMIT ||
      unresolvedRounds >= SANDBOX_BOUNDARY_FAILURE_ROUND_LIMIT
    ) {
      finalizationRequested = true;
    }
  };

  for (const event of events) {
    eventTurnIds.add(event.turnId);
    eventRunIds.add(event.runId);
    eventIdentityPairs.add(`${event.runId}\u0000${event.turnId}`);
    const delta = event.actions?.stateDelta;
    const request = delta?.sandboxBoundaryRequest;
    const decision = delta?.sandboxBoundaryDecision;
    if (request !== undefined || decision !== undefined) {
      if (request !== undefined && decision !== undefined) {
        return invalid(`sandbox boundary event ${event.id} contains request and decision facts`);
      }
      if (
        event.role !== 'system' ||
        typeof event.refs?.toolCallId !== 'string' ||
        event.refs.toolCallId.length === 0
      ) {
        return invalid(`sandbox boundary event ${event.id} has non-canonical identity`);
      }
      if (request !== undefined) {
        if (
          event.author !== 'system' ||
          !isRecord(request) ||
          !hasExactKeys(request, ['requestId', 'toolUseId', 'justification', 'expansion']) ||
          !nonEmptyString(request.requestId) ||
          !nonEmptyString(request.toolUseId) ||
          typeof request.justification !== 'string' ||
          request.justification.trim().length === 0 ||
          !validateSandboxBoundaryExpansion(request.expansion).ok ||
          request.toolUseId !== event.refs.toolCallId
        ) {
          return invalid(`sandbox boundary request ${event.id} is incomplete`);
        }
        if (requests.has(request.requestId) || settledRequests.has(request.requestId)) {
          return invalid(`sandbox boundary request ${request.requestId} is duplicated`);
        }
        requests.add(request.requestId);
        requestToolUseIds.set(request.requestId, request.toolUseId);
        requestIdentityKeys.set(
          request.requestId,
          `${event.sessionId}\u0000${event.invocationId}\u0000${event.runId}\u0000${event.turnId}`,
        );
        requestEvents.add(request.requestId);
        continue;
      }
      const requestToolUseId =
        isRecord(decision) && nonEmptyString(decision.requestId)
          ? requestToolUseIds.get(decision.requestId)
          : undefined;
      const requestIdentityKey =
        isRecord(decision) && nonEmptyString(decision.requestId)
          ? requestIdentityKeys.get(decision.requestId)
          : undefined;
      const decisionIdentityKey = `${event.sessionId}\u0000${event.invocationId}\u0000${event.runId}\u0000${event.turnId}`;
      if (
        event.author !== 'user' ||
        !isRecord(decision) ||
        !hasExactKeys(decision, ['requestId', 'decision', 'status', 'revision']) ||
        !nonEmptyString(decision.requestId) ||
        (decision.decision !== 'allow' && decision.decision !== 'deny') ||
        (decision.status !== 'approved' &&
          decision.status !== 'denied' &&
          decision.status !== 'conflict') ||
        typeof decision.revision !== 'number' ||
        !Number.isSafeInteger(decision.revision) ||
        decision.revision < 0 ||
        requestToolUseId === undefined ||
        requestIdentityKey !== decisionIdentityKey ||
        event.refs.toolCallId !== requestToolUseId ||
        settledRequests.has(decision.requestId) ||
        (decision.status === 'approved' && decision.decision !== 'allow') ||
        (decision.status === 'denied' && decision.decision !== 'deny') ||
        (decision.status === 'conflict' && decision.decision !== 'allow')
      ) {
        return invalid(`sandbox boundary decision ${event.id} is incomplete`);
      }
      settledRequests.add(decision.requestId);
      decisionEvents.set(decision.requestId, { status: decision.status });
      hasStatefulEvent = true;
      if (decision.status === 'denied') {
        denied = true;
      } else if (decision.status === 'approved') {
        if (denied || finalizationRequested) {
          return invalid(
            `sandbox boundary approval ${decision.requestId} reopens a closed negotiation`,
          );
        }
        denied = false;
        invalidRounds = 0;
        unresolvedRounds = 0;
        invalidSteps.clear();
        unresolvedSteps.clear();
        finalizationRequested = false;
      } else {
        addFailure('unresolved', `request:${decision.requestId}`);
      }
      continue;
    }

    const content = event.content;
    if (content?.kind === 'function_call') {
      const isBoundaryCall = isBoundaryAuthorityCall(content.name, content.args);
      if (
        isBoundaryCall &&
        (event.role !== 'model' ||
          event.author !== 'agent' ||
          event.refs?.toolCallId !== content.id ||
          !nonEmptyString(content.name))
      ) {
        return invalid(`sandbox boundary call ${event.id} has non-canonical identity`);
      }
      const call = {
        name: content.name,
        step:
          event.refs?.stepId ??
          event.refs?.parentToolCallId ??
          event.refs?.parentOperationId ??
          event.refs?.toolCallId ??
          content.id,
      };
      if (toolCalls.has(content.id)) {
        return invalid(`tool call ${content.id} is duplicated`);
      }
      toolCalls.set(content.id, call);
      if (isBoundaryCall) {
        if (boundaryCalls.has(content.id)) {
          return invalid(`sandbox boundary call ${content.id} is duplicated`);
        }
        boundaryCalls.set(content.id, { step: call.step });
      }
      continue;
    }
    if (content?.kind !== 'function_response') continue;
    const call = toolCalls.get(content.id);
    const boundaryCall = boundaryCalls.get(content.id);
    const result = content.result;
    if (
      boundaryCall &&
      (event.role !== 'tool' ||
        event.author !== 'tool' ||
        event.refs?.toolCallId !== content.id ||
        content.name !== call?.name)
    ) {
      return invalid(`sandbox boundary response ${event.id} has non-canonical identity`);
    }
    const failure = readBoundaryFailure(result);
    if (failure === 'malformed') {
      return invalid(`sandbox boundary failure on ${event.id} is malformed`);
    }
    if (failure !== undefined) {
      if (!boundaryCall || !call || content.isError !== true) {
        return invalid(`sandbox boundary failure on ${event.id} has no canonical call`);
      }
      const step = event.refs?.stepId ?? boundaryCall?.step ?? call.step;
      addFailure(failure, step);
    } else if (content.isError === true && boundaryCall) {
      // Older ledgers did not carry a structured invalid-boundary marker. Do
      // not infer a count from their text; the relevant lineage is incomplete
      // and must be rejected closed by the continuation caller.
      return invalid(`sandbox boundary call ${content.id} lacks a canonical failure marker`);
    }
    if (boundaryCall) {
      if (boundaryResponses.has(content.id)) {
        return invalid(`sandbox boundary response ${content.id} is duplicated`);
      }
      boundaryResponses.add(content.id);
    }
    continue;
  }

  for (const callId of boundaryCalls.keys()) {
    if (!boundaryResponses.has(callId)) {
      return invalid(`sandbox boundary call ${callId} has no durable response`);
    }
  }

  const durableById = new Map<string, SandboxBoundaryRequest>();
  const durableSettlementsWithoutDecision: SandboxBoundaryRequest[] = [];
  for (const request of durableRequests) {
    const hasProvenance = request.turnId !== undefined || request.runId !== undefined;
    const attributable = hasProvenance
      ? request.turnId !== undefined && request.runId !== undefined
        ? eventIdentityPairs.has(`${request.runId}\u0000${request.turnId}`)
        : (request.turnId === undefined || eventTurnIds.has(request.turnId)) &&
          (request.runId === undefined || eventRunIds.has(request.runId))
      : requestEvents.has(request.requestId) || decisionEvents.has(request.requestId);
    if (!attributable) continue;
    if (
      !nonEmptyString(request.requestId) ||
      !SANDBOX_BOUNDARY_REQUEST_STATUSES.includes(request.status) ||
      !validateSandboxBoundaryExpansion(request.expansion).ok ||
      typeof request.justification !== 'string' ||
      request.justification.trim().length === 0 ||
      !Number.isSafeInteger(request.createdAt) ||
      request.createdAt < 0 ||
      (request.turnId !== undefined && !nonEmptyString(request.turnId)) ||
      (request.runId !== undefined && !nonEmptyString(request.runId))
    ) {
      return invalid(`sandbox boundary durable request ${String(request.requestId)} is malformed`);
    }
    if (durableById.has(request.requestId)) {
      return invalid(`sandbox boundary durable request ${request.requestId} is duplicated`);
    }
    durableById.set(request.requestId, request);
    const eventDecision = decisionEvents.get(request.requestId);
    if (eventDecision && eventDecision.status !== request.status) {
      return invalid(
        `sandbox boundary durable request ${request.requestId} changed decision status`,
      );
    }
    if (request.status === 'pending') {
      return invalid(`sandbox boundary durable request ${request.requestId} is unresolved`);
    }
    if (!eventDecision) {
      durableSettlementsWithoutDecision.push(request);
      settledRequests.add(request.requestId);
      if (request.status === 'denied') {
        denied = true;
      } else if (request.status === 'approved') {
        if (denied || finalizationRequested) {
          return invalid(
            `sandbox boundary approval ${request.requestId} reopens a closed negotiation`,
          );
        }
        denied = false;
        invalidRounds = 0;
        unresolvedRounds = 0;
        invalidSteps.clear();
        unresolvedSteps.clear();
        finalizationRequested = false;
      } else {
        addFailure('unresolved', `request:${request.requestId}`);
      }
    }
  }

  // Do not guess at the order between an interaction-row settlement and
  // RuntimeEvent facts from the same source run. An approved durable row
  // applied after the event projection could erase later failure budget, and
  // a denied row could overwrite a later approval. The only safe exception is
  // the ack-loss recovery case where the durable row is the sole stateful fact
  // and can be applied without crossing another state transition.
  if (
    durableSettlementsWithoutDecision.length > 1 ||
    (durableSettlementsWithoutDecision.length > 0 && hasStatefulEvent)
  ) {
    return invalid('sandbox boundary durable settlement ordering is unavailable');
  }

  for (const requestId of requests) {
    if (!settledRequests.has(requestId)) {
      return invalid(`sandbox boundary request ${requestId} has no durable decision`);
    }
  }
  return {
    kind: 'valid',
    state: {
      denied,
      invalidRounds,
      unresolvedRounds,
      finalizationRequested,
    },
  };
}

function isBoundaryAuthorityCall(toolName: string, args: unknown): boolean {
  if (toolName === 'request_sandbox_boundary') return true;
  if (toolName !== 'Bash' || !isRecord(args)) return false;
  return args.boundary_intent !== undefined && args.boundary_intent !== 'current';
}

function readBoundaryFailure(result: unknown): 'invalid' | 'unresolved' | 'malformed' | undefined {
  if (!isRecord(result) || result.kind !== 'text') return undefined;
  const failure = result.sandboxFailure;
  if (failure === undefined) return undefined;
  if (!isRecord(failure) || !hasOnlyKeys(failure, ['reason', 'requiredExpansion', 'source'])) {
    return 'malformed';
  }
  if (
    failure.reason === 'invalid_boundary_declaration' &&
    (failure.source !== undefined || failure.requiredExpansion !== undefined)
  ) {
    return 'malformed';
  }
  if (failure.reason === 'sandbox_boundary_required' || failure.reason === 'requires_bypass') {
    if (
      failure.source !== undefined &&
      !(failure.reason === 'requires_bypass' && failure.source === 'client_capability')
    ) {
      return 'malformed';
    }
    if (
      failure.requiredExpansion !== undefined &&
      !validateSandboxBoundaryExpansion(failure.requiredExpansion).ok
    ) {
      return 'malformed';
    }
    return 'unresolved';
  }
  if (failure.reason === 'invalid_boundary_declaration') return 'invalid';
  return 'malformed';
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === required.length && required.every((key) => keys.includes(key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export type SandboxProfile = PermissionProfileManaged;

export type ExecutionBoundary =
  | {
      readonly kind: 'managed';
      readonly profile: SandboxProfile;
      readonly revision: number;
    }
  | {
      readonly kind: 'bypass';
      readonly revision: number;
    }
  | {
      readonly kind: 'external';
      readonly revision: number;
    };

/**
 * Bounded Client read model for presenting an execution boundary without
 * exposing the potentially large Host-owned permission profile.
 */
export type ExecutionBoundarySummary =
  | {
      readonly kind: 'managed';
      readonly access: 'read_only' | 'writable';
      readonly revision: number;
    }
  | {
      readonly kind: 'bypass';
      readonly revision: number;
    }
  | {
      readonly kind: 'external';
      readonly revision: number;
    };

export type ExecutionBoundaryReadModel = ExecutionBoundary | ExecutionBoundarySummary;

/**
 * The permission mode a boundary should be *presented* as (#1611).
 *
 * The boundary is the authority on what a session may do; a session header's
 * stored `permissionMode` is only what it was last set to and goes stale the
 * moment an approved expansion widens the boundary. Every surface that shows
 * the user which permissions are in force derives them here, so Desktop and
 * the TUI cannot drift — and so the read-only/writable distinction the
 * boundary carries survives all the way to the label.
 *
 * `undefined` means the session is not locally controllable at all (an
 * externally isolated boundary), which each surface fails closed on.
 *
 * Everything managed that is not read-only maps to `ask`. That is a
 * deliberate under-statement, not a description: a workspace-write profile,
 * a profile widened by approved expansions, and `danger-full-access` all
 * present as Auto. Auto's copy is therefore written to stay true for any of
 * them — it never claims a specific boundary.
 */
export function executionBoundaryDisplayMode(
  boundary: ExecutionBoundaryReadModel,
): PermissionMode | undefined {
  if (boundary.kind === 'external') return undefined;
  if (boundary.kind === 'bypass') return 'bypass';
  const readOnly =
    'profile' in boundary
      ? isReadOnlyPermissionProfile(boundary.profile)
      : boundary.access === 'read_only';
  return readOnly ? 'explore' : 'ask';
}

export function createGenesisExecutionBoundary(mode: PermissionMode): ExecutionBoundary {
  if (mode === 'bypass') return { kind: 'bypass', revision: 0 };
  return {
    kind: 'managed',
    profile:
      mode === 'explore'
        ? createReadOnlyPermissionProfile()
        : createWorkspaceWritePermissionProfile(),
    revision: 0,
  };
}

export function createManagedExecutionBoundary(
  profile: SandboxProfile,
  revision: number,
): ExecutionBoundary {
  return { kind: 'managed', profile, revision };
}

export function createBypassExecutionBoundary(revision: number): ExecutionBoundary {
  return { kind: 'bypass', revision };
}

export function createExternalExecutionBoundary(revision = 0): ExecutionBoundary {
  return { kind: 'external', revision };
}

export function decodeExecutionBoundary(input: unknown): ExecutionBoundary {
  if (!isRecord(input) || !isBoundaryRevision(input.revision)) {
    throw new Error('Invalid execution boundary');
  }
  let boundary: ExecutionBoundary;
  if (input.kind === 'bypass' || input.kind === 'external') {
    if (hasUnexpectedKeys(input, ['kind', 'revision'])) {
      throw new Error('Invalid execution boundary');
    }
    boundary = { kind: input.kind, revision: input.revision };
  } else {
    if (input.kind !== 'managed' || hasUnexpectedKeys(input, ['kind', 'profile', 'revision'])) {
      throw new Error('Invalid execution boundary');
    }
    boundary = {
      kind: 'managed',
      profile: decodeSandboxProfile(input.profile),
      revision: input.revision,
    };
  }
  assertExecutionBoundaryCapacity(boundary);
  return boundary;
}

export function assertExecutionBoundaryCapacity(boundary: ExecutionBoundary): void {
  if (serializedByteLength(boundary) > MAX_EXECUTION_BOUNDARY_SERIALIZED_BYTES) {
    throw new Error('Execution boundary exceeds the serialized size limit');
  }
}

export function executionBoundaryContains(
  parent: ExecutionBoundary,
  child: ExecutionBoundary,
): boolean {
  if (parent.kind === 'bypass') return true;
  if (parent.kind === 'external') return child.kind === 'external';
  if (child.kind !== 'managed') return false;
  return sandboxProfileContains(parent.profile, child.profile);
}

export type SandboxBoundaryExpansionValidationFailureReason =
  | 'invalid_expansion'
  | 'empty_expansion'
  | 'too_many_entries'
  | 'invalid_entry'
  | 'invalid_path'
  | 'path_too_long'
  | 'payload_too_large';

export type SandboxBoundaryExpansionValidationResult =
  | { ok: true; expansion: SandboxBoundaryExpansion }
  | {
      ok: false;
      reason: SandboxBoundaryExpansionValidationFailureReason;
      message: string;
    };

export function validateSandboxBoundaryExpansion(
  input: unknown,
): SandboxBoundaryExpansionValidationResult {
  if (!isRecord(input)) {
    return invalid('invalid_expansion', 'Sandbox boundary expansion must be an object.');
  }
  if (hasUnexpectedKeys(input, ['filesystem', 'network'])) {
    return invalid('invalid_expansion', 'Sandbox boundary expansion contains unsupported fields.');
  }

  const entriesResult = validateFilesystem(input.filesystem);
  if (!entriesResult.ok) return entriesResult;
  const networkResult = validateNetwork(input.network);
  if (!networkResult.ok) return networkResult;
  if (entriesResult.entries.length === 0 && !networkResult.enabled) {
    return invalid(
      'empty_expansion',
      'Sandbox boundary expansion must contain at least one permission.',
    );
  }

  const expansion: SandboxBoundaryExpansion = {
    ...(entriesResult.entries.length > 0
      ? {
          filesystem: {
            entries: compactSandboxBoundaryFilesystemEntries(entriesResult.entries),
          },
        }
      : {}),
    ...(networkResult.enabled ? { network: { enabled: true as const } } : {}),
  };
  if (serializedByteLength(expansion) > MAX_SANDBOX_BOUNDARY_SERIALIZED_BYTES) {
    return invalid(
      'payload_too_large',
      'Sandbox boundary expansion exceeds the serialized size limit.',
    );
  }
  return { ok: true, expansion };
}

export function compactSandboxBoundaryFilesystemEntries(
  entries: readonly SandboxBoundaryFilesystemEntry[],
): readonly SandboxBoundaryFilesystemEntry[] {
  const sorted = [...entries]
    .map((entry) => ({ ...entry, path: trimTrailingSlashes(entry.path) }))
    .sort(compareEntries);
  const compacted: SandboxBoundaryFilesystemEntry[] = [];
  for (const entry of sorted) {
    if (compacted.some((existing) => entryCovers(existing, entry))) continue;
    for (let index = compacted.length - 1; index >= 0; index -= 1) {
      if (entryCovers(entry, compacted[index]!)) compacted.splice(index, 1);
    }
    compacted.push(entry);
  }
  return compacted.sort(compareEntries);
}

export function sandboxBoundaryExpansionAllowsPath(
  expansion: SandboxBoundaryExpansion,
  path: string,
  access: SandboxBoundaryAccess,
): boolean {
  return (
    expansion.filesystem?.entries.some(
      (entry) =>
        (access !== 'write' || entry.access === 'write') &&
        (entry.scope === 'exact' ? samePath(path, entry.path) : pathWithinRoot(path, entry.path)),
    ) ?? false
  );
}

export function applySandboxBoundaryExpansion(
  base: SandboxProfile,
  expansion: SandboxBoundaryExpansion,
): SandboxProfile {
  const fileSystem =
    base.fileSystem.kind === 'unrestricted'
      ? base.fileSystem
      : {
          ...base.fileSystem,
          entries: compactSandboxProfileFilesystemEntries([
            ...base.fileSystem.entries,
            ...(expansion.filesystem?.entries ?? []).map((entry) => ({
              kind: 'path' as const,
              access: entry.access,
              path: entry.path,
              match: entry.scope satisfies FileSystemPathMatch,
            })),
          ]),
        };

  return {
    ...base,
    fileSystem,
    network: expansion.network?.enabled ? { kind: 'enabled' } : base.network,
  };
}

function compactSandboxProfileFilesystemEntries(
  entries: readonly FileSystemSandboxEntry[],
): readonly FileSystemSandboxEntry[] {
  const explicitAllows: SandboxBoundaryFilesystemEntry[] = entries.flatMap((entry) =>
    entry.kind === 'path' && entry.access !== 'deny'
      ? [{ path: entry.path, access: entry.access, scope: entry.match ?? 'subtree' }]
      : [],
  );
  const preserved = entries.filter((entry) => entry.kind !== 'path' || entry.access === 'deny');
  const compacted = compactSandboxBoundaryFilesystemEntries(explicitAllows).map((entry) => ({
    kind: 'path' as const,
    access: entry.access,
    path: entry.path,
    match: entry.scope satisfies FileSystemPathMatch,
  }));
  return [...preserved, ...compacted];
}

export type SandboxBoundaryExpansionAssessment =
  | { outcome: 'apply'; profile: SandboxProfile }
  | { outcome: 'noop'; profile: SandboxProfile }
  | { outcome: 'conflict'; reason: 'explicit_deny' };

export function assessSandboxBoundaryExpansion(
  base: SandboxProfile,
  expansion: SandboxBoundaryExpansion,
  context: PermissionProfileMatchContext = {},
): SandboxBoundaryExpansionAssessment {
  if (expansionConflictsWithExplicitDeny(base, expansion, context)) {
    return { outcome: 'conflict', reason: 'explicit_deny' };
  }
  if (profileContainsExpansion(base, expansion, context)) {
    return { outcome: 'noop', profile: base };
  }
  return { outcome: 'apply', profile: applySandboxBoundaryExpansion(base, expansion) };
}

function profileContainsExpansion(
  profile: SandboxProfile,
  expansion: SandboxBoundaryExpansion,
  context: PermissionProfileMatchContext,
): boolean {
  if (expansion.network?.enabled && profile.network.kind !== 'enabled') return false;
  if (profile.fileSystem.kind === 'unrestricted') return true;

  return (expansion.filesystem?.entries ?? []).every((requested) =>
    profile.fileSystem.entries.some(
      (existing) =>
        existing.access !== 'deny' &&
        accessCovers(existing.access, requested.access) &&
        resolvedEntryRoots(existing, context).some((root) =>
          requested.scope === 'exact'
            ? pathCoveredByRoot(requested.path, root)
            : root.scope === 'subtree' && pathWithinRoot(requested.path, root.path),
        ),
    ),
  );
}

function sandboxProfileContains(parent: SandboxProfile, child: SandboxProfile): boolean {
  if (child.network.kind === 'enabled' && parent.network.kind !== 'enabled') return false;
  if (child.fileSystem.kind === 'unrestricted' && parent.fileSystem.kind !== 'unrestricted') {
    return false;
  }
  if (
    parent.fileSystem.kind !== 'unrestricted' &&
    !child.fileSystem.entries
      .filter((entry) => entry.access !== 'deny')
      .every((requested) =>
        parent.fileSystem.entries.some(
          (existing) =>
            existing.access !== 'deny' && sandboxProfileEntryContains(existing, requested, false),
        ),
      )
  ) {
    return false;
  }
  if (
    !parent.fileSystem.entries
      .filter((entry) => entry.access === 'deny')
      .every((requiredDeny) =>
        child.fileSystem.entries.some(
          (candidate) =>
            candidate.access === 'deny' &&
            sandboxProfileEntryContains(candidate, requiredDeny, true),
        ),
      )
  ) {
    return false;
  }
  const parentProtected = parent.fileSystem.protectedMetadata?.names ?? [];
  const childProtected = new Set(child.fileSystem.protectedMetadata?.names ?? []);
  return parentProtected.every((name) => childProtected.has(name));
}

function sandboxProfileEntryContains(
  existing: FileSystemSandboxEntry,
  requested: FileSystemSandboxEntry,
  ignoreAccess: boolean,
): boolean {
  if (
    !ignoreAccess &&
    existing.access !== 'write' &&
    (existing.access !== 'read' || requested.access !== 'read')
  ) {
    return false;
  }
  if (existing.kind === 'special' || requested.kind === 'special') {
    return (
      existing.kind === 'special' &&
      requested.kind === 'special' &&
      existing.special === requested.special
    );
  }
  const existingMatch = existing.match ?? 'subtree';
  const requestedMatch = requested.match ?? 'subtree';
  if (existingMatch === 'exact') {
    return requestedMatch === 'exact' && samePath(existing.path, requested.path);
  }
  return pathWithinRoot(requested.path, existing.path);
}

function expansionConflictsWithExplicitDeny(
  profile: SandboxProfile,
  expansion: SandboxBoundaryExpansion,
  context: PermissionProfileMatchContext,
): boolean {
  const deniedRoots = profile.fileSystem.entries
    .filter((entry) => entry.access === 'deny')
    .flatMap((entry) => resolvedEntryRoots(entry, context));

  return (expansion.filesystem?.entries ?? []).some(
    (requested) =>
      deniedRoots.some((denied) =>
        requested.scope === 'exact'
          ? pathCoveredByRoot(requested.path, denied)
          : pathWithinRoot(denied.path, requested.path) ||
            pathCoveredByRoot(requested.path, denied),
      ) || expansionWeakensProtectedMetadata(profile, requested, context),
  );
}

function expansionWeakensProtectedMetadata(
  profile: SandboxProfile,
  requested: SandboxBoundaryFilesystemEntry,
  context: PermissionProfileMatchContext,
): boolean {
  const policy = profile.fileSystem.protectedMetadata;
  if (policy?.access !== 'deny_write' || requested.access !== 'write') return false;
  const workspaceRoots = context.workspaceRoots ?? [];
  if (requested.scope === 'exact') {
    return isProtectedMetadataPath(requested.path, workspaceRoots, policy.names);
  }
  return workspaceRoots.some(
    (workspaceRoot) =>
      pathWithinRoot(requested.path, workspaceRoot) ||
      pathWithinRoot(workspaceRoot, requested.path),
  );
}

function accessCovers(
  existing: FileSystemSandboxEntry['access'],
  requested: SandboxBoundaryAccess,
): boolean {
  return existing === 'write' || (existing === 'read' && requested === 'read');
}

function resolvedEntryRoots(
  entry: FileSystemSandboxEntry,
  context: PermissionProfileMatchContext,
): readonly { path: string; scope: SandboxBoundaryScope }[] {
  if (entry.kind === 'path') {
    return [{ path: entry.path, scope: entry.match ?? 'subtree' }];
  }
  switch (entry.special) {
    case ':root':
      return [{ path: context.root ?? '/', scope: 'subtree' }];
    case ':workspace_roots':
      return (context.workspaceRoots ?? []).map((path) => ({ path, scope: 'subtree' }));
    case ':tmpdir':
      return context.tmpdir ? [{ path: context.tmpdir, scope: 'subtree' }] : [];
    case ':slash_tmp':
      return [{ path: context.slashTmp ?? '/tmp', scope: 'subtree' }];
    case ':minimal':
      return (context.minimalRoots ?? []).map((path) => ({ path, scope: 'subtree' }));
  }
}

function pathCoveredByRoot(
  path: string,
  root: { path: string; scope: SandboxBoundaryScope },
): boolean {
  return root.scope === 'exact' ? samePath(path, root.path) : pathWithinRoot(path, root.path);
}

function validateFilesystem(
  input: unknown,
):
  | { ok: true; entries: SandboxBoundaryFilesystemEntry[] }
  | Extract<SandboxBoundaryExpansionValidationResult, { ok: false }> {
  if (input === undefined) return { ok: true, entries: [] };
  if (!isRecord(input) || hasUnexpectedKeys(input, ['entries']) || !Array.isArray(input.entries)) {
    return invalid('invalid_expansion', 'filesystem must contain an entries array.');
  }
  if (input.entries.length > MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES) {
    return invalid(
      'too_many_entries',
      `Sandbox boundary filesystem entries are limited to ${MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES}.`,
    );
  }

  const entries: SandboxBoundaryFilesystemEntry[] = [];
  for (const candidate of input.entries) {
    if (!isRecord(candidate) || hasUnexpectedKeys(candidate, ['path', 'access', 'scope'])) {
      return invalid(
        'invalid_entry',
        'Sandbox boundary filesystem entry contains unsupported fields.',
      );
    }
    if (
      typeof candidate.path !== 'string' ||
      !SANDBOX_BOUNDARY_ACCESS_MODES.includes(candidate.access as SandboxBoundaryAccess) ||
      !SANDBOX_BOUNDARY_SCOPES.includes(candidate.scope as SandboxBoundaryScope)
    ) {
      return invalid(
        'invalid_entry',
        'Sandbox boundary filesystem entry must contain path, access, and scope.',
      );
    }
    if (!isNormalizedAbsolutePath(candidate.path)) {
      return invalid('invalid_path', 'Sandbox boundary path must be a normalized absolute path.');
    }
    if (candidate.path.length > MAX_SANDBOX_BOUNDARY_PATH_CHARS) {
      return invalid('path_too_long', 'Sandbox boundary path exceeds the length limit.');
    }
    entries.push({
      path: trimTrailingSlashes(candidate.path),
      access: candidate.access as SandboxBoundaryAccess,
      scope: candidate.scope as SandboxBoundaryScope,
    });
  }
  return { ok: true, entries };
}

function decodeSandboxProfile(input: unknown): SandboxProfile {
  if (
    !isRecord(input) ||
    input.type !== 'managed' ||
    hasUnexpectedKeys(input, ['type', 'name', 'fileSystem', 'network']) ||
    (input.name !== undefined && typeof input.name !== 'string') ||
    !isRecord(input.fileSystem) ||
    hasUnexpectedKeys(input.fileSystem, ['kind', 'entries', 'protectedMetadata']) ||
    (input.fileSystem.kind !== 'restricted' && input.fileSystem.kind !== 'unrestricted') ||
    !Array.isArray(input.fileSystem.entries) ||
    (input.fileSystem.protectedMetadata !== undefined &&
      (!isRecord(input.fileSystem.protectedMetadata) ||
        hasUnexpectedKeys(input.fileSystem.protectedMetadata, ['access', 'names']) ||
        input.fileSystem.protectedMetadata.access !== 'deny_write' ||
        !Array.isArray(input.fileSystem.protectedMetadata.names) ||
        !input.fileSystem.protectedMetadata.names.every(
          (name): name is string => typeof name === 'string',
        ))) ||
    !isRecord(input.network) ||
    hasUnexpectedKeys(input.network, ['kind']) ||
    (input.network.kind !== 'restricted' && input.network.kind !== 'enabled')
  ) {
    throw new Error('Invalid managed sandbox profile');
  }

  const entries: FileSystemSandboxEntry[] = input.fileSystem.entries.map((entry) => {
    if (!isRecord(entry) || !FILE_SYSTEM_ACCESS_MODES.includes(entry.access as never)) {
      throw new Error('Invalid managed sandbox filesystem entry');
    }
    if (
      entry.kind === 'path' &&
      !hasUnexpectedKeys(entry, ['kind', 'access', 'path', 'match']) &&
      typeof entry.path === 'string' &&
      isNormalizedAbsolutePath(entry.path) &&
      (entry.match === undefined || FILE_SYSTEM_PATH_MATCHES.includes(entry.match as never))
    ) {
      return {
        kind: 'path',
        access: entry.access as FileSystemSandboxEntry['access'],
        path: entry.path,
        ...(entry.match === undefined ? {} : { match: entry.match as FileSystemPathMatch }),
      };
    }
    if (
      entry.kind === 'special' &&
      !hasUnexpectedKeys(entry, ['kind', 'access', 'special']) &&
      FILE_SYSTEM_SPECIAL_PATHS.includes(entry.special as never)
    ) {
      return {
        kind: 'special',
        access: entry.access as FileSystemSandboxEntry['access'],
        special: entry.special as Extract<FileSystemSandboxEntry, { kind: 'special' }>['special'],
      };
    }
    throw new Error('Invalid managed sandbox filesystem entry');
  });

  return {
    type: 'managed',
    ...(input.name === undefined ? {} : { name: input.name }),
    fileSystem: {
      kind: input.fileSystem.kind,
      entries,
      ...(input.fileSystem.protectedMetadata === undefined
        ? {}
        : {
            protectedMetadata: {
              access: 'deny_write' as const,
              names: [...(input.fileSystem.protectedMetadata.names as string[])],
            },
          }),
    },
    network: { kind: input.network.kind },
  };
}

function isBoundaryRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateNetwork(
  input: unknown,
):
  | { ok: true; enabled: boolean }
  | Extract<SandboxBoundaryExpansionValidationResult, { ok: false }> {
  if (input === undefined) return { ok: true, enabled: false };
  if (!isRecord(input) || hasUnexpectedKeys(input, ['enabled']) || input.enabled !== true) {
    return invalid('invalid_expansion', 'network expansion only supports enabled: true.');
  }
  return { ok: true, enabled: true };
}

function entryCovers(
  existing: SandboxBoundaryFilesystemEntry,
  candidate: SandboxBoundaryFilesystemEntry,
): boolean {
  if (candidate.access === 'write' && existing.access !== 'write') return false;
  if (existing.scope === 'exact') {
    return candidate.scope === 'exact' && samePath(existing.path, candidate.path);
  }
  return pathWithinRoot(candidate.path, existing.path);
}

function compareEntries(
  a: SandboxBoundaryFilesystemEntry,
  b: SandboxBoundaryFilesystemEntry,
): number {
  return (
    a.path.localeCompare(b.path) ||
    (a.scope === b.scope ? 0 : a.scope === 'subtree' ? -1 : 1) ||
    (a.access === b.access ? 0 : a.access === 'write' ? -1 : 1)
  );
}

function trimTrailingSlashes(value: string): string {
  return trimTrailingPathSeparators(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

function invalid(
  reason: SandboxBoundaryExpansionValidationFailureReason,
  message: string,
): Extract<SandboxBoundaryExpansionValidationResult, { ok: false }> {
  return { ok: false, reason, message };
}

export type { PermissionProfileMatchContext };
