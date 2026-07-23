import { createHash } from 'node:crypto';
import {
  EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
  validateExecutionEvidenceRef,
  type ExecutionEvidenceRef,
  type ExecutionLogCoverage,
  type TargetSnapshotRef,
} from '@maka/core/execution-evidence';
import type { MakaChangeAuditRecord } from './change-audit.js';

export const MAKA_AHE_TARGET_PROTOCOL_VERSION_V1 = 'maka.ahe-target.v1' as const;
export const MAKA_AHE_TARGET_PROTOCOL_VERSION = 'maka.ahe-target.v2' as const;

export const MAKA_AHE_SUPPORTED_TARGET_PROTOCOL_VERSIONS = [
  MAKA_AHE_TARGET_PROTOCOL_VERSION_V1,
  MAKA_AHE_TARGET_PROTOCOL_VERSION,
] as const;

export const MAKA_AHE_RUN_RESULT_SCHEMA_VERSION = 'maka.ahe.run_result.v1' as const;
export const MAKA_AHE_EXECUTION_LINEAGE_SCHEMA_VERSION = 'maka.ahe.execution_lineage.v1' as const;

export const MAKA_AHE_TARGET_SOURCE_LABEL = 'ahe-target-protocol-20260714' as const;

export const MAKA_AHE_COMPONENT_CATEGORIES = [
  'system_prompt',
  'heavy_task_policy',
  'tool_contract',
  'context_management_policy',
  'permission_policy',
  'runtime_evidence',
  'headless_evaluation_policy',
] as const;

export const MAKA_AHE_RESULT_STATUSES = [
  'official_pass',
  'official_fail',
  'infra_failed',
  'excluded',
  'self_check_only',
  'unscored',
] as const;

export const MAKA_AHE_SCORE_AUTHORITIES = [
  'official_verifier',
  'official_scorer',
  'self_check',
  'analysis_only',
] as const;

export const MAKA_AHE_TRANSITION_STATUSES = [
  'fail_to_pass',
  'fail_to_fail',
  'pass_to_pass',
  'pass_to_fail',
  'new_pass',
  'new_fail',
  'infra_or_excluded',
] as const;

const FORBIDDEN_PATCH_PATH_PREFIXES = [
  '.git/',
  'node_modules/',
  'dist/',
  'packages/core/dist/',
  'packages/runtime/dist/',
  'packages/storage/dist/',
  'packages/headless/dist/',
  'packages/ui/dist/',
  'apps/desktop/dist/',
] as const;

const FORBIDDEN_PATCH_PATH_PARTS = ['/.git/', '/node_modules/', '/dist/'] as const;

export type MakaAheTargetProtocolVersion =
  (typeof MAKA_AHE_SUPPORTED_TARGET_PROTOCOL_VERSIONS)[number];
export type MakaAheCurrentTargetProtocolVersion = typeof MAKA_AHE_TARGET_PROTOCOL_VERSION;
export type MakaAheLegacyTargetProtocolVersion = typeof MAKA_AHE_TARGET_PROTOCOL_VERSION_V1;
export type MakaAheTargetSourceLabel = typeof MAKA_AHE_TARGET_SOURCE_LABEL;
export type MakaAheComponentCategory = (typeof MAKA_AHE_COMPONENT_CATEGORIES)[number];
export type MakaAheResultStatus = (typeof MAKA_AHE_RESULT_STATUSES)[number];
export type MakaAheScoreAuthority = (typeof MAKA_AHE_SCORE_AUTHORITIES)[number];
export type MakaAheTransitionStatus = (typeof MAKA_AHE_TRANSITION_STATUSES)[number];

export interface MakaAheSourceRef {
  path: string;
  exportName?: string;
  description?: string;
}

export interface MakaAheTargetComponent {
  id: string;
  category: MakaAheComponentCategory;
  label: string;
  description: string;
  sourceRefs: readonly MakaAheSourceRef[];
  editable: boolean;
}

export interface MakaAheGitIdentity {
  repository: string;
  ref?: string;
  commit?: string;
  dirty?: boolean;
}

export interface MakaAheSnapshotIdentity {
  protocolVersion: MakaAheCurrentTargetProtocolVersion;
  sourceLabel: MakaAheTargetSourceLabel | string;
  snapshotId: string;
  createdAt: string;
  git?: MakaAheGitIdentity;
}

export interface MakaAheSourceManifestEntry {
  componentId: string;
  path: string;
  exportName?: string;
  digest: string;
  sizeBytes: number;
}

export interface MakaAheSourceManifest {
  algorithm: 'sha256';
  digest: string;
  entries: readonly MakaAheSourceManifestEntry[];
}

export interface MakaAheTargetSnapshot extends MakaAheSnapshotIdentity {
  components: readonly MakaAheTargetComponent[];
  sourceManifest: MakaAheSourceManifest;
}

export interface MakaAheLegacyTargetSnapshot {
  protocolVersion: MakaAheLegacyTargetProtocolVersion;
  sourceLabel: MakaAheTargetSourceLabel | string;
  snapshotId: string;
  createdAt: string;
  git?: MakaAheGitIdentity;
  components: readonly MakaAheTargetComponent[];
}

export type MakaAheTargetSnapshotDocument = MakaAheTargetSnapshot | MakaAheLegacyTargetSnapshot;

