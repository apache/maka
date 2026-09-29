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
  STORAGE_USAGE_SESSION_MAX_ITEMS,
  type SessionStorageUsage,
} from '@maka/runtime-host/protocol';

export interface SessionStorageUsageRouting<Scope> {
  /** Resolves a Desktop session id to its Host scope; rejects when the Host is gone. */
  resolve(sessionId: string): Promise<{
    readonly scope: Scope;
    readonly scopeKey: string;
    readonly sessionId: string;
  }>;
  /** One `storage.usage.sessions.query` against one Host. */
  query(scope: Scope, sessionIds: readonly string[]): Promise<readonly SessionStorageUsage[]>;
}

/**
 * Per-task storage keyed by Desktop session id. Tasks are grouped by the Host
 * that holds them and each Host is paged one bounded request at a time. A task
 * whose Host cannot be resolved, or a Host whose query fails, is left out
 * rather than failing the other Hosts' tasks.
 */
export async function loadSessionStorageUsage<Scope>(
  sessionIds: readonly string[],
  routing: SessionStorageUsageRouting<Scope>,
): Promise<Record<string, SessionStorageUsage>> {
  const byScope = new Map<string, { scope: Scope; desktopIds: Map<string, string> }>();
  for (const sessionId of new Set(sessionIds)) {
    let ref: Awaited<ReturnType<SessionStorageUsageRouting<Scope>['resolve']>>;
    try {
      ref = await routing.resolve(sessionId);
    } catch {
      continue;
    }
    const group = byScope.get(ref.scopeKey) ?? {
      scope: ref.scope,
      desktopIds: new Map<string, string>(),
    };
    group.desktopIds.set(ref.sessionId, sessionId);
    byScope.set(ref.scopeKey, group);
  }
  const usage: Record<string, SessionStorageUsage> = {};
  await Promise.all(
    [...byScope.values()].map(async ({ scope, desktopIds }) => {
      const hostIds = [...desktopIds.keys()];
      try {
        for (let offset = 0; offset < hostIds.length; offset += STORAGE_USAGE_SESSION_MAX_ITEMS) {
          const sessions = await routing.query(
            scope,
            hostIds.slice(offset, offset + STORAGE_USAGE_SESSION_MAX_ITEMS),
          );
          for (const session of sessions) {
            const desktopId = desktopIds.get(session.sessionId);
            if (desktopId) usage[desktopId] = session;
          }
        }
      } catch {
        // This Host's remaining tasks stay unknown; the other Hosts still answer.
      }
    }),
  );
  return usage;
}
