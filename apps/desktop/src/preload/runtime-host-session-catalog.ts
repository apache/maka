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
  readonly access: 'owner' | 'session_guest';
  readonly sessions: Promise<DesktopSessionSummary[]>;
}

export interface RuntimeHostSessionCatalogCoverage {
  readonly sessions: DesktopSessionSummary[];
  readonly completeHostIds: string[];
}

export async function collectRuntimeHostSessionCatalogsWithCoverage(
  requests: readonly RuntimeHostSessionCatalogRequest[],
): Promise<RuntimeHostSessionCatalogCoverage> {
  const results = await Promise.allSettled(requests.map((request) => request.sessions));
  const fulfilled = results.flatMap((result, index) => result.status === 'fulfilled'
    ? [{ ...requests[index]!, sessions: result.value }]
    : []);
  const fulfilledRequests = new Set(
    results.flatMap((result, index) => result.status === 'fulfilled' ? [requests[index]!] : []),
  );
  if (requests.length > 0 && fulfilled.length === 0) {
    throw new AggregateError(
      results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
      'Every Runtime Host Session Catalog request failed',
    );
  }
  const hostIds = [...new Set(requests.map((request) => request.hostId))];
  return {
    sessions: sortSessionCatalogs(fulfilled.flatMap((entry) => entry.sessions)),
    completeHostIds: hostIds.filter((hostId) => {
      const hostRequests = requests.filter((request) => request.hostId === hostId);
      const ownerRequests = hostRequests.filter((request) => request.access === 'owner');
      return ownerRequests.length > 0
        ? ownerRequests.some((request) => fulfilledRequests.has(request))
        : hostRequests.every((request) => fulfilledRequests.has(request));
    }),
  };
}

export async function collectRuntimeHostSessionCatalogs(
  requests: readonly Promise<DesktopSessionSummary[]>[],
): Promise<DesktopSessionSummary[]> {
  const results = await Promise.allSettled(requests);
  const groups = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  if (requests.length > 0 && groups.length === 0) {
    throw new AggregateError(
      results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
      'Every Runtime Host Session Catalog request failed',
    );
  }
  return sortSessionCatalogs(groups.flat());
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
