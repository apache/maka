import type { RuntimeHostConnection } from './connection.js';

export async function waitForRuntimeHostReady(
  connection: Pick<RuntimeHostConnection, 'status'>,
  timeoutMs = 45_000,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new RangeError('timeoutMs must be an integer between 1 and 120000');
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    const status = await abortable(
      () => connection.status(Math.max(1, deadline - Date.now())),
      signal,
    );
    if (status.state === 'ready') return;
    if (status.state === 'draining') {
      throw new Error('Runtime Host drained before becoming ready');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('Runtime Host did not become ready before the deadline');
    }
    await abortable(
      () => new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining))),
      signal,
    );
  }
}

export function abortable<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(signal.reason);
  const running = operation();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    void running.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}
