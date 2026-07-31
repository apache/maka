import type { Config } from './contracts.js';
import type {
  AbArmSummary,
  AbArmSpec,
  AbAttemptPairSummary,
  AbComparisonSummary,
  AbDecision,
  AbRunManifest,
  AbTaskArmSummary,
  AbTaskComparison,
  AbTaskLevelSummary,
} from './ab-types.js';
import type { FixedPromptTask, TaskRunner } from './fixed-prompt-controller.js';
import type { FixedPromptTaskWalEvent } from './fixed-prompt-wal-types.js';

export interface SummarizePromptAbComparisonInput {
  runId: string;
  roundId: string;
  baselinePromptId: string;
  candidatePromptId: string;
  evaluationTaskIds: readonly string[];
  baselineRuns: readonly (readonly FixedPromptTaskWalEvent[])[];
  candidateRuns: readonly (readonly FixedPromptTaskWalEvent[])[];
  budgetMs?: number;
  nonInferiorityMargin?: number;
}

export interface RunPromptAbComparisonInput {
  runId: string;
  config: Config;
  baselinePromptPath: string;
  candidatePromptPath: string;
  candidatePromptId?: string;
  resultsJsonlPath: string;
  evaluationTasks: readonly FixedPromptTask[];
  reps?: number;
  maxConcurrency?: number;
  resumeFingerprint?: string;
  budgetMs?: number;
  nonInferiorityMargin?: number;
  harborRunner: TaskRunner;
  now?: () => number;
  newId?: () => string;
}

export type PromptAbDecision = AbDecision;

export type PromptAbArmSummary = AbArmSummary;
export type PromptAbTaskArmSummary = AbTaskArmSummary;
export type PromptAbTaskComparison = AbTaskComparison;
export type PromptAbTaskLevelSummary = AbTaskLevelSummary;
export type PromptAbAttemptPairSummary = AbAttemptPairSummary;

export interface PromptAbComparisonSummary extends AbComparisonSummary {
  baselinePromptId: string;
  candidatePromptId: string;
}

export interface PromptAbMetadataFilterInput {
  tasks: readonly FixedPromptTask[];
  maxExpertTimeEstimateMin?: number;
}

export interface PromptAbMetadataFilterResult {
  maxExpertTimeEstimateMin: number;
  candidateTaskCount: number;
  selectedTaskIds: string[];
  selectedTasks: FixedPromptTask[];
  rejected: {
    longExpertEstimateTaskIds: string[];
    missingExpertEstimateTaskIds: string[];
  };
}

export interface PromptAbCandidateTaskLimitResult {
  limit: number | null;
  inputTaskCount: number;
  selectedTaskIds: string[];
  selectedTasks: FixedPromptTask[];
  truncatedTaskIds: string[];
}

export interface PromptAbRunManifestInput {
  baselinePromptHash: string;
  candidatePromptHash: string;
  provider: string;
  baseUrl: string;
  model: string;
  taskBudgetSec: number;
  harborTimeoutMs: number;
  subjectFingerprint: string;
  taskSourceFingerprint: string;
  toolchainFingerprint: string;
  evaluationTaskIds: readonly string[];
  reps: number;
  candidateLimit: number | null;
  maxConcurrency: number;
  selectionMode?: 'explicit' | 'metadata';
  candidateTaskIds?: readonly string[];
  maxExpertTimeEstimateMin?: number | null;
  targetEvaluationTaskCount?: number | null;
  nonInferiorityMargin?: number;
}

export type PromptAbRunManifest = PromptAbRunManifestInput &
  Omit<AbRunManifest, 'schemaVersion' | 'arms'> & {
    schemaVersion: 'maka.prompt_ab.run_manifest.v1';
    fingerprint: string;
    experimentKind: 'prompt';
    arms: [AbArmSpec, AbArmSpec];
    evaluationTaskIds: string[];
    candidateTaskIds?: string[];
  };
