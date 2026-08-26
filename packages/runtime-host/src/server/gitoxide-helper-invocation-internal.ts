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
import { manageChildProcessLifecycle } from '@maka/runtime/child-process-lifecycle';
import {
  type GitoxideHelperInvocationCapability,
  verifyGitoxideHelperArtifactForInvocationInternal,
} from './gitoxide-helper-artifact-authority-internal.js';

const MAX_SUCCESSOR_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_SUCCESSOR_CONTENT_BYTES + 64 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
export const GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL = Object.freeze({
  inspectRepositoryMs: 5_000,
  importSourceHeadMs: 10 * 60_000,
  createSuccessorMs: 10 * 60_000,
  projectionMs: 10 * 60_000,
});
const SHA1_OID_PATTERN = /^[0-9a-f]{40}$/;
const MAKA_REF_PATTERN = /^refs\/maka\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
export const GITOXIDE_HELPER_ERROR_REASONS_V1 = Object.freeze([
  'internal_error_reason_invalid',
  'request_read_failed',
  'request_too_large',
  'invalid_request',
  'unsupported_protocol_version',
  'repository_metadata_limit_exceeded',
  'repository_alternates_unsupported',
  'repository_open_failed',
  'head_commit_unavailable',
  'head_commit_identity_mismatch',
  'head_tree_unavailable',
  'commit_object_limit_exceeded',
  'baseline_commit_write_failed',
  'baseline_publish_failed',
  'baseline_ref_outside_maka_namespace',
  'base_commit_unavailable',
  'base_path_lookup_failed',
  'base_tree_unavailable',
  'blob_write_failed',
  'commit_write_failed',
  'invalid_baseline_ref',
  'invalid_base_commit_oid',
  'invalid_successor_path',
  'import_destination_create_failed',
  'import_destination_not_fresh',
  'import_destination_object_format_mismatch',
  'import_destination_parent_untrusted',
  'invalid_source_head_commit_oid',
  'source_blob_copy_failed',
  'source_blob_identity_mismatch',
  'source_blob_invalid',
  'source_blob_unavailable',
  'source_attributes_limit_exceeded',
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
  'successor_content_limit_exceeded',
  'successor_publish_failed',
  'target_ref_outside_maka_namespace',
  'target_ref_unavailable',
  'tree_edit_failed',
  'tree_write_failed',
  'unsupported_base_path_kind',
  'accepted_commit_unavailable',
  'accepted_tree_unavailable',
  'invalid_accepted_commit_oid',
  'projection_blob_invalid',
  'projection_blob_unavailable',
  'projection_byte_limit_exceeded',
  'projection_destination_create_failed',
  'projection_destination_not_fresh',
  'projection_directory_create_failed',
  'projection_directory_sync_failed',
  'projection_file_create_failed',
  'projection_file_limit_exceeded',
  'projection_file_sync_failed',
  'projection_file_write_failed',
  'projection_mode_update_failed',
  'projection_path_collision',
  'projection_tree_invalid',
  'projection_tree_unavailable',
  'projection_unreadable',
  'unsupported_projection_entry_kind',
  'unsupported_projection_path',
  'unsupported_source_entry_kind',
  'unsupported_source_attributes',
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
  readonly managedTreePolicyVersion: 2;
  readonly filesImported: number;
  readonly bytesImported: number;
}

export interface GitoxideSuccessorPublishedV1 {
  readonly kind: 'successor_published';
  readonly protocolVersion: 1;
  readonly objectFormat: 'sha1';
  readonly baseCommitOid: string;
  readonly successorCommitOid: string;
  readonly successorTreeOid: string;
  readonly resultBlobOid: string;
  readonly targetRef: string;
  readonly path: string;
  readonly managedTreePolicyVersion: 2;
}

export interface GitoxideSuccessorRejectedV1 {
  readonly kind: 'successor_rejected';
  readonly protocolVersion: 1;
  readonly reason: 'base_commit_mismatch';
  readonly objectFormat: 'sha1';
  readonly expectedBaseCommitOid: string;
  readonly actualBaseCommitOid: string;
  readonly targetRef: string;
  readonly managedTreePolicyVersion: 2;
}

export type GitoxideSuccessorResultV1 = GitoxideSuccessorPublishedV1 | GitoxideSuccessorRejectedV1;

export interface GitoxideProjectionMaterializedV1 {
  readonly kind: 'projection_materialized';
  readonly protocolVersion: 1;
  readonly objectFormat: 'sha1';
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly destinationPath: string;
  readonly filesMaterialized: number;
  readonly bytesWritten: number;
  readonly managedTreePolicyVersion: 2;
}

export interface GitoxideProjectionObservedV1 {
  readonly kind: 'projection_observed';
  readonly protocolVersion: 1;
  readonly objectFormat: 'sha1';
  readonly state: 'clean';
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly projectionPath: string;
  readonly filesObserved: number;
  readonly bytesRead: number;
  readonly managedTreePolicyVersion: 2;
}

export interface GitoxideProjectionDriftedV1 {
  readonly kind: 'projection_drifted';
  readonly protocolVersion: 1;
  readonly objectFormat: 'sha1';
  readonly state: 'drifted';
  readonly reason: string;
  readonly path: string;
  readonly acceptedCommitOid: string;
  readonly acceptedTreeOid: string;
  readonly projectionPath: string;
  readonly managedTreePolicyVersion: 2;
}

export type GitoxideProjectionObservationV1 =
  | GitoxideProjectionObservedV1
  | GitoxideProjectionDriftedV1;

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
  const deadlineAt =
    performance.now() + GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.inspectRepositoryMs;
  return (
    await inspectCanonicalRepositoryWithGitoxideHelperInternal({
      ...input,
      deadlineAt,
    })
  ).observation;
}

