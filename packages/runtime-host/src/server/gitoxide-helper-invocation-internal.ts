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

import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { terminateChildProcessTree } from '@maka/runtime/process-tree-terminator';
import {
  type GitoxideHelperInvocationCapability,
  verifyGitoxideHelperArtifactForInvocationInternal,
} from './gitoxide-helper-artifact-authority-internal.js';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
export const GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL = Object.freeze({
  inspectRepositoryMs: 5_000,
  importSourceHeadMs: 10 * 60_000,
});
const SHA1_OID_PATTERN = /^[0-9a-f]{40}$/;
const MAKA_REF_PATTERN = /^refs\/maka\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
export const GITOXIDE_HELPER_ERROR_REASONS_V1 = Object.freeze([
  'internal_error_reason_invalid',
  'request_read_failed',
  'request_too_large',
  'invalid_request',
  'unsupported_protocol_version',
  'repository_open_failed',
  'head_commit_unavailable',
  'head_commit_identity_mismatch',
  'head_tree_unavailable',
  'commit_object_limit_exceeded',
  'baseline_commit_write_failed',
  'baseline_publish_failed',
  'baseline_ref_outside_maka_namespace',
  'invalid_baseline_ref',
  'import_destination_create_failed',
  'import_destination_not_fresh',
  'import_destination_object_format_mismatch',
  'import_destination_parent_untrusted',
  'import_destination_unreadable',
  'import_hooks_cleanup_failed',
  'invalid_source_head_commit_oid',
  'source_blob_copy_failed',
  'source_blob_identity_mismatch',
  'source_blob_invalid',
  'source_blob_unavailable',
  'source_byte_limit_exceeded',
  'source_file_limit_exceeded',
  'source_folded_path_byte_limit_exceeded',
  'source_folded_path_length_exceeded',
  'source_head_commit_mismatch',
  'source_head_commit_identity_mismatch',
  'source_head_commit_unavailable',
  'source_head_tree_unavailable',
  'source_path_collision',
  'source_path_byte_limit_exceeded',
  'source_path_length_exceeded',
  'source_tree_copy_failed',
  'source_tree_depth_exceeded',
  'source_tree_entry_limit_exceeded',
  'source_tree_identity_mismatch',
  'source_tree_invalid',
  'source_tree_object_byte_limit_exceeded',
  'source_tree_object_limit_exceeded',
  'source_tree_noncanonical_mode',
  'source_tree_not_sorted',
  'source_tree_observation_mismatch',
  'source_tree_unavailable',
  'source_tree_visit_limit_exceeded',
  'unsupported_source_entry_kind',
  'unsupported_source_path',
  'unsupported_object_format',
  'unsupported_managed_tree_policy',
] as const);
const HELPER_ERROR_REASONS = new Set<string>(GITOXIDE_HELPER_ERROR_REASONS_V1);

export interface GitoxideRepositoryObservationV1 {
  readonly kind: 'repository_inspected';
  readonly protocolVersion: 1;
  readonly objectFormat: 'sha1';
  readonly headCommitOid: string;
  readonly headTreeOid: string;
}

export interface GitoxideRepositoryRejectionV1 {
  readonly kind: 'repository_rejected';
  readonly protocolVersion: 1;
  readonly reason: 'unsupported_object_format';
  readonly objectFormat: 'sha256' | 'unknown';
  readonly supportedObjectFormats: readonly ['sha1'];
}

export type GitoxideRepositoryInspectionResultV1 =
  | GitoxideRepositoryObservationV1
  | GitoxideRepositoryRejectionV1;

export interface GitoxideSourceImportObservationV1 {
  readonly kind: 'source_imported';
  readonly protocolVersion: 1;
  readonly objectFormat: 'sha1';
  readonly sourceHeadCommitOid: string;
  readonly sourceTreeOid: string;
  readonly baselineCommitOid: string;
  readonly baselineTreeOid: string;
  readonly baselineRef: string;
  readonly managedTreePolicyVersion: 1;
  readonly filesImported: number;
  readonly bytesImported: number;
}

export type GitoxideHelperInvocationErrorCode =
  | 'gitoxide_helper_invocation_invalid'
  | 'gitoxide_helper_invocation_spawn_failed'
  | 'gitoxide_helper_invocation_timed_out'
  | 'gitoxide_helper_invocation_aborted'
  | 'gitoxide_helper_invocation_output_too_large'
  | 'gitoxide_helper_invocation_protocol_invalid'
  | 'gitoxide_helper_operation_failed';

