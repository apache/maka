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

import { cleanup, computed, effect, platform, signal, Storage, type JSX } from 'nsh';
import type { ApplicationHost } from 'maka/host';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickItem,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { currentLocale, tr } from '../../../products/maka/workbench/app/locale';
import { search } from '../../shared/quick-search';
import { DEFAULT_LIMIT, LIMITS, remember, type HistoryEntry, type Limit } from './history';
import { HistorySettings, type History } from './settings';

const KEYWORDS = ['cb', 'clipboard', '剪贴板', '剪貼簿'];
const POLL_MS = 1000;
const LIMIT_KEY = 'maka.clipboard-history.limit';

/** History lives in this process only: clipboard text may be private and must not reach disk. */
function createHistory(): History {
  const entries = signal<readonly HistoryEntry[]>([]);
  const failure = signal<unknown>(null);
  const limit = signal<Limit>(DEFAULT_LIMIT);
  // A limit chosen before the stored one arrives wins over it.
  let chosen = false;
  Storage.getItem(LIMIT_KEY).then(
    (stored) => {
      const value = Number(stored);
      if (!chosen && LIMITS.includes(value as Limit)) limit.set(value as Limit);
    },
    (reason) => failure.set(reason),
  );
  let saving: Promise<void> = Promise.resolve();
  return {
    entries,
    limit,
    failure,
    setLimit(next) {
      chosen = true;
      limit.set(next);
      entries.set(entries().slice(0, next));
      const value = String(next);
      saving = saving
        .then(() => Storage.setItem(LIMIT_KEY, value))
        .catch((reason) => failure.set(reason));
    },
    clear: () => entries.set([]),
  };
}

function watchClipboard(host: ApplicationHost, history: History) {
  let active = true;
  let seen: number | null = null;
  let reading = false;
  const timer = setInterval(() => {
    if (reading) return;
    reading = true;
    host
      .clipboardHistoryChange(seen)
      .then(({ change, entry }) => {
        if (!active) return;
        // The first read only learns the position; what was already there is not history.
        if (seen !== null && entry)
          history.entries.set(
            remember(
              history.entries(),
              { change, copiedAt: Date.now(), ...entry },
              history.limit(),
            ),
          );
        seen = change;
      })
      .catch((reason) => {
        history.failure.set(reason);
        clearInterval(timer);
      })
      .finally(() => {
        reading = false;
      });
  }, POLL_MS);
  cleanup(() => {
    active = false;
    clearInterval(timer);
  });
}

const TEXT = 'public.utf8-plain-text';
const PDF = 'com.adobe.pdf';

function entryTitle(entry: HistoryEntry): string {
  if (entry.paths.length)
    return entry.paths.map((p) => p.slice(p.lastIndexOf('/') + 1)).join(' · ');
  if (entry.format === TEXT) return entry.data.replace(/\s+/g, ' ').trim().slice(0, 200);
  const type =
    entry.format === PDF
      ? 'PDF'
      : `${tr('Image')} · ${entry.format.split('.').pop()!.toUpperCase()}`;
  const bytes =
    Math.floor((entry.data.length * 3) / 4) -
    (entry.data.endsWith('==') ? 2 : entry.data.endsWith('=') ? 1 : 0);
  return `${type} · ${Math.ceil(bytes / 1024)} KB`;
}

function ClipboardHistory(props: {
  input: QuickToolInput;
  history: History;
  host: ApplicationHost;
}) {
  const { input, history } = props;
  watchClipboard(props.host, history);
  effect(() => {
    if (history.failure() !== null) input.report(history.failure());
  });
  const items = computed(() =>
    search(history.entries(), input.query(), KEYWORDS, (entry) =>
      entry.paths.length ? entry.paths : entry.format === TEXT ? [entry.data] : [entryTitle(entry)],
    ).map(
      ({ item: entry, match }): QuickItem => ({
        id: String(entry.change),
        title: entryTitle(entry),
        image: entry.thumbnail ? () => entry.thumbnail ?? undefined : undefined,
        detail: entry.paths.length ? entry.paths.join(' · ') : undefined,
        icon:
          entry.paths.length || entry.format === PDF
            ? 'file'
            : entry.format === TEXT
              ? 'clipboard'
              : 'camera',
        source: tr('Clipboard'),
        action: tr('Copy and close'),
        match,
        run: () => void props.host.restoreClipboardEntry(entry).then(input.close, input.report),
      }),
    ),
  );
  input.attach({
    items,
    preview(id) {
      const entry = history.entries().find((it) => String(it.change) === id);
      if (!entry) return undefined;
      const format = entry.paths.length
        ? tr('Files')
        : entry.format === TEXT
          ? tr('Clipboard text')
          : entry.format.split('.').pop()!.toUpperCase();
      const fields = [{ label: tr('Clipboard format'), value: format }];
      if (entry.dimensions)
        fields.push({ label: tr('Pixel dimensions'), value: entry.dimensions + ' px' });
      fields.push({
        label: tr('Copied at'),
        value: new Date(entry.copiedAt).toLocaleString(currentLocale()),
      });
      return {
        image: entry.preview ?? undefined,
        text: entry.paths.length
          ? entry.paths.join('\n')
          : entry.format === TEXT
            ? entry.data
            : undefined,
        fields,
      };
    },
    entries: () => [
      { id: 'history', title: tr('Clipboard history'), icon: 'clipboard', keywords: KEYWORDS },
    ],
  });
  return null;
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  effect(() => currentLocale.set(context.locale()));
  const history = platform.os === 'macos' ? createHistory() : null;
  return {
    exports: {
      tool: {
        kind: 'view',
        contract: quickToolView.id,
        render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) =>
          history ? (
            <ClipboardHistory
              input={input}
              history={history}
              host={context.application as ApplicationHost}
            />
          ) : null,
      },
      history: {
        kind: 'settings',
        render: () => (history ? <HistorySettings history={history} /> : null),
      },
    },
  };
};
