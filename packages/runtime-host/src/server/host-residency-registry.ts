import type { OperationResidency } from './operation-dispatcher.js';

const RESIDENCY_LABEL_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export interface HostResidencySnapshot {
  readonly label: string;
  readonly count: number;
}

export class HostResidencyRegistry {
  readonly #counts = new Map<string, number>();
  readonly #drainWaiters = new Set<() => void>();
  #activeCount = 0;

  get activeCount(): number {
    return this.#activeCount;
  }

  acquire(label: string): OperationResidency {
    requireResidencyLabel(label);
    this.#activeCount += 1;
    this.#counts.set(label, (this.#counts.get(label) ?? 0) + 1);
    let active = true;
    return {
      release: () => {
        if (!active) return;
        active = false;
        this.#release(label);
      },
    };
  }

  snapshot(): readonly HostResidencySnapshot[] {
    return [...this.#counts]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([label, count]) => Object.freeze({ label, count }));
  }

  waitForEmpty(): Promise<void> {
    if (this.#activeCount === 0) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.add(resolve));
  }

  #release(label: string): void {
    const count = this.#counts.get(label);
    if (count === undefined || count === 0 || this.#activeCount === 0) {
      throw new Error('Runtime Host residency underflow');
    }
    if (count === 1) this.#counts.delete(label);
    else this.#counts.set(label, count - 1);
    this.#activeCount -= 1;
    if (this.#activeCount !== 0) return;
    for (const resolve of this.#drainWaiters) resolve();
    this.#drainWaiters.clear();
  }
}

function requireResidencyLabel(label: string): void {
  if (!RESIDENCY_LABEL_PATTERN.test(label) || label.length > 128) {
    throw new TypeError('Runtime Host residency label is invalid');
  }
}
