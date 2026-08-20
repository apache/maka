/**
 * Bounds how many Code Mode cells are outstanding at once.
 *
 * A permit is held across a cell's complete lifecycle, not just its sandbox
 * run. `executeCodeCell` settles only once the cell's host operations have
 * drained, so releasing on settlement covers the drain. The sandbox worker cap
 * cannot serve this purpose: on cancellation `runCodeMode` releases its worker
 * and rejects at once, by design, while host operations started by the cell may
 * still be running with durable side effects. Only the Runtime waits for those,
 * so only the Runtime can bound them — releasing when the worker is released
 * would let repeated cancellation accumulate host work without bound.
 *
 * One active cell and one queued, which is what the Code Mode adapter enforced
 * before this moved to the side that owns execution. Widening the bound needs
 * evidence that concurrent cells are wanted; none exists today.
 */
export class CodeCellAdmission {
  private active = false;
  private queued: (() => void) | undefined;

  /**
   * Resolves `'admitted'` once the cell holds the permit, or `'queue_full'`
   * when a cell is already waiting. Rejects if `signal` aborts while queued,
   * so a cancelled cell does not wait out the active one.
   */
  acquire(signal?: AbortSignal): Promise<'admitted' | 'queue_full'> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? codeCellAbortError());
    if (!this.active) {
      this.active = true;
      return Promise.resolve('admitted');
    }
    if (this.queued) return Promise.resolve('queue_full');
    return new Promise((resolve, reject) => {
      let admit!: () => void;
      const onAbort = () => {
        if (this.queued !== admit) return;
        this.queued = undefined;
        reject(signal?.reason ?? codeCellAbortError());
      };
      admit = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve('admitted');
      };
      this.queued = admit;
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Hands the permit to a queued cell, or frees it. */
  release(): void {
    const next = this.queued;
    this.queued = undefined;
    if (next) next();
    else this.active = false;
  }
}

function codeCellAbortError(): Error {
  const error = new Error('Code Mode cell aborted');
  error.name = 'AbortError';
  return error;
}
