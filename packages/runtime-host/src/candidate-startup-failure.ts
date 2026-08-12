export type CandidateStartupFailureReason =
  | 'stored_data_incompatible'
  | 'migration_blocked'
  | 'storage_unavailable'
  | 'internal_startup_failure';

export interface CandidateStartupFailure {
  readonly reason: CandidateStartupFailureReason;
}

const EXIT_CODE_BY_REASON: Readonly<Record<CandidateStartupFailureReason, number>> = {
  stored_data_incompatible: 65,
  internal_startup_failure: 70,
  storage_unavailable: 74,
  migration_blocked: 78,
};

export function classifyCandidateStartupFailure(error: unknown): CandidateStartupFailure {
  const errors = errorGraph(error);
  if (errors.some((candidate) => errorCode(candidate) === 'stored_session_message_incompatible')) {
    return { reason: 'stored_data_incompatible' };
  }
  if (errors.some((candidate) => errorCode(candidate) === 'operational_state_migration_blocked')) {
    return { reason: 'migration_blocked' };
  }
  if (errors.some(isSqliteStorageUnavailable)) return { reason: 'storage_unavailable' };
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

function errorGraph(root: unknown): unknown[] {
  const discovered: unknown[] = [];
  const pending = [root];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    discovered.push(value);
    if (typeof value !== 'object' || value === null || visited.has(value)) continue;
    visited.add(value);
    if ('cause' in value) pending.push((value as { cause?: unknown }).cause);
    if (value instanceof AggregateError) pending.push(...value.errors);
  }
  return discovered;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function isSqliteStorageUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' && [7, 8, 10, 13, 14].includes(errcode & 0xff);
}
