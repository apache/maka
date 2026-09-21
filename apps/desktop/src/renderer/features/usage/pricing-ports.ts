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

// Dependency-inversion boundary for the editable Pricing surface (#2015),
// hosted inside the Usage settings feature (#4425). The pricing controller owns
// the draft/CAS state and reads these ports; it never touches `window.maka`.
//
// Unlike the range-scoped `UsageServices` (still assembled inline in the legacy
// `settings/settings-surface.tsx`), pricing services are assembled in
// `composition/desktop-feature-services.tsx` via a `platform/desktop` adapter —
// the composition ownership #4425 targets. Pricing is net-new, so routing its
// `window.maka.settings.pricing` bridge access through the platform adapter is
// what keeps a new bridge path out of the frozen legacy-AppShell closure files
// (the renderer-architecture ratchet forbids growing their bridge paths).
//
import type { PricingMutation } from '@maka/runtime-host/protocol';
import type {
  DesktopPricingMutationOutcome,
  DesktopPricingSnapshot,
} from '../../../shared/desktop-pricing.js';
import type { UsageHostRef } from './ports.js';

export interface UsagePricingTarget {
  readonly host: UsageHostRef;
  readonly generationKey: string;
  /** True only while this exact Host generation remains authoritative. */
  readonly isCurrent: () => boolean;
}

export interface UsagePricingServices {
  /**
   * One complete effective pricing snapshot (built-in ∪ overrides) for the given
   * Runtime Host. The `host` is the settings-*selected* Host (threaded from the
   * legacy surface), not the app's active Host — pricing overrides are per-Host,
   * so the Pricing tab must read/write the same Host as the rest of the settings
   * page. The renderer round-trips the snapshot as the CAS base for a mutation.
   */
  loadPricing(host: UsageHostRef): Promise<DesktopPricingSnapshot>;
  /** Apply one pricing upsert/delete against the viewed snapshot (the CAS base). */
  mutatePricing(
    host: UsageHostRef,
    base: DesktopPricingSnapshot,
    mutation: PricingMutation,
  ): Promise<DesktopPricingMutationOutcome>;
}
