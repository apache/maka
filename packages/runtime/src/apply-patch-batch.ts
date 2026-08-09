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
    };

function operationFact(operation: ApplyPatchOperation): AppliedPatchOperationFact {
  return { type: operation.type, path: operation.path };
}

/** Execute one parsed patch in order while preserving the exact committed prefix. */
export async function executeApplyPatchOperations(
  operations: readonly ApplyPatchOperation[],
  apply: (operation: ApplyPatchOperation) => Promise<void>,
): Promise<ApplyPatchBatchResult> {
  const applied: AppliedPatchOperationFact[] = [];
  for (const operation of operations) {
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
