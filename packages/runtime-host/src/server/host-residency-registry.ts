import type { OperationResidency } from './operation-dispatcher.js';

const RESIDENCY_LABEL_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export interface HostResidencySnapshot {
  readonly label: string;
  readonly count: number;
}

export class HostResidencyRegistry {
  readonly #counts = new Map<string, number>();
  readonly #drainWaiters = new Set<{
    readonly excludedLabel: string | undefined;
    readonly resolve: () => void;
  }>();
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
    return this.#waitForEmptyExcept(undefined);
  }

  waitForEmptyExcept(excludedLabel: string): Promise<void> {
    requireResidencyLabel(excludedLabel);
    return this.#waitForEmptyExcept(excludedLabel);
  }

  #release(label: string): void {
    const count = this.#counts.get(label);
    if (count === undefined || count === 0 || this.#activeCount === 0) {
      throw new Error('Runtime Host residency underflow');
    }
    if (count === 1) this.#counts.delete(label);
    else this.#counts.set(label, count - 1);
    this.#activeCount -= 1;
    for (const waiter of this.#drainWaiters) {
      if (!this.#isEmptyExcept(waiter.excludedLabel)) continue;
      this.#drainWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  #waitForEmptyExcept(excludedLabel: string | undefined): Promise<void> {
    if (this.#isEmptyExcept(excludedLabel)) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.add({ excludedLabel, resolve }));
  }

  #isEmptyExcept(excludedLabel: string | undefined): boolean {
    for (const [label, count] of this.#counts) {
      if (count > 0 && label !== excludedLabel) return false;
    }
    return true;
  }
}

function requireResidencyLabel(label: string): void {
  if (!RESIDENCY_LABEL_PATTERN.test(label) || label.length > 128) {
    throw new TypeError('Runtime Host residency label is invalid');
  }
}
