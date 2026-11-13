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

import { effect, Clipboard, computed, openUrl, signal, Storage, type JSX } from 'nsh';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickEntry,
  type QuickItem,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { currentLocale, tr } from '../../../products/maka/workbench/app/locale';
import { afterKeyword, search } from '../../shared/quick-search';
import {
  expandLink,
  librarySearchTerms,
  isTemplate,
  parseLibrary,
  type LibraryItem,
  type LibraryKind,
} from './library';
import { LibrarySettings, type Library } from './settings';

const KEY = 'maka.quick-library.items';
const SNIPPET_KEYWORDS = ['snippet', 'snippets', '片段'];
const NOTE_KEYWORDS = ['note', 'notes', '笔记', '筆記'];
const LINK_KEYWORDS = ['link', 'links', '链接', '連結'];

function createLibrary(): Library {
  const items = signal<readonly LibraryItem[] | null>(null);
  const failure = signal<unknown>(null);
  Storage.getItem(KEY).then(
    (stored) => {
      try {
        items.set(parseLibrary(stored));
      } catch (reason) {
        failure.set(reason);
      }
    },
    (reason) => failure.set(reason),
  );
  let saving: Promise<void> = Promise.resolve();
  return {
    items,
    failure,
    save(next) {
      items.set(next);
      const value = JSON.stringify(next);
      saving = saving
        .then(() => Storage.setItem(KEY, value))
        .catch((reason) => failure.set(reason));
    },
  };
}

const preview = (value: string) => value.replace(/\s+/g, ' ').slice(0, 120);

function entry(kind: LibraryKind): QuickEntry {
  switch (kind) {
    case 'link':
      return { id: 'links', title: tr('Quick Links'), icon: 'link', keywords: LINK_KEYWORDS };
    case 'snippet':
      return {
        id: 'snippets',
        title: tr('Text Snippets'),
        icon: 'snippet',
        keywords: SNIPPET_KEYWORDS,
      };
    case 'note':
      return { id: 'notes', title: tr('Notes'), icon: 'note', keywords: NOTE_KEYWORDS };
  }
}

function LibraryTool(props: { input: QuickToolInput; library: Library; kind: LibraryKind }) {
  const { input, library, kind } = props;
  const edit = (item: LibraryItem) => {
    const current = () => library.items()?.find((other) => other.id === item.id);
    input.editText({
      title: item.name,
      value: () => current()?.value ?? '',
      change: (value) => {
        if (current()?.value === value) return;
        library.save(
          (library.items() ?? []).map((other) =>
            other.id === item.id ? { ...other, value } : other,
          ),
        );
      },
      error: () => (library.failure() ? String(library.failure()) : undefined),
    });
  };
  const items = computed((): QuickItem[] => {
    const all = library.items();
    if (!all) return [];
    const own = all.filter((item) => item.kind === kind);
    const query = input.query();
    const command = entry(kind);
    const scoped = afterKeyword(query, command.keywords);
    const matches = search(
      own,
      query,
      command.keywords,
      (item) => librarySearchTerms(item, scoped !== null),
      true,
    );
    const open = (url: string) =>
      void openUrl(url).then(({ opened }) => {
        if (opened) input.close();
        else input.report(new Error(tr('The link could not be opened')));
      }, input.report);
    const rows = matches.map(({ item, match }): QuickItem => {
      const engine = kind === 'link' && isTemplate(item);
      return {
        id: item.id,
        title: item.name,
        detail: preview(item.value),
        match,
        remembered: true,
        icon: command.icon,
        source: engine ? tr('Search engine') : command.title,
        action:
          kind === 'note'
            ? tr('Edit')
            : kind === 'snippet'
              ? tr('Copy and close')
              : engine
                ? tr('Search')
                : tr('Open'),
        run: () => {
          if (kind === 'note') edit(item);
          else if (kind === 'snippet')
            void Clipboard.writeText(item.value).then(input.close, input.report);
          else if (engine) input.enter(command.id, item.name + ' ');
          else open(item.value);
        },
      };
    });
    if (kind === 'link') {
      for (const item of own.filter(isTemplate)) {
        const text = afterKeyword(scoped ?? query, [item.name]);
        if (text)
          rows.unshift({
            id: item.id,
            title: item.name + ': ' + text,
            detail: preview(expandLink(item.value, text)),
            icon: 'link',
            source: tr('Search engine'),
            action: tr('Open'),
            match: 0,
            remembered: true,
            run: () => open(expandLink(item.value, text)),
          });
      }
    }
    if (kind === 'note' && scoped && !rows.length && scoped.length <= 160) {
      rows.push({
        id: 'create:' + scoped,
        title: tr('Create note') + ' · ' + scoped,
        icon: 'note',
        source: command.title,
        action: tr('Create note'),
        match: 0,
        run: () => {
          const item: LibraryItem = { id: crypto.randomUUID(), kind, name: scoped, value: '' };
          library.save([...(library.items() ?? []), item]);
          edit(item);
        },
      });
    }
    return rows;
  });
  input.attach({
    items,
    entries: () => [entry(kind)],
    ...(kind === 'snippet'
      ? {
          preview: (id: string) => {
            const item = library.items()?.find((other) => other.id === id && other.kind === kind);
            return item ? { text: item.value, fields: [] } : undefined;
          },
        }
      : {}),
  });
  return null;
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  effect(() => currentLocale.set(context.locale()));
  const library = createLibrary();
  const tool = (kind: LibraryKind) => ({
    kind: 'view' as const,
    contract: quickToolView.id,
    render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) => (
      <LibraryTool input={input} library={library} kind={kind} />
    ),
  });
  const settings = (kind: LibraryKind) => ({
    kind: 'settings' as const,
    render: () => <LibrarySettings library={library} kind={kind} />,
  });
  return {
    exports: {
      links: tool('link'),
      snippets: tool('snippet'),
      notes: tool('note'),
      linksSettings: settings('link'),
      snippetsSettings: settings('snippet'),
      notesSettings: settings('note'),
    },
  };
};