export interface MakaAheArtifactRef {
  kind: 'file' | 'directory' | 'url' | 'blob' | 'other';
  ref: string;
  mediaType?: string;
  description?: string;
  /** SHA-256 of the referenced file bytes when the export materialized the artifact. */
  digest?: string;
  sizeBytes?: number;
}

export interface MakaAheExecutionLineageGap {
  code:
    | 'attempt_execution_missing'
    | 'execution_identity_missing'
    | 'runtime_coverage_missing'
    | 'agent_run_inspect_missing'
    | 'runtime_events_missing'
    | 'runtime_coverage_mismatch';
  message: string;
  attemptId?: string;
  sessionId?: string;
  agentRunId?: string;
}

export interface MakaAheExecutionLineageAgentRun {
  evidence: ExecutionEvidenceRef;
  inspectRef?: MakaAheArtifactRef;
  runtimeEventsRef?: MakaAheArtifactRef;
  gaps: readonly MakaAheExecutionLineageGap[];
}

export interface MakaAheExecutionLineageAttempt {
  attemptId: string;
  status: string;
  executions: readonly MakaAheExecutionLineageAgentRun[];
  gaps: readonly MakaAheExecutionLineageGap[];
}

export interface MakaAheExecutionLineage {
  schemaVersion: typeof MAKA_AHE_EXECUTION_LINEAGE_SCHEMA_VERSION;
  target: TargetSnapshotRef;
  task: {
    taskRunId: string;
    taskId: string;
    coverage?: ExecutionLogCoverage;
  };
  rawRuntimeEvents: 'included' | 'omitted_by_policy' | 'requested_with_gaps';
  attempts: readonly MakaAheExecutionLineageAttempt[];
  gaps: readonly MakaAheExecutionLineageGap[];
}

export interface MakaAheTraceIndexEntry {
  taskRunId?: string;
  taskId: string;
  runId: string;
  snapshotId: string;
  executionLineage?: MakaAheArtifactRef;
  taskEventsJsonl?: MakaAheArtifactRef;
  agentRunInspections?: readonly MakaAheArtifactRef[];
  runtimeEventSources?: readonly MakaAheArtifactRef[];
  messages?: MakaAheArtifactRef;
  /** @deprecated Legacy v1 field; events.jsonl contained Task Events, not Runtime Events. */
  runtimeEventsJsonl?: MakaAheArtifactRef;
  transcript?: MakaAheArtifactRef;
  /** @deprecated Legacy field pointed at normalized messages rather than an AgentRun source document. */
  agentRun?: MakaAheArtifactRef;
  toolResults?: readonly MakaAheArtifactRef[];
  artifacts?: readonly MakaAheArtifactRef[];
}

export interface MakaAheTraceIndex {
  protocolVersion: MakaAheTargetProtocolVersion;
  snapshotId: string;
  entries: readonly MakaAheTraceIndexEntry[];
}

export interface MakaAheRunResult {
  schemaVersion: typeof MAKA_AHE_RUN_RESULT_SCHEMA_VERSION;
  protocolVersion: MakaAheTargetProtocolVersion;
  runId: string;
  snapshotId: string;
  taskRunId: string;
  taskId: string;
  status: MakaAheResultStatus;
  scoreAuthority: MakaAheScoreAuthority;
  score?: number;
  verifierRef?: MakaAheArtifactRef;
  traceRef?: MakaAheArtifactRef;
  executionLineageRef: MakaAheArtifactRef;
  failureTaxonomy?: readonly string[];
  warnings?: readonly string[];
}

export type MakaAheLegacyRunResult = Omit<
  MakaAheRunResult,
  'schemaVersion' | 'taskRunId' | 'executionLineageRef'
>;

export type MakaAheRunResultDocument = MakaAheRunResult | MakaAheLegacyRunResult;

export interface MakaAheHarnessResults {
  protocolVersion: MakaAheTargetProtocolVersion;
  snapshotId: string;
  runId: string;
  results: readonly MakaAheRunResult[];
  traceIndexRef?: MakaAheArtifactRef;
}

export interface MakaAheEvidenceCase {
  taskId: string;
  runId?: string;
  resultStatus?: MakaAheResultStatus;
  traceRef?: MakaAheArtifactRef;
  summary: string;
}

export interface MakaAheChangeManifest
  extends MakaChangeAuditRecord<
    MakaAheComponentCategory,
    MakaAheEvidenceCase,
    MakaAheEvidenceCase,
    MakaAheEvidenceCase
  > {
  protocolVersion: MakaAheTargetProtocolVersion;
  manifestId: string;
  sourceLabel: MakaAheTargetSourceLabel | string;
  targetSnapshotId: string;
  createdAt: string;
  changedComponents: readonly string[];
  validationDataset: {
    datasetId: string;
    taskIds: readonly string[];
    baselineRunId?: string;
  };
  patch: {
    applyMode: 'staged_patch';
    diffRef?: MakaAheArtifactRef;
    changedFiles?: readonly string[];
  };
  rollbackCriteria: readonly string[];
}

export interface MakaAheChangeEvaluationCell {
  taskId: string;
  baseline?: MakaAheRunResult;
  candidate?: MakaAheRunResult;
  transition: MakaAheTransitionStatus;
}

