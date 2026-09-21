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
  focusOrCreateWindow(): Promise<void>;
  handleBeforeQuit(event: AppQuitEvent): void;
}

/** The two awaited stages of an orderly quit, in the order they run. */
export type AppQuitStage = 'preparing' | 'cleaning';

/**
 * Quitting waits on Host retirement, MCP child processes, peer mesh teardown
 * and native resources. Any of those can stop settling, and an unbounded wait
 * is indistinguishable from a hang: the process keeps running with its windows
 * already committed to closing, and every later quit request is swallowed
 * because the sequence still owns the phase.
 *
 * An updater install makes that failure permanent rather than merely annoying.
 * Squirrel's ShipIt waits for this process to exit before it replaces the
 * bundle, so a quit that never finishes silently blocks the update instead of
 * reporting anything.
 */
const DEFAULT_PREPARE_TIMEOUT_MS = 15_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;

export interface AppQuitCoordinatorDeps {
  prepareToQuit(): Promise<'ready' | 'cancelled'>;
  cleanup(): Promise<void>;
  focusOrCreateWindow(signal: AbortSignal): void | Promise<void>;
  onPreparationError(error: unknown): void;
  onCleanupError(error: unknown): void;
  onWindowCreationError(error: unknown): void;
  resumeQuit(): void;
  /**
   * Terminate now, abandoning whatever never settled. Reached only after a
   * stage exceeds its bound, so it is the difference between a stuck quit and
   * a process that always goes away.
   */
  forceExit(): void;
  onQuitTimeout?(stage: AppQuitStage, timeoutMs: number): void;
  /**
   * The app is staying up after all. Anything staged for the quit that was
   * expected to follow has to be unwound here, because nothing else observes
   * a quit that simply did not happen.
   */
  onQuitAbandoned?(): void;
  prepareTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

type AppQuitPhase = 'running' | 'preparing' | 'cleaning' | 'ready-to-exit';

type StageOutcome<T> =
  | { kind: 'settled'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'timeout' };

/**
 * Run one quit stage under an upper bound.
 *
 * A late result is dropped rather than raced back in: once the bound elapses
 * the sequence has already moved on, and its rejection is still observed here
 * so abandoning the stage cannot surface as an unhandled rejection.
 */
function runStage<T>(run: () => Promise<T>, timeoutMs: number): Promise<StageOutcome<T>> {
  return new Promise<StageOutcome<T>>((resolve) => {
    let done = false;
    const settle = (outcome: StageOutcome<T>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
    // A pending bound must never be the reason the process stays alive.
    timer.unref?.();
    Promise.resolve()
      .then(run)
      .then(
        (value) => settle({ kind: 'settled', value }),
        (error) => settle({ kind: 'failed', error }),
      );
  });
}

export function createAppQuitCoordinator(deps: AppQuitCoordinatorDeps): AppQuitCoordinator {
  let phase: AppQuitPhase = 'running';
  let windowCreationAbort = new AbortController();
  const prepareTimeoutMs = deps.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
  const cleanupTimeoutMs = deps.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;

  const focusOrCreateWindow = (): Promise<void> => {
    if (phase !== 'running') return Promise.resolve();
    try {
      return Promise.resolve(deps.focusOrCreateWindow(windowCreationAbort.signal)).catch(
        deps.onWindowCreationError,
      );
    } catch (error) {
      deps.onWindowCreationError(error);
      return Promise.resolve();
    }
  };

  const abandonQuit = (): void => {
    phase = 'running';
    windowCreationAbort = new AbortController();
    deps.onQuitAbandoned?.();
    void focusOrCreateWindow();
  };

  const finishCleanup = (): void => {
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

  const runQuitSequence = async (): Promise<void> => {
    const preparation = await runStage(() => deps.prepareToQuit(), prepareTimeoutMs);

    if (preparation.kind === 'failed') {
      deps.onPreparationError(preparation.error);
      abandonQuit();
      return;
    }
    if (preparation.kind === 'settled' && preparation.value === 'cancelled') {
      abandonQuit();
      return;
    }
    if (preparation.kind === 'timeout') {
      // The user asked to quit and preparation is only a courtesy to the Host.
      // Report it and keep going: refusing to quit is the worse outcome.
      deps.onQuitTimeout?.('preparing', prepareTimeoutMs);
    }

    phase = 'cleaning';
    const cleanup = await runStage(() => deps.cleanup(), cleanupTimeoutMs);

    if (cleanup.kind === 'failed') deps.onCleanupError(cleanup.error);
    if (cleanup.kind === 'timeout') {
      deps.onQuitTimeout?.('cleaning', cleanupTimeoutMs);
      // Nothing left to wait for and no orderly exit available. Leaving the
      // process up would strand an in-flight updater install indefinitely.
      phase = 'ready-to-exit';
      deps.forceExit();
      return;
    }
    finishCleanup();
  };

  return {
    focusOrCreateWindow,
    handleBeforeQuit(event): void {
      if (phase === 'ready-to-exit') return;
      event.preventDefault();
      if (phase !== 'running') return;
      phase = 'preparing';
      windowCreationAbort.abort();
      void runQuitSequence();
    },
  };
}
