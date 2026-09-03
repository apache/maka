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

import { useUiLocale } from '@maka/ui';
import type { UsageSettings } from '@maka/core/settings';
import { UsageSettingsView } from '../features/usage';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsPage } from './settings-section';

/**
 * Legacy delegation seam for the Usage feature (issue #4425), split into the two
 * levels the settings surface mounts it at:
 *
 * - `UsageScopeMount` is the feature's persistent `UsageFeatureScope`, re-exported
 *   under the mount name. `settings-surface` mounts it *above* the loading/error
 *   gate, so the loaded snapshot survives a Skeleton/Banner state or a section
 *   change. The scope takes `targetKey` (`host:epoch`) as a prop and
 *   clears/invalidates internally when it changes, so a Host/generation change
 *   never remounts the surface. A plain re-export is enough — the scope's prop
 *   contract is already the mount contract, so no wrapper is needed.
 * - `UsageSettingsPage` is the disposable view, mounted in the section content
 *   slot; it reads the snapshot from the scope above via context.
 *
 * The page binds only the locale-scoped error description (`describeError`) here;
 * copy is imported directly from the validated locale catalog by the view. This
 * shim touches no `window.maka` and imports no platform/feature-internal code, so
 * it stays a thin closure shim. It is a transitional seam, not the composition
 * ownership #4425 targets: the `UsageServices` are still assembled in
 * `settings-surface`, not in `composition/desktop-feature-services.tsx` +
 * a `platform/desktop` adapter.
 */
export { UsageFeatureScope as UsageScopeMount } from '../features/usage';
export type { UsageScopeHandle } from '../features/usage';

export function UsageSettingsPage(props: {
  settings: UsageSettings;
  onOpenSession?(sessionId: string): void;
}) {
  const locale = useUiLocale();
  return (
    <SettingsPage className="settingsUsagePage">
      <UsageSettingsView
        settings={props.settings}
        describeError={(error) => settingsActionErrorMessage(error, locale)}
        onOpenSession={props.onOpenSession}
      />
    </SettingsPage>
  );
}