export interface MakaAheChangeEvaluation {
  protocolVersion: MakaAheTargetProtocolVersion;
  manifestId: string;
  baselineSnapshotId: string;
  candidateSnapshotId: string;
  candidateRunId: string;
  cells: readonly MakaAheChangeEvaluationCell[];
  predictedFixesObserved: readonly string[];
  predictedFixesMissed: readonly string[];
  regressions: readonly string[];
  excludedTaskIds: readonly string[];
  infraFailedTaskIds: readonly string[];
  selfCheckOnlyTaskIds: readonly string[];
}

export interface MakaAheValidationIssue {
  path: string;
  message: string;
}

export type MakaAheValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: MakaAheValidationIssue[] };

export const MAKA_AHE_CURRENT_COMPONENTS: readonly MakaAheTargetComponent[] = [
  {
    id: 'maka-system-prompt',
    category: 'system_prompt',
    label: 'Maka desktop system prompt',
    description:
      'Desktop main-process prompt and workspace context that shape every interactive Maka turn.',
    editable: true,
    sourceRefs: [
      { path: 'apps/desktop/src/main/system-prompt-main.ts' },
      { path: 'packages/runtime/src/system-prompt/session-environment-prompt.ts' },
      { path: 'apps/desktop/src/main/workspace-instructions.ts' },
    ],
  },
  {
    id: 'maka-heavy-task-policy',
    category: 'heavy_task_policy',
    label: 'Heavy-task policy',
    description:
      'Policy text and benchmark wrapper expectations for long-running and evidence-heavy tasks.',
    editable: true,
    sourceRefs: [
      { path: 'packages/headless/src/heavy-task-policy.ts' },
      { path: 'packages/headless/src/heavy-task-progress.ts' },
      { path: 'packages/headless/src/heavy-task-self-check.ts' },
      { path: 'packages/headless/src/heavy-task-finalization.ts' },
      { path: 'packages/headless/src/tools.ts' },
    ],
  },
  {
    id: 'maka-tool-contracts',
    category: 'tool_contract',
    label: 'Tool descriptions and schemas',
    description:
      'Maka tool names, descriptions, input schemas, gating, and selected desktop tool wrappers.',
    editable: true,
    sourceRefs: [
      { path: 'packages/runtime/src/tool-runtime.ts', exportName: 'MakaTool' },
      { path: 'packages/runtime/src/builtin-tools.ts' },
      { path: 'packages/runtime/src/tool-availability.ts' },
      { path: 'apps/desktop/src/main/rive-workflow-tool.ts' },
    ],
  },
  {
    id: 'maka-context-management',
    category: 'context_management_policy',
    label: 'Context budget and compaction',
    description:
      'Runtime context-budget, active tool-result pruning, and semantic compaction behavior.',
    editable: true,
    sourceRefs: [
      { path: 'packages/runtime/src/context-budget.ts' },
      { path: 'packages/runtime/src/active-full-compact.ts' },
      { path: 'packages/runtime/src/semantic-compact.ts' },
      { path: 'packages/runtime/src/context-budget-policy.ts' },
    ],
  },
  {
    id: 'maka-permission-policy',
    category: 'permission_policy',
    label: 'Permission and tool availability policy',
    description:
      'Permission modes, pre-tool-use policy, runtime permission enforcement, and dynamic tool availability.',
    editable: true,
    sourceRefs: [
      { path: 'packages/core/src/permission.ts' },
      { path: 'packages/runtime/src/permission-engine.ts' },
      { path: 'packages/runtime/src/tool-availability.ts' },
    ],
  },
  {
    id: 'maka-runtime-evidence',
    category: 'runtime_evidence',
    label: 'Runtime evidence ledger',
    description:
      'Canonical runtime events, agent-run records, and runner output used as AHE trace evidence.',
    editable: false,
    sourceRefs: [
      { path: 'packages/core/src/runtime-event.ts', exportName: 'RuntimeEvent' },
      { path: 'packages/core/src/agent-run.ts', exportName: 'AgentRunHeader' },
      { path: 'packages/runtime/src/runtime-runner.ts', exportName: 'RuntimeRunner' },
    ],
  },
  {
    id: 'maka-headless-evaluation',
    category: 'headless_evaluation_policy',
    label: 'Headless and benchmark evaluation',
    description:
      'Headless result format, official verifier accounting, and Terminal-Bench smoke runner protocol.',
    editable: true,
    sourceRefs: [
      { path: 'packages/headless/README.md' },
      { path: 'packages/headless/harbor/run-terminal-bench-smoke.mjs' },
      { path: 'packages/headless/harbor/maka_agent.py' },
      { path: 'packages/headless/harbor/maka_trajectory.py' },
    ],
  },
];

export function validateMakaAheTargetComponents(
  value: unknown,
): MakaAheValidationResult<readonly MakaAheTargetComponent[]> {
  const errors: MakaAheValidationIssue[] = [];
  if (!Array.isArray(value)) {
    return invalid('components', 'expected an array');
  }

  const ids = new Set<string>();
  value.forEach((component, index) => {
    const path = `components[${index}]`;
    if (!isRecord(component)) {
      errors.push({ path, message: 'expected an object' });
      return;
    }

    const id = readString(component.id);
    if (!id) {
      errors.push({ path: `${path}.id`, message: 'expected a non-empty string' });
    } else if (ids.has(id)) {
      errors.push({ path: `${path}.id`, message: `duplicate component id "${id}"` });
    } else {
      ids.add(id);
    }

    if (!isOneOf(component.category, MAKA_AHE_COMPONENT_CATEGORIES)) {
      errors.push({ path: `${path}.category`, message: 'expected a known component category' });
    }
    if (!readString(component.label)) {
      errors.push({ path: `${path}.label`, message: 'expected a non-empty string' });
    }
    if (!readString(component.description)) {
      errors.push({ path: `${path}.description`, message: 'expected a non-empty string' });
    }
    if (typeof component.editable !== 'boolean') {
      errors.push({ path: `${path}.editable`, message: 'expected a boolean' });
    }
    validateSourceRefs(component.sourceRefs, `${path}.sourceRefs`, errors);
  });

  return errors.length === 0
    ? { ok: true, value: value as readonly MakaAheTargetComponent[] }
    : { ok: false, errors };
}

