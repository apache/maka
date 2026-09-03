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

import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { UsagePricingServices } from '../../features/usage';

export type DesktopUsagePricingBridge = Pick<MakaBridge, 'settings'>;

// Desktop adapter for the editable Pricing surface (#2015). It owns the only
// `window.maka.settings.pricing` bridge access, keeping it in the platform zone
// so no new bridge path lands in a frozen legacy-closure file. The `host` is the
// settings-selected Runtime Host threaded from the feature, so pricing reads and
// writes target the same Host as the rest of the settings page (not the app's
// active Host, which `bridge.settings.pricing.load(undefined)` would resolve).
export function createDesktopUsagePricingServices(
  bridge: DesktopUsagePricingBridge = window.maka,
): UsagePricingServices {
  return {
    loadPricing: (host) => bridge.settings.pricing.load(host),
    mutatePricing: (host, base, mutation) => bridge.settings.pricing.mutate(base, mutation, host),
  };
}
