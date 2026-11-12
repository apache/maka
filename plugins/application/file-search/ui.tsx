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

import { cleanup, effect, platform, signal, type JSX } from 'nsh';
import type { ApplicationHost } from 'maka/host';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickItem,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { currentLocale, tr } from '../../../products/maka/workbench/app/locale';
import { createScopes, ScopeSettings, statusLabel } from './settings';
import { afterKeyword } from '../../shared/quick-search';

const KEYWORDS = ['f', 'file', '文件', '檔案'];
const SETTLE_MS = 200;

function FileSearch(props: {
  input: QuickToolInput;
  host: ApplicationHost;
  settings: ReturnType<typeof createScopes>;
}) {
  const { input, host } = props;
  const found = signal<readonly string[]>([]);
  const hint = signal('');
  effect(() => {
    const text = afterKeyword(input.query(), KEYWORDS);
    const roots = props.settings.roots();
    found.set([]);
    hint.set('');
    if (!text || roots === null) return;
    if (!roots.length) {
      hint.set(tr('Choose a search folder in Settings.'));
      return;
    }
    let current = true;
    let timer = setTimeout(refresh, SETTLE_MS);
    async function refresh() {
      try {
        const result = await host.scopedFileSearch(text!, roots!);
        if (!current) return;
        found.set(result.paths);
        const pending = result.scopes.some((scope) => scope.state === 'indexing');
        const problem = result.scopes.find((scope) => scope.state !== 'ready');
        hint.set(problem ? statusLabel(problem.state) + ' · ' + problem.root : '');
        if (pending) timer = setTimeout(refresh, 700);
      } catch (reason) {
        if (current) input.report(reason);
      }
    }
    cleanup(() => {
      current = false;
      clearTimeout(timer);
    });
  });
  input.attach({
    emptyMessage: () => hint(),
    items: () =>
      found().map((path): QuickItem => {
        const slash = path.lastIndexOf('/');
        return {
          id: path,
          title: path.slice(slash + 1),
          detail: path.slice(0, slash).replace(/^\/Users\/[^/]+/, '~'),
          icon: 'file',
          source: tr('File'),
          action: tr('Open'),
          match: 0,
          run: () => void host.openLocalPath(path).then(input.close, input.report),
        };
      }),
    entries: () => [{ id: 'search', title: tr('Search files'), icon: 'file', keywords: KEYWORDS }],
  });
  return null;
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  effect(() => currentLocale.set(context.locale()));
  const host = context.application as ApplicationHost;
  const settings = createScopes();
  return {
    exports: {
      preferences: {
        kind: 'settings',
        render: () => <ScopeSettings settings={settings} app={host} />,
      },
      tool: {
        kind: 'view',
        contract: quickToolView.id,
        render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) =>
          platform.os === 'macos' ? (
            <FileSearch input={input} host={host} settings={settings} />
          ) : null,
      },
    },
  };
};
