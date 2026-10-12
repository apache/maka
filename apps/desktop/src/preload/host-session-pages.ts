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

export interface HostSessionRef<Scope> {
  readonly scope: Scope;
  readonly scopeKey: string;
  /** The Host-local id. */
  readonly sessionId: string;
}

export interface HostSessionPage<Scope> {
  readonly scope: Scope;
  readonly scopeKey: string;
  /** Host-local ids of this page, at most the page size. */
  readonly hostIds: readonly string[];
  /** Host-local id to the Desktop id it was asked by. */
  readonly desktopIds: ReadonlyMap<string, string>;
}

export interface HostSessionPaging<Scope> {
  /** Resolves a Desktop session id to its Host scope; rejects when the Host is gone. */
  resolve(sessionId: string): Promise<HostSessionRef<Scope>>;
  readonly pageSize: number;
  /**
   * Failure policy. Absent: an unresolvable id or a failed page rejects the
   * whole call. Present: such an id is left out, a Host \`skip\` names is not
   * asked, and a failed page ends only its own Host's pages.
   */
  readonly tolerate?: {
    skip(scopeKey: string): boolean;
    failed(scopeKey: string, error: unknown): void;
  };
}

/**
 * Groups Desktop session ids by the Host that holds them, each id once, and
 * visits each Host's ids in bounded pages, one request at a time per Host.
 * Hosts are visited side by side: one slow Host does not hold up another's
 * pages, and no Host ever has more than one page in flight.
 */
export async function forEachHostSessionPage<Scope>(
  sessionIds: readonly string[],
  paging: HostSessionPaging<Scope>,
  visit: (page: HostSessionPage<Scope>) => Promise<void>,
): Promise<void> {
  const groups = new Map<string, { scope: Scope; desktopIds: Map<string, string> }>();
  for (const sessionId of new Set(sessionIds)) {
    let ref: HostSessionRef<Scope>;
    try {
      ref = await paging.resolve(sessionId);
    } catch (error) {
      if (paging.tolerate) continue;
      throw error;
    }
    if (paging.tolerate?.skip(ref.scopeKey)) continue;
    const group = groups.get(ref.scopeKey) ?? { scope: ref.scope, desktopIds: new Map() };
    group.desktopIds.set(ref.sessionId, sessionId);
    groups.set(ref.scopeKey, group);
  }
  await Promise.all(
    [...groups].map(async ([scopeKey, { scope, desktopIds }]) => {
      const ids = [...desktopIds.keys()];
      try {
        for (let offset = 0; offset < ids.length; offset += paging.pageSize) {
          const hostIds = ids.slice(offset, offset + paging.pageSize);
          await visit({ scope, scopeKey, hostIds, desktopIds });
        }
      } catch (error) {
        if (!paging.tolerate) throw error;
        paging.tolerate.failed(scopeKey, error);
      }
    }),
  );
}