export function validateMakaAheTargetSnapshot(
  value: unknown,
): MakaAheValidationResult<MakaAheTargetSnapshotDocument> {
  const errors: MakaAheValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalid('snapshot', 'expected an object');
  }

  if (!isOneOf(value.protocolVersion, MAKA_AHE_SUPPORTED_TARGET_PROTOCOL_VERSIONS)) {
    errors.push({
      path: 'protocolVersion',
      message: `expected one of ${MAKA_AHE_SUPPORTED_TARGET_PROTOCOL_VERSIONS.map((version) => `"${version}"`).join(', ')}`,
    });
  }
  requireNonEmptyString(value.sourceLabel, 'sourceLabel', errors);
  requireNonEmptyString(value.snapshotId, 'snapshotId', errors);
  requireNonEmptyString(value.createdAt, 'createdAt', errors);
  validateGitIdentity(value.git, errors);
  const componentResult = validateMakaAheTargetComponents(value.components);
  if (!componentResult.ok) errors.push(...componentResult.errors);

  if (value.protocolVersion === MAKA_AHE_TARGET_PROTOCOL_VERSION) {
    validateSourceManifest(value.sourceManifest, value.components, errors);
    if (componentResult.ok && isSourceManifest(value.sourceManifest)) {
      const expectedId = makaAheTargetSnapshotId(componentResult.value, value.sourceManifest);
      if (value.snapshotId !== expectedId) {
        errors.push({
          path: 'snapshotId',
          message: `does not match content-addressed target identity "${expectedId}"`,
        });
      }
    }
  } else if (
    value.protocolVersion === MAKA_AHE_TARGET_PROTOCOL_VERSION_V1 &&
    typeof value.sourceManifest !== 'undefined'
  ) {
    errors.push({
      path: 'sourceManifest',
      message: 'legacy v1 snapshots are not content-addressed',
    });
  }

  return errors.length === 0
    ? { ok: true, value: value as unknown as MakaAheTargetSnapshotDocument }
    : { ok: false, errors };
}

export function makaAheSourceManifestDigest(
  entries: readonly MakaAheSourceManifestEntry[],
): string {
  return contentHash({
    algorithm: 'sha256',
    entries: canonicalSourceManifestEntries(entries),
  });
}

export function makaAheTargetSnapshotId(
  components: readonly MakaAheTargetComponent[],
  sourceManifest: Pick<MakaAheSourceManifest, 'algorithm' | 'digest'>,
): string {
  const digest = contentHash({
    protocolVersion: MAKA_AHE_TARGET_PROTOCOL_VERSION,
    components: canonicalTargetComponents(components),
    sourceManifest: {
      algorithm: sourceManifest.algorithm,
      digest: sourceManifest.digest,
    },
  });
  return `maka-ahe-${digest.replace(/^sha256:/, '')}`;
}

