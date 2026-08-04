import { z } from 'zod';
import {
  THEME_PALETTES,
  UI_LOCALE_PREFERENCES,
  type AppSettings,
  type UpdateAppSettingsInput,
} from '@maka/core';
import type { MakaTool } from '@maka/runtime';
import type { SettingsStore } from '@maka/storage';

export const MAKA_SETTINGS_GET_TOOL_NAME = 'MakaSettingsGet';
export const MAKA_SETTINGS_UPDATE_TOOL_NAME = 'MakaSettingsUpdate';

const appearancePatchSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'auto']).optional(),
    palette: z.enum(THEME_PALETTES).optional(),
  })
  .strict();

const personalizationPatchSchema = z
  .object({
    displayName: z.string().max(80).optional(),
    assistantTone: z.string().max(500).optional(),
    uiLocale: z.enum(UI_LOCALE_PREFERENCES).optional(),
  })
  .strict();

const localMemoryPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    agentReadEnabled: z.boolean().optional(),
  })
  .strict();

const enabledPatchSchema = z.object({ enabled: z.boolean().optional() }).strict();

const privacyPatchSchema = z.object({ incognitoActive: z.boolean().optional() }).strict();
const notificationsPatchSchema = z.object({ runComplete: z.boolean().optional() }).strict();
const systemPatchSchema = z.object({ keepSystemAwake: z.boolean().optional() }).strict();

const agentSettingsPatchSchema = z
  .object({
    appearance: appearancePatchSchema.optional(),
    personalization: personalizationPatchSchema.optional(),
    localMemory: localMemoryPatchSchema.optional(),
    workspaceInstructions: enabledPatchSchema.optional(),
    privacy: privacyPatchSchema.optional(),
    notifications: notificationsPatchSchema.optional(),
    system: systemPatchSchema.optional(),
    webSearch: enabledPatchSchema.optional(),
  })
  .strict();

export type AgentSettingsPatch = z.infer<typeof agentSettingsPatchSchema>;

export interface AgentSettingsSnapshot {
  appearance: Pick<AppSettings['appearance'], 'theme' | 'palette'>;
  personalization: Pick<
    AppSettings['personalization'],
    'displayName' | 'assistantTone' | 'uiLocale'
  >;
  localMemory: Pick<AppSettings['localMemory'], 'enabled' | 'agentReadEnabled'>;
  workspaceInstructions: Pick<AppSettings['workspaceInstructions'], 'enabled'>;
  privacy: Pick<AppSettings['privacy'], 'incognitoActive'>;
  notifications: Pick<AppSettings['notifications'], 'runComplete'>;
  system: Pick<AppSettings['system'], 'keepSystemAwake'>;
  webSearch: Pick<AppSettings['webSearch'], 'enabled'>;
}

export interface AgentSettingsToolsDeps {
  settingsStore: Pick<SettingsStore, 'get'>;
  updateSettings(patch: UpdateAppSettingsInput): Promise<AppSettings>;
}

export function buildAgentSettingsTools(deps: AgentSettingsToolsDeps): MakaTool[] {
  const getTool: MakaTool<Record<string, never>, AgentSettingsSnapshot> = {
    name: MAKA_SETTINGS_GET_TOOL_NAME,
    displayName: '读取 Maka 设置',
    description:
      'Read the safe, non-secret subset of Maka application settings that the assistant may help configure. ' +
      'This never returns API keys, tokens, model credentials, proxy credentials, Bot settings, or Gateway settings.',
    parameters: z.object({}).strict(),
    categoryHint: 'read',
    recoveryMode: 'replay_safe',
    impl: async () => projectAgentSettings(await deps.settingsStore.get()),
  };

  const updateTool: MakaTool<AgentSettingsPatch, AgentSettingsUpdateResult> = {
    name: MAKA_SETTINGS_UPDATE_TOOL_NAME,
    displayName: '修改 Maka 设置',
    description:
      'Update a small allowlisted subset of Maka application settings. ' +
      'Use only when the user explicitly asks to change Maka itself. ' +
      'Every effective change requires an in-app confirmation before it is persisted. ' +
      'Secrets, provider/model configuration, network proxy, Bot/Gateway settings, and permission defaults are not supported.',
    parameters: agentSettingsPatchSchema,
    categoryHint: 'custom_tool',
    recoveryMode: 'never_auto_retry',
    executionSemantics: 'exclusive_step',
    impl: async (input, context) => {
      const current = await deps.settingsStore.get();
      const patch = toSettingsPatch(input);
      const changes = describeChanges(current, patch);
      if (changes.length === 0) {
        return {
          kind: 'maka_settings_update',
          ok: true,
          applied: false,
          message: 'The requested Maka settings already have those values.',
          settings: projectAgentSettings(current),
        };
      }
      if (!context.askUserQuestion) {
        return {
          kind: 'maka_settings_update',
          ok: false,
          applied: false,
          reason: 'confirmation_unavailable',
          message: 'Maka settings were not changed because confirmation is unavailable.',
          settings: projectAgentSettings(current),
        };
      }

      const answer = await context.askUserQuestion([
        {
          question: `Apply these Maka setting changes?\n${changes.map((change) => `• ${change}`).join('\n')}`,
          options: [
            {
              label: 'Apply changes',
              description: 'Persist the listed Maka settings now.',
            },
            {
              label: 'Cancel',
              description: 'Leave every setting unchanged.',
            },
          ],
        },
      ]);
      if (answer.answers[0]?.answer !== 'Apply changes') {
        return {
          kind: 'maka_settings_update',
          ok: true,
          applied: false,
          reason: 'cancelled',
          message: 'Maka settings were not changed.',
          settings: projectAgentSettings(await deps.settingsStore.get()),
        };
      }

      const updated = await deps.updateSettings(patch);
      return {
        kind: 'maka_settings_update',
        ok: true,
        applied: true,
        changes,
        message: `Updated ${changes.length} Maka setting${changes.length === 1 ? '' : 's'}.`,
        settings: projectAgentSettings(updated),
      };
    },
  };

  return [getTool, updateTool];
}

