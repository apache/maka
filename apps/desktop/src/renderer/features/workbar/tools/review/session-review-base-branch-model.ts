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

import type { GitReviewSnapshot } from '@maka/core/git-review';

export const REVIEW_BASE_BRANCH_STORAGE_KEY = 'maka-session-review-base-branch-v1';

// A local wrapper rather than @/browser-storage: the renderer architecture
// check forbids new feature-to-legacy imports, and a feature may use Web
// Storage directly. Storage can be unavailable in restricted renderer contexts.
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Persistence is a preference, not a correctness requirement.
  }
}

function readStoredBaseBranches(): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(readStorage(REVIEW_BASE_BRANCH_STORAGE_KEY) ?? '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(
        ([, value]) => typeof value === 'string' && value.length > 0,
      ),
    );
  } catch {
    return {};
  }
}

export function readSessionReviewBaseBranch(sessionId: string): string | null {
  return readStoredBaseBranches()[sessionId] ?? null;
}

/** `null` drops the Session's entry so the next read falls back to the resolved base. */
export function persistSessionReviewBaseBranch(
  sessionId: string,
  branch: string | null,
): void {
  const stored = readStoredBaseBranches();
  if (branch === null) delete stored[sessionId];
  else stored[sessionId] = branch;
  writeStorage(REVIEW_BASE_BRANCH_STORAGE_KEY, JSON.stringify(stored));
}

/** The request omits `baseBranch` entirely while nothing is selected. */
export function reviewBaseBranchRequestValue(
  selection: string | null,
): string | undefined {
  return selection ?? undefined;
}

/**
 * Adopts the base branch the backend resolved for a request that omitted one,
 * so the Session pins a real branch instead of re-resolving on every read.
 * The resolved branch must be one of the offered options: a value the backend
 * would reject on the next read is worse than staying unresolved.
 */
export function resolveAdoptedBaseBranch(
  selection: string | null,
  snapshot: Pick<GitReviewSnapshot, 'baseBranch' | 'baseBranchOptions'>,
): string | null {
  if (selection !== null) return selection;
  const resolved = snapshot.baseBranch;
  if (resolved === null) return null;
  return snapshot.baseBranchOptions.includes(resolved) ? resolved : null;
}