export async function inspectCanonicalRepositoryWithGitoxideHelperInternal(input: {
  readonly invocationOwnerToken: object;
  readonly capability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly deadlineAt: number;
  readonly abortSignal?: AbortSignal;
}): Promise<{
  readonly repositoryPath: string;
  readonly observation: GitoxideRepositoryInspectionResultV1;
}> {
  const { artifact, repositoryPath } = await runGitoxideOperationWithinDeadlineInternal({
    deadlineAt: input.deadlineAt,
    abortSignal: input.abortSignal,
    operation: async () => {
      if (!isAbsolute(input.repositoryPath)) {
        throw new GitoxideHelperInvocationError(
          'gitoxide_helper_invocation_invalid',
          'Gitoxide repository path must be absolute',
        );
      }
      const [artifact, repositoryPath] = await Promise.all([
        verifyGitoxideHelperArtifactForInvocationInternal(
          input.invocationOwnerToken,
          input.capability,
        ),
        realpath(input.repositoryPath).catch((error) => {
          throw new GitoxideHelperInvocationError(
            'gitoxide_helper_invocation_invalid',
            `Gitoxide repository path could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ]);
      return { artifact, repositoryPath };
    },
  });

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
    deadlineAt: input.deadlineAt,
  });
  return Object.freeze({ repositoryPath, observation: decodeOutcome(outcome) });
}

export async function runGitoxideOperationWithinDeadlineInternal<T>(input: {
  readonly deadlineAt: number;
  readonly operation: () => Promise<T>;
  readonly abortSignal?: AbortSignal;
}): Promise<T> {
  throwIfAborted(input.abortSignal);
  const remainingMs = input.deadlineAt - performance.now();
  if (remainingMs <= 0) throw invocationTimedOut();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finishReject(invocationTimedOut()), remainingMs);
    const abort = () =>
      finishReject(
        new GitoxideHelperInvocationError(
          'gitoxide_helper_invocation_aborted',
          terminationMessage('gitoxide_helper_invocation_aborted'),
        ),
      );
    input.abortSignal?.addEventListener('abort', abort, { once: true });

    void Promise.resolve().then(input.operation).then(finishResolve, finishReject);

    function finishResolve(value: T): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }

    function finishReject(error: unknown): void {
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

function invocationTimedOut(): GitoxideHelperInvocationError {
  return new GitoxideHelperInvocationError(
    'gitoxide_helper_invocation_timed_out',
    terminationMessage('gitoxide_helper_invocation_timed_out'),
  );
}

export async function importSourceHeadWithGitoxideHelperInternal(input: {
  readonly invocationOwnerToken: object;
  readonly capability: GitoxideHelperInvocationCapability;
  readonly sourceRepositoryPath: string;
  readonly expectedSourceHeadCommitOid: string;
  readonly destinationRepositoryPath: string;
  readonly baselineRef: string;
  readonly managedTreePolicyVersion: 2;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideSourceImportObservationV1> {
  const deadlineAt =
    performance.now() + GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.importSourceHeadMs;
  const { artifact, sourceRepositoryPath } = await runGitoxideOperationWithinDeadlineInternal({
    deadlineAt,
    abortSignal: input.abortSignal,
    operation: async () => {
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
        verifyGitoxideHelperArtifactForInvocationInternal(
          input.invocationOwnerToken,
          input.capability,
        ),
        realpath(input.sourceRepositoryPath).catch((error) => {
          throw new GitoxideHelperInvocationError(
            'gitoxide_helper_invocation_invalid',
            `Gitoxide source repository path could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ]);
      return { artifact, sourceRepositoryPath };
    },
  });

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
    deadlineAt,
  });
  return decodeSourceImportOutcome(outcome, {
    expectedSourceHeadCommitOid: input.expectedSourceHeadCommitOid,
    baselineRef: input.baselineRef,
    managedTreePolicyVersion: input.managedTreePolicyVersion,
  });
}

export async function createSuccessorWithGitoxideHelperInternal(input: {
  readonly invocationOwnerToken: object;
  readonly capability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly expectedBaseCommitOid: string;
  readonly targetRef: string;
  readonly path: string;
  readonly content: string;
  readonly managedTreePolicyVersion: 2;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideSuccessorResultV1> {
  const deadlineAt =
    performance.now() + GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.createSuccessorMs;
  const { artifact, repositoryPath } = await runGitoxideOperationWithinDeadlineInternal({
    deadlineAt,
    abortSignal: input.abortSignal,
    operation: async () => {
      if (
        !isAbsolute(input.repositoryPath) ||
        !SHA1_OID_PATTERN.test(input.expectedBaseCommitOid) ||
        !MAKA_REF_PATTERN.test(input.targetRef) ||
        !isCanonicalManagedPathV2(input.path) ||
        Buffer.byteLength(input.content, 'utf8') > MAX_SUCCESSOR_CONTENT_BYTES ||
        input.managedTreePolicyVersion !== 2
      ) {
        throw new GitoxideHelperInvocationError(
          'gitoxide_helper_invocation_invalid',
          'Gitoxide successor request is invalid',
        );
      }
      const [artifact, repositoryPath] = await Promise.all([
        verifyGitoxideHelperArtifactForInvocationInternal(
          input.invocationOwnerToken,
          input.capability,
        ),
        realpath(input.repositoryPath).catch((error) => {
          throw new GitoxideHelperInvocationError(
            'gitoxide_helper_invocation_invalid',
            `Gitoxide managed repository path could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ]);
      return { artifact, repositoryPath };
    },
  });
  const request = Buffer.from(
    JSON.stringify({
      protocolVersion: artifact.protocolVersion,
      operation: 'create_successor',
      repositoryPath,
      expectedBaseCommitOid: input.expectedBaseCommitOid,
      targetRef: input.targetRef,
      path: input.path,
      content: input.content,
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
    deadlineAt,
  });
  return decodeSuccessorOutcome(outcome, {
    expectedBaseCommitOid: input.expectedBaseCommitOid,
    targetRef: input.targetRef,
    path: input.path,
    managedTreePolicyVersion: input.managedTreePolicyVersion,
  });
}

export async function materializeProjectionWithGitoxideHelperInternal(input: {
  readonly invocationOwnerToken: object;
  readonly capability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly acceptedCommitOid: string;
  readonly destinationPath: string;
  readonly managedTreePolicyVersion: 2;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideProjectionMaterializedV1> {
  const deadlineAt = performance.now() + GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.projectionMs;
  const { artifact, repositoryPath } = await prepareProjectionInvocation({ ...input, deadlineAt });
  const request = Buffer.from(
    JSON.stringify({
      protocolVersion: artifact.protocolVersion,
      operation: 'materialize_projection',
      repositoryPath,
      acceptedCommitOid: input.acceptedCommitOid,
      destinationPath: input.destinationPath,
      managedTreePolicyVersion: input.managedTreePolicyVersion,
    }),
  );
  if (request.length > MAX_REQUEST_BYTES) throw invocationInvalid('Gitoxide request is too large');
  const outcome = await invokeHelper({
    executablePath: artifact.executablePath,
    request,
    abortSignal: input.abortSignal,
    deadlineAt,
  });
  return decodeProjectionMaterializationOutcome(outcome, input);
}

export async function observeProjectionWithGitoxideHelperInternal(input: {
  readonly invocationOwnerToken: object;
  readonly capability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly acceptedCommitOid: string;
  readonly projectionPath: string;
  readonly managedTreePolicyVersion: 2;
  readonly abortSignal?: AbortSignal;
}): Promise<GitoxideProjectionObservationV1> {
  const deadlineAt = performance.now() + GITOXIDE_HELPER_OPERATION_TIMEOUTS_INTERNAL.projectionMs;
  const prepared = await prepareProjectionInvocation({
    ...input,
    destinationPath: input.projectionPath,
    deadlineAt,
  });
  const request = Buffer.from(
    JSON.stringify({
      protocolVersion: prepared.artifact.protocolVersion,
      operation: 'observe_projection',
      repositoryPath: prepared.repositoryPath,
      acceptedCommitOid: input.acceptedCommitOid,
      projectionPath: input.projectionPath,
      managedTreePolicyVersion: input.managedTreePolicyVersion,
    }),
  );
  if (request.length > MAX_REQUEST_BYTES) throw invocationInvalid('Gitoxide request is too large');
  const outcome = await invokeHelper({
    executablePath: prepared.artifact.executablePath,
    request,
    abortSignal: input.abortSignal,
    deadlineAt,
  });
  return decodeProjectionObservationOutcome(outcome, input);
}

async function prepareProjectionInvocation(input: {
  readonly invocationOwnerToken: object;
  readonly capability: GitoxideHelperInvocationCapability;
  readonly repositoryPath: string;
  readonly acceptedCommitOid: string;
  readonly destinationPath: string;
  readonly managedTreePolicyVersion: 2;
  readonly deadlineAt: number;
  readonly abortSignal?: AbortSignal;
}): Promise<{
  readonly artifact: Awaited<ReturnType<typeof verifyGitoxideHelperArtifactForInvocationInternal>>;
  readonly repositoryPath: string;
}> {
  return runGitoxideOperationWithinDeadlineInternal({
    deadlineAt: input.deadlineAt,
    abortSignal: input.abortSignal,
    operation: async () => {
      if (
        !isAbsolute(input.repositoryPath) ||
        !isAbsolute(input.destinationPath) ||
        !SHA1_OID_PATTERN.test(input.acceptedCommitOid) ||
        input.managedTreePolicyVersion !== 2
      ) {
        throw invocationInvalid('Gitoxide projection request is invalid');
      }
      const [artifact, repositoryPath] = await Promise.all([
        verifyGitoxideHelperArtifactForInvocationInternal(
          input.invocationOwnerToken,
          input.capability,
        ),
        realpath(input.repositoryPath).catch((error) => {
          throw invocationInvalid(
            `Gitoxide managed repository path could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ]);
      return { artifact, repositoryPath };
    },
  });
}

/*
 * The absolute operation deadline starts at the public entry point. Once it
 * expires, the shared lifecycle owner force-kills the process tree and applies
 * bounded exit-acknowledgement and output-drain deadlines before this promise
 * settles.
 */
function invokeHelper(input: {
  readonly executablePath: string;
  readonly request: Buffer;
  readonly abortSignal?: AbortSignal;
  readonly deadlineAt: number;
}): Promise<HelperProcessOutcome> {
  if (input.abortSignal?.aborted) {
    return Promise.reject(
      new GitoxideHelperInvocationError(
        'gitoxide_helper_invocation_aborted',
        terminationMessage('gitoxide_helper_invocation_aborted'),
      ),
    );
  }
  const remainingMs = input.deadlineAt - performance.now();
  if (remainingMs <= 0) return Promise.reject(invocationTimedOut());

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
      throw new GitoxideHelperInvocationError(
        'gitoxide_helper_invocation_spawn_failed',
        `Gitoxide helper could not be started: ${error instanceof Error ? error.message : String(error)}`,
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
    const lifecycle = manageChildProcessLifecycle(
      child,
      [
        { key: 'stdout', stream: child.stdout! },
        { key: 'stderr', stream: child.stderr! },
      ],
      {
        killGraceMs: 0,
        ioDrainTimeoutMs: 2_000,
        exitAcknowledgementMs: 2_000,
      },
    );
    const timeout = setTimeout(
      () => terminate('gitoxide_helper_invocation_timed_out'),
      remainingMs,
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
    void lifecycle.completion.then(
      (outcome) => {
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
        if (!outcome.ioDrained) {
          finishReject(
            new GitoxideHelperInvocationError(
              'gitoxide_helper_invocation_protocol_invalid',
              'Gitoxide helper output did not drain before its lifecycle deadline',
            ),
          );
          return;
        }
        finishResolve({
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          stdout: Buffer.concat(stdout, stdoutBytes),
          stderr: Buffer.concat(stderr, stderrBytes),
        });
      },
      (error: unknown) => {
        if (termination) {
          finishReject(
            new GitoxideHelperInvocationError(termination, terminationMessage(termination)),
          );
          return;
        }
        finishReject(
          new GitoxideHelperInvocationError(
            'gitoxide_helper_invocation_spawn_failed',
            `Gitoxide helper process failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      },
    );
    child.stdin!.on('error', (error) => {
      if (settled || processFailure) return;
      processFailure = new GitoxideHelperInvocationError(
        'gitoxide_helper_invocation_spawn_failed',
        `Gitoxide helper request could not be written: ${error.message}`,
      );
      lifecycle.forceKill();
    });
    child.stdin!.end(input.request);

    function terminate(reason: NonNullable<typeof termination>): void {
      if (settled || termination) return;
      termination = reason;
      lifecycle.forceKill();
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

interface HelperProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
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
    readonly managedTreePolicyVersion: 2;
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

function decodeSuccessorOutcome(
  outcome: HelperProcessOutcome,
  expected: {
    readonly expectedBaseCommitOid: string;
    readonly targetRef: string;
    readonly path: string;
    readonly managedTreePolicyVersion: 2;
  },
): GitoxideSuccessorResultV1 {
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
  if (outcome.exitCode === 0 && isSuccessorPublished(value, expected)) {
    return Object.freeze(value);
  }
  if (outcome.exitCode === 3 && isSuccessorRejected(value, expected)) {
    return Object.freeze(value);
  }
  if (outcome.exitCode === 1 && isHelperError(value)) {
    throw new GitoxideHelperInvocationError(
      'gitoxide_helper_operation_failed',
      `Gitoxide helper could not create the successor: ${value.reason}`,
      value.reason,
    );
  }
  const stderr = outcome.stderr.toString('utf8').trim();
  throw protocolInvalid(
    `Gitoxide helper exit code and response disagree${stderr ? `: ${stderr}` : ''}`,
  );
}

function isSuccessorPublished(
  value: unknown,
  expected: {
    readonly expectedBaseCommitOid: string;
    readonly targetRef: string;
    readonly path: string;
    readonly managedTreePolicyVersion: 2;
  },
): value is GitoxideSuccessorPublishedV1 {
  return (
    hasExactKeys(value, [
      'protocolVersion',
      'kind',
      'objectFormat',
      'baseCommitOid',
      'successorCommitOid',
      'successorTreeOid',
      'resultBlobOid',
      'targetRef',
      'path',
      'managedTreePolicyVersion',
    ]) &&
    value.protocolVersion === 1 &&
    value.kind === 'successor_published' &&
    value.objectFormat === 'sha1' &&
    value.baseCommitOid === expected.expectedBaseCommitOid &&
    typeof value.successorCommitOid === 'string' &&
    SHA1_OID_PATTERN.test(value.successorCommitOid) &&
    typeof value.successorTreeOid === 'string' &&
    SHA1_OID_PATTERN.test(value.successorTreeOid) &&
    typeof value.resultBlobOid === 'string' &&
    SHA1_OID_PATTERN.test(value.resultBlobOid) &&
    value.targetRef === expected.targetRef &&
    value.path === expected.path &&
    value.managedTreePolicyVersion === expected.managedTreePolicyVersion
  );
}

function isSuccessorRejected(
  value: unknown,
  expected: {
    readonly expectedBaseCommitOid: string;
    readonly targetRef: string;
    readonly managedTreePolicyVersion: 2;
  },
): value is GitoxideSuccessorRejectedV1 {
  return (
    hasExactKeys(value, [
      'protocolVersion',
      'kind',
      'reason',
      'objectFormat',
      'expectedBaseCommitOid',
      'actualBaseCommitOid',
      'targetRef',
      'managedTreePolicyVersion',
    ]) &&
    value.protocolVersion === 1 &&
    value.kind === 'successor_rejected' &&
    value.reason === 'base_commit_mismatch' &&
    value.objectFormat === 'sha1' &&
    value.expectedBaseCommitOid === expected.expectedBaseCommitOid &&
    typeof value.actualBaseCommitOid === 'string' &&
    SHA1_OID_PATTERN.test(value.actualBaseCommitOid) &&
    value.targetRef === expected.targetRef &&
    value.managedTreePolicyVersion === expected.managedTreePolicyVersion
  );
}

function decodeProjectionMaterializationOutcome(
  outcome: HelperProcessOutcome,
  expected: {
    readonly acceptedCommitOid: string;
    readonly destinationPath: string;
    readonly managedTreePolicyVersion: 2;
  },
): GitoxideProjectionMaterializedV1 {
  const value = parseHelperOutcome(outcome);
  if (
    outcome.exitCode === 0 &&
    isProjectionMaterialized(value) &&
    value.acceptedCommitOid === expected.acceptedCommitOid &&
    value.destinationPath === expected.destinationPath &&
    value.managedTreePolicyVersion === expected.managedTreePolicyVersion
  ) {
    return Object.freeze(value);
  }
  if (outcome.exitCode === 1 && isHelperError(value)) {
    throw operationFailed('materialize the projection', value.reason);
  }
  throw protocolInvalid('Gitoxide projection materialization response is invalid');
}

function decodeProjectionObservationOutcome(
  outcome: HelperProcessOutcome,
  expected: {
    readonly acceptedCommitOid: string;
    readonly projectionPath: string;
    readonly managedTreePolicyVersion: 2;
  },
): GitoxideProjectionObservationV1 {
  const value = parseHelperOutcome(outcome);
  if (
    ((outcome.exitCode === 0 && isProjectionObserved(value)) ||
      (outcome.exitCode === 3 && isProjectionDrifted(value))) &&
    value.acceptedCommitOid === expected.acceptedCommitOid &&
    value.projectionPath === expected.projectionPath &&
    value.managedTreePolicyVersion === expected.managedTreePolicyVersion
  ) {
    return Object.freeze(value);
  }
  if (outcome.exitCode === 1 && isHelperError(value)) {
    throw operationFailed('observe the projection', value.reason);
  }
  throw protocolInvalid('Gitoxide projection observation response is invalid');
}

function parseHelperOutcome(outcome: HelperProcessOutcome): unknown {
  if (outcome.signal !== null) {
    throw protocolInvalid(`Gitoxide helper exited from signal ${outcome.signal}`);
  }
  try {
    return JSON.parse(outcome.stdout.toString('utf8'));
  } catch {
    throw protocolInvalid('Gitoxide helper stdout is not one JSON response');
  }
}

function operationFailed(operation: string, reason: string): GitoxideHelperInvocationError {
  return new GitoxideHelperInvocationError(
    'gitoxide_helper_operation_failed',
    `Gitoxide helper could not ${operation}: ${reason}`,
    reason,
  );
}

function isProjectionMaterialized(value: unknown): value is GitoxideProjectionMaterializedV1 {
  return (
    hasExactKeys(value, [
      'protocolVersion',
      'kind',
      'objectFormat',
      'acceptedCommitOid',
      'acceptedTreeOid',
      'destinationPath',
      'filesMaterialized',
      'bytesWritten',
      'managedTreePolicyVersion',
    ]) &&
    value.protocolVersion === 1 &&
    value.kind === 'projection_materialized' &&
    value.objectFormat === 'sha1' &&
    isSha1(value.acceptedCommitOid) &&
    isSha1(value.acceptedTreeOid) &&
    typeof value.destinationPath === 'string' &&
    isAbsolute(value.destinationPath) &&
    isNonNegativeSafeInteger(value.filesMaterialized) &&
    isNonNegativeSafeInteger(value.bytesWritten) &&
    value.managedTreePolicyVersion === 2
  );
}

function isProjectionObserved(value: unknown): value is GitoxideProjectionObservedV1 {
  return (
    hasExactKeys(value, [
      'protocolVersion',
      'kind',
      'objectFormat',
      'state',
      'acceptedCommitOid',
      'acceptedTreeOid',
      'projectionPath',
      'filesObserved',
      'bytesRead',
      'managedTreePolicyVersion',
    ]) &&
    value.protocolVersion === 1 &&
    value.kind === 'projection_observed' &&
    value.objectFormat === 'sha1' &&
    value.state === 'clean' &&
    isSha1(value.acceptedCommitOid) &&
    isSha1(value.acceptedTreeOid) &&
    typeof value.projectionPath === 'string' &&
    isAbsolute(value.projectionPath) &&
    isNonNegativeSafeInteger(value.filesObserved) &&
    isNonNegativeSafeInteger(value.bytesRead) &&
    value.managedTreePolicyVersion === 2
  );
}

function isProjectionDrifted(value: unknown): value is GitoxideProjectionDriftedV1 {
  return (
    hasExactKeys(value, [
      'protocolVersion',
      'kind',
      'objectFormat',
      'state',
      'reason',
      'path',
      'acceptedCommitOid',
      'acceptedTreeOid',
      'projectionPath',
      'managedTreePolicyVersion',
    ]) &&
    value.protocolVersion === 1 &&
    value.kind === 'projection_drifted' &&
    value.objectFormat === 'sha1' &&
    value.state === 'drifted' &&
    typeof value.reason === 'string' &&
    value.reason.length > 0 &&
    value.reason.length <= 128 &&
    typeof value.path === 'string' &&
    Buffer.byteLength(value.path, 'utf8') <= 4096 &&
    isSha1(value.acceptedCommitOid) &&
    isSha1(value.acceptedTreeOid) &&
    typeof value.projectionPath === 'string' &&
    isAbsolute(value.projectionPath) &&
    value.managedTreePolicyVersion === 2
  );
}

function isSha1(value: unknown): value is string {
  return typeof value === 'string' && SHA1_OID_PATTERN.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSourceImportObservation(
  value: unknown,
  expected: {
    readonly expectedSourceHeadCommitOid: string;
    readonly baselineRef: string;
    readonly managedTreePolicyVersion: 2;
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

function isCanonicalManagedPathV2(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    Buffer.byteLength(path, 'utf8') > 4096
  ) {
    return false;
  }
  return path.split('/').every((component) => {
    const bytes = Buffer.byteLength(component, 'utf8');
    return component !== '' && component !== '.' && component !== '..' && bytes <= 255;
  });
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

function invocationInvalid(message: string): GitoxideHelperInvocationError {
  return new GitoxideHelperInvocationError('gitoxide_helper_invocation_invalid', message);
}