export function validateMakaAheExecutionLineage(
  value: unknown,
): MakaAheValidationResult<MakaAheExecutionLineage> {
  const errors: MakaAheValidationIssue[] = [];
  if (!isRecord(value)) return invalid('lineage', 'expected an object');
  if (value.schemaVersion !== MAKA_AHE_EXECUTION_LINEAGE_SCHEMA_VERSION) {
    errors.push({
      path: 'schemaVersion',
      message: `expected "${MAKA_AHE_EXECUTION_LINEAGE_SCHEMA_VERSION}"`,
    });
  }
  if (!isRecord(value.target)) {
    errors.push({ path: 'target', message: 'expected an object' });
  } else {
    requireNonEmptyString(value.target.snapshotId, 'target.snapshotId', errors);
    if (typeof value.target.sourceLabel !== 'undefined') {
      requireNonEmptyString(value.target.sourceLabel, 'target.sourceLabel', errors);
    }
  }
  if (!isRecord(value.task)) {
    errors.push({ path: 'task', message: 'expected an object' });
  } else {
    requireNonEmptyString(value.task.taskRunId, 'task.taskRunId', errors);
    requireNonEmptyString(value.task.taskId, 'task.taskId', errors);
    const taskRef = validateExecutionEvidenceRef({
      schemaVersion: EXECUTION_EVIDENCE_REF_SCHEMA_VERSION,
      task: { taskRunId: value.task.taskRunId },
      ...(typeof value.task.coverage !== 'undefined' ? { taskCoverage: value.task.coverage } : {}),
      ...(isRecord(value.target) ? { target: value.target } : {}),
    });
    if (!taskRef.ok) {
      errors.push(
        ...taskRef.errors.map((issue) => ({ path: `task.${issue.path}`, message: issue.message })),
      );
    }
  }
  if (
    value.rawRuntimeEvents !== 'included' &&
    value.rawRuntimeEvents !== 'omitted_by_policy' &&
    value.rawRuntimeEvents !== 'requested_with_gaps'
  ) {
    errors.push({
      path: 'rawRuntimeEvents',
      message: 'expected "included", "omitted_by_policy", or "requested_with_gaps"',
    });
  }
  if (!Array.isArray(value.attempts)) {
    errors.push({ path: 'attempts', message: 'expected an array' });
  } else {
    const attemptIds = new Set<string>();
    value.attempts.forEach((attempt, attemptIndex) => {
      const path = `attempts[${attemptIndex}]`;
      if (!isRecord(attempt)) {
        errors.push({ path, message: 'expected an object' });
        return;
      }
      const attemptId = readString(attempt.attemptId);
      if (!attemptId)
        errors.push({ path: `${path}.attemptId`, message: 'expected a non-empty string' });
      else if (attemptIds.has(attemptId))
        errors.push({ path: `${path}.attemptId`, message: `duplicate attempt id "${attemptId}"` });
      else attemptIds.add(attemptId);
      requireNonEmptyString(attempt.status, `${path}.status`, errors);
      validateLineageGaps(attempt.gaps, `${path}.gaps`, errors);
      if (!Array.isArray(attempt.executions)) {
        errors.push({ path: `${path}.executions`, message: 'expected an array' });
        return;
      }
      attempt.executions.forEach((execution, executionIndex) => {
        const executionPath = `${path}.executions[${executionIndex}]`;
        if (!isRecord(execution)) {
          errors.push({ path: executionPath, message: 'expected an object' });
          return;
        }
        const validation = validateExecutionEvidenceRef(execution.evidence);
        if (!validation.ok) {
          errors.push(
            ...validation.errors.map((issue) => ({
              path: `${executionPath}.evidence.${issue.path}`,
              message: issue.message,
            })),
          );
        } else {
          if (isRecord(value.task) && validation.value.task?.taskRunId !== value.task.taskRunId) {
            errors.push({
              path: `${executionPath}.evidence.task.taskRunId`,
              message: 'expected owning taskRunId',
            });
          }
          if (attemptId && validation.value.task?.attemptId !== attemptId) {
            errors.push({
              path: `${executionPath}.evidence.task.attemptId`,
              message: 'expected owning attemptId',
            });
          }
          if (
            isRecord(value.target) &&
            validation.value.target?.snapshotId !== value.target.snapshotId
          ) {
            errors.push({
              path: `${executionPath}.evidence.target.snapshotId`,
              message: 'expected owning target snapshotId',
            });
          }
        }
        if (typeof execution.inspectRef !== 'undefined')
          validateArtifactRef(execution.inspectRef, `${executionPath}.inspectRef`, errors);
        if (typeof execution.runtimeEventsRef !== 'undefined')
          validateArtifactRef(
            execution.runtimeEventsRef,
            `${executionPath}.runtimeEventsRef`,
            errors,
          );
        validateLineageGaps(execution.gaps, `${executionPath}.gaps`, errors);
      });
    });
  }
  validateLineageGaps(value.gaps, 'gaps', errors);
  return errors.length === 0
    ? { ok: true, value: value as unknown as MakaAheExecutionLineage }
    : { ok: false, errors };
}

export function validateMakaAheChangeManifest(
  value: unknown,
  components: readonly MakaAheTargetComponent[] = MAKA_AHE_CURRENT_COMPONENTS,
): MakaAheValidationResult<MakaAheChangeManifest> {
  const errors: MakaAheValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalid('manifest', 'expected an object');
  }

  requireProtocol(value.protocolVersion, 'protocolVersion', errors);
  requireNonEmptyString(value.manifestId, 'manifestId', errors);
  requireNonEmptyString(value.sourceLabel, 'sourceLabel', errors);
  requireNonEmptyString(value.targetSnapshotId, 'targetSnapshotId', errors);
  requireNonEmptyString(value.createdAt, 'createdAt', errors);
  if (!isOneOf(value.editedSurface, MAKA_AHE_COMPONENT_CATEGORIES)) {
    errors.push({ path: 'editedSurface', message: 'expected a known component category' });
  }
  requireNonEmptyString(value.hypothesis, 'hypothesis', errors);
  requireNonEmptyString(value.targetedFix, 'targetedFix', errors);
  if (typeof value.failurePattern !== 'undefined') {
    requireNonEmptyString(value.failurePattern, 'failurePattern', errors);
  }

  const componentIds = new Set(components.map((component) => component.id));
  validateStringArray(value.changedComponents, 'changedComponents', errors, {
    minItems: 1,
    allowedValues: componentIds,
  });
  const changedComponentIds = stringArray(value.changedComponents);
  const changedComponents = components.filter((component) =>
    changedComponentIds.includes(component.id),
  );
  if (
    isOneOf(value.editedSurface, MAKA_AHE_COMPONENT_CATEGORIES) &&
    changedComponents.some((component) => component.category !== value.editedSurface)
  ) {
    errors.push({
      path: 'editedSurface',
      message: 'expected every changed component to match the declared surface',
    });
  }
  for (const componentId of changedComponentIds) {
    const component = components.find((candidate) => candidate.id === componentId);
    if (component && !component.editable) {
      errors.push({
        path: 'changedComponents',
        message: `component "${componentId}" is evidence-only and cannot be patched`,
      });
    }
  }
  validateEvidenceCases(value.evidenceRefs, 'evidenceRefs', errors, { minItems: 1 });
  validateEvidenceCases(value.predictedFixes, 'predictedFixes', errors, { minItems: 1 });
  validateEvidenceCases(value.riskTasks, 'riskTasks', errors, { minItems: 1 });
  validateValidationDataset(value.validationDataset, errors);
  validatePatch(value.patch, errors, changedComponents);
  validateStringArray(value.rollbackCriteria, 'rollbackCriteria', errors, { minItems: 1 });

  return errors.length === 0
    ? { ok: true, value: value as unknown as MakaAheChangeManifest }
    : { ok: false, errors };
}

