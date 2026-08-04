import type {
  ClientCapabilityCallFrame,
  ClientCapabilityCallResult,
  ClientCapabilityOffer,
  ClientCapabilityServiceCallFrame,
  ClientCapabilityServiceOffer,
} from '../protocol/index.js';

/** A Client-owned open-world capability provider registered on one Host connection. */
export interface ClientCapabilityProvider {
  offers(): readonly ClientCapabilityOffer[];
  services?(): readonly ClientCapabilityServiceOffer[];
  call?(
    frame: ClientCapabilityCallFrame,
    options: {
      readonly signal: AbortSignal;
      /** Await immediately before crossing the provider's irreversible admission cut. */
      accept(): Promise<void>;
    },
  ): Promise<ClientCapabilityCallResult>;
  callService?(
    frame: ClientCapabilityServiceCallFrame,
    options: {
      readonly signal: AbortSignal;
      /** Await immediately before crossing the provider's irreversible admission cut. */
      accept(): Promise<void>;
    },
  ): Promise<Record<string, unknown>>;
  /** Release provider-owned resources after its final registration is retired. */
  close?(): void | Promise<void>;
}
