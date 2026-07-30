export type SerializedOperationExecutor<Context> = <T>(
  operation: (context: Context) => Promise<T>,
) => Promise<T>;

/**
 * Admits an operation into its owner before waiting for earlier operations.
 * This lets owner shutdown observe and drain every accepted reservation.
 */
export class SerializedOperationLane<Context> {
  readonly #execute: SerializedOperationExecutor<Context>;
  #tail: Promise<void> = Promise.resolve();

  constructor(execute: SerializedOperationExecutor<Context>) {
    this.#execute = execute;
  }

  run<T>(operation: (context: Context) => Promise<T>): Promise<T> {
    const ready = this.#tail;
    let releaseTail!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseTail();
    };
    let entered = false;
    let execution: Promise<T>;
    try {
      execution = this.#execute(async (context) => {
        entered = true;
        await ready;
        try {
          return await operation(context);
        } finally {
          release();
        }
      });
    } catch (error) {
      release();
      throw error;
    }
    return execution.finally(() => {
      if (!entered) release();
    });
  }
}
