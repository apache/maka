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

import type { ApplyPatchOperation } from './filesystem-executor.js';
import { formatSyntheticToolErrorText } from './tool-runtime.js';

export interface AppliedPatchOperationFact {
  readonly type: ApplyPatchOperation['type'];
  readonly path: string;
}

export type ApplyPatchBatchResult =
  | {
      readonly status: 'completed';
      readonly applied: readonly AppliedPatchOperationFact[];
      readonly output: string;
    }
  | {
      readonly status: 'failed';
      readonly applied: readonly AppliedPatchOperationFact[];
      readonly failed: AppliedPatchOperationFact;
      readonly error: string;
    }
  | {
      readonly status: 'failed';
      readonly applied: readonly AppliedPatchOperationFact[];
      readonly stoppedBefore: AppliedPatchOperationFact;
      readonly error: string;
    };

function operationFact(operation: ApplyPatchOperation): AppliedPatchOperationFact {
  return { type: operation.type, path: operation.path };
}

/** Execute one parsed patch in order while preserving the exact committed prefix. */
export async function executeApplyPatchOperations(
  operations: readonly ApplyPatchOperation[],
  apply: (operation: ApplyPatchOperation) => Promise<void>,
  abortSignal?: AbortSignal,
): Promise<ApplyPatchBatchResult> {
  const applied: AppliedPatchOperationFact[] = [];
  for (const operation of operations) {
    if (abortSignal?.aborted) {
      const stoppedBefore = operationFact(operation);
      const appliedText = applied.length
        ? ` Applied before stop: ${applied.map((item) => `${item.type} ${item.path}`).join(', ')}.`
        : ' No file operation was applied.';
      return {
        status: 'failed',
        applied,
        stoppedBefore,
        error: formatSyntheticToolErrorText(
          `ApplyPatch stopped before ${stoppedBefore.type} ${stoppedBefore.path} after ${applied.length} of ${operations.length} operations.${appliedText}`,
        ),
      };
    }
    try {
      await apply(operation);
      applied.push(operationFact(operation));
    } catch (error) {
      const failed = operationFact(operation);
      const appliedText = applied.length
        ? ` Applied before failure: ${applied.map((item) => `${item.type} ${item.path}`).join(', ')}.`
        : ' No file operation was applied.';
      return {
        status: 'failed',
        applied,
        failed,
        error: formatSyntheticToolErrorText(
          `ApplyPatch failed on ${failed.type} ${failed.path} after ${applied.length} of ${operations.length} operations.${appliedText} ${error instanceof Error ? error.message : String(error)}`,
        ),
      };
    }
  }
  return {
    status: 'completed',
    applied,
    output: `Applied ${applied.length} file operation${applied.length === 1 ? '' : 's'}.`,
  };
}
