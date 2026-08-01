import type {
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
  ConnectionModelDiscoveryResult,
  ConnectionTestSummary,
  CredentialLocator,
  CredentialStatus,
  CredentialVersionBasis,
  RuntimePolicy,
} from '@maka/core/runtime-policy';
import type { ProviderAuthActionAvailability } from '@maka/core/provider-auth';
import type { ProviderDefaults } from '@maka/core/llm-connections';

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
  readonly networkProxy?: RuntimePolicyCredentialMaterial;
}

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

export interface RuntimePolicyOperationCoordinator {
  resolveExecutionConnection(connectionSlug: string): Promise<ResolveExecutionConnectionResult>;
  compareAndSetOAuthCredential(
    input: CompareAndSetOAuthCredentialInput,
  ): Promise<CompareAndSetOAuthCredentialResult>;
  beginModelFetch(connectionId: string): Promise<BeginModelFetchResult>;
  completeModelFetch(
    ticket: ModelFetchTicket,
    result: ConnectionModelDiscoveryResult,
  ): Promise<ConnectionEffectCompletionResult>;
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
