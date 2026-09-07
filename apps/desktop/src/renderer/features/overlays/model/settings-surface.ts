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

import type { ProviderType } from '@maka/core/llm-connections';
import type { SettingsSection } from '@maka/core/settings';

export interface SettingsNavigationRequest {
  readonly section?: SettingsSection;
  readonly profileId?: string;
}

/** What the Settings modal is asked to show, and whether it is showing. */
export interface SettingsSurface {
  readonly open: boolean;
  readonly request: SettingsNavigationRequest;
  readonly providerCatalogOpen: boolean;
  readonly connectionDetailSlug: string | undefined;
  readonly createProviderType: ProviderType | undefined;
}

/** Every way the shell opens Settings, as data. */
export type SettingsSurfaceIntent =
  | { readonly kind: 'settings' }
  | { readonly kind: 'section'; readonly section: SettingsSection }
  | { readonly kind: 'project'; readonly profileId: string }
  | { readonly kind: 'provider-catalog' }
  | { readonly kind: 'connection-detail'; readonly slug: string }
  | { readonly kind: 'provider-create'; readonly providerType: ProviderType };

export const CLOSED_SETTINGS_SURFACE: SettingsSurface = {
  open: false,
  request: {},
  providerCatalogOpen: false,
  connectionDetailSlug: undefined,
  createProviderType: undefined,
};

/** The section an intent lands on; `undefined` keeps the remembered one. */
export function settingsIntentSection(intent: SettingsSurfaceIntent): SettingsSection | undefined {
  switch (intent.kind) {
    case 'section':
      return intent.section;
    case 'project':
      return 'projects';
    case 'provider-catalog':
    case 'connection-detail':
    case 'provider-create':
      return 'models';
    default:
      return undefined;
  }
}

/**
 * Opens Settings on an intent. Every opener resets the three sub-surfaces and
 * then raises its own; a project intent replaces the whole request so a stale
 * profile from an earlier open cannot leak into the Projects page.
 */
export function openSettingsSurface(
  current: SettingsSurface,
  intent: SettingsSurfaceIntent,
): SettingsSurface {
  const section = settingsIntentSection(intent);
  const request: SettingsNavigationRequest =
    intent.kind === 'project'
      ? { section: 'projects', profileId: intent.profileId }
      : section
        ? { ...current.request, section }
        : current.request;
  return {
    open: true,
    request,
    providerCatalogOpen: intent.kind === 'provider-catalog',
    connectionDetailSlug: intent.kind === 'connection-detail' ? intent.slug : undefined,
    createProviderType: intent.kind === 'provider-create' ? intent.providerType : undefined,
  };
}

/** Closes Settings and its catalog; the other sub-surfaces reset on the next open. */
export function closeSettingsSurface(current: SettingsSurface): SettingsSurface {
  if (!current.open && !current.providerCatalogOpen) return current;
  return { ...current, open: false, providerCatalogOpen: false };
}

export function withSettingsProfileId(
  current: SettingsSurface,
  profileId: string | undefined,
): SettingsSurface {
  if (current.request.profileId === profileId) return current;
  return { ...current, request: { ...current.request, profileId } };
}
