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
  type QuickItem,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { currentLocale, tr } from '../../../products/maka/workbench/app/locale';
import { afterKeyword, search, type Found } from '../../shared/quick-search';
import { expandLink, isTemplate, parseLibrary, type LibraryItem } from './library';
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
const name = (item: LibraryItem) => [item.name];

function results(items: readonly LibraryItem[], input: QuickToolInput): QuickItem[] {
  const query = input.query();
  const remembered = (item: LibraryItem, match: number) => ({
    id: item.id,
    title: item.name,
    detail: preview(item.value),
    match,
    remembered: true,
  });
  const copy = ({ item, match }: Found<LibraryItem>): QuickItem => ({
    ...remembered(item, match),
    icon: item.kind === 'note' ? 'note' : 'snippet',
    source: item.kind === 'note' ? tr('Note') : tr('Snippet'),
    action: tr('Copy and close'),
    run: () => void Clipboard.writeText(item.value).then(input.close, input.report),
  });
  const open = (item: LibraryItem, match: number, url: string, title: string): QuickItem => ({
    ...remembered(item, match),
    title,
    icon: 'link',
    source: tr('Link'),
    action: tr('Open'),
    run: () =>
      void openUrl(url).then(({ opened }) => {
        if (opened) input.close();
        else input.report(new Error(tr('The link could not be opened')));
      }, input.report),
  });
  const kind =
    afterKeyword(query, NOTE_KEYWORDS) !== null
      ? 'note'
      : afterKeyword(query, SNIPPET_KEYWORDS) !== null
        ? 'snippet'
        : afterKeyword(query, LINK_KEYWORDS) !== null
          ? 'link'
          : null;
  const ofKind = (wanted: LibraryItem['kind']) =>
    kind !== null && kind !== wanted ? [] : items.filter((item) => item.kind === wanted);
  const links = ofKind('link');
  const notes = ofKind('note');
  return [
    ...links.filter(isTemplate).flatMap((item) => {
      const text = afterKeyword(query, [item.name]);
      return text ? [open(item, 0, expandLink(item.value, text), `${item.name}: ${text}`)] : [];
    }),
    ...search(
      links.filter((item) => !isTemplate(item)),
      query,
      LINK_KEYWORDS,
      name,
      true,
    ).map(({ item, match }) => open(item, match, item.value, item.name)),
    ...search(ofKind('snippet'), query, SNIPPET_KEYWORDS, name, true).map(copy),
    ...search(
      notes,
      query,
      NOTE_KEYWORDS,
      // Note bodies are only searched once the query has asked for notes.
      afterKeyword(query, NOTE_KEYWORDS) === null ? name : (item) => [item.name, item.value],
      true,
    ).map(copy),
  ];
}

function LibraryTool(props: { input: QuickToolInput; library: Library }) {
  const { input, library } = props;
  const items = computed(() => results(library.items() ?? [], input));
  input.attach({
    items,
    entries: () => [
      { id: 'snippets', title: tr('Snippets'), icon: 'snippet', keywords: SNIPPET_KEYWORDS },
      { id: 'notes', title: tr('Notes'), icon: 'note', keywords: NOTE_KEYWORDS },
      { id: 'links', title: tr('Links'), icon: 'link', keywords: LINK_KEYWORDS },
    ],
  });
  return null;
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  effect(() => currentLocale.set(context.locale()));
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
