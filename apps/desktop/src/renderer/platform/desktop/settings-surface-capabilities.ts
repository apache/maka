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

import { runtimeHostProfileUsesHostWorkspace } from '@maka/runtime-host/profile-kind';
import type { RuntimeHostProfileKind } from '@maka/runtime-host/profile-kind';

/**
 * Desktop adapters for the Settings surface.
 *
 * Settings pages are legacy-zone renderer code and must not own Desktop
 * capabilities directly. The surface takes them from here and passes plain
 * values and callbacks down, so no Settings page reaches for `window.maka` or
 * web storage itself.
 */

/**
 * Whether the selected Runtime Host can own a local default working directory.
 *
 * This is the same boundary the Projects page's `setLocalDefault` capability
 * reports: the main process derives that flag from
 * `runtimeHostProfileUsesHostWorkspace` when it builds the project management
 * service, so the selected profile's kind answers it here without a second
 * capability round-trip. Host-backed targets never receive
 * `defaultWorkingDirectory` in their ProjectRootController, so the control stays
 * hidden for them rather than saving a path the target cannot use.
 */
export function canSetLocalDefaultWorkingDirectory(
  profileKind: RuntimeHostProfileKind | undefined,
): boolean {
  if (profileKind === undefined) return false;
  return !runtimeHostProfileUsesHostWorkspace(profileKind);
}

/**
 * Opens the Desktop directory picker for the default working directory.
 *
 * Resolves `undefined` when the user cancels, which callers must treat as "leave
 * the preference alone" rather than as a request to clear it.
 */
export function chooseDefaultWorkingDirectory(): Promise<string | undefined> {
  return window.maka.settings.chooseDefaultWorkingDirectory();
}

/**
 * Persists the last Settings section the user had open.
 *
 * Web-storage access is a Desktop environment capability, so the Settings
 * surface routes it through this adapter rather than reaching for `localStorage`
 * itself. Failures are swallowed: storage is unavailable in restricted and test
 * renderer contexts, and remembering the section is a convenience, never a
 * correctness requirement.
 */
export function persistSettingsSection(section: string): void {
  try {
    localStorage.setItem('maka-settings-section-v1', section);
  } catch {
    // Storage may be unavailable in restricted or test renderer contexts.
  }
}

/**
 * Resolves what a default-working-directory action should persist.
 *
 * Returns the settings patch to send, or `undefined` when nothing should be
 * saved. The cancel case is why this is a decision rather than a straight-line
 * save: a dismissed picker resolves `undefined`, and treating that as a value
 * would silently clear a directory the user still wants. The value goes into the
 * client-owned `projects` section, so it stays per-machine rather than shared
 * with every other client of a Runtime Host — a working directory only exists on
 * one filesystem.
 */
export async function resolveDefaultWorkingDirectoryPatch(
  action: 'choose' | 'clear',
  choose: () => Promise<string | undefined>,
): Promise<{ projects: { defaultWorkingDirectory?: string } } | undefined> {
  if (action === 'clear') return { projects: { defaultWorkingDirectory: undefined } };
  const defaultWorkingDirectory = await choose();
  if (defaultWorkingDirectory === undefined) return undefined;
  return { projects: { defaultWorkingDirectory } };
}
