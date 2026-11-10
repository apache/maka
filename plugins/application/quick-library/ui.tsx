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

import { Clipboard, computed, openUrl, signal, Storage, type JSX } from 'nsh';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { QuickRows } from '../../../products/maka/workbench/app/QuickBar';
import { tr } from '../../../products/maka/workbench/app/locale';
import { afterKeyword, rank } from '../../shared/quick-search';
import { expandLink, isTemplate, parseLibrary, type LibraryItem } from './library';
import { LibrarySettings, type Library } from './settings';

const KEY = 'maka.quick-library.items';
const LIMIT = 5;
const NOTE_KEYWORDS = ['note', 'notes', '笔记', '筆記'];

type Row =
  | { kind: 'copy'; id: string; title: string; text: string }
  | { kind: 'open'; id: string; title: string; url: string };

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

function matches(items: readonly LibraryItem[], query: string): Row[] {
  const copy = (item: LibraryItem): Row => ({
    kind: 'copy',
    id: item.id,
    title: item.name,
    text: item.value,
  });
  const snippets = items.filter((item) => item.kind === 'snippet');
  const notes = items.filter((item) => item.kind === 'note');
  const links = items.filter((item) => item.kind === 'link');
  const noteText = afterKeyword(query, NOTE_KEYWORDS);
  const templates = links.flatMap((item): Row[] => {
    if (!isTemplate(item)) return [];
    const text = afterKeyword(query, [item.name]);
    if (!text) return [];
    return [
      {
        kind: 'open',
        id: item.id,
        title: `${item.name}: ${text}`,
        url: expandLink(item.value, text),
      },
    ];
  });
  return [
    ...templates,
    ...rank(
      links.filter((item) => !isTemplate(item)),
      query,
      (item) => [item.name],
      LIMIT,
    ).map((item): Row => ({ kind: 'open', id: item.id, title: item.name, url: item.value })),
    ...rank(snippets, query, (item) => [item.name], LIMIT).map(copy),
    ...(noteText
      ? rank(notes, noteText, (item) => [item.name, item.value], LIMIT)
      : noteText === ''
        ? notes.slice(0, LIMIT)
        : rank(notes, query, (item) => [item.name], LIMIT)
    ).map(copy),
  ];
}

function LibraryTool(props: { input: QuickToolInput; library: Library }) {
  const { input, library } = props;
  const rows = computed(() => matches(library.items() ?? [], input.query()));
  const run = (row: Row) => {
    if (row.kind === 'copy') {
      void Clipboard.writeText(row.text).then(input.close, input.report);
      return;
    }
    openUrl(row.url).then(({ opened }) => {
      if (opened) input.close();
      else input.report(new Error(tr('The link could not be opened')));
    }, input.report);
  };
  return (
    <QuickRows
      input={input}
      items={rows}
      title={(row) => row.title}
      hint={(row) => (row.kind === 'copy' ? tr('Copy') : tr('Open'))}
      activate={run}
    />
  );
}

export const activate: UiModule<JSX.Element>['activate'] = () => {
  const library = createLibrary();
  return {
    exports: {
      tool: {
        kind: 'view',
        contract: quickToolView.id,
        render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) => (
          <LibraryTool input={input} library={library} />
        ),
      },
      library: { kind: 'settings', render: () => <LibrarySettings library={library} /> },
    },
  };
};
