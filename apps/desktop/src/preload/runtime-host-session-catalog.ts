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
  readonly completeHostIds: string[];
}

export async function collectRuntimeHostSessionCatalogsWithCoverage(
  requests: readonly RuntimeHostSessionCatalogRequest[],
): Promise<RuntimeHostSessionCatalogCoverage> {
  const results = await Promise.allSettled(requests.map((request) => request.sessions));
  const fulfilled = results.flatMap((result, index) => result.status === 'fulfilled'
    ? [{ hostId: requests[index]!.hostId, sessions: result.value }]
    : []);
  if (requests.length > 0 && fulfilled.length === 0) {
    throw new AggregateError(
      results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
      'Every Runtime Host Session Catalog request failed',
    );
  }
  return {
    sessions: sortSessionCatalogs(fulfilled.flatMap((entry) => entry.sessions)),
    completeHostIds: fulfilled.map((entry) => entry.hostId),
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
  return sessions.sort((left, right) => {
    if (left.activityAt === undefined || right.activityAt === undefined) {
      throw new Error('Runtime Host Session Catalog activity is unavailable');
    }
    return right.activityAt - left.activityAt || left.id.localeCompare(right.id);
  });
}
