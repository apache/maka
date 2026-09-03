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

import type { UsageRange, UsageSettings, UsageStats } from '@maka/core/settings';

// Dependency-inversion boundary for the Usage settings feature (issue #4425).
// The feature controller owns draft/state and reads these ports; it never
// touches `window.maka` or legacy settings helpers directly. Both are narrow —
// the feature consumes only `UsageSettings`, never the whole `AppSettings`. This
// contract is currently implemented in the legacy `settings/settings-surface.tsx`
// (bound to the settings-selected Runtime Host and its settings-update
// reconciliation), which is a transitional seam — not yet the
// `composition/desktop-feature-services.tsx` + `platform/desktop` adapter that
// #4425 ultimately targets.
export interface UsageServices {
  /** Host-scoped usage stats for a range (`null` = no Host / not loaded yet). */
  loadUsageStats(range: UsageRange): Promise<UsageStats | null>;
  /**
   * Persist a usage display-preferences patch and resolve with the reconciled
   * usage settings. Routes through the app settings update (client-owned
   * settings) so the settings-surface reconciliation (uiLocale gate +
   * client-settings reload) is preserved; the adapter projects the result down
   * to `UsageSettings` so the feature never sees the whole `AppSettings`.
   */
  updateUsageSettings(patch: Partial<UsageSettings>): Promise<UsageSettings>;
}
