import type {
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
  ConnectionModelDiscoveryResult,
  ConnectionTestSummary,
  CredentialMutationResult,
  CredentialLocator,
  CredentialProfileMutationResult,
  CreateCredentialProfileInput,
  RemoveCredentialProfileInput,
  SetCredentialInput,
  SetCredentialProfileEnabledInput,
  SetCredentialRoutingModeInput,
  UpdateCredentialProfileInput,
  CredentialStatus,
  CredentialVersionBasis,
  RuntimePolicy,
  RequestHeaderUpdate,
  SavedRequestHeaders,
} from '@maka/core/runtime-policy';
import type { ProviderAuthActionAvailability } from '@maka/core/provider-auth';
import type { ProviderDefaults } from '@maka/core/llm-connections';

export type {
  CreateCredentialProfileInput,
  CredentialProfileMutationResult,
  RemoveCredentialProfileInput,
  SetCredentialProfileEnabledInput,
  SetCredentialRoutingModeInput,
  UpdateCredentialProfileInput,
} from '@maka/core/runtime-policy';

/**
 * Record rebuildable Profile-level execution evidence (RFC 4.5). This is the
 * production verification writer that the Profile test/discovery effects will
 * call; the e2e path uses it to seed evidence before balanced activation.
 * The write is keyed to the current credential identity/revision and the
 * execution basis digest, and is CAS-checked against the connection/profile
 * revisions so a stale test completion cannot overwrite newer config.
 */
export interface RecordCredentialProfileVerificationInput {
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly modelId: string;
  readonly status: 'supported' | 'denied';
  readonly source: 'discovered' | 'tested';
  readonly evidence: 'positive_only' | 'authoritative';
  readonly checkedAt: number;
  readonly testSummary?: ConnectionTestSummary;
}

export type RecordCredentialProfileVerificationResult =
  | { readonly kind: 'committed' }
  | { readonly kind: 'connection_not_found' }
  | {
      readonly kind: 'connection_stale';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    }
  | { readonly kind: 'profile_not_found' }
  | { readonly kind: 'credential_not_configured' }
  | { readonly kind: 'invalid_request'; readonly reason: string };

declare const operationTicketBrand: unique symbol;

export type ProviderAuthKind = ProviderDefaults['authKind'];
export type ConnectionEffectChangedDomain = 'connection' | 'credential' | 'network_proxy';
export type UnavailableProviderActionAvailability = Exclude<
  ProviderAuthActionAvailability,
  'available'
>;

export interface RuntimePolicyCredentialMaterial extends CredentialVersionBasis {
  readonly secret: string;
}

export interface RuntimePolicyOperationSecretMaterial {
  readonly connection?: RuntimePolicyCredentialMaterial;
  readonly requestHeaders?: RuntimePolicyCredentialMaterial;
  readonly networkProxy?: RuntimePolicyCredentialMaterial;
}

export type ResolveWebSearchExecutionResult =
  | { readonly kind: 'privacy_mode' }
  | {
      readonly kind: 'disabled';
      readonly provider: RuntimePolicy['webSearch']['defaultProvider'];
    }
  | {
      readonly kind: 'model_native_only';
      readonly provider: 'model';
    }
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  | {
      readonly kind: 'ready';
      readonly provider: 'tavily';
      readonly secretMaterial: {
        readonly webSearch: RuntimePolicyCredentialMaterial;
        readonly networkProxy?: RuntimePolicyCredentialMaterial;
      };
      readonly networkProxy: RuntimePolicy['networkProxy'];
    };

export interface ResolveWebSearchExecutionInput {
  readonly provider?: 'tavily';
  readonly secretOverride?: string;
  readonly bypassFeatureGate?: boolean;
}

export interface ResolveNetworkProxyExecutionInput {
  readonly networkProxy?: RuntimePolicy['networkProxy'];
  readonly secretOverride?: string;
}

export type ResolveNetworkProxyExecutionResult =
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  | {
      readonly kind: 'ready';
      readonly networkProxy: RuntimePolicy['networkProxy'];
      readonly secretMaterial: Pick<RuntimePolicyOperationSecretMaterial, 'networkProxy'>;
    };

export type ResolveWebFetchExecutionResult =
  | { readonly kind: 'privacy_mode' }
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  | {
      readonly kind: 'ready';
      readonly networkProxy: RuntimePolicy['networkProxy'];
      readonly secretMaterial: Pick<RuntimePolicyOperationSecretMaterial, 'networkProxy'>;
    };

export type OAuthCredentialLocator = Omit<
  Extract<CredentialLocator, { scope: 'connection' }>,
  'kind'
