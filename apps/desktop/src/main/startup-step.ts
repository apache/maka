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

// apps/desktop/src/main/startup-step.ts
//
// Everything before the first window is created runs at boot's top level,
// where a promise that never settles takes the launch with it: the process
// stays alive, the main thread sits in the event loop, no window is created,
// and nothing at all is printed. From outside, that is indistinguishable from
// a crash — diagnosing one instance of it cost a long bisection over workspace
// contents, because there was no line saying which step had not come back.
//
// Naming the step turns that silence into one line that says where to look.
// A step that finishes normally prints nothing, so this costs no noise.
//
// Who gets to read that line: whoever can see the main process's stderr — a
// developer running from a terminal, an e2e run capturing output, a crash
// report gathered by hand. `report` defaults to `console.warn`, and a packaged
// .app launched from the Finder has nowhere for stderr to land, so somebody
// who hits this in a shipped build still sees no window and nothing printed,
// exactly as described above. This is a diagnostic for whoever goes looking,
// not a message to the person the launch failed on. Ending the silence for
// them would take a visible surface, which does not exist before the first
// window and is not what this file does.
//
// What it cannot report: a step that never settles and holds no ref'd handle
// lets the process exit before the unref'd timer ever fires, so nothing is
// printed. That is not the case for any of the three steps wrapped today — a
// dialog and disk I/O both hold handles — but a future step that awaits
// nothing but a bare promise would fall through this silently.

/** How long a step may run before it is worth saying it has not come back. */
export const STARTUP_STEP_REPORT_INTERVAL_MS = 3_000;

/**
 * How many people-waiting states are open.
 *
 * A modal that waits for an answer is not a hang, and repeating "still waiting"
 * every three seconds tells a person who is reading a dialog that the app is
 * stuck. But going silent instead would hide the failure this file exists for:
 * a dialog raised before any window exists does not appear, and then nobody is
 * reading anything and nothing is ever printed.
 *
 * So a person-owned wait is said once and then not again, in wording that says
 * an answer is expected rather than that a step is late. One line names the
 * step for the dialog that never opened; a person looking at a real dialog is
 * not narrated at.
 *
 * This is a module global, so it mutes every step tracked at the same time, not
 * only the one whose dialog is open. Boot is sequential today, so no two steps
 * are ever tracked at once and no case is currently wrong.
 */
let awaitingPerson = 0;

export interface StartupStepOptions {
  intervalMs?: number;
  report?: (message: string) => void;
}

/** Await a startup step, and say so if it takes long enough to look like a hang. */
export async function startupStep<T>(
  name: string,
  work: Promise<T>,
  options: StartupStepOptions = {},
): Promise<T> {
  const report = options.report ?? ((message: string) => console.warn(message));
  let saidAnswerExpected = false;
  const timer = setInterval(() => {
    if (awaitingPerson > 0) {
      if (saidAnswerExpected) return;
      saidAnswerExpected = true;
      report(`[startup] ${name} is waiting for an answer; if no dialog is on screen, none opened`);
      return;
    }
    // Said once per step, not once per dialog: the flag is never cleared, so a
    // second person-owned span inside the same step would not be named again.
    // One step wraps one dialog today (`confirmDesktopStorageRootRepair`, and
    // `resolveDesktopStorageRoot` calls it at most once), so there is no second
    // span to lose. Clearing it here would name the next one — do that if a
    // step ever asks twice.
    report(`[startup] still waiting on ${name}`);
  }, options.intervalMs ?? STARTUP_STEP_REPORT_INTERVAL_MS);
  // The timer must never be the reason the process stays alive: a step that
  // hangs should still let the runtime exit if everything else has finished.
  timer.unref?.();
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

/**
 * Mark the span in which a person, not the machine, owns the delay.
 *
 * Wrapping the modal rather than excluding the whole step keeps the I/O either
 * side of it tracked: a repair that hangs reading the disk before the dialog
 * opens still gets named. And the span is quieter, not silent — a dialog that
 * never appears is still named once, because that is the failure that leaves
 * nobody looking at anything.
 */
export async function whileAwaitingPerson<T>(work: Promise<T>): Promise<T> {
  awaitingPerson += 1;
  try {
    return await work;
  } finally {
    awaitingPerson -= 1;
  }
}
