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

import { safeLocalStorageGet, safeLocalStorageSet } from './browser-storage.js';
import type { WorkbarServices } from '../../features/workbar/index.js';

export const REVIEW_BASE_BRANCH_STORAGE_KEY = 'maka-session-review-base-branch-v1';

/** Desktop persistence for explicit per-Session comparison choices. */
export function createReviewBaseBranchPreferences(): WorkbarServices['reviewBaseBranchPreference'] {
  function readStoredBranches(): Record<string, string> {
    try {
      const stored: unknown = JSON.parse(safeLocalStorageGet(REVIEW_BASE_BRANCH_STORAGE_KEY) ?? '{}');
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

  return {
    read: (sessionId) => readStoredBranches()[sessionId] ?? null,
    write(sessionId, branch) {
      const stored = readStoredBranches();
      if (branch === null) delete stored[sessionId];
      else stored[sessionId] = branch;
      safeLocalStorageSet(REVIEW_BASE_BRANCH_STORAGE_KEY, JSON.stringify(stored));
    },
  };
}
