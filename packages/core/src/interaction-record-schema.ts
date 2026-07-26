import {
  APPROVALS_REVIEWERS,
  APPROVAL_RISK_LEVELS,
  isToolCategory,
  type AdditionalPermissionRequest,
  type PermissionRequest,
  type PermissionRequestPayload,
  type PermissionResponse,
  type SandboxEscalationRequest,
  type SandboxEscalationRiskSummary,
} from './permission.js';
import {
  validateAdditionalPermissionProfile,
  type AdditionalPermissionRiskSummary,
} from './additional-permissions.js';
import type { UserQuestion, UserQuestionOption, UserQuestionRequest } from './user-question.js';
import {
  defineObjectShape,
  hasExactShape,
  isFiniteNumber,
  isOptionalString,
  isRecord,
} from './record-schema.js';

const TOOL_PERMISSION_SHAPE = defineObjectShape<PermissionRequest>()(
  [
    'kind',
    'requestId',
    'toolUseId',
    'toolName',
    'category',
    'reason',
    'args',
    'rememberForTurnAllowed',
  ],
  ['hint'],
);

const ADDITIONAL_PERMISSION_SHAPE = defineObjectShape<AdditionalPermissionRequest>()(
  [
    'kind',
    'requestId',
    'toolUseId',
    'toolName',
    'category',
    'reason',
    'additionalPermissions',
    'cwd',
    'justification',
    'intentHash',
    'permissionsHash',
    'risk',
    'alsoApprovesToolExecution',
    'availableDecisions',
  ],
  ['hint'],
);

const SANDBOX_ESCALATION_SHAPE = defineObjectShape<SandboxEscalationRequest>()(
  [
    'kind',
    'requestId',
    'toolUseId',
    'toolName',
    'category',
    'reason',
    'command',
    'cwd',
    'justification',
    'intentHash',
    'commandHash',
    'trigger',
    'risk',
    'alsoApprovesToolExecution',
    'availableDecisions',
  ],
  ['hint'],
);

const PERMISSION_RESPONSE_SHAPE = defineObjectShape<PermissionResponse>()(
  ['requestId', 'decision'],
  ['rememberForTurn', 'reviewer', 'rationale', 'riskLevel'],
);

const ADDITIONAL_PERMISSION_RISK_SHAPE = defineObjectShape<AdditionalPermissionRiskSummary>()(
  ['outsideWorkspace', 'protectedMetadata', 'networkEnabled'],
  [],
);
const SANDBOX_ESCALATION_RISK_SHAPE = defineObjectShape<SandboxEscalationRiskSummary>()(
  [
    'unsandboxedExecution',
    'unrestrictedFileSystem',
    'unrestrictedNetwork',
    'protectedMetadataExposed',
  ],
  [],
);

const QUESTION_REQUEST_SHAPE = defineObjectShape<UserQuestionRequest>()(
  ['requestId', 'toolUseId', 'questions'],
  [],
);
const QUESTION_SHAPE = defineObjectShape<UserQuestion>()(['question', 'options'], []);
const QUESTION_OPTION_SHAPE = defineObjectShape<UserQuestionOption>()(['label'], ['description']);

const TOOL_PERMISSION_REASONS = new Set([
  'shell_dangerous',
  'file_write',
  'fs_destructive',
  'network',
  'git_destructive',
  'privileged',
  'browser',
  'computer_use',
  'custom',
]);

