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

import { cleanup, effect, host, signal, Storage } from 'nsh';
import type { ApplicationHost } from 'maka/host';
import {
  SettingsBody,
  SettingsSection,
  SettingsButton,
  SettingsRow,
  SettingsSwitch,
  SettingsProblem,
} from '../../../products/maka/workbench/app/SettingsPage';
import { tr } from '../../../products/maka/workbench/app/locale';
import { errorText, renderText } from '../../../products/maka/workbench/app/text';

const PERSONAL = [
  '~/Downloads',
  '~/Desktop',
  '~/Documents',
  '~/Pictures',
  '~/Music',
  '~/Movies',
  '~',
];
const KEY = 'maka.file-search.roots';
export function createScopes() {
  const roots = signal<string[] | null>(null);
  const failure = signal<unknown>(null);
  Storage.getItem(KEY)
    .then((raw) => {
      const saved: unknown = raw === null ? PERSONAL : JSON.parse(raw);
      if (!Array.isArray(saved) || !saved.every((p) => typeof p === 'string'))
        throw Error('Invalid file search folders');
      roots.set([...new Set<string>(saved)]);
    })
    .catch((reason) => failure.set(reason));
  let saving = Promise.resolve();
  return {
    roots,
    failure,
    toggle(path: string) {
      const current = roots();
      if (!current) return;
      const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path];
      roots.set(next);
      saving = saving
        .then(() => Storage.setItem(KEY, JSON.stringify(next)))
        .catch((reason) => failure.set(reason));
    },
  };
}

export function statusLabel(state: string) {
  switch (state) {
    case 'ready':
      return tr('Indexed');
    case 'indexing':
      return tr('Indexing…');
    case 'denied':
      return tr('Folder access required');
    case 'partial':
      return tr('Some subfolders could not be read');
    case 'missing':
      return tr('Folder missing or volume disconnected');
    default:
      return tr('Folder unavailable');
  }
}

export function ScopeSettings(props: {
  settings: ReturnType<typeof createScopes>;
  app: ApplicationHost;
}) {
  const { settings } = props;
  const result = signal<Awaited<ReturnType<ApplicationHost['scopedFileSearch']>> | null>(null);
  const choosing = signal(false);
  effect(() => {
    const roots = settings.roots();
    if (!roots) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await props.app.scopedFileSearch('', roots!);
        if (active) result.set(next);
      } catch (reason) {
        if (active) settings.failure.set(reason);
      }
      if (active) timer = setTimeout(refresh, 2000);
    }
    void refresh();
    cleanup(() => {
      active = false;
      clearTimeout(timer);
    });
  });
  const choose = async () => {
    choosing.set(true);
    try {
      const path: string | null = await host.call('workspace.chooseFolder', {}, { timeout: 0 });
      if (path && !settings.roots()?.includes(path)) settings.toggle(path);
    } catch (reason) {
      settings.failure.set(reason);
    } finally {
      choosing.set(false);
    }
  };
  const status = (path: string) => {
    const row = result()?.scopes.find((item) => item.root === path);
    return settings.roots()?.includes(path) && row ? statusLabel(row.state) : undefined;
  };
  const choices = () => [
    ...new Set([...PERSONAL, ...(result()?.volumes ?? []), ...(settings.roots() ?? [])]),
  ];
  return (
    <SettingsBody>
      <If when={settings.failure() !== null}>
        <SettingsProblem message={renderText(errorText(settings.failure()))} />
      </If>
      <SettingsSection
        title={tr('Search folders')}
        note={tr('Search includes subfolders. Select a mounted volume or add a folder.')}
      >
        <Each of={choices()} key={(path: string) => path}>
          {(entry) => (
            <SettingsSwitch
              label={entry() === '~' ? tr('Other personal files') : entry()}
              status={status(entry())}
              checked={settings.roots()?.includes(entry()) ?? false}
              disabled={settings.roots() === null}
              onPress={() => settings.toggle(entry())}
            />
          )}
        </Each>
        <SettingsRow
          label={tr('Add a search folder')}
          trailing={
            <SettingsButton
              label={tr('Choose…')}
              disabled={choosing() || settings.roots() === null}
              onPress={() => void choose()}
            />
          }
        />
      </SettingsSection>
    </SettingsBody>
  );
}