export function validateMakaAheRunResult(
  value: unknown,
): MakaAheValidationResult<MakaAheRunResultDocument> {
  const errors: MakaAheValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalid('result', 'expected an object');
  }

  requireProtocol(value.protocolVersion, 'protocolVersion', errors);
  requireNonEmptyString(value.runId, 'runId', errors);
  requireNonEmptyString(value.snapshotId, 'snapshotId', errors);
  requireNonEmptyString(value.taskId, 'taskId', errors);

  if (typeof value.schemaVersion !== 'undefined') {
    if (value.schemaVersion !== MAKA_AHE_RUN_RESULT_SCHEMA_VERSION) {
      errors.push({
        path: 'schemaVersion',
        message: `expected "${MAKA_AHE_RUN_RESULT_SCHEMA_VERSION}"`,
      });
    }
    requireNonEmptyString(value.taskRunId, 'taskRunId', errors);
    validateArtifactRef(value.executionLineageRef, 'executionLineageRef', errors);
  }

  if (!isOneOf(value.status, MAKA_AHE_RESULT_STATUSES)) {
    errors.push({ path: 'status', message: 'expected a known result status' });
  }
  if (!isOneOf(value.scoreAuthority, MAKA_AHE_SCORE_AUTHORITIES)) {
    errors.push({ path: 'scoreAuthority', message: 'expected a known score authority' });
  }
  if (
    (value.status === 'official_pass' || value.status === 'official_fail') &&
    value.scoreAuthority !== 'official_verifier' &&
    value.scoreAuthority !== 'official_scorer'
  ) {
    errors.push({
      path: 'status',
      message: 'official pass/fail requires scoreAuthority official_verifier or official_scorer',
    });
  }
  if (typeof value.score !== 'undefined' && typeof value.score !== 'number') {
    errors.push({ path: 'score', message: 'expected a number when present' });
  }

  for (const [field, ref] of [
    ['verifierRef', value.verifierRef],
    ['traceRef', value.traceRef],
  ] as const) {
    if (typeof ref !== 'undefined') validateArtifactRef(ref, field, errors);
  }

  return errors.length === 0
    ? { ok: true, value: value as unknown as MakaAheRunResultDocument }
    : { ok: false, errors };
}

function validateSourceRefs(value: unknown, path: string, errors: MakaAheValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path, message: 'expected at least one source ref' });
    return;
  }
  const identities = new Set<string>();
  value.forEach((sourceRef, index) => {
    const sourcePath = `${path}[${index}]`;
    if (!isRecord(sourceRef)) {
      errors.push({ path: sourcePath, message: 'expected an object' });
      return;
    }
    requireNonEmptyString(sourceRef.path, `${sourcePath}.path`, errors);
    if (typeof sourceRef.exportName !== 'undefined' && !readString(sourceRef.exportName)) {
      errors.push({
        path: `${sourcePath}.exportName`,
        message: 'expected a non-empty string when present',
      });
    }
    if (typeof sourceRef.description !== 'undefined' && !readString(sourceRef.description)) {
      errors.push({
        path: `${sourcePath}.description`,
        message: 'expected a non-empty string when present',
      });
    }
    if (readString(sourceRef.path)) {
      const identity = `${sourceRef.path}\u0000${readString(sourceRef.exportName) ?? ''}`;
      if (identities.has(identity)) {
        errors.push({ path: sourcePath, message: 'duplicate source ref path/exportName identity' });
      }
      identities.add(identity);
    }
  });
}

function validateSourceManifest(
  value: unknown,
  components: unknown,
  errors: MakaAheValidationIssue[],
): void {
  if (!isRecord(value)) {
    errors.push({ path: 'sourceManifest', message: 'expected an object for v2 snapshots' });
    return;
  }
  if (value.algorithm !== 'sha256') {
    errors.push({ path: 'sourceManifest.algorithm', message: 'expected "sha256"' });
  }
  requireSha256(value.digest, 'sourceManifest.digest', errors);
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    errors.push({
      path: 'sourceManifest.entries',
      message: 'expected at least one source manifest entry',
    });
    return;
  }

  const identities = new Set<string>();
  value.entries.forEach((entry, index) => {
    const path = `sourceManifest.entries[${index}]`;
    if (!isRecord(entry)) {
      errors.push({ path, message: 'expected an object' });
      return;
    }
    requireNonEmptyString(entry.componentId, `${path}.componentId`, errors);
    requireNonEmptyString(entry.path, `${path}.path`, errors);
    if (typeof entry.exportName !== 'undefined' && !readString(entry.exportName)) {
      errors.push({
        path: `${path}.exportName`,
        message: 'expected a non-empty string when present',
      });
    }
    requireSha256(entry.digest, `${path}.digest`, errors);
    if (
      typeof entry.sizeBytes !== 'number' ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0
    ) {
      errors.push({ path: `${path}.sizeBytes`, message: 'expected a non-negative safe integer' });
    }
    const identity = sourceManifestEntryIdentity(entry);
    if (identity && identities.has(identity)) {
      errors.push({ path, message: 'duplicate componentId/path/exportName identity' });
    }
    if (identity) identities.add(identity);
  });

  if (isSourceManifest(value)) {
    const expectedDigest = makaAheSourceManifestDigest(value.entries);
    if (value.digest !== expectedDigest) {
      errors.push({
        path: 'sourceManifest.digest',
        message: `does not match manifest entries "${expectedDigest}"`,
      });
    }
  }

  if (Array.isArray(components)) {
    const expected = components
      .flatMap((component) => {
        if (
          !isRecord(component) ||
          !readString(component.id) ||
          !Array.isArray(component.sourceRefs)
        )
          return [];
        return component.sourceRefs.flatMap((sourceRef) => {
          if (!isRecord(sourceRef) || !readString(sourceRef.path)) return [];
          return [
            `${component.id}\u0000${sourceRef.path}\u0000${readString(sourceRef.exportName) ?? ''}`,
          ];
        });
      })
      .sort();
    const actual = [...identities].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push({
        path: 'sourceManifest.entries',
        message: 'entries must exactly cover component source refs',
      });
    }
  }
}

