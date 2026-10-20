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

export type CancelScheduledRefresh = () => void;

export interface RefreshReadCoordinator {
  /** An authority event arrived; invalidate older reads and debounce a refresh. */
  observe(): void;
  /** Read immediately, retiring any scheduled or in-flight older read. */
  refresh(): void;
  /** Cancel scheduled work and retire every in-flight read. */
  cancel(): void;
}

/**
 * Coordinates a debounced read of an authority-owned projection.
 *
 * The freshness invariant is intentionally stronger than "only the latest
 * query may apply": an authority event also invalidates a read that is
 * already in flight. That read may have captured the projection before the
 * event and can otherwise resolve after the newer state has reached the
 * caller. Callers decide which events are relevant; this module owns the
 * ordering and cancellation rule behind that small interface.
 */
export function createRefreshReadCoordinator<T>(input: {
  read: () => Promise<T>;
  apply: (result: T) => void;
  delayMs: number;
  schedule: (callback: () => void, delayMs: number) => CancelScheduledRefresh;
}): RefreshReadCoordinator {
  let cancelScheduled: CancelScheduledRefresh | undefined;
  let revision = 0;

  const dropScheduled = (): void => {
    cancelScheduled?.();
    cancelScheduled = undefined;
  };

  const run = (): void => {
    cancelScheduled = undefined;
    const readRevision = ++revision;
    void input.read().then(
      (result) => {
        if (readRevision !== revision) return;
        input.apply(result);
      },
      () => {},
    );
  };

  return {
    observe() {
      // Invalidate before scheduling. The previous read can resolve during the
      // debounce window, before the replacement read is issued.
      revision += 1;
      dropScheduled();
      cancelScheduled = input.schedule(run, input.delayMs);
    },
    refresh() {
      dropScheduled();
      run();
    },
    cancel() {
      dropScheduled();
      revision += 1;
    },
  };
}
