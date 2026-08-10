import type { ConnectionTestSummary } from './runtime-policy.js';

/**
 * Provider Credential routing contracts (RFC section 6).
 *
 * These are pure cross-boundary types owned by Core: the Runtime Host
 * composes Catalog, Vault and the routing Health authority into a
 * {@link ProviderCredentialResolver}; the Runtime consumes the resolver and
 * never imports Storage. Secrets never appear in public types beyond the
 * per-attempt {@link ProviderCredentialLease}, which lives only for one
 * physical Provider request.
 */

/**
 * Canonical failure vocabulary consumed by the Router. Values mirror the
 * Runtime `ModelFailureKind` so adapters can classify into the same strings
 * without a second taxonomy (RFC section 8.1).
 */
export type ProviderFailureKind =
  | 'abort'
  | 'auth'
  | 'context_overflow'
  | 'provider_permission'
  | 'provider_billing'
  | 'usage_limit'
  | 'rate_limit'
  | 'network'
  | 'provider_unavailable'
  | 'timeout'
  | 'unknown';

/**
 * Structured routing hint produced by a Provider adapter (RFC section 8.1).
 * The Router consumes only the normalized kind + scope and never parses
 * Provider error text. `retryAt` is Unix epoch milliseconds; illegal, past
 * or oversized values are treated as the bounded backoff default.
 */
export interface ProviderFailureRoutingHint {
  readonly kind: ProviderFailureKind;
  readonly scope: 'credential' | 'credential_model' | 'connection' | 'unknown';
  readonly retryAt?: number;
  readonly evidence: 'status' | 'header' | 'provider_code' | 'provider_adapter';
}

/** Why a turn/background call is asking the Router for a Profile. */
export type ProviderCredentialRouteFailureReason =
  | 'initial'
  | 'binding_invalidated'
  | 'account_failover'
  | 'half_open_probe';

/**
 * How a Profile was chosen for a binding or an attempt lease (RFC 7.3).
 * `legacy_single` is the fast path for connections without `credentialRouting`
 * or with `mode='legacy_primary'`; `single_eligible` is a balanced connection
 * with exactly one eligible candidate (never a fabricated failover).
 */
export type ProviderCredentialSelectionReason =
  | 'legacy_single'
  | 'single_eligible'
  | 'weighted'
  | 'binding_reselect'
  | 'account_failover'
  | 'half_open_probe';

/** Per-request routing context (RFC section 6.2). */
export interface ProviderCredentialRouteContext {
  readonly connectionId: string;
  readonly connectionSlug: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly logicalCallId: string;
  readonly callKind: string;
  readonly excludedProfileIds: ReadonlySet<string>;
  readonly reason: ProviderCredentialRouteFailureReason;
  readonly signal: AbortSignal;
}

/**
 * Turn-granular in-process sticky selection. It holds only the Profile
 * identity and selection reason — never a secret — so it is safe to keep for
 * the lifetime of a turn.
 */
export interface ProviderProfileBinding {
  readonly bindingId: string;
  readonly profileId: string;
  readonly selectionReason: ProviderCredentialSelectionReason;
}

/**
 * One physical Provider attempt. The secret is bound to a single dispatch and
 * must be settled/released in the same call frame (RFC section 6.2).
 */
export interface ProviderCredentialLease {
  readonly leaseId: string;
  readonly bindingId: string;
  readonly profileId: string;
  readonly credentialId: string;
  readonly credentialRevision: number;
  readonly selectionReason: ProviderCredentialSelectionReason;
  readonly apiKey: string;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
}

export type ProviderCredentialOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'aborted' }
  | {
      readonly kind: 'failure';
      readonly failure: { readonly kind: ProviderFailureKind; readonly retryable: boolean };
      readonly routingHint: ProviderFailureRoutingHint;
    };

/**
 * Narrow Runtime injection contract. `acquireAttempt` re-validates the
 * Connection/Profile/model/credential basis and health before producing a
 * short-lived lease; `settle` records the outcome in the routing Health
 * authority; `releaseTurn` frees the turn binding.
 */
export interface ProviderCredentialResolver {
  acquireAttempt(context: ProviderCredentialRouteContext): Promise<ProviderCredentialLease>;
  settle(lease: ProviderCredentialLease, outcome: ProviderCredentialOutcome): Promise<void>;
  releaseTurn(sessionId: string, turnId: string): void;
}

/**
 * Per-credential circuit state (RFC section 8.3). `closed` allows execution,
 * `open` blocks until blockedUntil/nextProbeAt, `half_open` admits exactly
 * one probe, and `invalid` is a confirmed auth failure that only a credential
 * revision change or a manual retest can clear.
 */
export type CredentialCircuitState = 'closed' | 'open' | 'half_open' | 'invalid';

/**
 * Readiness projection for a Profile under a Connection (RFC section 4.4).
 * It is a combination of Catalog, Vault and routing health — never a fourth
 * stored authority.
 */
export type CredentialProfileReadiness =
  | 'ready'
  | 'disabled'
  | 'unconfigured'
  | 'unverified'
  | 'cooldown'
  | 'invalid'
  | 'needs_reauth'
  | 'model_unavailable';

/**
 * Rebuildable execution evidence for a Profile × model (RFC section 4.5).
 * Verification is persisted in the `provider_routing` SQLite scope, is
 * exported nowhere, and is rebuilt after import.
 */
export interface CredentialProfileVerificationRecord {
  readonly connectionId: string;
  readonly profileId: string;
  readonly credentialId: string;
  readonly credentialRevision: number;
  readonly executionBasisDigest: string;
  readonly modelId: string;
  readonly status: 'supported' | 'denied';
  readonly source: 'discovered' | 'tested';
  readonly evidence: 'positive_only' | 'authoritative';
  readonly checkedAt: number;
  readonly testSummary?: ConnectionTestSummary;
}

/**
 * Structured pool-exhausted reason (RFC section 9.4). Not a public
 * `ModelFailureKind`; callers keep returning the most actionable existing
 * error while recording this diagnostic.
 */
export interface CredentialPoolExhausted {
  readonly kind: 'credential_pool_exhausted';
  readonly countsByReadiness: Readonly<Record<string, number>>;
  readonly lastFailure?: ProviderFailureKind;
  readonly nextRetryAt?: number;
}
