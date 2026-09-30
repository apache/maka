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
  SESSION_REMOVE_PREVIEW_MAX_ITEMS,
  type SessionRemovePreviewInput,
  type SessionRemovePreviewResult,
} from '@maka/runtime-host/protocol';
import { forEachHostSessionPage, type HostSessionRef } from './host-session-pages.js';

export type SessionRemovalPreviewOptions = Omit<SessionRemovePreviewInput, 'sessionIds'>;

export interface SessionRemovalPreviewRouting<Scope> {
  /** Resolves a Desktop session id to its Host scope; rejects when the Host is gone. */
  resolve(sessionId: string): Promise<HostSessionRef<Scope>>;
  /** One `session.remove.preview` page against one Host. */
  query(scope: Scope, input: SessionRemovePreviewInput): Promise<SessionRemovePreviewResult>;
}

export type SessionRemovalPreviewReader = (
  sessionIds: readonly string[],
  options?: SessionRemovalPreviewOptions,
) => Promise<SessionRemovePreviewResult>;

/**
 * What deleting a set of tasks would remove, summed over bounded pages per
 * Host. Each page deduplicates what its own targets share; the archived task
 * rows a Client selects are distinct tasks, so pages do not overlap.
 *
 * All or nothing: a task whose Host cannot be resolved, or a page that fails,
 * rejects the whole preview — a sum over the Hosts that answered would read
 * as the full cost of a delete that also reaches the others. Bytes are
 * reported only when every page measured them.
 */
export function createSessionRemovalPreviewReader<Scope>(
  routing: SessionRemovalPreviewRouting<Scope>,
): SessionRemovalPreviewReader {
  return async (sessionIds, options = {}) => {
    let archivableSubtaskCount = 0;
    let removedSubtaskCount = 0;
    let worktreeCount = 0;
    let bytes: number | undefined = 0;
    await forEachHostSessionPage(
      sessionIds,
      { resolve: routing.resolve, pageSize: SESSION_REMOVE_PREVIEW_MAX_ITEMS },
      async ({ scope, hostIds }) => {
        const page = await routing.query(scope, { ...options, sessionIds: [...hostIds] });
        archivableSubtaskCount += page.archivableSubtaskCount;
        removedSubtaskCount += page.removedSubtaskCount;
        worktreeCount += page.worktreeCount;
        bytes = bytes === undefined || page.bytes === undefined ? undefined : bytes + page.bytes;
      },
    );
    return {
      archivableSubtaskCount,
      removedSubtaskCount,
      worktreeCount,
      ...(bytes === undefined || !options.measureBytes ? {} : { bytes }),
    };
  };
}
