import type { ProjectCatalogChangedFrame } from '../protocol/index.js';

export interface ProjectCatalogChangeConnection {
  close(): void;
}

interface ProjectCatalogChangeSink {
  send(frame: ProjectCatalogChangedFrame): Promise<void>;
}

export class HostProjectCatalogChangeService {
  readonly #connections = new Map<string, ProjectCatalogChangeSink>();
  #revision = 0;

  attachConnection(
    connectionId: string,
    sink: ProjectCatalogChangeSink,
  ): ProjectCatalogChangeConnection {
    this.#connections.set(connectionId, sink);
    return {
      close: () => {
        if (this.#connections.get(connectionId) === sink) this.#connections.delete(connectionId);
      },
    };
  }

  publish(): void {
    this.#revision += 1;
    const frame: ProjectCatalogChangedFrame = {
      kind: 'project.catalog.changed',
      revision: this.#revision,
    };
    for (const [connectionId, sink] of this.#connections) {
      void sink.send(frame).catch(() => {
        if (this.#connections.get(connectionId) === sink) this.#connections.delete(connectionId);
      });
    }
  }
}
