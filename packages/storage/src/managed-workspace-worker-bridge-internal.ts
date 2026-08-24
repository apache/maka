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

import {
  createManagedExecutionBoundary,
  type ExecutionBoundary,
} from '@maka/core/sandbox-boundary';
import { createReadOnlyPermissionProfile } from '@maka/core/permission-profile';
import {
  requireManagedWorkspaceExecutionScopeInternal,
  type ManagedWorkspaceExecutionScope,
} from './managed-workspace-execution-authority-internal.js';

export type ManagedWorkspaceReadOnlyOperation =
  | {
      readonly kind: 'read';
      readonly path: string;
      readonly offset?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: 'glob';
      readonly path: string;
      readonly pattern: string;
      readonly limit?: number;
    }
  | {
      readonly kind: 'grep';
      readonly path: string;
      readonly pattern: string;
      readonly glob?: string;
      readonly maxCountPerFile: number;
      readonly limit: number;
      readonly timeoutMs: number;
    };

interface ManagedWorkspaceFilesystemWorkerInput {
  readonly operation: ManagedWorkspaceReadOnlyOperation;
  readonly cwd: string;
  readonly executionBoundary: ExecutionBoundary;
  readonly abortSignal?: AbortSignal;
}

export type ManagedWorkspaceReadOnlyResult =
  | { readonly kind: 'read'; readonly content: string }
  | {
      readonly kind: 'read_image';
      readonly base64: string;
      readonly mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    }
  | { readonly kind: 'glob'; readonly files: readonly string[] }
  | { readonly kind: 'grep'; readonly matches: readonly string[] };

export interface ManagedWorkspaceFilesystemWorker {
  /**
   * Resolves only after the one-shot filesystem operation and every process it
   * owns have reached a terminal lifecycle state. Implementations must not
   * return a detached filesystem effect to the caller. The production adapter
   * satisfies this contract through FilesystemWorkerClient; M1.2 admits only
   * read-only operations, so a host crash cannot leave a workspace mutation.
   */
  execute(input: ManagedWorkspaceFilesystemWorkerInput): Promise<ManagedWorkspaceReadOnlyResult>;
}

export type ManagedWorkspaceWorkerBridgeErrorCode = 'managed_workspace_operation_denied';

export class ManagedWorkspaceWorkerBridgeError extends Error {
  constructor(
    readonly code: ManagedWorkspaceWorkerBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManagedWorkspaceWorkerBridgeError';
  }
}

export interface ManagedWorkspaceWorkerBridgeInternal {
  execute(
    scope: ManagedWorkspaceExecutionScope,
    operation: ManagedWorkspaceReadOnlyOperation,
    abortSignal?: AbortSignal,
  ): Promise<ManagedWorkspaceReadOnlyResult>;
}

/**
 * Owner-bound bridge from an opaque, revocable scope to the filesystem worker.
 * The caller never supplies or receives cwd. Runtime validation intentionally
 * repeats the TypeScript allowlist so JavaScript/forged inputs fail closed.
 */
export function createManagedWorkspaceWorkerBridgeInternal(
  ownerToken: object,
  worker: ManagedWorkspaceFilesystemWorker,
): ManagedWorkspaceWorkerBridgeInternal {
  const bridge: ManagedWorkspaceWorkerBridgeInternal = {
    async execute(
      scope: ManagedWorkspaceExecutionScope,
      operation: ManagedWorkspaceReadOnlyOperation,
      abortSignal?: AbortSignal,
    ) {
      if (!isReadOnlyOperation(operation)) {
        throw new ManagedWorkspaceWorkerBridgeError(
          'managed_workspace_operation_denied',
          'Managed workspace execution currently permits only Read, Glob, and Grep operations',
        );
      }
      const state = requireManagedWorkspaceExecutionScopeInternal(ownerToken, scope);
      if (state.workspaceEffect !== 'none' || state.provisioning !== 'canonical_tree_only_v1') {
        throw new ManagedWorkspaceWorkerBridgeError(
          'managed_workspace_operation_denied',
          'Managed workspace execution scope does not permit filesystem mutation',
        );
      }
      return await worker.execute({
        operation,
        cwd: state.cwd,
        executionBoundary: createManagedExecutionBoundary(createReadOnlyPermissionProfile(), 0),
        ...(abortSignal ? { abortSignal } : {}),
      });
    },
  };
  return Object.freeze(bridge);
}

function isReadOnlyOperation(input: unknown): input is ManagedWorkspaceReadOnlyOperation {
  if (!input || typeof input !== 'object') return false;
  const kind = (input as { kind?: unknown }).kind;
  return kind === 'read' || kind === 'glob' || kind === 'grep';
}
