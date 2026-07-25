import type { InvocationResult } from '@maka/runtime';
import type { Config, ResultRecord, Task } from './contracts.js';
import { countRuntimeSteps } from './cell-output.js';
import {
  commandResourceScope,
  hashNormalizedArgs,
  matchPermissionGrant,
  permissionPreview,
} from './permission-grants.js';
import type { ResolvedHeadlessSystemPrompt } from './system-prompts.js';
import { approvalRequestInboxItem } from './task-inbox.js';
import type {
  PermissionResourceScope,
  TaskEvent,
  TaskInterventionPolicy,
  TaskPermissionRequest,
} from './task-contracts.js';
import type { TaskRunWriter } from './task-run-store.js';

export const DEFAULT_INTERVENTION_POLICY: TaskInterventionPolicy = { mode: 'fail_closed' };
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export interface PermissionInterventionInput {
  invocation: InvocationResult;
  store: TaskRunWriter;
  taskRunId: string;
  attemptId: string;
  now: () => number;
  newId: () => string;
  policy: TaskInterventionPolicy;
  config: Config;
  task: Task;
  sessionId: string;
  startedAt: number;
  closeTaskRun: boolean;
  systemPrompt: Pick<ResolvedHeadlessSystemPrompt, 'mode' | 'systemPromptHash'>;
}

export type PermissionInterventionResult =
  | { parked: false; invocation: InvocationResult }
  | { parked: true; invocation: InvocationResult; resultRecord: ResultRecord };

export async function handlePermissionIntervention(
  input: PermissionInterventionInput,
): Promise<PermissionInterventionResult> {
  const permissionRequestEvent = input.invocation.events.find(
    (event) => event.actions?.permissionRequest,
  );
  const rawRequest = permissionRequestEvent?.actions?.permissionRequest;
  if (!rawRequest) {
    return { parked: false, invocation: input.invocation };
  }

  const requestedAt = input.now();
  const request = permissionRequestFromRuntime({
    rawRequest,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    requestedAt,
    expiresAt: requestedAt + (input.policy.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS),
  });
  await appendTaskEvent(input.store, input.taskRunId, {
    type: 'permission_request_recorded',
    id: input.newId(),
    taskRunId: input.taskRunId,
    ts: requestedAt,
    request,
  });

  const projection = await input.store.project(input.taskRunId);
  const postHocGrant = matchPermissionGrant(request, projection.permissionGrants, requestedAt);
  const failClosedDenyReason = postHocGrant
    ? 'matching permission grant was observed only after runtime emitted a permission handoff; headless cannot safely resume post-hoc permission requests'
    : 'headless fail-closed policy denied interactive permission request';

  const inboxItem = approvalRequestInboxItem({
    inboxItemId: input.newId(),
    request,
    createdAt: requestedAt,
  });
  await appendTaskEvent(input.store, input.taskRunId, {
    type: 'task_inbox_item_recorded',
    id: input.newId(),
    taskRunId: input.taskRunId,
    ts: requestedAt,
    item: inboxItem,
  });

  if (input.policy.mode === 'park') {
    await appendTaskEvent(input.store, input.taskRunId, {
      type: 'task_attempt_completed',
      id: input.newId(),
      taskRunId: input.taskRunId,
      ts: requestedAt,
      attemptId: input.attemptId,
      finishedAt: requestedAt,
      status: 'needs_approval',
      error: {
        message: `task run needs approval for ${request.toolName}`,
        class: 'needs_approval',
      },
    });
    if (input.closeTaskRun) {
      await appendTaskEvent(input.store, input.taskRunId, {
        type: 'task_run_needs_approval',
        id: input.newId(),
        taskRunId: input.taskRunId,
        ts: requestedAt,
        attemptId: input.attemptId,
        reason: 'approval',
        inboxItemId: inboxItem.inboxItemId,
      });
    }
    return {
      parked: true,
      invocation: input.invocation,
      resultRecord: syntheticPermissionResultRecord({
        config: input.config,
        task: input.task,
        sessionId: input.sessionId,
        runId: input.invocation.runId,
        startedAt: input.startedAt,
        finishedAt: requestedAt,
        steps: countRuntimeSteps(input.invocation.events),
        errorClass: 'needs_approval',
        error: `task run needs approval for ${request.toolName}`,
        systemPrompt: input.systemPrompt,
      }),
    };
  }

  await appendTaskEvent(input.store, input.taskRunId, {
    type: 'permission_decision_recorded',
    id: input.newId(),
    taskRunId: input.taskRunId,
    ts: requestedAt,
    requestId: request.requestId,
    decision: 'deny',
    source: 'ci_policy',
    decidedAt: requestedAt,
    reason: failClosedDenyReason,
  });
  await appendTaskEvent(input.store, input.taskRunId, {
    type: 'task_inbox_item_resolved',
    id: input.newId(),
    taskRunId: input.taskRunId,
    ts: requestedAt,
    inboxItemId: inboxItem.inboxItemId,
    status: 'resolved',
    resolution: {
      decision: 'deny',
      actorId: 'ci_policy',
      resolvedAt: requestedAt,
      reason: failClosedDenyReason,
    },
  });

  return { parked: false, invocation: normalizeHeadlessInvocation(input.invocation) };
}

