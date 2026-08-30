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

import type { ForeignSessionDigest, ForeignSessionSummary } from '@maka/core/foreign-session';
import type { ModelInfo, ProviderType } from '@maka/core/llm-connections';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { ConnectionOnboardingTarget } from '@maka/core/runtime-policy';
import type {
  ConnectionEffectFailureClass,
  ConnectionOnboardingSaveResult as RuntimeHostOnboardingSaveResult,
  ConnectionOnboardingVerifyResult as RuntimeHostOnboardingVerifyResult,
} from '@maka/runtime-host/protocol';
import type { MakaPiTuiTurnActivity } from './pi-tui-turn.js';

export interface ModelChoice {
  /** Immutable account identity; required for a cross-connection selection. */
  connectionId?: string;
  connectionSlug: string;
  connectionName: string;
  providerType: ProviderType;
  model: string;
  /** Human-readable model name from the provider catalog, when available. */
  displayName?: string;
  isDefaultConnection: boolean;
  /** Maximum context tokens for this model, resolved from the connection or provider catalog. */
  contextWindow?: number;
  /**
   * Thinking levels this model exposes. `listReadyModelChoices` always
   * computes this with the full connection (so an openai-compatible relay's
   * declared `relayModelProfiles[model].thinkingLevels` are honoured);
   * optional only so hand-written choice literals stay valid — consumers
   * must tolerate its absence.
   */
  thinkingLevels?: readonly ThinkingLevel[];
}

export interface OnboardableProvider {
  providerType: ProviderType;
  label: string;
  authKind: 'api_key' | 'optional_api_key';
  requiresBaseUrl: boolean;
  fallbackModels: readonly string[];
}

export type OnboardingProviderEntry = OnboardableProvider &
  (
    | {
        target: Extract<ConnectionOnboardingTarget, { readonly kind: 'create' }>;
        enabledModelIds: readonly string[];
      }
    | {
        target: Extract<ConnectionOnboardingTarget, { readonly kind: 'existing' }>;
        connectionSlug: string;
        enabledModelIds: readonly string[];
      }
  );

export interface OnboardingVerifyInput {
  target: ConnectionOnboardingTarget;
  apiKey?: string;
  /** Endpoint for `requiresBaseUrl` providers; blank reuses the persisted one. */
  baseUrl?: string;
}

export type OnboardingVerifyRejectionReason = Extract<
  RuntimeHostOnboardingVerifyResult,
  { readonly kind: 'rejected' }
>['reason'];

export type OnboardingSaveRejectionReason = Extract<
  RuntimeHostOnboardingSaveResult,
  { readonly kind: 'rejected' }
>['reason'];

export type OnboardingRejectionReason =
  | OnboardingVerifyRejectionReason
  | OnboardingSaveRejectionReason;

export type OnboardingFailureClass = ConnectionEffectFailureClass;

export type OnboardingFailure =
  | { kind: 'rejected'; reason: OnboardingRejectionReason }
  | { kind: 'failed'; errorClass: ConnectionEffectFailureClass }
  | { kind: 'unavailable' };

export type OnboardingVerifyResult =
  | { kind: 'ok'; models: ModelInfo[] }
  | { kind: 'rejected'; reason: OnboardingVerifyRejectionReason }
  | { kind: 'failed'; errorClass: ConnectionEffectFailureClass }
  | { kind: 'unavailable' };

export interface OnboardingSaveInput {
  target: ConnectionOnboardingTarget;
  apiKey?: string;
  /** Endpoint for `requiresBaseUrl` providers; blank reuses the persisted one. */
  baseUrl?: string;
  enabledModelIds: readonly string[];
  models: readonly ModelInfo[];
}

export interface OnboardingSavedConnection {
  connectionId: string;
  revision: number;
  slug: string;
  providerType: ProviderType;
}

export type OnboardingSaveResult =
  | {
      kind: 'ok';
      connection: OnboardingSavedConnection;
      refresh:
        | { kind: 'ok'; modelChoices: ModelChoice[] }
        | { kind: 'failed'; reason: 'catalog_unavailable' };
    }
  | OnboardingFailure;

export interface MakaOnboardingSurface {
  listProviders(): Promise<OnboardingProviderEntry[]>;
  verify(input: OnboardingVerifyInput): Promise<OnboardingVerifyResult>;
  save(input: OnboardingSaveInput): Promise<OnboardingSaveResult>;
}

export interface SessionRecapGenerator {
  generate(
    sessionId: string,
    reason: 'manual' | 'idle',
  ): Promise<{ ok: true; text: string; raw: string } | { ok: false; error: string }>;
}

export interface MakaForeignSessionReader {
  listSessions(options?: { cwd?: string }): Promise<ForeignSessionSummary[]>;
  readDigest(summary: ForeignSessionSummary): Promise<ForeignSessionDigest>;
}

export type MakaPiTuiTurnActivitySurface = MakaPiTuiTurnActivity;
