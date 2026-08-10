import type { HostedExecutionListener, HostedExecutionRef } from './hosted-execution-authority.js';

export class HostedExecutionRegistry<T extends HostedExecutionRef> {
  readonly #activeBySession = new Map<string, T>();
  readonly #listeners = new Set<HostedExecutionListener>();

  get(sessionId: string): T | undefined {
    return this.#activeBySession.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.#activeBySession.has(sessionId);
  }

  entries(): IterableIterator<[string, T]> {
    return this.#activeBySession.entries();
  }

  get size(): number {
    return this.#activeBySession.size;
  }

  activate(execution: T, replacing?: T): void {
    const current = this.#activeBySession.get(execution.sessionId);
    if (current !== replacing) {
      throw new Error(
        replacing
          ? 'Hosted execution replacement lost its current owner'
          : 'Session already has an active hosted execution',
      );
    }
    this.#activeBySession.set(execution.sessionId, execution);
  }

  release(execution: T): boolean {
    if (this.#activeBySession.get(execution.sessionId) !== execution) return false;
    this.#activeBySession.delete(execution.sessionId);
    return true;
  }

  subscribe(listener: HostedExecutionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(execution: HostedExecutionRef): void {
    const ref = Object.freeze({
      sessionId: execution.sessionId,
      turnId: execution.turnId,
      runId: execution.runId,
    });
    for (const listener of this.#listeners) {
      try {
        listener(ref);
      } catch {
        // Change notifications are hints. Durable execution state remains authoritative.
      }
    }
  }

  close(): void {
    this.#listeners.clear();
  }
}
