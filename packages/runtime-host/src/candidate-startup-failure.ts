/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

export type CandidateStartupFailureReason =
  | 'stored_data_incompatible'
  | 'operational_state_migration_blocked'
  | 'local_ipc_security_failed'
  | 'internal_startup_failure';

export interface CandidateStartupFailure {
  readonly reason: CandidateStartupFailureReason;
}

export interface CandidateStartupFailureReport extends CandidateStartupFailure {
  readonly startupAttemptId: string;
}

const STARTUP_ATTEMPT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const EXIT_CODE_BY_REASON: Readonly<Record<CandidateStartupFailureReason, number>> = {
  stored_data_incompatible: 65,
  operational_state_migration_blocked: 78,
  local_ipc_security_failed: 77,
  internal_startup_failure: 70,
};

export function classifyCandidateStartupFailure(error: unknown): CandidateStartupFailure {
  const errors = primaryErrorChain(error);
  if (errors.some((candidate) => errorCode(candidate) === 'stored_session_message_incompatible')) {
    return { reason: 'stored_data_incompatible' };
  }
  if (errors.some((candidate) => errorCode(candidate) === 'operational_state_migration_blocked')) {
    return { reason: 'operational_state_migration_blocked' };
  }
  if (errors.some((candidate) => errorCode(candidate) === 'insecure_endpoint_directory')) {
    return { reason: 'local_ipc_security_failed' };
  }
  return { reason: 'internal_startup_failure' };
}

export function isPermanentCandidateStartupFailure(
  failure: CandidateStartupFailure | undefined,
): failure is CandidateStartupFailure & {
  readonly reason: 'stored_data_incompatible' | 'operational_state_migration_blocked';
} {
  return (
    failure?.reason === 'stored_data_incompatible' ||
    failure?.reason === 'operational_state_migration_blocked'
  );
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

export function isCandidateStartupAttemptId(value: unknown): value is string {
  return typeof value === 'string' && STARTUP_ATTEMPT_ID_PATTERN.test(value);
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
