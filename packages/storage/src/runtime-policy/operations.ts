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

export function connectionRequestHeadersLocator(
  connectionId: string,
): Extract<CredentialLocator, { scope: 'connection' }> & { readonly kind: 'request_headers' } {
  return { scope: 'connection', connectionId, kind: 'request_headers' };
}
