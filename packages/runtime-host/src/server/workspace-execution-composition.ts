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

import { createReadOnlyPermissionProfile } from '@maka/core/permission-profile';
import {
  createManagedExecutionBoundary,
  type ExecutionBoundary,
} from '@maka/core/sandbox-boundary';
import type {
  FilesystemWorkerClient,
  FilesystemWorkerClientOperation,
} from '@maka/runtime/filesystem-worker';

export interface RuntimeHostWorkspaceExecutionProfile {
  readonly kind: 'attached_checkout_v1';
  readonly cwd: string;
}

export type RuntimeHostWorkspaceReadOnlyOperation = Extract<
  FilesystemWorkerClientOperation,
  { kind: 'read' | 'glob' | 'grep' }
>;

export type RuntimeHostWorkspaceReadOnlyResult = Extract<
  Awaited<ReturnType<FilesystemWorkerClient['execute']>>,
  { kind: 'read' | 'read_image' | 'glob' | 'grep' }
>;

export interface RuntimeHostWorkspaceFilesystemWorker {
  execute(input: {
    readonly operation: RuntimeHostWorkspaceReadOnlyOperation;
    readonly cwd: string;
    readonly executionBoundary: ExecutionBoundary;
    readonly abortSignal?: AbortSignal;
  }): Promise<RuntimeHostWorkspaceReadOnlyResult>;
}

export type RuntimeHostWorkspaceExecutionErrorCode =
  | 'workspace_execution_draining'
  | 'filesystem_worker_unavailable'
  | 'workspace_operation_denied';

export class RuntimeHostWorkspaceExecutionError extends Error {
  constructor(
    readonly code: RuntimeHostWorkspaceExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHostWorkspaceExecutionError';
  }
}

export interface RuntimeHostWorkspaceExecutionComposition {
  readonly state: 'ready' | 'draining' | 'closed';
  executeReadOnly(
    profile: RuntimeHostWorkspaceExecutionProfile,
    operation: RuntimeHostWorkspaceReadOnlyOperation,
    abortSignal?: AbortSignal,
  ): Promise<RuntimeHostWorkspaceReadOnlyResult>;
  beginDrain(): void;
  close(): Promise<void>;
}

export interface CreateRuntimeHostWorkspaceExecutionCompositionInput {
  readonly filesystemWorker?: RuntimeHostWorkspaceFilesystemWorker;
}

export function createAttachedWorkspaceExecutionProfile(
  cwd: string,
): RuntimeHostWorkspaceExecutionProfile {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new RuntimeHostWorkspaceExecutionError(
      'workspace_operation_denied',
      'Attached workspace execution requires a non-empty cwd',
    );
  }
  return Object.freeze({ kind: 'attached_checkout_v1', cwd });
}

export function createRuntimeHostWorkspaceExecutionComposition(
  input: CreateRuntimeHostWorkspaceExecutionCompositionInput,
): RuntimeHostWorkspaceExecutionComposition {
  let state: RuntimeHostWorkspaceExecutionComposition['state'] = 'ready';
  let activeOperations = 0;
  const drainWaiters = new Set<() => void>();
  let closeTask: Promise<void> | undefined;

  const beginDrain = () => {
    if (state === 'ready') state = 'draining';
  };
  const waitForDrain = () => {
    if (activeOperations === 0) return Promise.resolve();
    return new Promise<void>((resolve) => drainWaiters.add(resolve));
  };
  const finishOperation = () => {
    activeOperations -= 1;
    if (activeOperations !== 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  };

  return {
    get state() {
      return state;
    },
    async executeReadOnly(profile, operation, abortSignal) {
      if (state !== 'ready') {
        throw new RuntimeHostWorkspaceExecutionError(
          'workspace_execution_draining',
          'Runtime Host workspace execution is draining',
        );
      }
      if (!isReadOnlyOperation(operation)) {
        throw new RuntimeHostWorkspaceExecutionError(
          'workspace_operation_denied',
          'Runtime Host workspace execution permits only Read, Glob, and Grep',
        );
      }
      if (!isWorkspaceExecutionProfile(profile)) {
        throw new RuntimeHostWorkspaceExecutionError(
          'workspace_operation_denied',
          'Runtime Host workspace execution profile is invalid',
        );
      }
      activeOperations += 1;
      try {
        if (!input.filesystemWorker) {
          throw new RuntimeHostWorkspaceExecutionError(
            'filesystem_worker_unavailable',
            'Attached workspace filesystem worker is unavailable',
          );
        }
        return await input.filesystemWorker.execute({
          operation,
          cwd: profile.cwd,
          executionBoundary: createManagedExecutionBoundary(createReadOnlyPermissionProfile(), 0),
          ...(abortSignal ? { abortSignal } : {}),
        });
      } finally {
        finishOperation();
      }
    },
    beginDrain,
    close() {
      closeTask ??= (async () => {
        beginDrain();
        await waitForDrain();
        state = 'closed';
      })();
      return closeTask;
    },
  };
}

function isReadOnlyOperation(input: unknown): input is RuntimeHostWorkspaceReadOnlyOperation {
  if (!input || typeof input !== 'object') return false;
  const kind = (input as { kind?: unknown }).kind;
  return kind === 'read' || kind === 'glob' || kind === 'grep';
}

function isWorkspaceExecutionProfile(
  input: unknown,
): input is RuntimeHostWorkspaceExecutionProfile {
  if (!input || typeof input !== 'object') return false;
  const candidate = input as {
    kind?: unknown;
    cwd?: unknown;
  };
  return (
    candidate.kind === 'attached_checkout_v1' &&
    typeof candidate.cwd === 'string' &&
    candidate.cwd.length > 0
  );
}
