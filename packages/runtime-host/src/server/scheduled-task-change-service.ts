import type { ScheduledTaskChangedFrame, ScheduledTaskChangedReason } from '../protocol/index.js';

export interface ScheduledTaskChangeConnection {
  close(): void;
}

interface ScheduledTaskChangeSink {
  send(frame: ScheduledTaskChangedFrame): Promise<void>;
}

export class HostScheduledTaskChangeService {
  readonly #connections = new Map<string, ScheduledTaskChangeSink>();

  attachConnection(
    connectionId: string,
    sink: ScheduledTaskChangeSink,
  ): ScheduledTaskChangeConnection {
    this.#connections.set(connectionId, sink);
    return {
      close: () => {
        if (this.#connections.get(connectionId) === sink) this.#connections.delete(connectionId);
      },
    };
  }

  publish(revision: number, reason: ScheduledTaskChangedReason, taskId: string): void {
    const frame: ScheduledTaskChangedFrame = {
      kind: 'scheduled-task.changed',
      revision,
      reason,
      taskId,
    };
    for (const [connectionId, sink] of this.#connections) {
      void sink.send(frame).catch(() => {
        if (this.#connections.get(connectionId) === sink) this.#connections.delete(connectionId);
      });
    }
  }
}
