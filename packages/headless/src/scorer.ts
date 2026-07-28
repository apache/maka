import type { Config, SubmittedSnapshot, Task } from './contracts.js';
import type { AutonomousResultTaxonomy, VerifierResult } from './task-contracts.js';

export interface FinalScorerInput {
  config: Config;
  task: Task;
  runnerCompleted: boolean;
  runnerStatus: 'completed' | 'failed';
  invocationFailure?: { class?: string; message?: string };
  submittedSnapshot: SubmittedSnapshot;
  verifierResult?: VerifierResult;
}

export interface FinalScore {
  passed: boolean;
  scored: boolean;
  eligible: boolean;
  taxonomy: AutonomousResultTaxonomy;
  errorClass?: string;
  excludedReason?: string;
  score?: number;
  maxScore?: number;
  details?: Record<string, unknown>;
}

export type FinalScorer = (input: FinalScorerInput) => FinalScore;

export const defaultFinalScorer: FinalScorer = (input) => {
  const verifier = input.verifierResult;

  if (verifier?.errorClass === 'unsupported_adapter') {
    return {
      passed: false,
      scored: false,
      eligible: false,
      taxonomy: 'unsupported_adapter',
      errorClass: 'unsupported_adapter',
      excludedReason: verifier.error ?? 'unsupported verifier adapter',
    };
  }

  if (!input.runnerCompleted) {
    const taxonomy = taxonomyFromFailureClass(input.invocationFailure?.class);
    return {
      passed: false,
      scored: false,
      eligible: true,
      taxonomy,
      errorClass: input.invocationFailure?.class ?? taxonomy,
      details: input.invocationFailure?.message
        ? { failureMessage: input.invocationFailure.message }
        : undefined,
    };
  }

  if (verifier && verifier.kind !== 'command' && verifier.authority?.authoritative === false) {
    return {
      passed: false,
      scored: false,
      eligible: true,
      taxonomy: 'verification_failed',
      errorClass: 'non_authoritative_verifier',
      excludedReason: 'official benchmark verifier result is missing',
      details: {
        verifierAuthority: verifier.authority,
        ...(verifier.details?.verificationPlaceholder === true
          ? { verificationPlaceholder: true }
          : {}),
      },
    };
  }

  if (!verifier) {
    return {
      passed: false,
      scored: false,
      eligible: true,
      taxonomy: 'verification_error',
      errorClass: 'verification_error',
    };
  }

  if (verifier.errorClass === 'verification_error' || verifier.exitCode === null) {
    return {
      passed: false,
      scored: false,
      eligible: true,
      taxonomy: 'verification_error',
      errorClass: 'verification_error',
      details: verifier.error ? { verifierError: verifier.error } : undefined,
    };
  }

  return {
    passed: verifier.passed,
    scored: true,
    eligible: true,
    taxonomy: verifier.passed ? 'passed' : 'verification_failed',
    ...(verifier.score !== undefined ? { score: verifier.score } : {}),
    ...(verifier.maxScore !== undefined ? { maxScore: verifier.maxScore } : {}),
    ...(verifier.details ? { details: { benchmark: verifier.details } } : {}),
    ...(verifier.passed ? {} : { errorClass: 'verification_failed' }),
  };
};

function taxonomyFromFailureClass(errorClass: string | undefined): AutonomousResultTaxonomy {
  const normalized = errorClass?.toLowerCase() ?? '';
  if (normalized.includes('cancel')) return 'cancelled';
  if (normalized.includes('abort')) return 'aborted';
  if (
    normalized.includes('budget') ||
    normalized.includes('limit') ||
    normalized.includes('max_tokens')
  )
    return 'budget_exhausted';
  if (normalized.includes('blocked')) return 'blocked';
  if (
    normalized.includes('policy') ||
    normalized.includes('permission') ||
    normalized.includes('denied') ||
    normalized.includes('requires_bypass') ||
    normalized.includes('sandbox_boundary_required')
  )
    return 'policy_denied';
  if (
    normalized.includes('incomplete') ||
    normalized.includes('tool_calls') ||
    normalized.includes('tool_step_cap') ||
    normalized.includes('truncated')
  )
    return 'agent_incomplete';
  if (normalized.includes('infra')) return 'infra_failed';
  return 'agent_failed';
}
