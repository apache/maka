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
  type SessionRemovePreviewResult,
} from '@maka/runtime-host/protocol';

export interface SessionRemovalPreviewRouting<Scope> {
  /** Resolves a Desktop session id to its Host scope; rejects when the Host is gone. */
  resolve(sessionId: string): Promise<{
    readonly scope: Scope;
    readonly scopeKey: string;
    readonly sessionId: string;
  }>;
  /** One `session.remove.preview` page against one Host. */
  query(scope: Scope, sessionIds: readonly string[]): Promise<SessionRemovePreviewResult>;
}

export type SessionRemovalPreviewReader = (
  sessionIds: readonly string[],
) => Promise<SessionRemovePreviewResult>;

/**
 * What deleting a set of tasks would remove, keyed by Desktop session id.
 * Tasks are grouped by the Host that holds them and each Host is paged one
 * bounded request at a time, so a large selection never becomes one unbounded
 * Host query. Pages are summed; each Host deduplicates within its own pages,
 * and the Desktop only ever asks about archived task rows, which do not share
 * revision families.
 *
 * All or nothing: a task whose Host cannot be resolved, or a page that fails,
 * rejects the whole preview. A sum over the Hosts that answered would read as
 * the full cost of a delete that also reaches the ones that did not.
 */
export function createSessionRemovalPreviewReader<Scope>(
  routing: SessionRemovalPreviewRouting<Scope>,
): SessionRemovalPreviewReader {
  return async (sessionIds) => {
    const byScope = new Map<string, { scope: Scope; hostIds: Set<string> }>();
    for (const sessionId of new Set(sessionIds)) {
      const ref = await routing.resolve(sessionId);
      const group = byScope.get(ref.scopeKey) ?? { scope: ref.scope, hostIds: new Set<string>() };
      group.hostIds.add(ref.sessionId);
      byScope.set(ref.scopeKey, group);
    }
    const total = {
      archivableSubtaskCount: 0,
      removedSubtaskCount: 0,
      worktreeCount: 0,
      bytes: 0,
    };
    for (const { scope, hostIds } of byScope.values()) {
      const ids = [...hostIds];
      for (let offset = 0; offset < ids.length; offset += SESSION_REMOVE_PREVIEW_MAX_ITEMS) {
        const page = await routing.query(
          scope,
          ids.slice(offset, offset + SESSION_REMOVE_PREVIEW_MAX_ITEMS),
        );
        total.archivableSubtaskCount += page.archivableSubtaskCount;
        total.removedSubtaskCount += page.removedSubtaskCount;
        total.worktreeCount += page.worktreeCount;
        total.bytes += page.bytes;
      }
    }
    return total;
  };
}