> & {
  readonly kind: 'oauth_token';
};

export interface CompareAndSetOAuthCredentialInput {
  readonly locator: OAuthCredentialLocator;
  readonly expected: Pick<CredentialVersionBasis, 'credentialId' | 'revision'>;
  readonly secret: string;
}

export type CompareAndSetOAuthCredentialResult =
  | {
      readonly kind: 'committed';
      readonly credentialId: string;
      readonly revision: number;
    }
  | { readonly kind: 'superseded' };

export type CredentialStatusQueryResult =
  | { readonly kind: 'status'; readonly status: CredentialStatus }
  | { readonly kind: 'connection_not_found' };

export interface ModelFetchTicket {
  readonly [operationTicketBrand]: 'model_fetch';
}

export interface ConnectionTestTicket {
  readonly [operationTicketBrand]: 'connection_test';
}

export interface InteractiveOAuthLoginTicket {
  readonly [operationTicketBrand]: 'interactive_oauth_login';
}

export type InteractiveOAuthLoginProvider = Extract<
  ConnectionCatalogEntry['providerType'],
  'claude-subscription' | 'openai-codex' | 'xai-oauth'
>;

export type BeginInteractiveOAuthLoginResult =
  | { readonly kind: 'connection_not_found' }
  | { readonly kind: 'connection_disabled' }
  | {
      readonly kind: 'provider_action_unavailable';
      readonly availability: UnavailableProviderActionAvailability;
    }
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  | {
      readonly kind: 'ready';
      readonly ticket: InteractiveOAuthLoginTicket;
      readonly connection: ConnectionCatalogEntry & {
        readonly providerType: InteractiveOAuthLoginProvider;
      };
      readonly secretMaterial: Pick<RuntimePolicyOperationSecretMaterial, 'networkProxy'>;
      readonly networkProxy: RuntimePolicy['networkProxy'];
    };

export type InteractiveOAuthLoginCompletionResult =
  | {
      readonly kind: 'committed';
      readonly credentialId: string;
      readonly revision: number;
    }
  | {
      readonly kind: 'superseded';
      readonly changed: readonly Extract<
        ConnectionEffectChangedDomain,
        'connection' | 'credential'
      >[];
    };

export type ConnectionEffectPreparationFailure =
  | { readonly kind: 'connection_not_found' }
  | { readonly kind: 'connection_disabled' }
  | {
      readonly kind: 'provider_action_unavailable';
      readonly availability: UnavailableProviderActionAvailability;
    }
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus };

export type BeginModelFetchResult =
  | ConnectionEffectPreparationFailure
  | {
      readonly kind: 'ready';
      readonly ticket: ModelFetchTicket;
      readonly connection: ConnectionCatalogEntry;
      readonly secretMaterial: RuntimePolicyOperationSecretMaterial;
      readonly networkProxy: RuntimePolicy['networkProxy'];
    };

export type BeginConnectionTestResult =
  | ConnectionEffectPreparationFailure
  | {
      readonly kind: 'ready';
      readonly ticket: ConnectionTestTicket;
      readonly connection: ConnectionCatalogEntry;
      readonly modelId: string | null;
      readonly secretMaterial: RuntimePolicyOperationSecretMaterial;
      readonly networkProxy: RuntimePolicy['networkProxy'];
    };

export type ConnectionEffectCompletionResult =
  | { readonly kind: 'committed'; readonly snapshot: ConnectionCatalogSnapshot }
  | {
      readonly kind: 'superseded';
      readonly changed: readonly ConnectionEffectChangedDomain[];
    };

export interface CommitConnectionOnboardingInput {
  readonly providerType: ConnectionCatalogEntry['providerType'];
  readonly suppliedSecret: string | null;
  readonly enabledModelIds: readonly string[];
  readonly discovery: ConnectionModelDiscoveryResult;
}

export type CommitConnectionOnboardingResult =
  | {
      readonly kind: 'committed';
      readonly snapshot: ConnectionCatalogSnapshot;
      readonly changed: boolean;
    }
  | { readonly kind: 'slug_conflict' };

export type ResolveExecutionConnectionResult =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  | {
      readonly kind: 'ready';
      readonly connection: ConnectionCatalogEntry;
      readonly secretMaterial: RuntimePolicyOperationSecretMaterial;
      readonly networkProxy: RuntimePolicy['networkProxy'];
    };

export type ReplaceConnectionRequestHeadersResult =
  | ({ readonly kind: 'committed' | 'unchanged' } & SavedRequestHeaders)
  | { readonly kind: 'connection_not_found' };

