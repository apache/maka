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

import { host } from 'maka/host';
import { signal, Storage } from 'nsh';
import type { ConnectionVersionBasis } from '../../../../packages/plugin-sdk/src/index.js';
import { tr } from './locale';

type Connection = { name: string; basis: ConnectionVersionBasis };
const symbol = Symbol.for('maka.dictation.preferences');
function preferences() {
  const enabled = signal(false);
  const listenOnOpen = signal(true);
  const selected = signal('');
  const connections = signal<Connection[]>([]);
  const legacy = signal(false);
  const busy = signal(false);
  const error = signal('');
  let initialization: Promise<void> | undefined;
  let generation = 0;
  const prefix = () => host.dictationStoragePrefix();
  const initialize = () =>
    (initialization ??= Promise.all([
      Storage.getItem(prefix() + 'listenOnOpen').then((v) => listenOnOpen.set(v !== 'false')),
      Storage.getItem(prefix() + 'enabled').then((v) => enabled.set(v === 'true')),
      Storage.getItem(prefix() + 'connection').then((v) => selected.set(v ?? '')),
    ])
      .then(() => {})
      .catch((e) => error.set(String(e))));
  const refresh = async () => {
    await initialize();
    const run = ++generation;
    const items = (await host.query('settings', 'dictationConnections', {})) as Connection[];
    if (run === generation) {
      connections.set(items);
      legacy.set(enabled() && host.legacyDictationKey());
      error.set('');
    }
  };
  const useLegacy = () =>
    legacy() && (selected() === 'legacy' || (!selected() && !connections().length));
  const current = () =>
    selected()
      ? connections().find((c) => c.basis.connectionId === selected())
      : connections().length === 1
        ? connections()[0]
        : undefined;
  const update = async (
    field: 'enabled' | 'connection' | 'listenOnOpen',
    value: string,
    enable = false,
  ) => {
    if (busy()) throw new Error(tr('Dictation settings are being saved.'));
    busy.set(true);
    try {
      await initialize();
      await Storage.setItem(prefix() + field, value);
      if (field === 'enabled') enabled.set(value === 'true');
      else if (field === 'listenOnOpen') listenOnOpen.set(value === 'true');
      else selected.set(value);
      if (enable && !enabled()) {
        await Storage.setItem(prefix() + 'enabled', 'true');
        enabled.set(true);
      }
      if (enabled()) await refresh();
    } finally {
      busy.set(false);
    }
  };
  return {
    enabled,
    listenOnOpen,
    selected,
    connections,
    legacy,
    busy,
    error,
    initialize,
    refresh,
    current,
    useLegacy,
    save: (field: 'enabled' | 'connection' | 'listenOnOpen', value: string) =>
      update(field, value).catch((e) => error.set(String(e))),
    enableForConnection: (id: string) => update('connection', id, true),
    description: () =>
      !enabled()
        ? tr('Off')
        : 'DeepSeek · ' +
          (current()?.name ??
            (useLegacy() ? tr('Saved dictation key') : tr('Choose a model connection'))),
    async recordingConnection() {
      await initialize();
      if (!enabled()) throw new Error(tr('Dictation is off'));
      await refresh();
      if (!enabled()) throw new Error(tr('Dictation is off'));
      const row = current();
      if (row) return row.basis;
      if (useLegacy()) return undefined;
      throw new Error(tr('Choose a DeepSeek connection in dictation settings.'));
    },
  };
}
const globals = globalThis as { [symbol]?: ReturnType<typeof preferences> };
export const dictationPreferences = (globals[symbol] ??= preferences());
