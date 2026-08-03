export interface EvidenceReadBudget {
  readonly maxRecords: number;
  readonly maxBytes: number;
}

export type BoundedEvidenceReadResult<T> =
  | {
      readonly status: 'complete';
      readonly records: readonly T[];
      readonly sourceRecordCount: number;
      readonly storedBytes: number;
    }
  | { readonly status: 'limit_exceeded' };

export function assertEvidenceReadBudget(budget: EvidenceReadBudget): void {
  if (!Number.isSafeInteger(budget.maxRecords) || budget.maxRecords < 0) {
    throw new RangeError('Evidence record limit must be a non-negative integer');
  }
  if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 0) {
    throw new RangeError('Evidence byte limit must be a non-negative integer');
  }
}

export function measureEvidenceRows(
  rows: readonly { stored_bytes?: unknown }[],
  budget: EvidenceReadBudget,
  invalidRowMessage: string,
): { readonly sourceRecordCount: number; readonly storedBytes: number } | undefined {
  if (rows.length > budget.maxRecords) return undefined;
  let storedBytes = 0;
  for (const row of rows) {
    if (
      typeof row.stored_bytes !== 'number' ||
      !Number.isSafeInteger(row.stored_bytes) ||
      row.stored_bytes < 0
    ) {
      throw new Error(invalidRowMessage);
    }
    storedBytes += row.stored_bytes;
    if (!Number.isSafeInteger(storedBytes) || storedBytes > budget.maxBytes) return undefined;
  }
  return { sourceRecordCount: rows.length, storedBytes };
}