export interface RuntimePolicyOperationCoordinator {
  exportCredentialMaterial(
    locator: CredentialLocator,
  ): Promise<RuntimePolicyCredentialMaterial | null>;
  getConnectionRequestHeaders(connectionId: string): Promise<SavedRequestHeaders | null>;
  replaceConnectionRequestHeaders(
    connectionId: string,
    updates: readonly RequestHeaderUpdate[],
  ): Promise<ReplaceConnectionRequestHeadersResult>;
  resolveExecutionConnection(connectionSlug: string): Promise<ResolveExecutionConnectionResult>;
  resolveWebSearchExecution(
    input?: ResolveWebSearchExecutionInput,
  ): Promise<ResolveWebSearchExecutionResult>;
  resolveWebFetchExecution(): Promise<ResolveWebFetchExecutionResult>;
  resolveNetworkProxyExecution(
    input?: ResolveNetworkProxyExecutionInput,
  ): Promise<ResolveNetworkProxyExecutionResult>;
  compareAndSetOAuthCredential(
    input: CompareAndSetOAuthCredentialInput,
  ): Promise<CompareAndSetOAuthCredentialResult>;
  importConnectionCredential(input: SetCredentialInput): Promise<CredentialMutationResult>;
  createCredentialProfile(
    input: CreateCredentialProfileInput,
  ): Promise<CredentialProfileMutationResult>;
  updateCredentialProfile(
    input: UpdateCredentialProfileInput,
  ): Promise<CredentialProfileMutationResult>;
  setCredentialProfileEnabled(
    input: SetCredentialProfileEnabledInput,
  ): Promise<CredentialProfileMutationResult>;
  removeCredentialProfile(
    input: RemoveCredentialProfileInput,
  ): Promise<CredentialProfileMutationResult>;
  setCredentialRoutingMode(
    input: SetCredentialRoutingModeInput,
  ): Promise<CredentialProfileMutationResult>;
  recordCredentialProfileVerification(
    input: RecordCredentialProfileVerificationInput,
  ): Promise<RecordCredentialProfileVerificationResult>;
  beginInteractiveOAuthLogin(connectionId: string): Promise<BeginInteractiveOAuthLoginResult>;
  completeInteractiveOAuthLogin(
    ticket: InteractiveOAuthLoginTicket,
    secret: string,
  ): Promise<InteractiveOAuthLoginCompletionResult>;
  beginModelFetch(connectionId: string): Promise<BeginModelFetchResult>;
  completeModelFetch(
    ticket: ModelFetchTicket,
    result: ConnectionModelDiscoveryResult,
  ): Promise<ConnectionEffectCompletionResult>;
  commitConnectionOnboarding(
    input: CommitConnectionOnboardingInput,
  ): Promise<CommitConnectionOnboardingResult>;
  beginConnectionTest(
    connectionId: string,
    modelId: string | null,
  ): Promise<BeginConnectionTestResult>;
  completeConnectionTest(
    ticket: ConnectionTestTicket,
    result: ConnectionTestSummary,
  ): Promise<ConnectionEffectCompletionResult>;
}

export function connectionCredentialLocator(
  connectionId: string,
  authKind: ProviderAuthKind,
): Extract<CredentialLocator, { scope: 'connection' }> | null {
  switch (authKind) {
    case 'api_key':
    case 'optional_api_key':
      return { scope: 'connection', connectionId, kind: 'api_key' };
    case 'oauth_token':
      return { scope: 'connection', connectionId, kind: 'oauth_token' };
    case 'none':
      return null;
  }
}

/**
 * The Credential Vault locator for a secondary Profile. `authKind` must be a
 * profile-capable kind (`api_key` | `optional_api_key` | `oauth_token`);
 * the primary Profile keeps using `connectionCredentialLocator` with the
 * `connection` scope, so this helper must never be called for the primary
 * (`profileId === connectionId`).
 */
export function connectionProfileCredentialLocator(
  connectionId: string,
  profileId: string,
  authKind: ProviderAuthKind,
): Extract<CredentialLocator, { scope: 'connection_profile' }> | null {
  switch (authKind) {
    case 'api_key':
    case 'optional_api_key':
      return { scope: 'connection_profile', connectionId, profileId, kind: 'api_key' };
    case 'oauth_token':
      return { scope: 'connection_profile', connectionId, profileId, kind: 'oauth_token' };
    case 'none':
      return null;
  }
}

export function connectionRequestHeadersLocator(
  connectionId: string,
): Extract<CredentialLocator, { scope: 'connection' }> & { readonly kind: 'request_headers' } {
  return { scope: 'connection', connectionId, kind: 'request_headers' };
}
