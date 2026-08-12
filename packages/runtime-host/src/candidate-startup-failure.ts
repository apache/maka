export type CandidateStartupFailureReason = 'stored_data_incompatible' | 'internal_startup_failure';

export interface CandidateStartupFailure {
  readonly reason: CandidateStartupFailureReason;
}

const EXIT_CODE_BY_REASON: Readonly<Record<CandidateStartupFailureReason, number>> = {
  stored_data_incompatible: 65,
  internal_startup_failure: 70,
};

export function classifyCandidateStartupFailure(error: unknown): CandidateStartupFailure {
  const errors = primaryErrorChain(error);
  if (errors.some((candidate) => errorCode(candidate) === 'stored_session_message_incompatible')) {
    return { reason: 'stored_data_incompatible' };
  }
  return { reason: 'internal_startup_failure' };
}

export function candidateStartupFailureExitCode(failure: CandidateStartupFailure): number {
  return EXIT_CODE_BY_REASON[failure.reason];
}

export function candidateStartupFailureForExitCode(
  exitCode: number | null,
): CandidateStartupFailure | undefined {
  for (const [reason, code] of Object.entries(EXIT_CODE_BY_REASON)) {
    if (exitCode === code) return { reason: reason as CandidateStartupFailureReason };
  }
  return undefined;
}

function primaryErrorChain(root: unknown): unknown[] {
  const chain: unknown[] = [];
  const visited = new Set<object>();
  let value: unknown = root;
  while (true) {
    chain.push(value);
    if (typeof value !== 'object' || value === null || visited.has(value)) break;
    visited.add(value);
    const cause = 'cause' in value ? (value as { cause?: unknown }).cause : undefined;
    if (cause !== undefined) {
      value = cause;
      continue;
    }
    if (value instanceof AggregateError && value.errors.length > 0) {
      [value] = value.errors;
      continue;
    }
    break;
  }
  return chain;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}
