import {
  isConnectionReady,
  normalizeOpenAiCodexConnection,
  type ChatConfigurationReason,
} from './connection-readiness.js';
import type { LlmConnection } from './llm-connections.js';

export const TASK_SUBMISSION_READINESS_STATES = [
  'ready',
  'repair_required',
  'unavailable',
  'unknown',
] as const;

export type TaskSubmissionReadinessState = (typeof TASK_SUBMISSION_READINESS_STATES)[number];

export type TaskSubmissionReadinessRepairTarget =
  | { kind: 'provider_catalog' }
  | { kind: 'connection'; connectionSlug: string }
  | { kind: 'models' }
  | { kind: 'runtime_restart' }
  | { kind: 'workspace_picker' }
  | { kind: 'system_permission'; permissionId: string }
  | { kind: 'capability_settings'; capabilityId: string };

export type TaskSubmissionReadinessBlockerCode =
  | `model_${ChatConfigurationReason}`
  | 'model_credentials_unknown'
  | 'model_target_unknown'
  | 'runtime_unavailable'
  | 'runtime_unknown'
  | 'workspace_missing'
  | 'workspace_unavailable'
  | 'workspace_unknown'
  | 'capability_unavailable'
  | 'capability_unknown';

export interface TaskSubmissionReadinessDimension {
  id: 'runtime' | 'model_target' | 'workspace' | `capability:${string}`;
  state: TaskSubmissionReadinessState;
  authority:
    | 'runtime_host'
    | 'connection_readiness'
    | 'workspace_execution'
    | 'capability_snapshot';
  checkedAt: number;
  blockerCode?: TaskSubmissionReadinessBlockerCode;
  repairTarget?: TaskSubmissionReadinessRepairTarget;
}

export interface TaskSubmissionReadinessSnapshot {
  checkedAt: number;
  state: TaskSubmissionReadinessState;
  dimensions: TaskSubmissionReadinessDimension[];
  blockers: TaskSubmissionReadinessDimension[];
}

export interface TaskSubmissionCapabilityReadinessInput {
  id: string;
  state: 'ready' | 'unavailable' | 'unknown';
  checkedAt: number;
  repairTarget?: TaskSubmissionReadinessRepairTarget;
}

export interface DeriveTaskSubmissionReadinessInput {
  checkedAt: number;
  runtime: {
    state: 'ready' | 'starting' | 'unavailable' | 'unknown';
    checkedAt: number;
  };
  modelTarget:
    | {
        kind: 'resolved';
        connection: LlmConnection;
        hasSecret?: boolean;
        requestedModel?: string;
        checkedAt: number;
      }
    | { kind: 'missing_default'; checkedAt: number }
    | { kind: 'connection_missing'; connectionSlug: string; checkedAt: number }
    | { kind: 'unknown'; checkedAt: number };
  workspace: {
    state: 'ready' | 'missing' | 'unavailable' | 'unknown';
    checkedAt: number;
  };
  capabilities?: ReadonlyArray<TaskSubmissionCapabilityReadinessInput>;
  requestedCapabilityIds?: ReadonlyArray<string>;
}

/**
 * Pure task-submission projection over current authorities. Historical health
 * observations are deliberately not an input: callers must not turn an old
 * runtime probe into a current send gate.
 */
export function deriveTaskSubmissionReadiness(
  input: DeriveTaskSubmissionReadinessInput,
): TaskSubmissionReadinessSnapshot {
  const dimensions = [
    runtimeDimension(input.runtime),
    modelTargetDimension(input.modelTarget),
    workspaceDimension(input.workspace),
    ...requestedCapabilityDimensions(
      input.capabilities ?? [],
      input.requestedCapabilityIds ?? [],
      input.checkedAt,
    ),
  ];
  const blockers = dimensions.filter((dimension) => dimension.state !== 'ready');
  return {
    checkedAt: input.checkedAt,
    state: aggregateReadinessState(blockers),
    dimensions,
    blockers,
  };
}

function runtimeDimension(
  runtime: DeriveTaskSubmissionReadinessInput['runtime'],
): TaskSubmissionReadinessDimension {
  if (runtime.state === 'ready') {
    return dimension('runtime', 'ready', 'runtime_host', runtime.checkedAt);
  }
  if (runtime.state === 'unavailable') {
    return dimension('runtime', 'unavailable', 'runtime_host', runtime.checkedAt, {
      blockerCode: 'runtime_unavailable',
      repairTarget: { kind: 'runtime_restart' },
    });
  }
  return dimension('runtime', 'unknown', 'runtime_host', runtime.checkedAt, {
    blockerCode: 'runtime_unknown',
  });
}