export class GitoxideHelperInvocationError extends Error {
  constructor(
    readonly code: GitoxideHelperInvocationErrorCode,
    message: string,
    readonly helperReason?: string,
  ) {
    super(message);
    this.name = 'GitoxideHelperInvocationError';
  }
}

export async function inspectRepositoryWithGitoxideHelperInternal(input: {
  readonly invocationOwnerToken: object;
  readonly capability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideRepositoryInspectionResultV1> {
  throwIfAborted(input.abortSignal);
  if (!isAbsolute(input.repositoryPath)) {
    throw new GitoxideHelperInvocationError(
      'gitoxide_helper_invocation_invalid',
      'Gitoxide repository path must be absolute',
    );
  }
  const [artifact, repositoryPath] = await Promise.all([
    verifyGitoxideHelperArtifactForInvocationInternal(input.invocationOwnerToken, input.capability),
    realpath(input.repositoryPath).catch((error) => {
      throw new GitoxideHelperInvocationError(
        'gitoxide_helper_invocation_invalid',
        `Gitoxide repository path could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }),
  ]);
  throwIfAborted(input.abortSignal);

  const request = Buffer.from(
    JSON.stringify({
      protocolVersion: artifact.protocolVersion,
      operation: 'inspect_repository',
      repositoryPath,
    }),
  );
  if (request.length > MAX_REQUEST_BYTES) {
    throw new GitoxideHelperInvocationError(
      'gitoxide_helper_invocation_invalid',
      'Gitoxide helper request exceeds its byte limit',
    );
  }

  const outcome = await invokeHelper({
    executablePath: artifact.executablePath,
    request,
    abortSignal: input.abortSignal,
    timeoutMs: GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.inspectRepositoryMs,
  });
  return decodeOutcome(outcome);
}

export async function importSourceHeadWithGitoxideHelperInternal(input: {
  readonly invocationOwnerToken: object;
  readonly capability: GitoxideHelperInvocationCapability;
  readonly sourceRepositoryPath: string;
  readonly expectedSourceHeadCommitOid: string;
  readonly destinationRepositoryPath: string;
  readonly baselineRef: string;
  readonly managedTreePolicyVersion: 1;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideSourceImportObservationV1> {
  throwIfAborted(input.abortSignal);
  if (
    !isAbsolute(input.sourceRepositoryPath) ||
    !isAbsolute(input.destinationRepositoryPath) ||
    !SHA1_OID_PATTERN.test(input.expectedSourceHeadCommitOid) ||
    !MAKA_REF_PATTERN.test(input.baselineRef)
  ) {
    throw new GitoxideHelperInvocationError(
      'gitoxide_helper_invocation_invalid',
      'Gitoxide source import request is invalid',
    );
  }
  const [artifact, sourceRepositoryPath] = await Promise.all([
    verifyGitoxideHelperArtifactForInvocationInternal(input.invocationOwnerToken, input.capability),
    realpath(input.sourceRepositoryPath).catch((error) => {
      throw new GitoxideHelperInvocationError(
        'gitoxide_helper_invocation_invalid',
        `Gitoxide source repository path could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }),
  ]);
  throwIfAborted(input.abortSignal);
  const request = Buffer.from(
    JSON.stringify({
      protocolVersion: artifact.protocolVersion,
      operation: 'import_source_head',
      sourceRepositoryPath,
      expectedSourceHeadCommitOid: input.expectedSourceHeadCommitOid,
      destinationRepositoryPath: input.destinationRepositoryPath,
      baselineRef: input.baselineRef,
      managedTreePolicyVersion: input.managedTreePolicyVersion,
    }),
  );
  if (request.length > MAX_REQUEST_BYTES) {
    throw new GitoxideHelperInvocationError(
      'gitoxide_helper_invocation_invalid',
      'Gitoxide helper request exceeds its byte limit',
    );
  }
  const outcome = await invokeHelper({
    executablePath: artifact.executablePath,
    request,
    abortSignal: input.abortSignal,
    timeoutMs: GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.importSourceHeadMs,
  });
  return decodeSourceImportOutcome(outcome, {
    expectedSourceHeadCommitOid: input.expectedSourceHeadCommitOid,
    baselineRef: input.baselineRef,
    managedTreePolicyVersion: input.managedTreePolicyVersion,
  });
}

interface HelperProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function invokeHelper(input: {
  readonly executablePath: string;
  readonly request: Buffer;
  readonly abortSignal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<HelperProcessOutcome> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.executablePath, [], {
        cwd: dirname(input.executablePath),
        env: helperEnvironment(),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        new GitoxideHelperInvocationError(
          'gitoxide_helper_invocation_spawn_failed',
          `Gitoxide helper could not be started: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let termination:
      | 'gitoxide_helper_invocation_timed_out'
      | 'gitoxide_helper_invocation_aborted'
      | 'gitoxide_helper_invocation_output_too_large'
      | undefined;
    let processFailure: GitoxideHelperInvocationError | undefined;
    const timeout = setTimeout(
      () => terminate('gitoxide_helper_invocation_timed_out'),
      input.timeoutMs,
    );
    const abort = () => terminate('gitoxide_helper_invocation_aborted');
    input.abortSignal?.addEventListener('abort', abort, { once: true });
    if (input.abortSignal?.aborted) abort();

    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        terminate('gitoxide_helper_invocation_output_too_large');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        terminate('gitoxide_helper_invocation_output_too_large');
        return;
      }
      stderr.push(chunk);
    });
    child.once('error', (error) => {
      finishReject(
        new GitoxideHelperInvocationError(
          'gitoxide_helper_invocation_spawn_failed',
          `Gitoxide helper process failed: ${error.message}`,
        ),
      );
    });
    child.once('close', (exitCode, signal) => {
      if (processFailure) {
        finishReject(processFailure);
        return;
      }
      if (termination) {
        finishReject(
          new GitoxideHelperInvocationError(termination, terminationMessage(termination)),
        );
        return;
      }
      finishResolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
      });
    });
    child.stdin!.on('error', (error) => {
      if (settled || processFailure) return;
      processFailure = new GitoxideHelperInvocationError(
        'gitoxide_helper_invocation_spawn_failed',
        `Gitoxide helper request could not be written: ${error.message}`,
      );
      void terminateChildProcessTree(child, 'SIGKILL');
    });
    child.stdin!.end(input.request);

    function terminate(reason: NonNullable<typeof termination>): void {
      if (settled || termination) return;
      termination = reason;
      void terminateChildProcessTree(child, 'SIGKILL');
    }

    function finishResolve(outcome: HelperProcessOutcome): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    }

    function finishReject(error: GitoxideHelperInvocationError): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    function cleanup(): void {
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener('abort', abort);
    }
  });
}

function decodeOutcome(outcome: HelperProcessOutcome): GitoxideRepositoryInspectionResultV1 {
  if (outcome.signal !== null) {
    throw new GitoxideHelperInvocationError(
      'gitoxide_helper_invocation_protocol_invalid',
      `Gitoxide helper exited from signal ${outcome.signal}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(outcome.stdout.toString('utf8'));
  } catch {
    throw protocolInvalid('Gitoxide helper stdout is not one JSON response');
  }

  if (outcome.exitCode === 0 && isRepositoryObservation(value)) return Object.freeze(value);
  if (outcome.exitCode === 2 && isRepositoryRejection(value)) {
    return Object.freeze({ ...value, supportedObjectFormats: Object.freeze(['sha1'] as const) });
  }
  if (outcome.exitCode === 1 && isHelperError(value)) {
    throw new GitoxideHelperInvocationError(
      'gitoxide_helper_operation_failed',
      `Gitoxide helper could not inspect the repository: ${value.reason}`,
      value.reason,
    );
  }
  const stderr = outcome.stderr.toString('utf8').trim();
  throw protocolInvalid(
    `Gitoxide helper exit code and response disagree${stderr ? `: ${stderr}` : ''}`,
  );
}

function decodeSourceImportOutcome(
  outcome: HelperProcessOutcome,
  expected: {
    readonly expectedSourceHeadCommitOid: string;
    readonly baselineRef: string;
    readonly managedTreePolicyVersion: 1;
  },
): GitoxideSourceImportObservationV1 {
  if (outcome.signal !== null) {
    throw new GitoxideHelperInvocationError(
      'gitoxide_helper_invocation_protocol_invalid',
      `Gitoxide helper exited from signal ${outcome.signal}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(outcome.stdout.toString('utf8'));
  } catch {
    throw protocolInvalid('Gitoxide helper stdout is not one JSON response');
  }
  if (outcome.exitCode === 0 && isSourceImportObservation(value, expected)) {
    return Object.freeze(value);
  }
  if (outcome.exitCode === 1 && isHelperError(value)) {
    throw new GitoxideHelperInvocationError(
      'gitoxide_helper_operation_failed',
      `Gitoxide helper could not import the source repository: ${value.reason}`,
      value.reason,
    );
  }
  const stderr = outcome.stderr.toString('utf8').trim();
  throw protocolInvalid(
    `Gitoxide helper exit code and response disagree${stderr ? `: ${stderr}` : ''}`,
  );
}

function isSourceImportObservation(
  value: unknown,
  expected: {
    readonly expectedSourceHeadCommitOid: string;
    readonly baselineRef: string;
    readonly managedTreePolicyVersion: 1;
  },
): value is GitoxideSourceImportObservationV1 {
  return (
    hasExactKeys(value, [
      'protocolVersion',
      'kind',
      'objectFormat',
      'sourceHeadCommitOid',
      'sourceTreeOid',
      'baselineCommitOid',
      'baselineTreeOid',
      'baselineRef',
      'managedTreePolicyVersion',
      'filesImported',
      'bytesImported',
    ]) &&
    value.protocolVersion === 1 &&
    value.kind === 'source_imported' &&
    value.objectFormat === 'sha1' &&
    typeof value.sourceHeadCommitOid === 'string' &&
    SHA1_OID_PATTERN.test(value.sourceHeadCommitOid) &&
    value.sourceHeadCommitOid === expected.expectedSourceHeadCommitOid &&
    typeof value.sourceTreeOid === 'string' &&
    SHA1_OID_PATTERN.test(value.sourceTreeOid) &&
    typeof value.baselineCommitOid === 'string' &&
    SHA1_OID_PATTERN.test(value.baselineCommitOid) &&
    typeof value.baselineTreeOid === 'string' &&
    SHA1_OID_PATTERN.test(value.baselineTreeOid) &&
    value.baselineTreeOid === value.sourceTreeOid &&
    typeof value.baselineRef === 'string' &&
    MAKA_REF_PATTERN.test(value.baselineRef) &&
    value.baselineRef === expected.baselineRef &&
    value.managedTreePolicyVersion === expected.managedTreePolicyVersion &&
    Number.isSafeInteger(value.filesImported) &&
    (value.filesImported as number) >= 0 &&
    Number.isSafeInteger(value.bytesImported) &&
    (value.bytesImported as number) >= 0
  );
}

function isRepositoryObservation(value: unknown): value is GitoxideRepositoryObservationV1 {
  return (
    hasExactKeys(value, [
      'protocolVersion',
      'kind',
      'objectFormat',
      'headCommitOid',
      'headTreeOid',
    ]) &&
    value.protocolVersion === 1 &&
    value.kind === 'repository_inspected' &&
    value.objectFormat === 'sha1' &&
    typeof value.headCommitOid === 'string' &&
    SHA1_OID_PATTERN.test(value.headCommitOid) &&
    typeof value.headTreeOid === 'string' &&
    SHA1_OID_PATTERN.test(value.headTreeOid)
  );
}

function isRepositoryRejection(value: unknown): value is GitoxideRepositoryRejectionV1 {
  return (
    hasExactKeys(value, [
      'protocolVersion',
      'kind',
      'reason',
      'objectFormat',
      'supportedObjectFormats',
    ]) &&
    value.protocolVersion === 1 &&
    value.kind === 'repository_rejected' &&
    value.reason === 'unsupported_object_format' &&
    (value.objectFormat === 'sha256' || value.objectFormat === 'unknown') &&
    Array.isArray(value.supportedObjectFormats) &&
    value.supportedObjectFormats.length === 1 &&
    value.supportedObjectFormats[0] === 'sha1'
  );
}

function isHelperError(value: unknown): value is {
  readonly protocolVersion: 1;
  readonly kind: 'helper_error';
  readonly reason: string;
} {
  return (
    hasExactKeys(value, ['protocolVersion', 'kind', 'reason']) &&
    value.protocolVersion === 1 &&
    value.kind === 'helper_error' &&
    typeof value.reason === 'string' &&
    HELPER_ERROR_REASONS.has(value.reason)
  );
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function helperEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new GitoxideHelperInvocationError(
    'gitoxide_helper_invocation_aborted',
    'Gitoxide helper invocation was aborted',
  );
}

function terminationMessage(
  code:
    | 'gitoxide_helper_invocation_timed_out'
    | 'gitoxide_helper_invocation_aborted'
    | 'gitoxide_helper_invocation_output_too_large',
): string {
  if (code === 'gitoxide_helper_invocation_timed_out')
    return 'Gitoxide helper invocation timed out';
  if (code === 'gitoxide_helper_invocation_aborted')
    return 'Gitoxide helper invocation was aborted';
  return 'Gitoxide helper output exceeded its byte limit';
}

function protocolInvalid(message: string): GitoxideHelperInvocationError {
  return new GitoxideHelperInvocationError('gitoxide_helper_invocation_protocol_invalid', message);
}
