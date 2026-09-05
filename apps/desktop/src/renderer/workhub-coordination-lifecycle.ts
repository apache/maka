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

import type { DesktopRuntimeHostProfileChangedEvent } from '../preload/bridge-contract.js';
import { parseDesktopSessionKey } from '../shared/runtime-host-identity.js';

export type WorkHubCoordinationHostChange = Pick<
  DesktopRuntimeHostProfileChangedEvent,
  'hostId' | 'isDefault' | 'readiness' | 'removed'
>;

const UNAVAILABLE_DEFAULT_HOST = 'The default Runtime Host is unavailable';

/** Keeps active WorkHub resolution aligned with the current default Runtime Host. */
export function startWorkHubCoordinationLifecycle(input: {
  readonly resolve: () => Promise<string>;
  readonly subscribeHostChanges: (
    handler: (event: WorkHubCoordinationHostChange) => void,
  ) => () => void;
  readonly subscribeAvailabilityChanges: (handler: () => void) => () => void;
  readonly onResolving: () => void;
  readonly onResolved: (sessionId: string) => void;
  readonly reportFailure: (error: unknown, retry: () => void) => void;
}): () => void {
  let stopped = false;
  let generation = 0;
  let failedGeneration: number | undefined;
  let resolvedHostId: string | undefined;

  const revoke = () => {
    const currentGeneration = ++generation;
    failedGeneration = undefined;
    resolvedHostId = undefined;
    input.onResolving();
    return currentGeneration;
  };
  const reportGenerationFailure = (currentGeneration: number, error: unknown) => {
    failedGeneration = currentGeneration;
    input.reportFailure(error, () => {
      if (!stopped && failedGeneration === currentGeneration) beginResolve();
    });
  };
  const resolveGeneration = (currentGeneration: number) => {
    void input.resolve()
      .then((sessionId) => {
        if (stopped || currentGeneration !== generation) return;
        resolvedHostId = parseDesktopSessionKey(sessionId).hostId;
        failedGeneration = undefined;
        input.onResolved(sessionId);
      })
      .catch((error) => {
        if (stopped || currentGeneration !== generation) return;
        reportGenerationFailure(currentGeneration, error);
      });
  };
  const beginResolve = () => resolveGeneration(revoke());

  const unsubscribeHosts = input.subscribeHostChanges((event) => {
    if (stopped || !event.isDefault) return;
    if (
      resolvedHostId !== undefined &&
      event.hostId === resolvedHostId &&
      event.readiness !== 'unavailable' &&
      !event.removed
    ) {
      return;
    }
    const currentGeneration = revoke();
    if (event.readiness === 'ready') {
      resolveGeneration(currentGeneration);
      return;
    }
    // Connecting and reconnecting are still on their way to an answer, so the
    // loading state stays honest. An unavailable default Host is not: without a
    // reported failure the surface would hold that spinner forever, and the
    // availability subscription only reopens a generation that failed.
    if (event.readiness === 'unavailable' || event.removed) {
      reportGenerationFailure(currentGeneration, new Error(UNAVAILABLE_DEFAULT_HOST));
    }
  });
  const unsubscribeAvailability = input.subscribeAvailabilityChanges(() => {
    if (!stopped && failedGeneration === generation) beginResolve();
  });
  beginResolve();
  return () => {
    stopped = true;
    generation += 1;
    failedGeneration = undefined;
    unsubscribeHosts();
    unsubscribeAvailability();
  };
}
