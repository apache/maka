import type { EncodedProtocolMessage } from '../protocol/index.js';

export interface RuntimeHostMessageTransport {
  readonly closed: Promise<void>;
  read(timeoutMs: number): Promise<unknown>;
  write(message: EncodedProtocolMessage): Promise<void>;
  closeAfterFlush(): void;
  abort(error?: Error): void;
}
