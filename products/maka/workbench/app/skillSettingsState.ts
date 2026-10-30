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

import { cleanup, effect, signal, untracked } from 'nsh';
import type { Host } from './host';
import type { SettingsOperations } from './settingsOperations';
import { settingsRejection } from './settingsOperations';
import type { ConfigurationWorkspace } from './ConfigurationScope';
import type {
  ConfigurationLocation,
  SkillLibraryPage,
  SkillLibraryEntry,
  SkillLibraryCursor,
  SkillLibraryDiscoveredSource,
  SkillLibraryDocument,
  SkillLibraryInstall,
} from '../../../../packages/plugin-sdk/src/index.js';
import { tr } from './locale';

type Page = Extract<SkillLibraryPage, { kind: 'page' }>;
type Document = Extract<SkillLibraryDocument, { kind: 'page' }>;
export function createSkillSettings(
  host: Host,
  operations: SettingsOperations,
  scope: ConfigurationWorkspace,
) {
  const active = signal(false);
  const query = signal('');
  const loading = signal(false);
  const page = signal<Page | null>(null);
  const entries = signal<SkillLibraryEntry[]>([]);
  const screen = signal<'library' | 'add' | 'detail'>('library');
  const sourceText = signal('');
  const discovered = signal<SkillLibraryDiscoveredSource | null>(null);
  const selected = signal<string[]>([]);
  const location = signal<ConfigurationLocation | null>(null);
  const document = signal<Document | null>(null);
  const deleting = signal<SkillLibraryEntry | null>(null);
  let alive = true;
  let read = 0;
  cleanup(() => {
    alive = false;
    ++read;
  });
  const load = async (cursor: SkillLibraryCursor | null = null) => {
    const request = ++read;
    loading.set(true);
    const workspace = scope.workspace();
    const search = query();
    try {
      const result = await host.query('skills', 'list', { workspace, query: search, cursor });
      if (!alive || request !== read) return;
      if (result.kind === 'changed') {
        await load();
        return;
      }
      page.set(result);
      entries.set(cursor ? [...entries(), ...result.entries] : result.entries);
    } catch (error) {
      if (alive && request === read) {
        page.set(null);
        entries.set([]);
        operations.report(error);
      }
    } finally {
      if (alive && request === read) loading.set(false);
    }
  };
  effect(() => {
    const visible = active();
    scope.workspace();
    query();
    if (visible)
      untracked(() => {
        document.set(null);
        deleting.set(null);
        screen.set('library');
        void load();
      });
  });
  const back = () => {
    if (deleting()) {
      deleting.set(null);
      return false;
    }
    if (screen() !== 'library') {
      screen.set('library');
      return false;
    }
    return true;
  };
  const refresh = () => {
    document.set(null);
    deleting.set(null);
    void load();
  };
  const open = async (entry: SkillLibraryEntry) => {
    const revision = page()?.revision;
    if (!revision) return;
    screen.set('detail');
    document.set(null);
    await readDocument({ reference: entry.reference, revision, offset: 0 });
  };
  const readDocument = async (input: { reference: string; revision: string; offset: number }) => {
    const request = ++read;
    loading.set(true);
    try {
      const result = await host.query('skills', 'read', { workspace: scope.workspace(), ...input });
      if (!alive || request !== read) return;
      if (result.kind !== 'page') {
        screen.set('library');
        await load();
        return;
      }
      document.set(result);
    } catch (error) {
      if (alive && request === read) operations.report(error);
    } finally {
      if (alive && request === read) loading.set(false);
    }
  };
  const discover = async (source: string) => {
    const request = ++read;
    loading.set(true);
    discovered.set(null);
    selected.set([]);
    try {
      const result = await host.query('skills', 'discoverSource', {
        workspace: scope.workspace(),
        source,
      });
      if (!alive || request !== read) return;
      discovered.set(result);
      const preferred: ConfigurationLocation = scope.workspace() ? 'project:agents' : 'user:agents';
      location.set(
        page()?.targets.find((target) => target.location === preferred)?.location ??
          page()?.targets[0]?.location ??
          null,
      );
    } catch (error) {
      if (alive && request === read) operations.report(error);
    } finally {
      if (alive && request === read) loading.set(false);
    }
  };
  const installInput = (): SkillLibraryInstall | null => {
    const source = discovered();
    const target = location();
    return source && target && selected().length
      ? {
          workspace: scope.workspace(),
          location: target,
          source: source.source,
          skills: selected(),
        }
      : null;
  };
  const install = (input: SkillLibraryInstall | null) => {
    if (!input) return;
    void operations.run(async () => {
      const result = await operations.mutate('skills', 'install', input);
      if (!alive) return;
      const failed = result.results.filter((result) => result.kind === 'rejected');
      selected.set(failed.map((result) => result.directory));
      if (failed.length)
        operations.report(
          new Error(
            failed.map((result) => `${result.directory || '.'}: ${result.reason}`).join('\n'),
          ),
        );
      else {
        screen.set('library');
        discovered.set(null);
      }
      await load();
    });
  };
  const manage = (input: { entry: SkillLibraryEntry; update: boolean }) => {
    void operations.run(async () => {
      const result = await operations.mutate('skills', input.update ? 'update' : 'delete', {
        workspace: scope.workspace(),
        reference: input.entry.reference,
      });
      if (result.kind !== 'applied') throw settingsRejection(result);
      if (!alive) return;
      deleting.set(null);
      document.set(null);
      screen.set('library');
      operations.notice.set(tr(input.update ? 'Skill updated.' : 'Skill deleted.'));
      await load();
    });
  };
  return {
    scope,
    query,
    loading,
    page,
    entries,
    screen,
    sourceText,
    discovered,
    selected,
    location,
    document,
    deleting,
    busy: scope.busy,
    back,
    refresh,
    open,
    readDocument,
    discover,
    install,
    installInput,
    manage,
    add: () => {
      screen.set('add');
      discovered.set(null);
      selected.set([]);
    },
    choose: (directory: string) => {
      selected.set(
        selected().includes(directory)
          ? selected().filter((item) => item !== directory)
          : [...selected(), directory],
      );
    },
    more: () => {
      const cursor = page()?.after;
      if (cursor) void load(cursor);
    },
    activate: () => {
      active.set(true);
    },
    deactivate: () => {
      active.set(false);
      ++read;
      loading.set(false);
    },
    navigation: () =>
      `${screen()}:${document()?.entry.reference ?? ''}:${deleting()?.reference ?? ''}`,
    recovered: () => {
      back();
      refresh();
    },
  };
}
export type SkillSettingsOwner = ReturnType<typeof createSkillSettings>;
