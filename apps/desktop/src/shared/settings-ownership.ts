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

import type {
  AppSettings,
  UpdateAppSettingsInput,
} from "@maka/core/settings";

/** Keep Desktop-owned preferences independent from the selected Runtime Host. */
export function clientOwnedSettingsPatch(
  patch: UpdateAppSettingsInput,
): UpdateAppSettingsInput {
  const personalization =
    patch.personalization?.uiLocale === undefined &&
    patch.personalization?.selectedPetId === undefined
      ? undefined
      : {
          ...(patch.personalization.uiLocale === undefined
            ? {}
            : { uiLocale: patch.personalization.uiLocale }),
          ...(patch.personalization.selectedPetId === undefined
            ? {}
            : { selectedPetId: patch.personalization.selectedPetId }),
        };
  // `appIcon` is filtered out the way `personalization` is filtered field by
  // field above, rather than forwarding the section wholesale: the app icon is
  // owned by the main process's icon seam, which serializes selection against
  // import and removal and refuses a choice whose artwork is gone. A write
  // arriving through this generic channel would queue behind none of that and
  // could land between a removal's settings apply and its file deletion.
  const appearance =
    patch.appearance === undefined
      ? undefined
      : (({ appIcon: _ignored, ...rest }) =>
          Object.keys(rest).length === 0 ? undefined : rest)(patch.appearance);
  return {
    ...(patch.botChat ? { botChat: patch.botChat } : {}),
    ...(patch.usage ? { usage: patch.usage } : {}),
    ...(appearance ? { appearance } : {}),
    ...(personalization ? { personalization } : {}),
    ...(patch.notifications ? { notifications: patch.notifications } : {}),
    ...(patch.projects ? { projects: patch.projects } : {}),
    ...(patch.system ? { system: patch.system } : {}),
  };
}

export function hasRuntimeHostSettingsPatch(
  patch: UpdateAppSettingsInput,
): boolean {
  return Boolean(
    patch.shell ||
      patch.network ||
      patch.localMemory ||
      patch.workspaceInstructions ||
      patch.privacy ||
      patch.chatDefaults ||
      patch.webSearch ||
      patch.subagents ||
      patch.personalization?.displayName !== undefined ||
      patch.personalization?.assistantTone !== undefined,
  );
}

export function projectClientOwnedSettings(
  runtimeHost: AppSettings,
  client: AppSettings,
): AppSettings {
  return {
    ...runtimeHost,
    schemaVersion: client.schemaVersion,
    botChat: client.botChat,
    usage: client.usage,
    appearance: client.appearance,
    personalization: {
      ...runtimeHost.personalization,
      uiLocale: client.personalization.uiLocale,
      selectedPetId: client.personalization.selectedPetId,
    },
    onboarding: client.onboarding,
    projects: client.projects,
    notifications: client.notifications,
    system: client.system,
  };
}

export function hasSettingsPatch(patch: UpdateAppSettingsInput): boolean {
  return Object.keys(patch).length > 0;
}
