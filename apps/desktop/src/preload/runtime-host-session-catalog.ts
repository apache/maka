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

import type { DesktopSessionSummary } from './bridge-contract.js';

export interface RuntimeHostSessionCatalogRequest {
  readonly hostId: string;
  readonly sessions: Promise<DesktopSessionSummary[]>;
}

export interface RuntimeHostSessionCatalogCoverage {
  readonly sessions: DesktopSessionSummary[];
  /** Hosts whose Owner catalog answered authoritatively. */
  readonly completeHostIds: string[];
}

export interface RuntimeHostSessionCatalogSnapshot extends RuntimeHostSessionCatalogCoverage {
  /** Owner profiles still retained by Desktop. */
  readonly knownOwnerProfileIds: string[];
  /** The mount service's complete Guest projection, when it answered. */
  readonly guestSessions?: DesktopSessionSummary[];
}

export interface RuntimeHostSessionCatalogRefresher {
  refresh(): Promise<RuntimeHostSessionCatalogCoverage>;
  /** Commit a newly created Session and fence any catalog read started before it. */
  admit(session: DesktopSessionSummary): void;
  /** Begin an asynchronous bootstrap read whose result may later seed the catalog. */
  beginSeed(): {
    commit(catalog: RuntimeHostSessionCatalogCoverage): boolean;
  };
}

export function createRuntimeHostSessionCatalogRefresher(input: {
  readonly listCatalog: () => Promise<RuntimeHostSessionCatalogCoverage>;
  readonly currentCatalog: () => RuntimeHostSessionCatalogCoverage;
  readonly commitCatalog: (catalog: RuntimeHostSessionCatalogCoverage) => void;
}): RuntimeHostSessionCatalogRefresher {
  let dirty = false;
  let catalogGeneration = 0;
  let active: Promise<RuntimeHostSessionCatalogCoverage> | undefined;
  const commitCatalog = (catalog: RuntimeHostSessionCatalogCoverage): void => {
    input.commitCatalog(catalog);
    catalogGeneration += 1;
  };
  const drain = async (): Promise<RuntimeHostSessionCatalogCoverage> => {
    try {
      let catalog = input.currentCatalog();
      do {
        dirty = false;
        try {
          const candidate = await input.listCatalog();
          // A later invalidation supersedes this observation before it can
          // mutate the authority map. The trailing read is the one to commit.
          if (dirty) continue;
          catalog = candidate;
          commitCatalog(candidate);
        } catch (error) {
          // Like a successful stale read, a superseded failure cannot decide
          // the drain. Let the already-admitted trailing read decide instead.
          if (!dirty) throw error;
          catalog = input.currentCatalog();
        }
      } while (dirty);
      return catalog;
    } finally {
      active = undefined;
    }
  };
  return {
    admit(session) {
      // The creation result is newer than every read already in flight. Mark
      // those observations stale before publishing it so none can erase a
      // Session that the Host has just committed.
      dirty = true;
      const current = input.currentCatalog();
      commitCatalog({
        ...current,
        sessions: sortSessionCatalogs([
          ...current.sessions.filter(({ id }) => id !== session.id),
          session,
        ]),
      });
    },
    beginSeed() {
      const admittedCatalogGeneration = catalogGeneration;
      return {
        commit(catalog) {
          if (catalogGeneration !== admittedCatalogGeneration) return false;
          // The bootstrap snapshot is now the newest accepted observation.
          // Fence an older catalog read before publishing it.
          dirty = true;
          commitCatalog(catalog);
          return true;
        },
      };
    },
    refresh() {
      dirty = true;
      if (!active) active = drain();
      return active;
    },
  };
}

export async function resolveRuntimeHostSessionCatalog(
  current: readonly DesktopSessionSummary[],
  coverage: Promise<RuntimeHostSessionCatalogCoverage>,
  knownOwnerProfileIds: () => readonly string[],
  guestSessions: Promise<DesktopSessionSummary[]>,
): Promise<RuntimeHostSessionCatalogCoverage> {
  const [snapshot, guests] = await Promise.all([
    coverage,
    guestSessions.then(
      (sessions) => ({ available: true as const, sessions }),
      () => ({ available: false as const, sessions: [] }),
    ),
  ]);
  return {
    sessions: reconcileRuntimeHostSessionCatalog(current, {
      ...snapshot,
      knownOwnerProfileIds: [...knownOwnerProfileIds()],
      ...(guests.available ? { guestSessions: guests.sessions } : {}),
    }),
    completeHostIds: snapshot.completeHostIds,
  };
}

export async function collectRuntimeHostSessionCatalogsWithCoverage(
  requests: readonly RuntimeHostSessionCatalogRequest[],
): Promise<RuntimeHostSessionCatalogCoverage> {
  const results = await Promise.allSettled(requests.map((request) => request.sessions));
  const fulfilled = results.flatMap((result, index) =>
    result.status === 'fulfilled' ? [{ ...requests[index]!, sessions: result.value }] : [],
  );
  return {
    sessions: sortSessionCatalogs(fulfilled.flatMap((entry) => entry.sessions)),
    completeHostIds: [...new Set(fulfilled.map(({ hostId }) => hostId))],
  };
}

/**
 * An observation may establish an unknown Session authority, but only an
 * accepted catalog may replace one. Returns false when the observation came
 * from a different profile and should therefore trigger a generic refresh.
 */
export function recordObservedRuntimeHostSessionAuthority(
  authorities: Map<string, string>,
  sessionId: string,
  profileId: string,
): boolean {
  const accepted = authorities.get(sessionId);
  if (accepted === undefined) {
    authorities.set(sessionId, profileId);
    return true;
  }
  return accepted === profileId;
}

/**
 * Commits complete Owner catalogs per Host while retaining the last accepted
 * Owner rows for an authority that cannot answer. Guest rows come exclusively
 * from the mount service: a successful mount read replaces them completely,
 * while a failed read retains the last authenticated projection.
 */
export function reconcileRuntimeHostSessionCatalog(
  current: readonly DesktopSessionSummary[],
  snapshot: RuntimeHostSessionCatalogSnapshot,
): DesktopSessionSummary[] {
  const completeHostIds = new Set(snapshot.completeHostIds);
  const knownOwnerProfileIds = new Set(snapshot.knownOwnerProfileIds);
  const liveSessions = sortSessionCatalogs([
    ...snapshot.sessions,
    ...(snapshot.guestSessions ?? []),
  ]);
  const liveSessionIds = new Set(liveSessions.map(({ id }) => id));
  const fallbackSessions = current.filter(
    (session) =>
      !liveSessionIds.has(session.id) &&
      (session.shared === true
        ? snapshot.guestSessions === undefined
        : knownOwnerProfileIds.has(session.profileId) &&
          !completeHostIds.has(session.runtimeHostId)),
  );
  return sortSessionCatalogs([...liveSessions, ...fallbackSessions]);
}

function sortSessionCatalogs(sessions: DesktopSessionSummary[]): DesktopSessionSummary[] {
  const unique = new Map<string, DesktopSessionSummary>();
  for (const session of sessions) {
    const current = unique.get(session.id);
    if (!current || (current.shared === true && session.shared !== true)) {
      unique.set(session.id, session);
    }
  }
  return [...unique.values()].sort((left, right) => {
    if (left.activityAt === undefined || right.activityAt === undefined) {
      throw new Error('Runtime Host Session Catalog activity is unavailable');
    }
    return right.activityAt - left.activityAt || left.id.localeCompare(right.id);
  });
}
