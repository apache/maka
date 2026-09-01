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

import { forwardRef, type ReactNode } from 'react';
import { useUiLocale } from '@maka/ui';
import type { UsageSettings } from '@maka/core/settings';
import {
  UsageFeatureScope,
  UsageSettingsView,
  type UsageScopeHandle,
  type UsageServices,
} from '../features/usage';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsPage } from './settings-section';

export type { UsageScopeHandle } from '../features/usage';

/**
 * Legacy delegation seam for the Usage feature (issue #4425), split into the two
 * levels the settings surface mounts it at:
 *
 * - `UsageScopeMount` hosts the feature's persistent `UsageFeatureScope`.
 *   `settings-surface` mounts it *above* the loading/error gate, so the loaded
 *   snapshot survives a Skeleton/Banner state or a section change. The scope
 *   takes `targetKey` (`host:epoch`) as a prop and clears/invalidates internally
 *   when it changes, so a Host/generation change never remounts the surface.
 * - `UsageSettingsPage` is the disposable view, mounted in the section content
 *   slot; it reads the snapshot from the scope above via context.
 *
 * Both bind locale-scoped copy + error description here, touch no `window.maka`,
 * and import no platform/feature-internal code, so this stays a thin closure
 * shim. It is a transitional seam, not the composition ownership #4425 targets:
 * the `UsageServices` are still assembled in `settings-surface`, not in
 * `composition/desktop-feature-services.tsx` + a `platform/desktop` adapter.
 */
export const UsageScopeMount = forwardRef<
  UsageScopeHandle,
  {
    /** Selected Host generation (`host:epoch`); a change resets the scope's snapshot. */
    targetKey: string;
    services: UsageServices;
    loadErrorTitle: string;
    /** Localize a load failure (bound to the settings locale by the caller). */
    describeError(error: unknown): string;
    children?: ReactNode;
  }
>(function UsageScopeMount(props, ref) {
  return (
    <UsageFeatureScope
      ref={ref}
      targetKey={props.targetKey}
      services={props.services}
      loadErrorTitle={props.loadErrorTitle}
      describeError={props.describeError}
    >
      {props.children}
    </UsageFeatureScope>
  );
});

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
