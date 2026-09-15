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

import type { ExecutionSessionWriter } from '@maka/storage/execution-stores';
import type { InteractiveInteractionStoreWriterFacade } from '@maka/storage/interaction-store';

/**
 * Process-local read projection of the canonical pending requests. Refreshes run
 * under the Interaction coordinator's Session admission, including withdrawals
 * that have no Runtime answer event. Catalog reads never query these stores.
 */
export class SessionInteractionActivityProjection {
  readonly #counts = new Map<string, ReadonlyMap<string, number>>();

  constructor(
    private readonly sources: {
      interactions: Pick<InteractiveInteractionStoreWriterFacade, 'listSessionPending'>;
      sandboxBoundaries: Pick<ExecutionSessionWriter, 'listPendingSandboxBoundaryRequests'>;
      onChanged(sessionId: string): void;
    },
  ) {}

  readTurnPendingInteractionCount(sessionId: string, turnId: string): number | undefined {
    const counts = this.#counts.get(sessionId);
    return counts ? (counts.get(turnId) ?? 0) : undefined;
  }

  async refresh(sessionId: string): Promise<void> {
    const [interactions, boundaries] = await Promise.all([
      this.sources.interactions.listSessionPending(sessionId),
      this.sources.sandboxBoundaries.listPendingSandboxBoundaryRequests(sessionId),
    ]);
    const counts = new Map<string, number>();
    for (const request of [...interactions, ...boundaries]) {
      // Handoffs replace the physical run id while retaining this logical Turn.
      // A new graph activation has a different Turn and cannot inherit its wait.
      if (request.turnId === undefined) continue;
      counts.set(request.turnId, (counts.get(request.turnId) ?? 0) + 1);
    }
    const previous = this.#counts.get(sessionId);
    if (
      previous?.size === counts.size &&
      [...counts].every(([turnId, count]) => previous.get(turnId) === count)
    ) {
      return;
    }
    this.#counts.set(sessionId, counts);
    this.sources.onChanged(sessionId);
  }
}
