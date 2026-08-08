import type { SessionCatalogChangedFrame } from '../protocol/index.js';

export interface SessionCatalogChangeConnection {
  close(): void;
}

interface SessionCatalogChangeSink {
  send(frame: SessionCatalogChangedFrame): Promise<void>;
}

export class HostSessionCatalogChangeService {
  readonly #connections = new Map<string, SessionCatalogChangeSink>();
  #revision = 0;

  attachConnection(
    connectionId: string,
    sink: SessionCatalogChangeSink,
  ): SessionCatalogChangeConnection {
    this.#connections.set(connectionId, sink);
    return {
      close: () => {
        if (this.#connections.get(connectionId) === sink) this.#connections.delete(connectionId);
      },
    };
  }

  publish(sessionId: string): void {
    this.#revision += 1;
    const frame: SessionCatalogChangedFrame = {
      kind: 'session.catalog.changed',
      revision: this.#revision,
      sessionId,
    };
    for (const [connectionId, sink] of this.#connections) {
      void sink.send(frame).catch(() => {
        if (this.#connections.get(connectionId) === sink) this.#connections.delete(connectionId);
      });
    }
  }
}