function permissionRequestFromRuntime(input: {
  rawRequest: {
    requestId?: string;
    toolUseId?: string;
    toolName?: string;
    reason?: string;
    category?: string;
    args?: unknown;
  };
  taskRunId: string;
  attemptId: string;
  requestedAt: number;
  expiresAt: number;
}): TaskPermissionRequest {
  const args = input.rawRequest.args;
  const toolName = input.rawRequest.toolName ?? 'unknown_tool';
  const toolCallId =
    input.rawRequest.toolUseId ?? input.rawRequest.requestId ?? 'unknown_tool_call';
  return {
    schemaVersion: 1,
    requestId: input.rawRequest.requestId ?? `${input.taskRunId}:${input.attemptId}:${toolCallId}`,
    taskRunId: input.taskRunId,
    attemptId: input.attemptId,
    toolCallId,
    toolName,
    normalizedArgsHash: hashNormalizedArgs(args),
    resourceScope: permissionScope(toolName, args),
    reason: input.rawRequest.reason ?? input.rawRequest.category ?? 'permission required',
    preview: permissionPreview(args),
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
  };
}

function permissionScope(toolName: string, args: unknown): PermissionResourceScope {
  if (toolName.toLowerCase() === 'bash' && isRecord(args) && typeof args.command === 'string') {
    return commandResourceScope(args.command);
  }
  return { kind: 'tool', value: toolName, mode: 'execute' };
}

function syntheticPermissionResultRecord(input: {
  config: Config;
  task: Task;
  sessionId: string;
  runId: string;
  startedAt: number;
  finishedAt: number;
  steps: number;
  errorClass: string;
  error: string;
  systemPrompt: Pick<ResolvedHeadlessSystemPrompt, 'mode' | 'systemPromptHash'>;
}): ResultRecord {
  return {
    taskId: input.task.id,
    configId: input.config.id,
    sessionId: input.sessionId,
    runId: input.runId,
    systemPromptMode: input.systemPrompt.mode,
    systemPromptHash: input.systemPrompt.systemPromptHash,
    status: 'failed',
    runnerCompleted: false,
    passed: false,
    scored: false,
    eligible: false,
    excludedReason: input.error,
    exitCode: null,
    steps: input.steps,
    durationMs: input.finishedAt - input.startedAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    error: input.error,
    errorClass: input.errorClass,
  };
}

function normalizeHeadlessInvocation(invocation: InvocationResult): InvocationResult {
  const permissionRequestEvent = invocation.events.find(
    (event) => event.actions?.permissionRequest,
  );
  if (!permissionRequestEvent) return invocation;

  const request = permissionRequestEvent.actions?.permissionRequest;
  return {
    ...invocation,
    status: 'failed',
    failure: {
      class: 'policy_denied',
      message: request?.requestId
        ? `headless task run cannot satisfy permission request ${request.requestId}`
        : 'headless task run cannot satisfy an interactive permission request',
    },
  };
}

function appendTaskEvent(store: TaskRunWriter, taskRunId: string, event: TaskEvent): Promise<void> {
  return store.appendEvent(taskRunId, event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
