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

import { Clipboard, computed, platform, signal, type JSX } from 'nsh';
import type { ApplicationHost } from 'maka/host';
import type { UiEmbeddedViewProps, UiModule } from '../../../packages/plugin-sdk/src/workbench.js';
import {
  quickToolView,
  type QuickItem,
  type QuickAction,
  type QuickToolInput,
} from '../../../packages/plugin-sdk/src/workbench-views.js';
import { localizedKeywords, tr } from '../../../products/maka/workbench/app/locale';
import { search } from '../../shared/quick-search';

const keywords = () =>
  localizedKeywords(['app', 'apps', 'Search applications'], 'launcher.keywords.applications');
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
    search(installed(), input.query(), keywords(), (path) => [applicationName(path)], true).map(
      ({ item: path, match }): QuickItem => ({
        id: path,
        title: applicationName(path),
        icon: 'app',
        image: () => iconOf(path),
        source: tr('Application'),
        action: tr('Open'),
        async actions(): Promise<readonly QuickAction[]> {
          const pid = await host.applicationInstance(path);
          const run = (task: Promise<unknown>) => void task.then(input.close, input.report);
          return [
            {
              title: tr('Reveal in Finder'),
              icon: 'folder',
              run: () => run(host.applicationAction(path, 0, 'reveal')),
            },
            {
              title: tr('Copy application path'),
              icon: 'copy',
              run: () => run(Clipboard.writeText(path)),
            },
            ...(pid == null
              ? []
              : [
                  {
                    title: tr('Hide application'),
                    icon: 'minus' as const,
                    startsGroup: true,
                    run: () => run(host.applicationAction(path, pid, 'hide')),
                  },
                  {
                    title: tr('Restart application'),
                    icon: 'refresh' as const,
                    run: () => run(host.applicationAction(path, pid, 'restart')),
                  },
                  {
                    title: tr('Quit application'),
                    icon: 'close' as const,
                    run: () => run(host.applicationAction(path, pid, 'quit')),
                  },
                  {
                    title: tr('Force quit application'),
                    icon: 'stop' as const,
                    confirm: tr('Force quit {app}? Unsaved changes may be lost.', {
                      app: applicationName(path),
                    }),
                    run: () => run(host.applicationAction(path, pid, 'forceQuit')),
                  },
                ]),
          ];
        },
        match,
        remembered: true,
        run: () => void host.openLocalPath(path).then(input.close, input.report),
      }),
    ),
  );
  input.attach({
    items,
    entries: () => [{ id: 'search', title: tr('Applications'), icon: 'app', keywords: keywords() }],
  });
  return null;
}

export const activate: UiModule<JSX.Element>['activate'] = (context) => {
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
