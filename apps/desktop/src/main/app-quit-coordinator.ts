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

export interface AppQuitEvent {
  preventDefault(): void;
}

export interface AppQuitCoordinator {
  focusOrCreateWindow(): void;
  getWindowCreationSignal(): AbortSignal | undefined;
  handleBeforeQuit(event: AppQuitEvent): void;
}

export interface AppQuitCoordinatorDeps {
  cleanup(): Promise<void>;
  focusOrCreateWindow(signal: AbortSignal): void;
  onCleanupError(error: unknown): void;
  resumeQuit(): void;
}

type AppQuitPhase = 'running' | 'cleaning' | 'ready-to-exit';

export function createAppQuitCoordinator(deps: AppQuitCoordinatorDeps): AppQuitCoordinator {
  let phase: AppQuitPhase = 'running';
  const windowCreationAbort = new AbortController();

  return {
    focusOrCreateWindow(): void {
      if (phase !== 'running') return;
      deps.focusOrCreateWindow(windowCreationAbort.signal);
    },
    getWindowCreationSignal(): AbortSignal | undefined {
      return phase === 'running' ? windowCreationAbort.signal : undefined;
    },
    handleBeforeQuit(event): void {
      if (phase === 'ready-to-exit') return;
      event.preventDefault();
      if (phase === 'cleaning') return;
      phase = 'cleaning';
      windowCreationAbort.abort();
      const finishCleanup = () => {
        // `before-quit` was cancelled inside Electron's native quit transaction.
        // Resuming from the cleanup Promise's microtask re-enters that transaction:
        // Electron closes the windows but emits `window-all-closed` instead of
        // `will-quit`, leaving the macOS process alive. Start a fresh transaction
        // only after the current event-loop turn has unwound.
        setImmediate(() => {
          phase = 'ready-to-exit';
          deps.resumeQuit();
        });
      };
      void deps.cleanup().then(finishCleanup, (error) => {
        deps.onCleanupError(error);
        finishCleanup();
      });
    },
  };
}
