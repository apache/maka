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
