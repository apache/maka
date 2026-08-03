/**
 * Sleep that honours an abort signal.
 *
 * The model-facing `wait` action used a bare setTimeout, so a user stop during
 * a long wait was ignored until the timer fired on its own.
 *
 * Only the maka-cu backend waits this way. `cua-driver-backend.ts` still calls
 * a bare `setTimeout` for its own `wait`, so a stop during one is still ignored
 * there for up to ten seconds — a pre-existing bug on the default backend, and
 * not one this module fixed by existing. This comment previously claimed both
 * backends waited the same way, which is the kind of sentence that stops the
 * next person from checking.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