function validateGitIdentity(value: unknown, errors: MakaAheValidationIssue[]): void {
  if (typeof value === 'undefined') return;
  if (!isRecord(value)) {
    errors.push({ path: 'git', message: 'expected an object when present' });
    return;
  }
  requireNonEmptyString(value.repository, 'git.repository', errors);
  for (const field of ['ref', 'commit'] as const) {
    if (typeof value[field] !== 'undefined' && !readString(value[field])) {
      errors.push({ path: `git.${field}`, message: 'expected a non-empty string when present' });
    }
  }
  if (typeof value.dirty !== 'undefined' && typeof value.dirty !== 'boolean') {
    errors.push({ path: 'git.dirty', message: 'expected a boolean when present' });
  }
}

function validateArtifactRef(value: unknown, path: string, errors: MakaAheValidationIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path, message: 'expected an artifact ref object' });
    return;
  }
  if (!['file', 'directory', 'url', 'blob', 'other'].includes(String(value.kind))) {
    errors.push({ path: `${path}.kind`, message: 'expected a known artifact ref kind' });
  }
  requireNonEmptyString(value.ref, `${path}.ref`, errors);
  if (typeof value.mediaType !== 'undefined')
    requireNonEmptyString(value.mediaType, `${path}.mediaType`, errors);
  if (typeof value.description !== 'undefined')
    requireNonEmptyString(value.description, `${path}.description`, errors);
  if (typeof value.digest !== 'undefined') requireSha256(value.digest, `${path}.digest`, errors);
  if (
    typeof value.sizeBytes !== 'undefined' &&
    (typeof value.sizeBytes !== 'number' ||
      !Number.isSafeInteger(value.sizeBytes) ||
      value.sizeBytes < 0)
  ) {
    errors.push({
      path: `${path}.sizeBytes`,
      message: 'expected a non-negative safe integer when present',
    });
  }
}

function validateLineageGaps(value: unknown, path: string, errors: MakaAheValidationIssue[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'expected an array' });
    return;
  }
  const allowed = new Set([
    'attempt_execution_missing',
    'execution_identity_missing',
    'runtime_coverage_missing',
    'agent_run_inspect_missing',
    'runtime_events_missing',
    'runtime_coverage_mismatch',
  ]);
  value.forEach((gap, index) => {
    const gapPath = `${path}[${index}]`;
    if (!isRecord(gap)) {
      errors.push({ path: gapPath, message: 'expected an object' });
      return;
    }
    if (!allowed.has(String(gap.code)))
      errors.push({ path: `${gapPath}.code`, message: 'expected a known lineage gap code' });
    requireNonEmptyString(gap.message, `${gapPath}.message`, errors);
  });
}

function validateEvidenceCases(
  value: unknown,
  path: string,
  errors: MakaAheValidationIssue[],
  options: { minItems: number },
): void {
  if (!Array.isArray(value) || value.length < options.minItems) {
    errors.push({ path, message: `expected at least ${options.minItems} evidence case(s)` });
    return;
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      errors.push({ path: itemPath, message: 'expected an object' });
      return;
    }
    requireNonEmptyString(item.taskId, `${itemPath}.taskId`, errors);
    requireNonEmptyString(item.summary, `${itemPath}.summary`, errors);
    if (
      typeof item.resultStatus !== 'undefined' &&
      !isOneOf(item.resultStatus, MAKA_AHE_RESULT_STATUSES)
    ) {
      errors.push({ path: `${itemPath}.resultStatus`, message: 'expected a known result status' });
    }
  });
}

function validateValidationDataset(value: unknown, errors: MakaAheValidationIssue[]): void {
  if (!isRecord(value)) {
    errors.push({ path: 'validationDataset', message: 'expected an object' });
    return;
  }
  requireNonEmptyString(value.datasetId, 'validationDataset.datasetId', errors);
  validateStringArray(value.taskIds, 'validationDataset.taskIds', errors, { minItems: 1 });
}

