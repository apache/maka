import type { ConfigurationChangedFrame } from '../protocol/index.js';

export interface ConfigurationChangeConnection {
  close(): void;
}

interface ConfigurationChangeSink {
  send(frame: ConfigurationChangedFrame): Promise<void>;
}

export class HostConfigurationChangeService {
  readonly #connections = new Map<string, ConfigurationChangeSink>();
  #revision = 0;

  attachConnection(
    connectionId: string,
    sink: ConfigurationChangeSink,
  ): ConfigurationChangeConnection {
    this.#connections.set(connectionId, sink);
    return {
      close: () => {
        if (this.#connections.get(connectionId) === sink) this.#connections.delete(connectionId);
      },
    };
  }

  publish(): void {
    this.#revision += 1;
    const frame: ConfigurationChangedFrame = {
      kind: 'configuration.changed',
      revision: this.#revision,
    };
    for (const [connectionId, sink] of this.#connections) {
      void sink.send(frame).catch(() => {
        if (this.#connections.get(connectionId) === sink) this.#connections.delete(connectionId);
      });
    }
  }
}
