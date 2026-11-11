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
import { tr } from '../../../products/maka/workbench/app/locale';
import { afterKeyword } from '../../shared/quick-search';

const KEYWORDS = ['f', 'file', '文件', '檔案'];
const SETTLE_MS = 200;

function FileSearch(props: { input: QuickToolInput; host: ApplicationHost }) {
  const { input, host } = props;
  const found = signal<readonly string[]>([]);
  effect(() => {
    const text = afterKeyword(input.query(), KEYWORDS);
    if (text === null || text.length < 2) {
      found.set([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      host.searchFileNames(text).then((paths) => {
        if (current) found.set(paths);
      }, input.report);
    }, SETTLE_MS);
    cleanup(() => {
      current = false;
      clearTimeout(timer);
    });
  });
  input.attach({
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

export const activate: UiModule<JSX.Element>['activate'] = (context) => ({
  exports: {
    tool: {
      kind: 'view',
      contract: quickToolView.id,
      render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) =>
        platform.os === 'macos' ? (
          <FileSearch input={input} host={context.application as ApplicationHost} />
        ) : null,
    },
  },
});