function validatePatch(
  value: unknown,
  errors: MakaAheValidationIssue[],
  changedComponents: readonly MakaAheTargetComponent[],
): void {
  if (!isRecord(value)) {
    errors.push({ path: 'patch', message: 'expected an object' });
    return;
  }
  if (value.applyMode !== 'staged_patch') {
    errors.push({ path: 'patch.applyMode', message: 'expected "staged_patch"' });
  }
  if (typeof value.changedFiles !== 'undefined') {
    validateStringArray(value.changedFiles, 'patch.changedFiles', errors, { minItems: 1 });
    const allowedFiles = new Set(
      changedComponents
        .filter((component) => component.editable)
        .flatMap((component) => component.sourceRefs.map((sourceRef) => sourceRef.path)),
    );
    for (const [index, changedFile] of stringArray(value.changedFiles).entries()) {
      const path = `patch.changedFiles[${index}]`;
      const safetyIssue = unsafePatchPathReason(changedFile);
      if (safetyIssue) {
        errors.push({ path, message: safetyIssue });
        continue;
      }
      if (!allowedFiles.has(changedFile)) {
        errors.push({
          path,
          message: `changed file "${changedFile}" is not a source ref of an editable changed component`,
        });
      }
    }
  }
}

function unsafePatchPathReason(path: string): string | undefined {
  if (path.startsWith('/') || path.includes('\\')) {
    return 'patch paths must be repo-relative POSIX paths';
  }
  if (path === '.' || path === '..' || path.includes('../') || path.includes('/..')) {
    return 'patch paths must not traverse outside the repo';
  }
  if (FORBIDDEN_PATCH_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return 'patch path targets generated, dependency, or repository-control content';
  }
  if (FORBIDDEN_PATCH_PATH_PARTS.some((part) => path.includes(part))) {
    return 'patch path contains generated, dependency, or repository-control content';
  }
  return undefined;
}

function validateStringArray(
  value: unknown,
  path: string,
  errors: MakaAheValidationIssue[],
  options: { minItems: number; allowedValues?: ReadonlySet<string> },
): void {
  if (!Array.isArray(value) || value.length < options.minItems) {
    errors.push({ path, message: `expected at least ${options.minItems} string item(s)` });
    return;
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!readString(item)) {
      errors.push({ path: itemPath, message: 'expected a non-empty string' });
      return;
    }
    if (options.allowedValues && !options.allowedValues.has(item)) {
      errors.push({ path: itemPath, message: `unknown value "${item}"` });
    }
  });
}

function requireProtocol(value: unknown, path: string, errors: MakaAheValidationIssue[]): void {
  if (!isOneOf(value, MAKA_AHE_SUPPORTED_TARGET_PROTOCOL_VERSIONS)) {
    errors.push({
      path,
      message: `expected one of ${MAKA_AHE_SUPPORTED_TARGET_PROTOCOL_VERSIONS.map((version) => `"${version}"`).join(', ')}`,
    });
  }
}

function requireSha256(value: unknown, path: string, errors: MakaAheValidationIssue[]): void {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    errors.push({ path, message: 'expected a sha256:<64 lowercase hex characters> digest' });
  }
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  errors: MakaAheValidationIssue[],
): void {
  if (!readString(value)) {
    errors.push({ path, message: 'expected a non-empty string' });
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && allowed.includes(value);
}

function isSourceManifest(value: unknown): value is MakaAheSourceManifest {
  return (
    isRecord(value) &&
    value.algorithm === 'sha256' &&
    typeof value.digest === 'string' &&
    Array.isArray(value.entries) &&
    value.entries.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.componentId === 'string' &&
        typeof entry.path === 'string' &&
        (typeof entry.exportName === 'undefined' || typeof entry.exportName === 'string') &&
        typeof entry.digest === 'string' &&
        typeof entry.sizeBytes === 'number',
    )
  );
}

function sourceManifestEntryIdentity(value: Record<string, unknown>): string | undefined {
  const componentId = readString(value.componentId);
  const path = readString(value.path);
  if (!componentId || !path) return undefined;
  return `${componentId}\u0000${path}\u0000${readString(value.exportName) ?? ''}`;
}

function canonicalSourceManifestEntries(
  entries: readonly MakaAheSourceManifestEntry[],
): Array<Record<string, unknown>> {
  return [...entries]
    .sort(
      (a, b) =>
        a.componentId.localeCompare(b.componentId) ||
        a.path.localeCompare(b.path) ||
        (a.exportName ?? '').localeCompare(b.exportName ?? ''),
    )
    .map((entry) => ({
      componentId: entry.componentId,
      path: entry.path,
      ...(entry.exportName ? { exportName: entry.exportName } : {}),
      digest: entry.digest,
      sizeBytes: entry.sizeBytes,
    }));
}

function canonicalTargetComponents(
  components: readonly MakaAheTargetComponent[],
): Array<Record<string, unknown>> {
  return [...components]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((component) => ({
      id: component.id,
      category: component.category,
      label: component.label,
      description: component.description,
      editable: component.editable,
      sourceRefs: [...component.sourceRefs]
        .sort(
          (a, b) =>
            a.path.localeCompare(b.path) || (a.exportName ?? '').localeCompare(b.exportName ?? ''),
        )
        .map((sourceRef) => ({
          path: sourceRef.path,
          ...(sourceRef.exportName ? { exportName: sourceRef.exportName } : {}),
          ...(sourceRef.description ? { description: sourceRef.description } : {}),
        })),
    }));
}

function contentHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function invalid(path: string, message: string): MakaAheValidationResult<never> {
  return { ok: false, errors: [{ path, message }] };
}
