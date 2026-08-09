export class HostProjectMembershipGate {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(operation, operation);
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
