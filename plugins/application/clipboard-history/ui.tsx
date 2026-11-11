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

import { Clipboard, cleanup, computed, effect, platform, signal, Storage, type JSX } from 'nsh';
import type { ApplicationHost } from 'maka/host';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickItem,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { tr } from '../../../products/maka/workbench/app/locale';
import { search } from '../../shared/quick-search';
import { DEFAULT_LIMIT, LIMITS, remember, type Limit } from './history';
import { HistorySettings, type History } from './settings';

const KEYWORDS = ['cb', 'clipboard', '剪贴板', '剪貼簿'];
const POLL_MS = 1000;
const LIMIT_KEY = 'maka.clipboard-history.limit';

/** History lives in this process only: clipboard text may be private and must not reach disk. */
function watchClipboard(host: ApplicationHost): History {
  const entries = signal<readonly string[]>([]);
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
  let seen: number | null = null;
  let reading = false;
  const timer = setInterval(() => {
    if (reading) return;
    reading = true;
    host
      .clipboardTextChange(seen)
      .then(({ change, text }) => {
        // The first read only learns the position; what was already there is not history.
        if (seen !== null && text) entries.set(remember(entries(), text, limit()));
        seen = change;
      })
      .catch((reason) => {
        failure.set(reason);
        clearInterval(timer);
      })
      .finally(() => {
        reading = false;
      });
  }, POLL_MS);
  cleanup(() => clearInterval(timer));
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

function ClipboardHistory(props: { input: QuickToolInput; history: History }) {
  const { input, history } = props;
  effect(() => {
    if (history.failure() !== null) input.report(history.failure());
  });
  const items = computed(() =>
    search(history.entries(), input.query(), KEYWORDS, (entry) => [entry]).map(
      ({ item: entry, match }): QuickItem => ({
        id: entry,
        title: entry.replace(/\s+/g, ' ').trim().slice(0, 200),
        icon: 'clipboard',
        source: tr('Clipboard'),
        action: tr('Copy and close'),
        match,
        run: () => void Clipboard.writeText(entry).then(input.close, input.report),
      }),
    ),
  );
  input.attach({
    items,
    entries: () => [
      { id: 'history', title: tr('Clipboard history'), icon: 'clipboard', keywords: KEYWORDS },
    ],
  });
  return null;
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  const history =
    platform.os === 'macos' ? watchClipboard(context.application as ApplicationHost) : null;
  return {
    exports: {
      tool: {
        kind: 'view',
        contract: quickToolView.id,
        render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) =>
          history ? <ClipboardHistory input={input} history={history} /> : null,
      },
      history: {
        kind: 'settings',
        render: () => (history ? <HistorySettings history={history} /> : null),
      },
    },
  };
};
