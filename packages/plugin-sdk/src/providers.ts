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

import type { Awaitable, Cancellation, Json, Registration } from './host.js';
import type { ModelRequest, ModelTransport } from './models.js';

export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra';
export type ApiProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';
export type Modality = 'text' | 'image' | 'audio' | 'pdf' | 'video';
export interface ModelCapabilities {
  chat?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  functionCalling?: boolean;
  parallelToolCalls?: boolean;
  imageGeneration?: boolean;
  webSearch?: boolean;
}
export interface ModelInfo {
  id: string;
  displayName?: string;
  description?: string;
  apiProtocol?: ApiProtocol;
  contextWindow?: number;
  inputLimit?: number;
  maxOutputTokens?: number;
  thinkingLevels?: readonly ThinkingLevel[];
  defaultThinkingLevel?: ThinkingLevel;
  supportsReasoningSummary?: boolean;
  knowledgeCutoff?: string;
  structuredOutput?: boolean;
  lastUpdated?: string;
  capabilities?: ModelCapabilities;
  modalities?: { input: readonly Modality[]; output: readonly Modality[] };
}
export interface ModelOverride {
  adapter?: string;
  codeMode?: boolean;
  applyPatch?: boolean;
  thinkingLevels?: readonly ThinkingLevel[];
  defaultThinkingLevel?: ThinkingLevel;
  vision?: boolean;
  contextWindow?: number;
  compactionThreshold?: number;
  inputLimit?: number;
  maxOutputTokens?: number;
  displayName?: string;
  description?: string;
  apiProtocol?: ApiProtocol;
  knowledgeCutoff?: string;
  capabilities?: Omit<ModelCapabilities, 'vision'>;
  modalities?: ModelInfo['modalities'];
  serviceTier?: 'fast';
}
export interface ProviderIdentity {
  packageId: string;
  entryId: string;
  scope: 'profile' | `session:${string}`;
  name: string;
}
export interface ProviderConnection {
  id: string;
  revision: number;
  configuration: Json;
}
export interface AuthenticationMethod {
  id: string;
  label: string;
  inputSchema: Json;
  interactive: boolean;
}
export interface ProviderDescriptor {
  label: string;
  configurationSchema: Json;
  configurationDefaults: Json;
  authentication: readonly AuthenticationMethod[];
  /** Supports a connection without a stored credential; not an authorization grant. */
  anonymous: boolean;
  discovery: boolean;
}
/** Opaque state stored by Host, never ordinary plugin storage or catalog metadata. */
export interface ProviderCredential {
  secret: string;
  /** Absolute Unix milliseconds; the provider includes its refresh lead time. */
  refreshAt: number | null;
}
export interface ResolveModel {
  connection: ProviderConnection;
  model: ModelInfo;
  overrides: ModelOverride | null;
  thinkingLevel: ThinkingLevel | null;
}
export interface ResolvedModel {
  adapter: string;
  protocol: ModelRequest['provider']['kind'];
  baseUrl: string;
  info: ModelInfo;
  thinkingLevels: readonly ThinkingLevel[];
  providerOptions: Json;
  /** Resolved reply budget, not advertised model capacity. */
  mainOutputLimit: number | null;
}
export type RequestCredentials =
  | { apiKey: string }
  | { requestHeaders: Readonly<Record<string, string>> };
export interface ProviderContext {
  readonly signal: Cancellation;
  readonly transport: ModelTransport;
  /** Only an interactive login has presentation authority. */
  openExternal(url: string, userCode?: string): Promise<void>;
}
export interface ModelProvider {
  resolve(input: ResolveModel): Awaitable<ResolvedModel>;
  authorize(input: {
    connection: ProviderConnection;
    credential: ProviderCredential | null;
    sessionId: string;
  }): Awaitable<RequestCredentials>;
  authenticate?(
    input: {
      connection: ProviderConnection;
      method: string;
      input: Json;
    },
    context: ProviderContext,
  ): Awaitable<ProviderCredential>;
  refresh?(
    input: {
      connection: ProviderConnection;
      credential: ProviderCredential;
    },
    context: ProviderContext,
  ): Awaitable<ProviderCredential>;
  discover?(
    input: {
      connection: ProviderConnection;
      credential: ProviderCredential | null;
      requestHeaders: Readonly<Record<string, string>>;
    },
    context: ProviderContext,
  ): Awaitable<readonly ModelInfo[]>;
  verify?(
    input: {
      connection: ProviderConnection;
      credential: ProviderCredential | null;
      requestHeaders: Readonly<Record<string, string>>;
      model: ModelInfo;
      overrides: ModelOverride | null;
      requestBodyOverlay: Json | null;
    },
    context: ProviderContext,
  ): Awaitable<void>;
}
export interface ModelProviders {
  register(
    name: string,
    descriptor: ProviderDescriptor,
    provider: ModelProvider,
  ): Promise<Registration>;
}
export type ProviderFailure =
  | { kind: 'unavailable' | 'cancelled' | 'authentication_required' | 'outcome_unknown' }
  | { kind: 'http'; message: number }
  | { kind: 'rejected' | 'invalid' | 'transport'; message: string };
