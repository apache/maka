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

// Public API of the Usage settings feature (issue #4425). Legacy consumers
// import only from this barrel.

export { UsageSettingsView } from './ui/usage-settings-view.js';
export { UsageFeatureScope, type UsageScopeHandle } from './services-context.js';
export type { UsageServices } from './ports.js';
// The editable Pricing surface (#2015) is a Usage tab, but its services are
// assembled in `composition/desktop-feature-services.tsx` (not the legacy
// settings-surface that assembles `UsageServices`), so its bridge access stays
// out of the frozen legacy-AppShell closure.
export { UsagePricingServicesProvider } from './pricing-services-context.js';
export type { UsagePricingServices } from './pricing-ports.js';
