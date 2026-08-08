/**
 * Keeps an in-flight import attached to exactly one dialog lifetime.
 *
 * UI close requests are blocked while active. An external unmount/close can
 * still invalidate the token, ensuring the old completion cannot navigate or
 * close a later dialog instance.
 */
export class ExternalSessionImportLifecycle {
  #generation = 0;
  #activeToken: number | null = null;

  begin(): number {
    if (this.#activeToken !== null) throw new Error('External Session import is already active');
    const token = ++this.#generation;
    this.#activeToken = token;
    return token;
  }

  canClose(): boolean {
    return this.#activeToken === null;
  }

  isCurrent(token: number): boolean {
    return this.#activeToken === token;
  }

  finish(token: number): boolean {
    if (!this.isCurrent(token)) return false;
    this.#activeToken = null;
    return true;
  }

  invalidate(): void {
    this.#generation += 1;
    this.#activeToken = null;
  }
}
