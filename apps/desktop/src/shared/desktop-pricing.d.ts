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

// Cross-boundary Pricing Settings *types* shared by the Desktop adapter (main),
// the preload bridge, and the renderer. They live here — not in `main/` — so the
// renderer and preload can name them without importing the Runtime Host client.
//
// This is a declaration-only file (`.d.ts`) on purpose: the preload bridge
// contract (`bridge-contract.d.ts`) reaches these types from the renderer's
// import graph, and a declaration file is excluded from the legacy-AppShell /
// renderer-root transitive closure the architecture ratchet tracks (a runtime
// `.ts` in `shared/` would be pulled in as new closure debt). The runtime guard
// that validates a round-tripped snapshot lives beside it in
// `desktop-pricing-decode.ts`, imported only by the Main IPC layer.
//
// The adapter (`runtime-host-client.ts`) is the sole owner of the snapshot's
// `revision`/`hostEpoch`/`connectionId`; the renderer only ever round-trips a
// snapshot it loaded back as the CAS `base`.

import type { EffectivePricingEntry, PricingMutation } from '@maka/runtime-host/protocol';

/** One revision-consistent page of effective pricing, stamped to its Host connection. */
export interface DesktopPricingSnapshot {
  readonly hostEpoch: string;
  readonly connectionId: string;
  readonly revision: number;
  readonly entries: readonly EffectivePricingEntry[];
}

export interface DesktopPricingMutationInput {
  readonly base: DesktopPricingSnapshot;
  readonly mutation: PricingMutation;
}

/**
 * Every terminal state of a pricing mutation. `saved`/`synchronized`/
 * `review_required` carry a fresh authoritative snapshot; `saved_refresh_failed`
 * and `reconciliation_unavailable` cannot, so the renderer keeps its draft and
 * disables further writes until it can reload.
 */
export type DesktopPricingMutationOutcome =
  | {
      readonly kind: 'saved';
      readonly disposition: 'committed' | 'unchanged';
      readonly snapshot: DesktopPricingSnapshot;
    }
  | {
      readonly kind: 'saved_refresh_failed';
      readonly disposition: 'committed' | 'unchanged';
    }
  | {
      readonly kind: 'synchronized' | 'review_required';
      readonly reason: 'revision_conflict' | 'outcome_unknown';
      readonly snapshot: DesktopPricingSnapshot;
    }
  | {
      readonly kind: 'reconciliation_unavailable';
      readonly reason: 'revision_conflict' | 'outcome_unknown';
    };
