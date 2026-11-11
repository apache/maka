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

import { host, signal, Storage, View, type JSX } from 'nsh';
import { Button } from 'nsh/base';
import {
  SettingsBody,
  SettingsButton,
  SettingsProblem,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsSwitch,
} from '../../../products/maka/workbench/app/SettingsPage';
import { tr } from '../../../products/maka/workbench/app/locale';
import { errorText, renderText } from '../../../products/maka/workbench/app/text';
import { C } from '../../../products/maka/workbench/app/ui';

const KEY = 'maka.screenshot.preferences';

export const COLORS = ['#FF3B30', '#FFCC00', '#34C759', '#2A8FFF', '#FFFFFF', '#1C1C1E'] as const;
export const SIZES = [
  ['small', 'Thin', 6],
  ['medium', 'Medium', 9],
  ['large', 'Thick', 12],
] as const;
export type InkSize = (typeof SIZES)[number][0];

export type Preferences = {
  /** Where Save puts pictures; macOS's screenshot folder when null. */
  readonly folder: string | null;
  readonly color: string;
  readonly size: InkSize;
  /** Whether boxes seen in the picture are targets, besides windows and their controls. */
  readonly pictureBoxes: boolean;
};

const defaults: Preferences = {
  folder: null,
  color: COLORS[0],
  size: 'medium',
  pictureBoxes: true,
};

/** What was stored, each value kept only when it is one this version understands. */
function parse(stored: string | null): Preferences {
  if (stored === null) return defaults;
  const value = JSON.parse(stored) as Partial<Record<keyof Preferences, unknown>>;
  return {
    folder: typeof value.folder === 'string' ? value.folder : defaults.folder,
    color: COLORS.includes(value.color as never) ? (value.color as string) : defaults.color,
    size: SIZES.some(([name]) => name === value.size) ? (value.size as InkSize) : defaults.size,
    pictureBoxes:
      typeof value.pictureBoxes === 'boolean' ? value.pictureBoxes : defaults.pictureBoxes,
  };
}

export type ScreenshotSettings = {
  current(): Preferences;
  failure(): unknown;
  change(patch: Partial<Preferences>): void;
};

export function createSettings(): ScreenshotSettings {
  const current = signal(defaults);
  const failure = signal<unknown>(null);
  // A change made before the stored preferences arrive wins over them.
  let changed = false;
  Storage.getItem(KEY).then(
    (stored) => {
      if (changed) return;
      try {
        current.set(parse(stored));
      } catch (reason) {
        failure.set(reason);
      }
    },
    (reason) => failure.set(reason),
  );
  let saving: Promise<void> = Promise.resolve();
  return {
    current,
    failure,
    change(patch) {
      changed = true;
      const next = { ...current(), ...patch };
      current.set(next);
      const value = JSON.stringify(next);
      saving = saving
        .then(() => Storage.setItem(KEY, value))
        .catch((reason) => failure.set(reason));
    },
  };
}

function Swatches(props: { value: string; change(color: string): void }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Each of={COLORS} key={(hex: string) => hex}>
        {(entry) => {
          const hex = entry();
          return (
            <Button
              accessibilityLabel={hex}
              selected={props.value === hex}
              onPress={() => props.change(hex)}
              style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                borderWidth: 2,
                borderColor: props.value === hex ? C.text : C.line,
                backgroundColor: hex,
              }}
            />
          );
        }}
      </Each>
    </View>
  );
}

export function ScreenshotSettingsPage(props: { settings: ScreenshotSettings }): JSX.Element {
  const { settings } = props;
  const choosing = signal(false);
  const problem = signal<unknown>(null);
  const chooseFolder = async () => {
    choosing.set(true);
    problem.set(null);
    try {
      // The panel stays open as long as the user needs it.
      const path: string | null = await host.call(
        'screenshot.chooseFolder',
        { current: settings.current().folder },
        { timeout: 0 },
      );
      if (path !== null) settings.change({ folder: path });
    } catch (reason) {
      problem.set(reason);
    } finally {
      choosing.set(false);
    }
  };
  return (
    <SettingsBody>
      <If when={settings.failure() !== null || problem() !== null}>
        <SettingsProblem message={renderText(errorText(problem() ?? settings.failure()))} />
      </If>
      <SettingsSection title={tr('Saving')}>
        <SettingsRow
          label={tr('Save to')}
          description={settings.current().folder ?? tr('Where macOS saves its screenshots')}
          trailing={
            <View style={{ flexDirection: 'row', gap: 4 }}>
              <If when={settings.current().folder !== null}>
                <SettingsButton
                  label={tr('Use macOS’s folder')}
                  tone="quiet"
                  onPress={() => settings.change({ folder: null })}
                />
              </If>
              <SettingsButton
                label={tr('Choose…')}
                disabled={choosing()}
                onPress={() => void chooseFolder()}
              />
            </View>
          }
        />
      </SettingsSection>
      <SettingsSection title={tr('Marks')} note={tr('Each screenshot starts with these.')}>
        <SettingsRow
          label={tr('Color')}
          trailing={
            <Swatches
              value={settings.current().color}
              change={(color) => settings.change({ color })}
            />
          }
        />
        <SettingsSegmented
          label={tr('Line width')}
          value={settings.current().size}
          choices={SIZES.map(([value, title]) => ({ value, title: tr(title) }))}
          change={(size) => settings.change({ size: size as InkSize })}
        />
      </SettingsSection>
      <SettingsSection title={tr('Snapping')}>
        <SettingsSwitch
          label={tr('Snap to boxes in the picture')}
          description={tr(
            'Besides windows and their controls, blocks of one color and outlined boxes, such as buttons and fields in web pages and terminals.',
          )}
          checked={settings.current().pictureBoxes}
          onPress={() => settings.change({ pictureBoxes: !settings.current().pictureBoxes })}
        />
      </SettingsSection>
    </SettingsBody>
  );
}
