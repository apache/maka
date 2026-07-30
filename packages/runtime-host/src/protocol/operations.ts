import { ARTIFACT_OPERATION_SPECS } from './artifact.js';
import { requireExactRecord, requireId, requireRecord, requireString } from './codec.js';
import { CONNECTION_EFFECT_OPERATION_SPECS } from './connection-effects.js';
import { invalidProtocolFrame } from './errors.js';
import { HOST_STATUS_OPERATION_SPECS } from './host-status.js';
import { INTERACTION_OPERATION_SPECS } from './interaction.js';
import { MESSAGE_OPERATION_SPECS } from './message.js';
import { MEMORY_OPERATION_SPECS } from './memory.js';
import {
  composeOperationSpecMaps,
  type HostOperationError,
  type HostOperationErrorCode,
  type OperationSpec,
} from './operation-spec.js';
import { RUNTIME_POLICY_OPERATION_SPECS } from './runtime-policy.js';
import { SESSION_CONTINUITY_OPERATION_SPECS } from './session-continuity.js';
import { SKILL_CATALOG_OPERATION_SPECS } from './skill-catalog.js';
import { TASK_LEDGER_OPERATION_SPECS } from './task-ledger.js';
import { TURN_OPERATION_SPECS } from './turn.js';
import { USAGE_PRICING_OPERATION_SPECS } from './usage-pricing.js';

export type { HostLifecycleState, HostStatusInput, HostStatusResult } from './host-status.js';
export type { HostOperationError, HostOperationErrorCode } from './operation-spec.js';
export {
  ARTIFACT_CURSOR_MAX_BYTES,
  ARTIFACT_MIME_TYPE_MAX_BYTES,
  ARTIFACT_NAME_MAX_BYTES,
  ARTIFACT_PAGE_MAX_ITEMS,
  ARTIFACT_PREVIEW_MAX_BYTES,
  ARTIFACT_RESULT_MAX_BYTES,
  ARTIFACT_SUMMARY_MAX_BYTES,
  decodeArtifactDeleteInput,
  decodeArtifactDeleteResult,
  decodeArtifactQueryInput,
  decodeArtifactQueryResult,
  encodeArtifactDeleteResult,
  encodeArtifactQueryResult,
} from './artifact.js';
export type {
  ArtifactBinaryPreview,
  ArtifactDeleteInput,
  ArtifactDeleteResult,
  ArtifactProjection,
  ArtifactQueryInput,
  ArtifactQueryResult,
  ArtifactRevision,
  ArtifactTextPreview,
} from './artifact.js';
export {
  TURN_MESSAGE_CONTENT_MAX_BYTES,
  TURN_MESSAGE_TEXT_MAX_BYTES,
} from './turn.js';
export type {
  InFlightMessageSnapshot,
  MessagePlacement,
  MessageQueueEntrySnapshot,
  QueueRetractInput,
  QueueRetractResult,
  QueuedMessageSnapshot,
  RetractedMessageSnapshot,
  SessionMessageQueueProjection,
  SteeringMessageSnapshot,
  TurnInterruptInput,
  TurnInterruptResult,
  TurnMessageSubmitInput,
  TurnMessageSubmitResult,
} from './message.js';
export type {
  TurnQueryInput,
  TurnRunStatus,
  TurnSnapshot,
  TurnStartInput,
  TurnStopInput,
} from './turn.js';
export * from './connection-effects.js';
export * from './memory.js';
export * from './runtime-policy.js';
export * from './skill-catalog.js';
export * from './usage-pricing.js';

const HOST_AND_TURN_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_STATUS_OPERATION_SPECS,
  TURN_OPERATION_SPECS,
);

const CORE_AND_CONNECTION_EFFECT_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_AND_TURN_OPERATION_SPECS,
  CONNECTION_EFFECT_OPERATION_SPECS,
);

const CORE_OPERATION_SPECS = composeOperationSpecMaps(
  CORE_AND_CONNECTION_EFFECT_OPERATION_SPECS,
  RUNTIME_POLICY_OPERATION_SPECS,
);

const CORE_AND_MESSAGE_OPERATION_SPECS = composeOperationSpecMaps(
  CORE_OPERATION_SPECS,
  MESSAGE_OPERATION_SPECS,
);

const CORE_MESSAGE_AND_TASK_LEDGER_OPERATION_SPECS = composeOperationSpecMaps(
  CORE_AND_MESSAGE_OPERATION_SPECS,
  TASK_LEDGER_OPERATION_SPECS,
);

const CORE_MESSAGE_TASK_LEDGER_AND_INTERACTION_OPERATION_SPECS = composeOperationSpecMaps(
  CORE_MESSAGE_AND_TASK_LEDGER_OPERATION_SPECS,
  INTERACTION_OPERATION_SPECS,
);

const CORE_MESSAGE_TASK_LEDGER_INTERACTION_AND_CONTINUITY_OPERATION_SPECS =
  composeOperationSpecMaps(
    CORE_MESSAGE_TASK_LEDGER_AND_INTERACTION_OPERATION_SPECS,
    SESSION_CONTINUITY_OPERATION_SPECS,
  );

const CORE_MESSAGE_TASK_LEDGER_INTERACTION_CONTINUITY_AND_ARTIFACT_OPERATION_SPECS =
  composeOperationSpecMaps(
    CORE_MESSAGE_TASK_LEDGER_INTERACTION_AND_CONTINUITY_OPERATION_SPECS,
    ARTIFACT_OPERATION_SPECS,
  );

