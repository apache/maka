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
  ProviderResponsesContract,
  ProviderRuntimeAdapter,
  ProviderRuntimeProfileId,
  ProviderType,
} from '@maka/core/llm-connections';

export type OpenResponsesCompatibilityProfile = 'alibaba-token-plan';

export type RuntimeProviderResponsesContract =
  | Extract<ProviderResponsesContract, { adapter: 'openai' }>
  | {
      readonly adapter: 'open-responses';
      readonly reasoningReplay: 'plaintext-content' | 'plaintext-summary';
      readonly compatibility?: OpenResponsesCompatibilityProfile;
    };

type OpenAiCompatibleRuntimeAdapter = Omit<
  Extract<ProviderRuntimeAdapter, { kind: 'openai-compatible' }>,
  'responses'
> & {
  readonly responses?: RuntimeProviderResponsesContract;
};

export type RuntimeProviderAdapter =
  | Exclude<ProviderRuntimeAdapter, { kind: 'openai-compatible' }>
  | OpenAiCompatibleRuntimeAdapter;

interface RuntimeProviderIdentity {
  readonly providerType: ProviderType;
  readonly slug?: string;
}

interface RuntimeProviderProfile {
  readonly responses: RuntimeProviderResponsesContract;
}

const ALIBABA_TOKEN_PLAN_RESPONSES = {
  adapter: 'open-responses',
  // The pinned SDK streams `response.reasoning_text.delta` as reasoning text,
  // then reads durable summary boundaries from `output_item.done.item.summary`.
  // Keep the raw-SSE contract test in sync if either channel changes.
  reasoningReplay: 'plaintext-summary',
  compatibility: 'alibaba-token-plan',
} as const satisfies RuntimeProviderResponsesContract;

const RUNTIME_PROVIDER_PROFILES = {
  'alibaba-token-plan': { responses: ALIBABA_TOKEN_PLAN_RESPONSES },
} as const satisfies Record<ProviderRuntimeProfileId, RuntimeProviderProfile>;

export const RUNTIME_PROVIDER_PROFILE_IDS = Object.freeze(
  Object.keys(RUNTIME_PROVIDER_PROFILES) as ProviderRuntimeProfileId[],
);

export function resolveRuntimeProviderAdapter(
  adapter: ProviderRuntimeAdapter,
): RuntimeProviderAdapter {
  if (adapter.kind !== 'openai-compatible' || adapter.runtimeProfile === undefined) {
    return adapter;
  }
  return { ...adapter, responses: RUNTIME_PROVIDER_PROFILES[adapter.runtimeProfile].responses };
}

/** Raw provider identity passed to open-responses and used as its provider-options key. */
export function runtimeProviderName(
  adapter: RuntimeProviderAdapter,
  connection: RuntimeProviderIdentity,
): string {
  return adapter.kind === 'openai-compatible' && adapter.name === 'connection'
    ? (connection.slug ?? connection.providerType)
    : connection.providerType;
}
