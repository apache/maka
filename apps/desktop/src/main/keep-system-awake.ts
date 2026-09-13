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

/**
 * Keep-system-awake controller.
 *
 * Two capabilities need the machine to stay running while nobody is touching
 * it, and they arrive independently:
 *
 *  - 定时任务: scheduled tasks are driven by an in-process timer (see
 *    `scheduled-tasks`); when the machine sleeps that timer is frozen and the
 *    task silently never fires. The user opts into this with 保持系统唤醒.
 *  - Computer Use: a run drives another app for as long as the model needs,
 *    and the physical-input guard means it does its work precisely when the
 *    user is not touching anything — which is exactly when idle sleep lands.
 *    A suspended system kills the run mid-task.
 *
 * So the blocker is refcounted by named holder rather than being one boolean.
 * Turning the setting off must not drop a blocker Computer Use is holding for
 * a run in progress, and a run finishing must not drop the setting's.
 *
 * `prevent-app-suspension` (NOT `prevent-display-sleep`) is deliberate: it
 * keeps the *system* from suspending the app while still letting the display
 * sleep. That is right for background scheduled work — we do not want to force
 * the user's monitor to stay lit just to run a timer — and it is right for
 * Computer Use for a stronger reason: `prevent-display-sleep` would also
 * suppress the automatic lock that follows display sleep, which would mean
 * silently overriding a security preference the user set. Computer Use stops
 * itself when the screen locks (see `computer-use/screen-lock.ts`); it does
 * not get to prevent the lock.
 *
 * Kept free of any `electron` import so the start/stop bookkeeping can be
 * unit-tested under plain `node --test` (the caller injects electron's
 * `powerSaveBlocker`), mirroring how `notifications-policy.ts` keeps its
 * decision logic Electron-free while `notifications-ipc-main.ts` owns the
 * Electron surface.
 */

/** Electron `powerSaveBlocker`'s surface, narrowed to what we use. */
export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export interface KeepSystemAwakeController {
  /**
   * Reconcile the 保持系统唤醒 setting with the blocker. Idempotent — safe to
   * call on every settings change and at launch.
   *
   * The setting is one holder among several, not the whole state: turning it
   * off must not drop a blocker that Computer Use is holding for a run in
   * progress, and vice versa.
   */
  apply(enabled: boolean): void;
  /**
   * Hold the blocker for a named reason until the matching `release`.
   *
   * Holding twice for the same reason is one hold, so callers driven by
   * repeated events (every action of a session, say) do not need to
   * de-duplicate before calling.
   */
  hold(reason: string): void;
  release(reason: string): void;
  /** Whether a blocker is currently held (for diagnostics / tests). */
  isActive(): boolean;
}

/** The 保持系统唤醒 setting's own holder name. */
const SETTING_HOLDER = 'setting:keepSystemAwake';

export function createKeepSystemAwakeController(
  blocker: PowerSaveBlockerLike,
): KeepSystemAwakeController {
  // The single blocker id we own, or null when nothing is held. Tracking the
  // id (plus an `isStarted` re-check) guards against a double-start leaking a
  // second, unreleasable blocker.
  let blockerId: number | null = null;
  const holders = new Set<string>();

  function start(): void {
    // Guard double-start: if we already hold a live blocker, do nothing.
    if (blockerId !== null && blocker.isStarted(blockerId)) return;
    blockerId = blocker.start('prevent-app-suspension');
  }

  function stop(): void {
    if (blockerId === null) return;
    // The blocker may have been released out from under us (process teardown
    // races); only call stop when it is genuinely still running.
    if (blocker.isStarted(blockerId)) blocker.stop(blockerId);
    blockerId = null;
  }

  function reconcile(): void {
    if (holders.size > 0) start();
    else stop();
  }

  return {
    apply(enabled: boolean): void {
      if (enabled) holders.add(SETTING_HOLDER);
      else holders.delete(SETTING_HOLDER);
      reconcile();
    },
    hold(reason: string): void {
      if (typeof reason !== 'string' || reason.length === 0) return;
      holders.add(reason);
      reconcile();
    },
    release(reason: string): void {
      if (!holders.delete(reason)) return;
      reconcile();
    },
    isActive(): boolean {
      return blockerId !== null && blocker.isStarted(blockerId);
    },
  };
}
