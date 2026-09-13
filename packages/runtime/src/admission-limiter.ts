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

export interface AdmissionPermit {
  release(): void;
}

interface AdmissionWaiter {
  signal: AbortSignal;
  resolve: (permit: AdmissionPermit) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

/**
 * Abort-aware FIFO permits, bounded by capacity.
 *
 * Two boundaries use it, at different lifetimes. Child-agent runs take one
 * instance per turn: tool-call admission and child-run capacity are separate
 * boundaries, since one admitted tool may eventually spawn multiple children,
 * so the limiter belongs at the narrow spawn capability where every caller
 * shares the same real-run budget. Code Mode cells take one per backend, which
 * has to outlive a turn — see `executeCodeModeCell`.
 *
 * A caller that must turn work away rather than queue it reads `waitingCount`
 * before calling `acquire`. Nothing awaits between that read and the enqueue
 * inside `acquire`, so the pair is atomic.
 */
export class AdmissionLimiter {
  private active = 0;
  private readonly waiters: AdmissionWaiter[] = [];
  private closedError: Error | undefined;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('Admission capacity must be a positive safe integer');
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  acquire(signal: AbortSignal): Promise<AdmissionPermit> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (signal.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.capacity && this.waiters.length === 0) {
      this.active += 1;
      return Promise.resolve(this.createPermit());
    }
    return new Promise<AdmissionPermit>((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort);
          reject(abortReason(signal));
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.reject(error);
    }
  }

  private createPermit(): AdmissionPermit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.grantWaiting();
      },
    };
  }

  private grantWaiting(): void {
    if (this.closedError) return;
    while (this.active < this.capacity && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.createPermit());
    }
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Child agent run cancelled while waiting for runtime capacity');
}
