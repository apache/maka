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

import type { SessionTurnAccessRequest } from '@maka/runtime-host/protocol';

export async function collectAvailablePendingTurnRequests(
  queries: readonly Promise<readonly SessionTurnAccessRequest[]>[],
): Promise<SessionTurnAccessRequest[]> {
  const results = await Promise.allSettled(queries);
  const available = results.flatMap(
    (result) => result.status === 'fulfilled' ? [result.value] : [],
  );
  // A Host with no collaboration authority rejects every inbox query with
  // `operation_unavailable`. That is a valid composition (e.g. the default
  // Local Host), not a failure, so when no Host answered we surface an empty
  // inbox instead of throwing — the next poll repopulates it once a capable
  // Host appears.
  return available
    .flat()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
