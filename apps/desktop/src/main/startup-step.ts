// apps/desktop/src/main/startup-step.ts
//
// Everything before the first window is created runs at main.ts's top level,
// where a promise that never settles takes the launch with it: the process
// stays alive, the main thread sits in the event loop, no window is created,
// and nothing at all is printed. From outside, that is indistinguishable from
// a crash — diagnosing one instance of it cost a long bisection over workspace
// contents, because there was no line saying which step had not come back.
//
// Naming the step turns that silence into one line that says where to look.
// A step that finishes normally prints nothing, so this costs no noise.

/** How long a step may run before it is worth saying it has not come back. */
export const STARTUP_STEP_REPORT_INTERVAL_MS = 3_000;

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
  const timer = setInterval(
    () => report(`[startup] still waiting on ${name}`),
    options.intervalMs ?? STARTUP_STEP_REPORT_INTERVAL_MS,
  );
  // The timer must never be the reason the process stays alive: a step that
  // hangs should still let the runtime exit if everything else has finished.
  timer.unref?.();
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}
