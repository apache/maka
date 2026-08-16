import { THEME_PALETTES, type AppSettings, type UpdateAppSettingsInput } from '@maka/core/settings';
import { UI_LOCALE_PREFERENCES } from '@maka/core/ui-locale';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { z } from 'zod';

const patchSchema = z
  .object({
    appearance: z
      .object({
        theme: z.enum(['light', 'dark', 'auto']).optional(),
        palette: z.enum(THEME_PALETTES).optional(),
      })
      .strict()
      .optional(),
    uiLocale: z.enum(UI_LOCALE_PREFERENCES).optional(),
    notifications: z.object({ runComplete: z.boolean().optional() }).strict().optional(),
    system: z.object({ keepSystemAwake: z.boolean().optional() }).strict().optional(),
  })
  .strict();

type ClientSettingsPatch = z.infer<typeof patchSchema>;

export interface ClientSettingsToolAuthority {
  read(): Promise<AppSettings>;
  update(patch: UpdateAppSettingsInput): Promise<AppSettings>;
  confirm(changes: readonly string[]): Promise<boolean>;
}

interface ClientSettingsSnapshot {
  readonly appearance: Pick<AppSettings['appearance'], 'theme' | 'palette'>;
  readonly uiLocale: AppSettings['personalization']['uiLocale'];
  readonly notifications: Pick<AppSettings['notifications'], 'runComplete'>;
  readonly system: Pick<AppSettings['system'], 'keepSystemAwake'>;
}

/** Exposes only settings owned by the bound Desktop capability provider. */
export function buildClientSettingsTools(
  authority: ClientSettingsToolAuthority,
): readonly MakaTool[] {
  const readTool: MakaTool<Record<string, never>, ClientSettingsSnapshot> = {
    name: 'MakaClientSettingsGet',
    displayName: 'Read client settings',
    description:
      'Read safe UI and operating-system settings for the currently bound Maka client. ' +
      'Runtime behavior, credentials, model configuration, network settings, and Bot settings are excluded.',
    parameters: z.object({}).strict(),
    categoryHint: 'read',
    recoveryMode: 'replay_safe',
    impl: async () => project(await authority.read()),
  };
  const updateTool: MakaTool<ClientSettingsPatch, ClientSettingsUpdateResult> = {
    name: 'MakaClientSettingsUpdate',
    displayName: 'Update client settings',
    description:
      'Update safe UI and operating-system settings for the currently bound Maka client. ' +
      'Use only when the user explicitly asks to change this client. The client asks for confirmation before saving.',
    parameters: patchSchema,
    categoryHint: 'custom_tool',
    recoveryMode: 'never_auto_retry',
    executionSemantics: 'exclusive_step',
    impl: async (input) => {
      const current = await authority.read();
      const changes = describeChanges(current, input);
      if (changes.length === 0) return unchanged(current);
      if (!(await authority.confirm(changes))) {
        return {
          kind: 'maka_client_settings_update',
          applied: false,
          reason: 'cancelled',
          message: 'Client settings were not changed.',
          settings: project(await authority.read()),
        };
      }
      const updated = await authority.update(toSettingsPatch(input));
      return {
        kind: 'maka_client_settings_update',
        applied: true,
        changes,
        message: `Updated ${changes.length} client setting${changes.length === 1 ? '' : 's'}.`,
        settings: project(updated),
      };
    },
  };
  return [readTool, updateTool];
}

type ClientSettingsUpdateResult = {
  readonly kind: 'maka_client_settings_update';
  readonly applied: boolean;
  readonly reason?: 'cancelled';
  readonly changes?: readonly string[];
  readonly message: string;
  readonly settings: ClientSettingsSnapshot;
};

function unchanged(settings: AppSettings): ClientSettingsUpdateResult {
  return {
    kind: 'maka_client_settings_update',
    applied: false,
    message: 'The requested client settings already have those values.',
    settings: project(settings),
  };
}

function project(settings: AppSettings): ClientSettingsSnapshot {
  return {
    appearance: {
      theme: settings.appearance.theme,
      palette: settings.appearance.palette,
    },
    uiLocale: settings.personalization.uiLocale,
    notifications: { runComplete: settings.notifications.runComplete },
    system: { keepSystemAwake: settings.system.keepSystemAwake },
  };
}

function toSettingsPatch(input: ClientSettingsPatch): UpdateAppSettingsInput {
  return {
    ...(input.appearance ? { appearance: input.appearance } : {}),
    ...(input.uiLocale ? { personalization: { uiLocale: input.uiLocale } } : {}),
    ...(input.notifications ? { notifications: input.notifications } : {}),
    ...(input.system ? { system: input.system } : {}),
  };
}

function describeChanges(current: AppSettings, patch: ClientSettingsPatch): string[] {
  const changes: string[] = [];
  compare(changes, 'Theme', current.appearance.theme, patch.appearance?.theme);
  compare(changes, 'Palette', current.appearance.palette, patch.appearance?.palette);
  compare(changes, 'UI language', current.personalization.uiLocale, patch.uiLocale);
  compare(
    changes,
    'Run-complete notifications',
    current.notifications.runComplete,
    patch.notifications?.runComplete,
  );
  compare(
    changes,
    'Keep system awake',
    current.system.keepSystemAwake,
    patch.system?.keepSystemAwake,
  );
  return changes;
}

function compare(
  changes: string[],
  label: string,
  current: string | boolean | undefined,
  next: string | boolean | undefined,
): void {
  if (next !== undefined && next !== current) {
    changes.push(`${label}: ${String(current)} → ${String(next)}`);
  }
}