const ALL_BUT_MEMORY_OPERATION_SPECS = composeOperationSpecMaps(
  CORE_MESSAGE_TASK_LEDGER_INTERACTION_CONTINUITY_AND_ARTIFACT_OPERATION_SPECS,
  SKILL_CATALOG_OPERATION_SPECS,
);

const ALL_WITH_USAGE_PRICING_OPERATION_SPECS = composeOperationSpecMaps(
  ALL_BUT_MEMORY_OPERATION_SPECS,
  USAGE_PRICING_OPERATION_SPECS,
);

export const HOST_OPERATION_SPECS = composeOperationSpecMaps(
  ALL_WITH_USAGE_PRICING_OPERATION_SPECS,
  MEMORY_OPERATION_SPECS,
);

export type OperationSpecMap = typeof HOST_OPERATION_SPECS;
export type OperationKey = keyof OperationSpecMap;

type InferInput<Spec> =
  Spec extends OperationSpec<infer Input, unknown, HostOperationErrorCode> ? Input : never;
type InferOutput<Spec> =
  Spec extends OperationSpec<unknown, infer Output, HostOperationErrorCode> ? Output : never;
type InferErrorCode<Spec> =
  Spec extends OperationSpec<unknown, unknown, infer ErrorCode> ? ErrorCode : never;

export type OperationInput<K extends OperationKey> = InferInput<OperationSpecMap[K]>;
export type OperationOutput<K extends OperationKey> = InferOutput<OperationSpecMap[K]>;
export type OperationError<K extends OperationKey> = HostOperationError<
  InferErrorCode<OperationSpecMap[K]>
>;

export type RequestFrameFor<K extends OperationKey> = {
  requestId: string;
  operation: K;
  input: OperationInput<K>;
};

export type ResponseFrameFor<K extends OperationKey> =
  | { requestId: string; operation: K; ok: true; result: OperationOutput<K> }
  | { requestId: string; operation: K; ok: false; error: OperationError<K> };

export type OperationOutcome<K extends OperationKey> =
  | { ok: true; result: OperationOutput<K> }
  | { ok: false; error: OperationError<K> };

export type RequestFrame = {
  [K in OperationKey]: RequestFrameFor<K>;
}[OperationKey];
export type ResponseFrame = {
  [K in OperationKey]: ResponseFrameFor<K>;
}[OperationKey];

export function decodeRequestFrame(value: unknown): RequestFrame {
  const frame = requireExactRecord(value, 'operation request', ['requestId', 'operation', 'input']);
  const requestId = requireId(frame.requestId, 'requestId');
  const operation = requireOperationKey(frame.operation);
  const input = HOST_OPERATION_SPECS[operation].decodeInput(frame.input);
  return { requestId, operation, input } as RequestFrame;
}

export function decodeResponseFrame(value: unknown): ResponseFrame {
  const record = requireRecord(value, 'operation response');
  const requestId = requireId(record.requestId, 'requestId');
  const operation = requireOperationKey(record.operation);
  const outcome = decodeOperationOutcome(operation, omitResponseIdentity(record));
  return { requestId, operation, ...outcome } as ResponseFrame;
}

export function decodeOperationOutcome<K extends OperationKey>(
  operation: K,
  value: unknown,
): OperationOutcome<K> {
  const record = requireRecord(value, 'operation outcome');
  if (record.ok === true) {
    const exact = requireExactRecord(record, 'operation outcome', ['ok', 'result']);
    return {
      ok: true,
      result: HOST_OPERATION_SPECS[operation].decodeOutput(exact.result),
    } as OperationOutcome<K>;
  }
  if (record.ok === false) {
    const exact = requireExactRecord(record, 'operation outcome', ['ok', 'error']);
    return {
      ok: false,
      error: decodeOperationError(exact.error, HOST_OPERATION_SPECS[operation].errors),
    } as OperationOutcome<K>;
  }
  throw invalidProtocolFrame('Invalid operation outcome');
}

export function isOperationKey(value: unknown): value is OperationKey {
  return typeof value === 'string' && Object.hasOwn(HOST_OPERATION_SPECS, value);
}

function omitResponseIdentity(record: Record<string, unknown>): Record<string, unknown> {
  if (record.ok === true) {
    requireExactRecord(record, 'operation response', ['requestId', 'operation', 'ok', 'result']);
    return { ok: true, result: record.result };
  }
  if (record.ok === false) {
    requireExactRecord(record, 'operation response', ['requestId', 'operation', 'ok', 'error']);
    return { ok: false, error: record.error };
  }
  throw invalidProtocolFrame('Invalid operation response outcome');
}

function decodeOperationError<C extends HostOperationErrorCode>(
  value: unknown,
  allowedCodes: readonly C[],
): HostOperationError<C> {
  const record = requireExactRecord(value, 'operation error', ['code', 'message']);
  if (typeof record.code !== 'string' || !allowedCodes.includes(record.code as C)) {
    throw invalidProtocolFrame('Operation returned an undeclared error code');
  }
  return {
    code: record.code as C,
    message: requireString(record.message, 'operation error message', 1024),
  };
}

function requireOperationKey(value: unknown): OperationKey {
  if (!isOperationKey(value)) throw invalidProtocolFrame('Unknown operation key');
  return value;
}
