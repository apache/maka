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

import { refreshRunningShellRunElapsed, type MakaPiTranscriptState } from './pi-transcript.js';

type CancelInterval = () => void;
type ScheduleInterval = (callback: () => void, intervalMs: number) => CancelInterval;

export interface ShellRunElapsedTicker {
  sync(): void;
  dispose(): void;
}

export function createShellRunElapsedTicker(input: {
  state: MakaPiTranscriptState;
  onTick: () => void;
  now?: () => number;
  schedule?: ScheduleInterval;
}): ShellRunElapsedTicker {
  const now = input.now ?? Date.now;
  const schedule = input.schedule ?? scheduleInterval;
  let cancel: CancelInterval | undefined;

  const stop = () => {
    cancel?.();
    cancel = undefined;
  };
  const tick = () => {
    if (!refreshRunningShellRunElapsed(input.state, now())) {
      stop();
      return;
    }
    input.onTick();
  };

  return {
    sync() {
      const running = refreshRunningShellRunElapsed(input.state, now());
      if (running && !cancel) cancel = schedule(tick, 1_000);
      if (!running) stop();
    },
    dispose: stop,
  };
}

function scheduleInterval(callback: () => void, intervalMs: number): CancelInterval {
  const handle = setInterval(callback, intervalMs);
  handle.unref();
  return () => clearInterval(handle);
}
