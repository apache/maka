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

/**
 * A provider's account usage, in a shape the settings card can render without
 * knowing which provider produced it.
 *
 * Providers differ in what they report — one exposes a five-hour window and a
 * weekly one, another only a monthly balance, a third nothing at all. Rather
 * than teach the card each dialect, the provider reports a LIST of windows and
 * optional stats, and every field is optional: what was not reported is absent,
 * which the card renders as "no such row", never as a zero placeholder. A
 * reported `0` is a fact (nothing consumed); an absent field is the provider not
 * speaking, and the two must not look alike.
 */

export type UsageUnit = 'credits' | 'usd' | 'tokens';

/**
 * One quota window — one progress bar. `fiveHour` / `weekly` / `monthly` are all
 * this: a label, an amount consumed against a cap, and a reset. The card keys
 * its localized labels off `id` and falls back to `label` for a window it does
 * not recognize, so a provider may add windows without a card change.
 */
export interface UsageWindow {
  /** Stable identity: `fiveHour` | `weekly` | `monthly` | provider-specific. */
  readonly id: string;
  /** Provider-supplied label, used when the card has no copy for `id`. */
  readonly label?: string;
  readonly used: number;
  readonly cap: number;
  readonly unit: UsageUnit;
  /** Epoch millis the window resets; absent when the provider did not say. */
  readonly resetsAt?: number;
  /**
   * The window exists but has no cap (spend is open). Distinct from a cap of
   * `0`, which is "no allowance left" — the same distinction the provider
   * itself draws between an absent window and an uncapped one.
   */
  readonly unlimited?: boolean;
}

/** Aggregate counters. Each is optional: providers report different subsets. */
export interface UsageStats {
  readonly requests?: number;
  readonly failed?: number;
  /** Percentage in `0..100`, as the provider reports it. */
  readonly successRate?: number;
  readonly cost?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
}

export interface ConnectionUsageReport {
  readonly accountLabel?: string;
  readonly planLabel?: string;
  readonly stats?: UsageStats;
  /** In display order. Empty when the provider reported no windows. */
  readonly windows: readonly UsageWindow[];
  /** Billing period end, when the provider reports one. */
  readonly periodEnd?: number;
  /**
   * True when SOME endpoints refused the credential (401/403) while others
   * answered — a key that is valid but lacks a scope, so part of the account's
   * data is missing rather than the whole read failing. The card shows what it
   * has and says the rest was refused, instead of silently presenting a partial
   * report as if it were complete.
   */
  readonly partiallyUnauthorized?: boolean;
  readonly fetchedAt: number;
}

/**
 * The outcome of a usage read. `unavailable` is not an error the caller
 * surfaces loudly — a credential the provider has not accepted, a fetch that
 * never landed, or a provider with no usage endpoint at all — it is the card
 * saying it has nothing to show.
 */
export type ConnectionUsageResult =
  | { readonly kind: 'report'; readonly report: ConnectionUsageReport }
  | {
      readonly kind: 'unavailable';
      /**
       * Why the read produced nothing. `unauthorized` is deliberately distinct
       * from `network`: an expired or under-scoped key and an unreachable host
       * are different problems with different fixes, and the settings page that
       * shows this is the page where the credential is repaired. Collapsing them
       * would tell a user with a dead key to check their connection.
       */
      readonly reason: 'no-credential' | 'unauthorized' | 'unsupported' | 'network';
    };

import type { ProviderType } from './llm-connections.js';

/**
 * The providers Maka can read account usage from. The single source of truth
 * for both the settings section's visibility and the runtime dispatch, so a
 * provider that gains a mapper is offered the card in the same change.
 */
const USAGE_PROVIDERS: ReadonlySet<ProviderType> = new Set<ProviderType>(['commandcode-go']);

export function providerReportsUsage(providerType: ProviderType): boolean {
  return USAGE_PROVIDERS.has(providerType);
}
