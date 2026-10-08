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
import { forEachHostSessionPage, type HostSessionRef } from './host-session-pages.js';

export interface SessionStorageUsageRouting<Scope> {
  /** Resolves a Desktop session id to its Host scope; rejects when the Host is gone. */
  resolve(sessionId: string): Promise<HostSessionRef<Scope>>;
  /** One `storage.usage.sessions.query` against one Host. */
  query(scope: Scope, sessionIds: readonly string[]): Promise<readonly SessionStorageUsage[]>;
}

/** A Host whose storage query failed is not asked again this soon. */
export const SESSION_STORAGE_HOST_FAILURE_COOLDOWN_MS = 60_000;

export type SessionStorageUsageReader = (
  sessionIds: readonly string[],
) => Promise<Record<string, SessionStorageUsage>>;

/**
 * Per-task storage keyed by Desktop session id. Tasks are grouped by the Host
 * that holds them and each Host is paged one bounded request at a time. A task
 * whose Host cannot be resolved, or a Host whose query fails, is left out
 * rather than failing the other Hosts' tasks.
 *
 * A failing Host is skipped for a cooldown, so a Host that is draining or
 * failing is not asked again for every newly visible row.
 */
export function createSessionStorageUsageReader<Scope>(
  routing: SessionStorageUsageRouting<Scope>,
  options: { readonly now?: () => number } = {},
): SessionStorageUsageReader {
  const now = options.now ?? Date.now;
  const failedScopes = new Map<string, number>();
  const isCoolingDown = (scopeKey: string) => {
    const failedAt = failedScopes.get(scopeKey);
    if (failedAt === undefined) return false;
    if (now() - failedAt < SESSION_STORAGE_HOST_FAILURE_COOLDOWN_MS) return true;
    failedScopes.delete(scopeKey);
    return false;
  };
  return async (sessionIds) => {
    const usage: Record<string, SessionStorageUsage> = {};
    await forEachHostSessionPage(
      sessionIds,
      {
        resolve: routing.resolve,
        pageSize: STORAGE_USAGE_SESSION_MAX_ITEMS,
        // This Host's remaining tasks stay unknown; the other Hosts still answer.
        tolerate: {
          skip: isCoolingDown,
          failed: (scopeKey) => failedScopes.set(scopeKey, now()),
        },
      },
      async ({ scope, hostIds, desktopIds }) => {
        for (const session of await routing.query(scope, hostIds)) {
          const desktopId = desktopIds.get(session.sessionId);
          if (desktopId) usage[desktopId] = session;
        }
      },
    );
    return usage;
  };
}