function modelTargetDimension(
  target: DeriveTaskSubmissionReadinessInput['modelTarget'],
): TaskSubmissionReadinessDimension {
  if (target.kind === 'unknown') {
    return dimension('model_target', 'unknown', 'connection_readiness', target.checkedAt, {
      blockerCode: 'model_target_unknown',
    });
  }
  if (target.kind === 'missing_default') {
    return dimension('model_target', 'repair_required', 'connection_readiness', target.checkedAt, {
      blockerCode: 'model_missing_default_connection',
      repairTarget: { kind: 'provider_catalog' },
    });
  }
  if (target.kind === 'connection_missing') {
    return dimension('model_target', 'repair_required', 'connection_readiness', target.checkedAt, {
      blockerCode: 'model_connection_missing',
      repairTarget: { kind: 'models' },
    });
  }

  const normalizedConnection = normalizeOpenAiCodexConnection(target.connection);
  const verdict = isConnectionReady({
    connection: normalizedConnection,
    hasSecret: target.hasSecret === true,
    requestedModel: target.requestedModel,
  });
  if (verdict.ready) {
    return dimension('model_target', 'ready', 'connection_readiness', target.checkedAt);
  }
  if (verdict.reason === 'missing_api_key' && target.hasSecret === undefined) {
    return dimension('model_target', 'unknown', 'connection_readiness', target.checkedAt, {
      blockerCode: 'model_credentials_unknown',
    });
  }
  return dimension('model_target', 'repair_required', 'connection_readiness', target.checkedAt, {
    blockerCode: `model_${verdict.reason}`,
    repairTarget: modelRepairTarget(verdict.reason, normalizedConnection.slug),
  });
}

function workspaceDimension(
  workspace: DeriveTaskSubmissionReadinessInput['workspace'],
): TaskSubmissionReadinessDimension {
  if (workspace.state === 'ready') {
    return dimension('workspace', 'ready', 'workspace_execution', workspace.checkedAt);
  }
  if (workspace.state === 'missing') {
    return dimension('workspace', 'repair_required', 'workspace_execution', workspace.checkedAt, {
      blockerCode: 'workspace_missing',
      repairTarget: { kind: 'workspace_picker' },
    });
  }
  if (workspace.state === 'unavailable') {
    return dimension('workspace', 'unavailable', 'workspace_execution', workspace.checkedAt, {
      blockerCode: 'workspace_unavailable',
      repairTarget: { kind: 'workspace_picker' },
    });
  }
  return dimension('workspace', 'unknown', 'workspace_execution', workspace.checkedAt, {
    blockerCode: 'workspace_unknown',
  });
}

function requestedCapabilityDimensions(
  capabilities: ReadonlyArray<TaskSubmissionCapabilityReadinessInput>,
  requestedIds: ReadonlyArray<string>,
  checkedAt: number,
): TaskSubmissionReadinessDimension[] {
  const byId = new Map(capabilities.map((capability) => [capability.id, capability]));
  return [...new Set(requestedIds)].map((id) => {
    const capability = byId.get(id);
    if (capability?.state === 'ready') {
      return dimension(`capability:${id}`, 'ready', 'capability_snapshot', capability.checkedAt);
    }
    const state = capability?.state === 'unavailable' ? 'unavailable' : 'unknown';
    return dimension(
      `capability:${id}`,
      state,
      'capability_snapshot',
      capability?.checkedAt ?? checkedAt,
      {
        blockerCode: state === 'unavailable' ? 'capability_unavailable' : 'capability_unknown',
        ...(state === 'unavailable'
          ? {
              repairTarget: capability?.repairTarget ?? {
                kind: 'capability_settings',
                capabilityId: id,
              },
            }
          : {}),
      },
    );
  });
}

function aggregateReadinessState(
  blockers: ReadonlyArray<TaskSubmissionReadinessDimension>,
): TaskSubmissionReadinessState {
  if (blockers.some((blocker) => blocker.state === 'unavailable')) return 'unavailable';
  if (blockers.some((blocker) => blocker.state === 'repair_required')) return 'repair_required';
  if (blockers.some((blocker) => blocker.state === 'unknown')) return 'unknown';
  return 'ready';
}

function modelRepairTarget(
  reason: ChatConfigurationReason,
  connectionSlug: string,
): TaskSubmissionReadinessRepairTarget {
  switch (reason) {
    case 'missing_default_connection':
    case 'connection_missing':
    case 'fake_backend':
      return { kind: 'provider_catalog' };
    case 'missing_model':
    case 'empty_model_list':
    case 'model_not_enabled':
    case 'model_not_chat_capable':
      return { kind: 'connection', connectionSlug };
    case 'connection_disabled':
    case 'missing_api_key':
    case 'oauth_subscription_not_wired':
      return { kind: 'connection', connectionSlug };
  }
}

function dimension(
  id: TaskSubmissionReadinessDimension['id'],
  state: TaskSubmissionReadinessState,
  authority: TaskSubmissionReadinessDimension['authority'],
  checkedAt: number,
  blocker?: Pick<TaskSubmissionReadinessDimension, 'blockerCode' | 'repairTarget'>,
): TaskSubmissionReadinessDimension {
  return { id, state, authority, checkedAt, ...blocker };
}
