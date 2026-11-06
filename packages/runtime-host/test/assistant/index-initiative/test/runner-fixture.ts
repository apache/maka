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

import type {
  DiscoveryLane,
  DiscoveryRunner,
} from '../../../../src/assistant/index-initiative/runner.js';
import type { InitiativeStore } from '../../../../src/assistant/index-initiative/store.js';

/** A controlled investigation; all admission and slot ownership use the real Runner. */
export function laneFixture(runner: DiscoveryRunner, store: InitiativeStore, lane: DiscoveryLane) {
  let wanted = false;
  let release = () => {};
  let gate = Promise.resolve();
  let calls = 0;
  runner.register(lane, {
    store,
    ready: () => store.fence(),
    request: async () => wanted,
    prepare: async (job) => {
      wanted = false;
      store.update((s) => {
        s.active = { id: job.id, startedAt: job.startedAt };
      });
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {};
    },
    recovery: async () => undefined,
    reattach: () => {},
    defer: () =>
      store.update((s) => {
        s.active = null;
      }),
    unfinished: () => !!store.get()?.active,
    run: async () => {
      calls++;
      await gate;
      store.update((s) => {
        s.active = null;
      });
    },
    error: (error) => {
      throw error;
    },
  });
  return {
    request() {
      wanted = true;
      runner.request(lane);
    },
    async start() {
      this.request();
      await runner.tick();
    },
    async finish() {
      release();
      await runner.running(lane);
    },
    calls: () => calls,
  };
}

/** An on-disk snapshot from before Runner migration (not a live state mutation). */
export function legacyState(store: InitiativeStore, change: (s: any) => void) {
  const state = store.get();
  delete state.runnerSchema;
  change(state);
  store.saveConfiguration(state);
}
