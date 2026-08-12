import { ARTIFACT_OPERATION_SPECS } from './artifact.js';
import { ACCESS_AUTHORITY_OPERATION_SPECS } from './access-authority.js';
import { AGENT_GRAPH_OPERATION_SPECS } from './agent-graph.js';
import { requireExactRecord, requireId, requireRecord, requireString } from './codec.js';
import { CONNECTION_EFFECT_OPERATION_SPECS } from './connection-effects.js';
import { CONFIGURATION_OPERATION_SPECS } from './configuration.js';
import { DEEP_RESEARCH_OPERATION_SPECS } from './deep-research.js';
import { DAILY_REVIEW_OPERATION_SPECS } from './daily-review.js';
import { CONTEXT_OPERATION_SPECS } from './context.js';
import { EXECUTION_INSPECT_OPERATION_SPECS } from './execution-inspect.js';
import { EXTERNAL_SESSION_OPERATION_SPECS } from './external-session.js';
import { CLIENT_CAPABILITY_OPERATION_SPECS } from './client-capability.js';
import { invalidProtocolFrame } from './errors.js';
import { HOST_BOOTSTRAP_OPERATION_SPECS } from './host-status.js';
import { HOSTED_EXECUTION_OPERATION_SPECS } from './hosted-execution.js';
import { GOAL_OPERATION_SPECS } from './goal.js';
import { INTERACTION_OPERATION_SPECS } from './interaction.js';
import { MESSAGE_OPERATION_SPECS } from './message.js';
import { MEMORY_OPERATION_SPECS } from './memory.js';
import { NETWORK_PROXY_OPERATION_SPECS } from './network-proxy.js';
import { OAUTH_OPERATION_SPECS } from './oauth.js';
import { PLAN_OPERATION_SPECS } from './plan.js';
import { PROJECT_CATALOG_OPERATION_SPECS } from './project-catalog.js';
import {
  composeOperationSpecMaps,
  type HostOperationError,
  type HostOperationErrorCode,
  type OperationSpec,
} from './operation-spec.js';
import { RUNTIME_POLICY_OPERATION_SPECS } from './runtime-policy.js';
import { RUNTIME_RESOURCE_OPERATION_SPECS } from './runtime-resource.js';
import { SCHEDULED_TASK_OPERATION_SPECS } from './scheduled-task.js';
import { SESSION_CATALOG_OPERATION_SPECS } from './session-catalog.js';
import { SESSION_CONTINUITY_OPERATION_SPECS } from './session-continuity.js';
import { SESSION_TRANSCRIPT_OPERATION_SPECS } from './session-transcript.js';
import { SESSION_REVISION_OPERATION_SPECS } from './session-revision.js';
import { SESSION_RETIREMENT_OPERATION_SPECS } from './session-retirement.js';
import { SESSION_EFFECT_OPERATION_SPECS } from './session-effects.js';
import { SKILL_CATALOG_OPERATION_SPECS } from './skill-catalog.js';
import { TASK_LEDGER_OPERATION_SPECS } from './task-ledger.js';
import { TURN_OPERATION_SPECS } from './turn.js';
import { USAGE_PRICING_OPERATION_SPECS } from './usage-pricing.js';
import { WEB_SEARCH_OPERATION_SPECS } from './web-search.js';

