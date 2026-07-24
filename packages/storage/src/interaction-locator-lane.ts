export type InteractionStoreOperationRunner = <T>(operation: () => Promise<T>) => Promise<T>;

export class InteractionLocatorLane {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(
    locator: string,
    authorize: InteractionStoreOperationRunner,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tails.get(locator) ?? Promise.resolve();
    const result = authorize(async () => {
      await previous;
      return operation();
    });
    const tail = previous
      .then(() => result)
      .then(
        () => undefined,
        () => undefined,
      );
    this.#tails.set(locator, tail);
    void tail.then(() => {
      if (this.#tails.get(locator) === tail) this.#tails.delete(locator);
    });
    return result;
  }
}

export function runInteractionStoreOperation<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}
