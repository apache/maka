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
  ConnectionTestResult,
  CreateConnectionInput,
  IdentifiedLlmConnection,
  LlmConnection,
  ModelDiscoveryResult,
  RequestHeaderUpdate,
  SavedRequestHeaders,
  UpdateConnectionInput,
} from '@maka/core/llm-connections';
import type { SubscriptionActionResult } from '@maka/core/oauth-subscription';
import type {
  ConnectionOnboardingSaveInput,
  ConnectionOnboardingSaveResult,
  ConnectionOnboardingVerifyInput,
  ConnectionOnboardingVerifyResult,
  OAuthConnectionIdentity,
} from '@maka/runtime-host/protocol';
import type {
  DesktopConnectionIdentity,
  DesktopConnectionSnapshot,
} from '../../../shared/desktop-connection-snapshot.js';
export interface ConnectionSettingsHost {
  readonly profileId: string;
  readonly hostId: string;
}

export type DesktopConnectionOnboardingIdentity = Extract<
  ConnectionOnboardingSaveResult,
  { readonly kind: 'saved' }
>['connection'];

export type ConnectionOAuthLoginTarget =
  | { readonly kind: 'create' }
  | { readonly kind: 'existing'; readonly connectionId: string };

export type ConnectionOAuthAuthorizationStartResult =
  | {
      readonly authRequestId: string;
      readonly stateHint: string;
      readonly connection: OAuthConnectionIdentity;
    }
  | Exclude<SubscriptionActionResult, { readonly ok: true }>;

export type ConnectionOAuthAuthorizationResult =
  | { readonly ok: true; readonly connection: OAuthConnectionIdentity }
  | Exclude<SubscriptionActionResult, { readonly ok: true }>;

export interface ConnectionOAuthProviderBridge {
  getAuthUrl(target: ConnectionOAuthLoginTarget): Promise<ConnectionOAuthAuthorizationStartResult>;
  openAuthUrl(authRequestId: string): Promise<SubscriptionActionResult>;
  completeAuthorization(authRequestId: string): Promise<ConnectionOAuthAuthorizationResult>;
  cancelAuthorization(authRequestId?: string): Promise<{ readonly ok: true }>;
  getEnrollmentState(): Promise<{ readonly enabled: boolean }>;
  getAccountState(connectionId: string): Promise<unknown>;
  logout(connectionId: string): Promise<SubscriptionActionResult>;
}

export interface ConnectionOAuthBridge {
  readonly openAiCodex: ConnectionOAuthProviderBridge;
  readonly xaiOAuth: ConnectionOAuthProviderBridge;
  readonly githubCopilotSubscription: ConnectionOAuthProviderBridge & {
    connectExistingLogin(): Promise<SubscriptionActionResult>;
  };
}

export interface ConnectionsBridge {
  /** Host-bound account operations; every adapter and fixture must provide them. */
  readonly oauth: ConnectionOAuthBridge;
  getSnapshot(): Promise<DesktopConnectionSnapshot>;
  setDefault(connection: DesktopConnectionIdentity | null): Promise<void>;
  create(input: CreateConnectionInput): Promise<IdentifiedLlmConnection>;
  update(connection: DesktopConnectionIdentity, patch: UpdateConnectionInput): Promise<LlmConnection>;
  delete(connection: DesktopConnectionIdentity): Promise<void>;
  test(connection: DesktopConnectionIdentity, opts?: { model?: string }): Promise<ConnectionTestResult>;
  fetchModels(connection: DesktopConnectionIdentity): Promise<
    Pick<ModelDiscoveryResult, 'models' | 'source'>
  >;
  hasSecret(connection: DesktopConnectionIdentity): Promise<boolean>;
  getRequestHeaders(connection: DesktopConnectionIdentity): Promise<SavedRequestHeaders>;
  setRequestHeaders(
    connection: DesktopConnectionIdentity,
    headers: readonly RequestHeaderUpdate[],
  ): Promise<SavedRequestHeaders>;
  subscribeEvents?(handler: () => void): () => void;
}

export interface RuntimeHostSettingsConnectionsBridge extends ConnectionsBridge {
  setDefaultModel(input: { slug: string; model: string } | null): Promise<void>;
  subscribeEvents(handler: () => void): () => void;
}

export interface ApiKeyOnboardingBridge {
  readonly saveUncertainty: {
    getSnapshot(): boolean;
    subscribe(listener: () => void): () => void;
    restart(): void;
  };
  verify(input: ConnectionOnboardingVerifyInput): Promise<ConnectionOnboardingVerifyResult>;
  save(input: ConnectionOnboardingSaveInput): Promise<
    | { readonly kind: 'result'; readonly result: ConnectionOnboardingSaveResult }
    | { readonly kind: 'not_saved' }
    | { readonly kind: 'outcome_unknown' }
  >;
}

export interface ConnectionSettingsServices {
  forHost(host: ConnectionSettingsHost): {
    readonly connections: RuntimeHostSettingsConnectionsBridge;
    readonly apiKeyOnboarding: ApiKeyOnboardingBridge;
  };
}
