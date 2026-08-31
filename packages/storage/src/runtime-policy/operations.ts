/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type {
  ConnectionCatalogEntry,
  ConnectionCatalogSnapshot,
  ConnectionModelDiscoveryResult,
  ConnectionOnboardingTarget,
  ConnectionTestSummary,
  CredentialMutationResult,
  CredentialLocator,
  SetCredentialInput,
  CredentialStatus,
  CredentialVersionBasis,
  RuntimePolicy,
  RequestHeaderUpdate,
  SavedRequestHeaders,
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
  'openai-codex' | 'xai-oauth'
>;

export type InteractiveOAuthLoginTarget =
  | { readonly kind: 'create'; readonly providerType: InteractiveOAuthLoginProvider }
  | { readonly kind: 'existing'; readonly connectionId: string };

export interface InteractiveOAuthLoginInput {
  readonly attemptId: string;
  readonly target: InteractiveOAuthLoginTarget;
}

export type InteractiveOAuthConnectionIdentity = Pick<
  ConnectionCatalogEntry,
  'connectionId' | 'slug' | 'providerType'
> & { readonly providerType: InteractiveOAuthLoginProvider };

export type QueryInteractiveOAuthLoginResult =
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'authenticated';
      readonly target: InteractiveOAuthLoginTarget;
      readonly connection: InteractiveOAuthConnectionIdentity;
    };

export type BeginInteractiveOAuthLoginResult =
  | {
      readonly kind: 'authenticated';
      readonly target: InteractiveOAuthLoginTarget;
      readonly connection: InteractiveOAuthConnectionIdentity;
    }
  | { readonly kind: 'connection_not_found' }
  | { readonly kind: 'connection_disabled' }
  | { readonly kind: 'catalog_full' }
  | { readonly kind: 'attempt_conflict' }
  | {
      readonly kind: 'provider_action_unavailable';
      readonly availability: UnavailableProviderActionAvailability;
    }
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  | {
      readonly kind: 'ready';
      readonly ticket: InteractiveOAuthLoginTicket;
      readonly target: InteractiveOAuthLoginTarget;
      readonly identity: InteractiveOAuthConnectionIdentity;
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
      readonly connection: InteractiveOAuthConnectionIdentity;
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

export interface ConnectionOnboardingTicket {
  readonly [operationTicketBrand]: 'connection_onboarding';
}

export interface BeginConnectionOnboardingInput {
  readonly target: ConnectionOnboardingTarget;
  readonly baseUrl: string | null;
}

/**
 * Discovery-basis handoff for onboarding: `begin` snapshots the connection
 * revision, credential status, and effective proxy the caller will discover
 * against and issues a one-shot ticket; `complete` revalidates that exact
 * basis under the write lane before committing, so a model inventory can
 * never be persisted onto an endpoint or credential it was not discovered
 * from (#3467 review).
 */
export type BeginConnectionOnboardingResult =
  // The explicitly targeted connection does not exist or changed provider type.
  | { readonly kind: 'target_missing' }
  | { readonly kind: 'provider_unsupported' }
  | { readonly kind: 'catalog_full' }
  | {
      readonly kind: 'ready';
      readonly ticket: ConnectionOnboardingTicket;
      readonly candidate: Pick<ConnectionCatalogEntry, 'connectionId' | 'slug' | 'providerType'>;
      /** The targeted persisted connection, or null when onboarding creates one. */
      readonly existingConnection: ConnectionCatalogEntry | null;
      /** Provider-normalized endpoint override pinned into the ticket. */
      readonly baseUrl: string | null;
      /** The target's stored API key, for blank-key reuse during discovery. */
      readonly storedSecret: string | null;
      /**
       * The target's custom request-headers secret, so the discovery probe
       * carries the same header customization the models path applies.
       */
      readonly requestHeadersSecret: string | null;
      /**
       * The proxy discovery must run through — pinned here, like
       * beginModelFetch pins it, so the basis certifies the egress the
       * inventory actually travelled.
       */
      readonly networkProxy: RuntimePolicy['networkProxy'];
      readonly proxySecret: string | null;
      /** The proxy requires a credential the vault does not hold. */
      readonly proxyCredentialMissing: boolean;
    };

export interface CommitConnectionOnboardingInput {
  readonly suppliedSecret: string | null;
  readonly enabledModelIds: readonly string[];
  readonly discovery: ConnectionModelDiscoveryResult;
}

export type CommitConnectionOnboardingResult =
  | {
      readonly kind: 'committed';
      readonly snapshot: ConnectionCatalogSnapshot;
      readonly changed: boolean;
      readonly connection: Pick<
        ConnectionCatalogEntry,
        'connectionId' | 'slug' | 'providerType' | 'revision'
      >;
    }
  | { readonly kind: 'catalog_full' }
  // The explicitly targeted connection no longer exists (or changed provider
  // type) between the caller's snapshot and this commit.
  | { readonly kind: 'target_missing' }
  // The discovery basis (connection revision, credential, or proxy) changed
  // between begin and complete: committing would bind another endpoint or
  // credential to a model inventory it never produced.
  | {
      readonly kind: 'superseded';
      readonly changed: readonly ConnectionEffectChangedDomain[];
    };

export type ResolveExecutionConnectionResult =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'identity_mismatch' }
  | { readonly kind: 'disabled' }
  /**
   * The provider was retired. Distinct from `disabled`, which the user chose
   * and can undo, and from `credential_not_configured`, which a sign-in would
   * fix — this connection keeps a usable credential and still cannot execute.
   */
  | { readonly kind: 'provider_retired' }
  | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  | {
      readonly kind: 'ready';
      readonly connection: ConnectionCatalogEntry;
      readonly secretMaterial: RuntimePolicyOperationSecretMaterial;
      readonly networkProxy: RuntimePolicy['networkProxy'];
    };

export type ExecutionConnectionRef =
  | {
      readonly kind: 'bound';
      readonly connectionId: string;
      readonly connectionSlug: string;
    }
  | {
      readonly kind: 'catalog_slug';
      readonly connectionSlug: string;
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
  resolveExecutionConnection(
    ref: ExecutionConnectionRef,
  ): Promise<ResolveExecutionConnectionResult>;
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
  beginInteractiveOAuthLogin(
    input: InteractiveOAuthLoginInput,
  ): Promise<BeginInteractiveOAuthLoginResult>;
  queryInteractiveOAuthLogin(attemptId: string): Promise<QueryInteractiveOAuthLoginResult>;
  completeInteractiveOAuthLogin(
    ticket: InteractiveOAuthLoginTicket,
    secret: string,
  ): Promise<InteractiveOAuthLoginCompletionResult>;
  beginModelFetch(connectionId: string): Promise<BeginModelFetchResult>;
  completeModelFetch(
    ticket: ModelFetchTicket,
    result: ConnectionModelDiscoveryResult,
  ): Promise<ConnectionEffectCompletionResult>;
  beginConnectionOnboarding(
    input: BeginConnectionOnboardingInput,
  ): Promise<BeginConnectionOnboardingResult>;
  completeConnectionOnboarding(
    ticket: ConnectionOnboardingTicket,
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

export function connectionRequestHeadersLocator(
  connectionId: string,
): Extract<CredentialLocator, { scope: 'connection' }> & { readonly kind: 'request_headers' } {
  return { scope: 'connection', connectionId, kind: 'request_headers' };
}