type AgentSettingsUpdateResult =
  | {
      kind: 'maka_settings_update';
      ok: true;
      applied: boolean;
      reason?: 'cancelled';
      changes?: string[];
      message: string;
      settings: AgentSettingsSnapshot;
    }
  | {
      kind: 'maka_settings_update';
      ok: false;
      applied: false;
      reason: 'confirmation_unavailable';
      message: string;
      settings: AgentSettingsSnapshot;
    };

export function projectAgentSettings(settings: AppSettings): AgentSettingsSnapshot {
  return {
    appearance: {
      theme: settings.appearance.theme,
      palette: settings.appearance.palette,
    },
    personalization: {
      displayName: settings.personalization.displayName,
      assistantTone: settings.personalization.assistantTone,
      uiLocale: settings.personalization.uiLocale,
    },
    localMemory: {
      enabled: settings.localMemory.enabled,
      agentReadEnabled: settings.localMemory.agentReadEnabled,
    },
    workspaceInstructions: { enabled: settings.workspaceInstructions.enabled },
    privacy: { incognitoActive: settings.privacy.incognitoActive },
    notifications: { runComplete: settings.notifications.runComplete },
    system: { keepSystemAwake: settings.system.keepSystemAwake },
    webSearch: { enabled: settings.webSearch.enabled },
  };
}

function toSettingsPatch(input: AgentSettingsPatch): UpdateAppSettingsInput {
  return {
    ...(input.appearance ? { appearance: input.appearance } : {}),
    ...(input.personalization ? { personalization: input.personalization } : {}),
    ...(input.localMemory ? { localMemory: input.localMemory } : {}),
    ...(input.workspaceInstructions
      ? { workspaceInstructions: input.workspaceInstructions }
      : {}),
    ...(input.privacy ? { privacy: input.privacy } : {}),
    ...(input.notifications ? { notifications: input.notifications } : {}),
    ...(input.system ? { system: input.system } : {}),
    ...(input.webSearch ? { webSearch: input.webSearch } : {}),
  };
}

function describeChanges(current: AppSettings, patch: UpdateAppSettingsInput): string[] {
  const changes: string[] = [];
  addChange(changes, 'appearance.theme', current.appearance.theme, patch.appearance?.theme);
  addChange(changes, 'appearance.palette', current.appearance.palette, patch.appearance?.palette);
  addChange(
    changes,
    'personalization.displayName',
    current.personalization.displayName,
    patch.personalization?.displayName,
  );
  addChange(
    changes,
    'personalization.assistantTone',
    current.personalization.assistantTone,
    patch.personalization?.assistantTone,
  );
  addChange(
    changes,
    'personalization.uiLocale',
    current.personalization.uiLocale,
    patch.personalization?.uiLocale,
  );
  addChange(changes, 'localMemory.enabled', current.localMemory.enabled, patch.localMemory?.enabled);
  addChange(
    changes,
    'localMemory.agentReadEnabled',
    current.localMemory.agentReadEnabled,
    patch.localMemory?.agentReadEnabled,
  );
  addChange(
    changes,
    'workspaceInstructions.enabled',
    current.workspaceInstructions.enabled,
    patch.workspaceInstructions?.enabled,
  );
  addChange(
    changes,
    'privacy.incognitoActive',
    current.privacy.incognitoActive,
    patch.privacy?.incognitoActive,
  );
  addChange(
    changes,
    'notifications.runComplete',
    current.notifications.runComplete,
    patch.notifications?.runComplete,
  );
  addChange(
    changes,
    'system.keepSystemAwake',
    current.system.keepSystemAwake,
    patch.system?.keepSystemAwake,
  );
  addChange(changes, 'webSearch.enabled', current.webSearch.enabled, patch.webSearch?.enabled);
  return changes;
}

function addChange(
  changes: string[],
  path: string,
  current: string | boolean | undefined,
  requested: string | boolean | undefined,
): void {
  if (requested === undefined || Object.is(current, requested)) return;
  changes.push(`${path}: ${displayValue(current)} → ${displayValue(requested)}`);
}

function displayValue(value: string | boolean | undefined): string {
  if (value === undefined) return '(unset)';
  return JSON.stringify(value);
}
