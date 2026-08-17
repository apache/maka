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
  return {
    ...(patch.botChat ? { botChat: patch.botChat } : {}),
    ...(patch.usage ? { usage: patch.usage } : {}),
    ...(patch.appearance ? { appearance: patch.appearance } : {}),
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
