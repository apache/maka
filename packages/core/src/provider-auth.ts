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

import {
  providerAuthRequiresSecret,
  providerDefaultsOf,
  providerSupportsModelDiscovery,
  type ProviderType,
} from './llm-connections.js';

/**
 * The credential operations this contract admits. One entry per operation the
 * storage coordinator actually gates — an operation with no admission point
 * does not belong here, however natural it sounds beside these three.
 */
export const PROVIDER_AUTH_ACTIONS = ['test_credentials', 'fetch_models', 'start_oauth'] as const;
export type ProviderAuthAction = (typeof PROVIDER_AUTH_ACTIONS)[number];

export interface ProviderAuthContract {
  /**
   * Whether reaching this provider needs credential material at all. Decides
   * whether a missing secret blocks the operation or is simply nothing to load.
   */
  requiresSecret: boolean;
  /** Whether each credential operation may run on this connection. */
  actionAvailability: Record<ProviderAuthAction, boolean>;
}

/**
 * Which credential operations a connection may run. This is an admission
 * answer, not a UI state: the storage layer refuses an unavailable action, so a
 * client that offers one gets the same refusal as one that never showed it.
 *
 * Callers decide `enabled` themselves before asking — a disabled connection
 * runs no credential operation at all, which is a decision about the
 * connection rather than about its provider's auth.
 */
export function deriveProviderAuthContract(input: {
  providerType: ProviderType;
  hasSecret: boolean;
}): ProviderAuthContract {
  const requiresSecret = providerAuthRequiresSecret(input.providerType);
  const defaults = providerDefaultsOf(input.providerType);
  // Two ways to have nothing to offer. An unknown providerType (legacy seed, or
  // a connection persisted on a branch that registers a provider this build
  // doesn't know) has no auth to run — mirrors `isRealConnection` in
  // connection-readiness.ts. A retired provider keeps its registry entry so a
  // stored connection still decodes and renders, but every action leads
  // nowhere: no Runtime adapter to send on, no sign-in to complete, no endpoint
  // to test. Deleting the connection is what clears the credential this machine
  // still holds.
  if (!defaults || defaults.retired === true) {
    return { requiresSecret, actionAvailability: actions({}) };
  }

  const hasSecret = input.hasSecret;
  const canFetchModels = providerSupportsModelDiscovery(input.providerType);

  if (defaults.authKind === 'oauth_token') {
    return {
      requiresSecret,
      actionAvailability: actions({
        test_credentials: hasSecret,
        fetch_models: hasSecret && canFetchModels,
        start_oauth: !hasSecret,
      }),
    };
  }

  // `none` needs no key, and `optional_api_key` may need none for this
  // instance, so both leave testing and fetching open whether or not one is
  // saved. Only a provider that requires a key waits for one.
  const reachableWithoutSecret =
    defaults.authKind === 'none' || defaults.authKind === 'optional_api_key';
  return {
    requiresSecret,
    actionAvailability: actions({
      test_credentials: reachableWithoutSecret || hasSecret,
      fetch_models: canFetchModels && (reachableWithoutSecret || hasSecret),
    }),
  };
}

function actions(
  available: Partial<Record<ProviderAuthAction, boolean>>,
): Record<ProviderAuthAction, boolean> {
  return Object.fromEntries(
    PROVIDER_AUTH_ACTIONS.map((action) => [action, available[action] === true]),
  ) as Record<ProviderAuthAction, boolean>;
}
