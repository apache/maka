import type { ClientCapabilityClientFrame, ClientCapabilityHostFrame } from '../protocol/index.js';

export interface ClientCapabilityConnectionSender {
  send(frame: ClientCapabilityHostFrame): Promise<void>;
}

export interface ClientCapabilityConnection {
  accept(frame: ClientCapabilityClientFrame): void;
  close(): Promise<void>;
}

/** Pure full-duplex seam kept outside the Runtime-backed execution composition. */
export interface ClientCapabilityService {
  attachConnection(
    connectionId: string,
    sender: ClientCapabilityConnectionSender,
  ): ClientCapabilityConnection;
}