export type {
  HostDiagnosticsInput,
  HostDiagnosticsResult,
  HostActivitySnapshot,
  HostLifecycleState,
  HostStatusInput,
  HostStatusResult,
  HostUpgradePrepareInput,
  HostUpgradePrepareResult,
} from './host-status.js';
export type {
  HostOperationError,
  HostOperationErrorCode,
} from './operation-spec.js';
export {
  ARTIFACT_CURSOR_MAX_BYTES,
  ARTIFACT_INGEST_CHUNK_MAX_BYTES,
  ARTIFACT_INGEST_MIME_TYPE_MAX_BYTES,
  ARTIFACT_MIME_TYPE_MAX_BYTES,
  ARTIFACT_NAME_MAX_BYTES,
  ARTIFACT_PAGE_MAX_ITEMS,
  ARTIFACT_PREVIEW_MAX_BYTES,
  ARTIFACT_READ_CHUNK_MAX_BYTES,
  ARTIFACT_RESULT_MAX_BYTES,
  ARTIFACT_SUMMARY_MAX_BYTES,
  decodeArtifactDeleteInput,
  decodeArtifactDeleteResult,
  decodeArtifactIngestInput,
  decodeArtifactIngestResult,
  decodeArtifactQueryInput,
  decodeArtifactQueryResult,
  encodeArtifactDeleteResult,
  encodeArtifactQueryResult,
} from './artifact.js';
export type {
  ArtifactIngestInput,
  ArtifactIngestResult,
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
  TURN_FAILURE_MESSAGE_MAX_BYTES,
  TURN_MESSAGE_CONTENT_MAX_BYTES,
  TURN_MESSAGE_TEXT_MAX_BYTES,
  TURN_RESUME_PARK_REASONS,
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
  TurnRegenerateInput,
  TurnResumeParkReason,
  TurnResumePlan,
  TurnResumeQueryInput,
  TurnResumeStartInput,
  TurnResumeStartResult,
  TurnRunStatus,
  TurnSnapshot,
  TurnStartInput,
  TurnStartResult,
  TurnStopInput,
} from './turn.js';
export * from './connection-effects.js';
export * from './access-authority.js';
export * from './configuration.js';
export * from './deep-research.js';
export * from './daily-review.js';
export * from './context.js';
export * from './agent-graph.js';
export * from './execution-inspect.js';
export * from './client-capability.js';
export * from './goal.js';
export * from './memory.js';
export * from './network-proxy.js';
export * from './oauth.js';
export * from './plan.js';
export * from './project-catalog.js';
export * from './runtime-policy.js';
export * from './runtime-resource.js';
export * from './scheduled-task.js';
export * from './session-catalog.js';
export * from './session-revision.js';
export * from './session-retirement.js';
export * from './session-transcript.js';
export * from './session-effects.js';
export * from './skill-catalog.js';
export * from './usage-pricing.js';
export * from './web-search.js';
export * from './workspace.js';

export const HOST_OPERATION_SPECS = composeOperationSpecMaps(
  HOST_BOOTSTRAP_OPERATION_SPECS,
  HOSTED_EXECUTION_OPERATION_SPECS,
  ACCESS_AUTHORITY_OPERATION_SPECS,
  AGENT_GRAPH_OPERATION_SPECS,
  GOAL_OPERATION_SPECS,
  TURN_OPERATION_SPECS,
  CONTEXT_OPERATION_SPECS,
  CONNECTION_EFFECT_OPERATION_SPECS,
  DEEP_RESEARCH_OPERATION_SPECS,
  DAILY_REVIEW_OPERATION_SPECS,
  EXECUTION_INSPECT_OPERATION_SPECS,
  EXTERNAL_SESSION_OPERATION_SPECS,
  RUNTIME_POLICY_OPERATION_SPECS,
  RUNTIME_RESOURCE_OPERATION_SPECS,
  SCHEDULED_TASK_OPERATION_SPECS,
  PLAN_OPERATION_SPECS,
  PROJECT_CATALOG_OPERATION_SPECS,
  MESSAGE_OPERATION_SPECS,
  TASK_LEDGER_OPERATION_SPECS,
  INTERACTION_OPERATION_SPECS,
  SESSION_CONTINUITY_OPERATION_SPECS,
  SESSION_TRANSCRIPT_OPERATION_SPECS,
  SESSION_CATALOG_OPERATION_SPECS,
  SESSION_EFFECT_OPERATION_SPECS,
  SESSION_REVISION_OPERATION_SPECS,
  SESSION_RETIREMENT_OPERATION_SPECS,
  ARTIFACT_OPERATION_SPECS,
  SKILL_CATALOG_OPERATION_SPECS,
  USAGE_PRICING_OPERATION_SPECS,
  MEMORY_OPERATION_SPECS,
  OAUTH_OPERATION_SPECS,
  CLIENT_CAPABILITY_OPERATION_SPECS,
  WEB_SEARCH_OPERATION_SPECS,
  NETWORK_PROXY_OPERATION_SPECS,
  CONFIGURATION_OPERATION_SPECS,
);

export type OperationSpecMap = typeof HOST_OPERATION_SPECS;
export type OperationKey = keyof OperationSpecMap;