export function isPermissionRequestPayload(value: unknown): value is PermissionRequestPayload {
  if (!isRecord(value)) return false;
  const common =
    typeof value.requestId === 'string' &&
    typeof value.toolUseId === 'string' &&
    typeof value.toolName === 'string' &&
    isToolCategory(value.category);
  if (!common) return false;

  if (value.kind === 'tool_permission') {
    return (
      hasExactShape(value, TOOL_PERMISSION_SHAPE) &&
      TOOL_PERMISSION_REASONS.has(value.reason as string) &&
      Object.hasOwn(value, 'args') &&
      typeof value.rememberForTurnAllowed === 'boolean' &&
      isOptionalString(value.hint)
    );
  }
  if (value.kind === 'additional_permissions') {
    return (
      hasExactShape(value, ADDITIONAL_PERMISSION_SHAPE) &&
      value.reason === 'additional_permissions' &&
      validateAdditionalPermissionProfile(value.additionalPermissions).ok &&
      isAdditionalPermissionRisk(value.risk) &&
      typeof value.cwd === 'string' &&
      typeof value.justification === 'string' &&
      typeof value.intentHash === 'string' &&
      typeof value.permissionsHash === 'string' &&
      typeof value.alsoApprovesToolExecution === 'boolean' &&
      isAllowOnceDenyTuple(value.availableDecisions) &&
      isOptionalString(value.hint)
    );
  }
  return (
    value.kind === 'sandbox_escalation' &&
    hasExactShape(value, SANDBOX_ESCALATION_SHAPE) &&
    value.toolName === 'Bash' &&
    value.reason === 'sandbox_escalation' &&
    typeof value.command === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.justification === 'string' &&
    typeof value.intentHash === 'string' &&
    typeof value.commandHash === 'string' &&
    (value.trigger === 'proactive' || value.trigger === 'sandbox_denial') &&
    isSandboxEscalationRisk(value.risk) &&
    typeof value.alsoApprovesToolExecution === 'boolean' &&
    isAllowOnceDenyTuple(value.availableDecisions) &&
    isOptionalString(value.hint)
  );
}

export function isPermissionResponse(value: unknown): value is PermissionResponse {
  return (
    isRecord(value) &&
    hasExactShape(value, PERMISSION_RESPONSE_SHAPE) &&
    typeof value.requestId === 'string' &&
    isPermissionDecisionFields(value)
  );
}

export function isPermissionDecisionFields(
  value: Record<string, unknown>,
  options: { allowHint?: boolean } = {},
): boolean {
  return (
    (value.decision === 'allow' || value.decision === 'deny') &&
    (value.rememberForTurn === undefined || typeof value.rememberForTurn === 'boolean') &&
    (value.reviewer === undefined ||
      (APPROVALS_REVIEWERS as readonly unknown[]).includes(value.reviewer)) &&
    isOptionalString(value.rationale) &&
    (value.riskLevel === undefined ||
      (APPROVAL_RISK_LEVELS as readonly unknown[]).includes(value.riskLevel)) &&
    (!options.allowHint || isOptionalString(value.hint))
  );
}

export function isUserQuestionRequest(value: unknown): value is UserQuestionRequest {
  return (
    isRecord(value) &&
    hasExactShape(value, QUESTION_REQUEST_SHAPE) &&
    typeof value.requestId === 'string' &&
    typeof value.toolUseId === 'string' &&
    Array.isArray(value.questions) &&
    value.questions.every(isUserQuestion)
  );
}

function isUserQuestion(value: unknown): value is UserQuestion {
  return (
    isRecord(value) &&
    hasExactShape(value, QUESTION_SHAPE) &&
    typeof value.question === 'string' &&
    Array.isArray(value.options) &&
    value.options.every(isUserQuestionOption)
  );
}

function isUserQuestionOption(value: unknown): value is UserQuestionOption {
  return (
    isRecord(value) &&
    hasExactShape(value, QUESTION_OPTION_SHAPE) &&
    typeof value.label === 'string' &&
    isOptionalString(value.description)
  );
}

function isAdditionalPermissionRisk(value: unknown): value is AdditionalPermissionRiskSummary {
  return (
    isRecord(value) &&
    hasExactShape(value, ADDITIONAL_PERMISSION_RISK_SHAPE) &&
    typeof value.outsideWorkspace === 'boolean' &&
    typeof value.protectedMetadata === 'boolean' &&
    typeof value.networkEnabled === 'boolean'
  );
}

function isSandboxEscalationRisk(value: unknown): value is SandboxEscalationRiskSummary {
  return (
    isRecord(value) &&
    hasExactShape(value, SANDBOX_ESCALATION_RISK_SHAPE) &&
    value.unsandboxedExecution === true &&
    value.unrestrictedFileSystem === true &&
    value.unrestrictedNetwork === true &&
    value.protectedMetadataExposed === true
  );
}

function isAllowOnceDenyTuple(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length === 2 && value[0] === 'allow_once' && value[1] === 'deny'
  );
}
