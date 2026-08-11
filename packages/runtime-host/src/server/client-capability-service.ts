import type {
  AccessCredentialPrincipalKind,
  ClientCapabilityClientFrame,
  ClientCapabilityHostFrame,
} from '../protocol/index.js';

export interface ClientCapabilityConnectionSender {
  send(frame: ClientCapabilityHostFrame): Promise<void>;
}

export interface ClientCapabilityConnectionIdentity {
  readonly connectionId: string;
  readonly principalId: string;
  readonly clientInstanceId: string;
  readonly principalKind: 'local_owner' | AccessCredentialPrincipalKind;
}

export interface ClientCapabilityConnection {
  accept(frame: ClientCapabilityClientFrame): void;
  close(): Promise<void>;
}

/** Pure full-duplex seam kept outside the Runtime-backed execution composition. */
export interface ClientCapabilityService {
  attachConnection(
    identity: ClientCapabilityConnectionIdentity,
    sender: ClientCapabilityConnectionSender,
  ): ClientCapabilityConnection;
}
