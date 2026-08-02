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
// What it cannot report: a step that never settles and holds no ref'd handle
// lets the process exit before the unref'd timer ever fires, so nothing is
// printed. That is not the case for either step wrapped today — a dialog and
// disk I/O both hold handles — but a future step that awaits nothing but a
// bare promise would fall through this silently.

/** How long a step may run before it is worth saying it has not come back. */
export const STARTUP_STEP_REPORT_INTERVAL_MS = 3_000;

/**
 * How many people-waiting states are open.
 *
 * A modal that waits for an answer is not a hang, and reporting one every three
 * seconds tells a person who is reading a dialog that the app is stuck. The
 * step is still tracked — a dialog that fails to appear at all is exactly the
 * failure this file exists for — but it stops narrating while the answer is
 * genuinely somebody else's to give.
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
  const timer = setInterval(() => {
    if (awaitingPerson > 0) return;
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
 * opens still gets named.
 */
export async function whileAwaitingPerson<T>(work: Promise<T>): Promise<T> {
  awaitingPerson += 1;
  try {
    return await work;
  } finally {
    awaitingPerson -= 1;
  }
}