// Remote credentials are fail-closed: adding a protocol operation does not
// grant it to remote owners until this policy is deliberately updated.
export const REMOTE_OWNER_OPERATION_GRANTS = Object.freeze([
  'agent.graph.operator.query',
  'agent.graph.query',
  'agent.graph.stop',
  'artifact.delete',
  'artifact.ingest',
  'artifact.query',
  'client.capability.replace',
  'client.capability.unregister',
  'configuration.credentials.export',
  'connection.catalog.create',
  'connection.catalog.query',
  'connection.catalog.remove',
  'connection.catalog.set-default-target',
  'connection.catalog.update',
  'connection.models.fetch',
  'connection.onboarding.save',
  'connection.onboarding.verify',
  'connection.request-headers.query',
  'connection.request-headers.replace',
  'connection.test.run',
  'context.compact',
  'context.diagnostics.query',
  'credential.vault.delete',
  'credential.vault.query',
  'credential.vault.set',
  'daily-review.mutate',
  'daily-review.query',
  'deep-research.query',
  'execution.inspect.query',
  'execution.inspect.resolve',
  'external-session.catalog.query',
  'external-session.import',
  'external-session.source.query',
  'goal.control',
  'goal.query',
  'host.diagnostics.query',
  'host.status',
  'interaction.answer',
  'interaction.query',
  'memory.mutate',
  'memory.query',
  'network-proxy.test',
  'oauth.account.usage.fetch',
  'oauth.login.cancel',
  'oauth.login.query',
  'oauth.login.start',
  'plan.control',
  'plan.query',
  'plan.turn.start',
  'pricing.mutate',
  'pricing.query',
  'project.catalog.mutate',
  'project.catalog.query',
  'queue.retract',
  'runtime.policy.mutate',
  'runtime.policy.query',
  'runtime.resource.controller.acquire',
  'runtime.resource.controller.control',
  'runtime.resource.controller.release',
  'runtime.resource.query',
  'runtime.resource.start',
  'runtime.resource.stop',
  'scheduled-task.mutate',
  'scheduled-task.query',
  'session.branch.create',
  'session.catalog.query',
  'session.configuration.update',
  'session.create',
  'session.execution_boundary.query',
  'session.lifecycle.set',
  'session.metadata.update',
  'session.read_marker.set',
  'session.recap.generate',
  'session.remove',
  'session.revision.abandon',
  'session.revision.create',
  'session.transcript.page',
  'session.transcript.overlay.release',
  'session.workspace.relocate',
  'skill.catalog.invocable.query',
  'skill.catalog.mutate',
  'skill.catalog.preview-update',
  'skill.catalog.query',
  'subscription.close',
  'subscription.open',
  'task.ledger.query',
  'turn.interrupt',
  'turn.message.submit',
  'turn.query',
  'turn.regenerate',
  'turn.resume.query',
  'turn.resume.start',
  'turn.start',
  'turn.stop',
  'usage.query',
  'web-search.execute',
] as const satisfies readonly OperationKey[]);

const REMOTE_OWNER_OPERATION_GRANT_SET = new Set<OperationKey>(REMOTE_OWNER_OPERATION_GRANTS);

export function operationAllowsRemoteOwner(operation: OperationKey): boolean {
  return REMOTE_OWNER_OPERATION_GRANT_SET.has(operation);
}

type InferInput<Spec> =
  Spec extends OperationSpec<infer Input, unknown, HostOperationErrorCode> ? Input : never;
type InferOutput<Spec> =
  Spec extends OperationSpec<unknown, infer Output, HostOperationErrorCode> ? Output : never;
type InferErrorCode<Spec> =
  Spec extends OperationSpec<unknown, unknown, infer ErrorCode> ? ErrorCode : never;

export type OperationInput<K extends OperationKey> = InferInput<OperationSpecMap[K]>;
export type OperationOutput<K extends OperationKey> = InferOutput<OperationSpecMap[K]>;
export type OperationError<K extends OperationKey> = HostOperationError<
  InferErrorCode<OperationSpecMap[K]> | 'unauthorized'
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

export function operationUsesHostPaths(frame: RequestFrame): boolean {
  const spec = HOST_OPERATION_SPECS[frame.operation] as OperationSpec<
    unknown,
    unknown,
    HostOperationErrorCode
  >;
  return spec.usesHostPaths?.(frame.input) ?? false;
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
  if (
    typeof record.code !== 'string' ||
    (record.code !== 'unauthorized' && !allowedCodes.includes(record.code as C))
  ) {
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
