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

import { Clipboard, cleanup, computed, effect, platform, signal, type JSX, type Signal } from 'nsh';
import type { ApplicationHost } from 'maka/host';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { QuickRows } from '../../../products/maka/workbench/app/QuickBar';
import { tr } from '../../../products/maka/workbench/app/locale';
import { afterKeyword, rank } from '../../shared/quick-search';
import { remember } from './history';

const KEYWORDS = ['cb', 'clipboard', '剪贴板', '剪貼簿'];
const POLL_MS = 1000;
const LIMIT = 30;

type History = { entries: Signal<readonly string[]>; failure: Signal<unknown> };

/** History lives in this process only: clipboard text may be private and must not reach disk. */
function watchClipboard(host: ApplicationHost): History {
  const entries = signal<readonly string[]>([]);
  const failure = signal<unknown>(null);
  let seen: number | null = null;
  let reading = false;
  const timer = setInterval(() => {
    if (reading) return;
    reading = true;
    host
      .clipboardTextChange(seen)
      .then(({ change, text }) => {
        // The first read only learns the position; what was already there is not history.
        if (seen !== null && text) entries.set(remember(entries(), text));
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
  return { entries, failure };
}

function ClipboardHistory(props: { input: QuickToolInput; history: History }) {
  const { input, history } = props;
  effect(() => {
    if (history.failure() !== null) input.report(history.failure());
  });
  const matches = computed(() => {
    const text = afterKeyword(input.query(), KEYWORDS);
    if (text === null) return [];
    return text === ''
      ? history.entries().slice(0, LIMIT)
      : rank(history.entries(), text, (entry) => [entry], LIMIT);
  });
  return (
    <QuickRows
      input={input}
      items={matches}
      title={(entry) => entry.replace(/\s+/g, ' ').trim().slice(0, 200)}
      hint={() => tr('Copy')}
      activate={(entry) => void Clipboard.writeText(entry).then(input.close, input.report)}
    />
  );
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
    },
  };
};
