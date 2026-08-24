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
  confirm(changes: readonly ClientSettingsChange[]): Promise<boolean>;
}

export interface ClientSettingsChange {
  readonly key: 'theme' | 'palette' | 'uiLocale' | 'runComplete' | 'keepSystemAwake';
  readonly current: string | boolean | undefined;
  readonly next: string | boolean;
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
      const proposedChanges = describeChanges(current, input);
      const changes = proposedChanges.map(describeChange);
      if (changes.length === 0) return unchanged(current);
      if (!(await authority.confirm(proposedChanges))) {
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

function describeChanges(current: AppSettings, patch: ClientSettingsPatch): ClientSettingsChange[] {
  const changes: ClientSettingsChange[] = [];
  compare(changes, 'theme', current.appearance.theme, patch.appearance?.theme);
  compare(changes, 'palette', current.appearance.palette, patch.appearance?.palette);
  compare(changes, 'uiLocale', current.personalization.uiLocale, patch.uiLocale);
  compare(
    changes,
    'runComplete',
    current.notifications.runComplete,
    patch.notifications?.runComplete,
  );
  compare(
    changes,
    'keepSystemAwake',
    current.system.keepSystemAwake,
    patch.system?.keepSystemAwake,
  );
  return changes;
}

function compare(
  changes: ClientSettingsChange[],
  key: ClientSettingsChange['key'],
  current: string | boolean | undefined,
  next: string | boolean | undefined,
): void {
  if (next !== undefined && next !== current) {
    changes.push({ key, current, next });
  }
}

function describeChange(change: ClientSettingsChange): string {
  const labels: Record<ClientSettingsChange['key'], string> = {
    theme: 'Theme',
    palette: 'Palette',
    uiLocale: 'UI language',
    runComplete: 'Run-complete notifications',
    keepSystemAwake: 'Keep system awake',
  };
  return `${labels[change.key]}: ${String(change.current)} → ${String(change.next)}`;
}
