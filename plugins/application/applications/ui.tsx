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

import { effect, computed, platform, signal, type JSX } from 'nsh';
import type { ApplicationHost } from 'maka/host';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickItem,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { currentLocale, tr } from '../../../products/maka/workbench/app/locale';
import { search } from '../../shared/quick-search';

const KEYWORDS = ['app', 'apps', '应用', '應用'];
const applicationName = (path: string) => path.slice(path.lastIndexOf('/') + 1, -'.app'.length);

function Applications(props: { input: QuickToolInput; host: ApplicationHost }) {
  const { input, host } = props;
  const installed = signal<readonly string[]>([]);
  host.installedApplications().then(installed.set, input.report);
  const icons = signal<ReadonlyMap<string, string>>(new Map());
  const requested = new Set<string>();
  const iconOf = (path: string) => {
    if (!requested.has(path)) {
      requested.add(path);
      host
        .applicationIcon(path)
        .then((icon) => icons.set(new Map(icons()).set(path, icon)), input.report);
    }
    return icons().get(path);
  };
  const items = computed(() =>
    search(installed(), input.query(), KEYWORDS, (path) => [applicationName(path)], true).map(
      ({ item: path, match }): QuickItem => ({
        id: path,
        title: applicationName(path),
        icon: 'app',
        image: () => iconOf(path),
        source: tr('Application'),
        action: tr('Open'),
        match,
        remembered: true,
        run: () => void host.openLocalPath(path).then(input.close, input.report),
      }),
    ),
  );
  input.attach({
    items,
    entries: () => [
      { id: 'search', title: tr('Search applications'), icon: 'app', keywords: KEYWORDS },
    ],
  });
  return null;
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
  effect(() => currentLocale.set(context.locale()));
  return {
    exports: {
      tool: {
        kind: 'view',
        contract: quickToolView.id,
        render: ({ input }: UiEmbeddedViewProps<QuickToolInput, JSX.Element>) =>
          platform.os === 'macos' ? (
            <Applications input={input} host={context.application as ApplicationHost} />
          ) : null,
      },
    },
  };
};
