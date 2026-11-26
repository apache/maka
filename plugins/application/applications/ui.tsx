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

function applicationIcons(host: ApplicationHost, input: QuickToolInput) {
  const icons = new Map<string, () => string | undefined>();
  return (id: string) => {
    let icon = icons.get(id);
    if (!icon) {
      const loaded = signal<string | undefined>(undefined);
      icon = loaded;
      icons.set(id, icon);
      host.applicationIcon(id).then(loaded.set, input.report);
    }
    return icon();
  };
}

function runningActions(
  name: string,
  visibility: 'hide' | 'minimize',
  invoke: (action: 'hide' | 'minimize' | 'quit' | 'forceQuit' | 'restart') => void,
): QuickAction[] {
  return [
    {
      title: visibility === 'hide' ? tr('Hide application') : tr('Minimize application'),
      icon: 'minus',
      startsGroup: true,
      run: () => invoke(visibility),
    },
    { title: tr('Restart application'), icon: 'refresh', run: () => invoke('restart') },
    { title: tr('Quit application'), icon: 'close', run: () => invoke('quit') },
    {
      title: tr('Force quit application'),
      icon: 'stop',
      confirm: tr('Force quit {app}? Unsaved changes may be lost.', { app: name }),
      run: () => invoke('forceQuit'),
    },
  ];
}

function macItems(input: QuickToolInput, host: ApplicationHost) {
  const installed = signal<readonly string[]>([]);
  host.installedApplications().then(installed.set, input.report);
  const iconOf = applicationIcons(host, input);
  return computed(() =>
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
              : runningActions(applicationName(path), 'hide', (action) =>
                  run(host.applicationAction(path, pid, action)),
                )),
          ];
        },
        match,
        remembered: true,
        run: () => void host.openLocalPath(path).then(input.close, input.report),
      }),
    ),
  );
}

function windowsItems(input: QuickToolInput, host: ApplicationHost) {
  const installed = signal<Awaited<ReturnType<ApplicationHost['startMenuApplications']>>>([]);
  host.startMenuApplications().then(installed.set, input.report);
  const iconOf = applicationIcons(host, input);
  return computed(() =>
    search(installed(), input.query(), keywords(), (app) => [app.name], true).map(
      ({ item, match }): QuickItem => ({
        id: item.id,
        title: item.name,
        icon: 'app',
        image: () => iconOf(item.id),
        source: tr('Application'),
        action: tr('Open'),
        async actions(): Promise<readonly QuickAction[]> {
          const { path, instance } = await host.startMenuActions(item.id);
          const run = (task: Promise<unknown>) => void task.then(input.close, input.report);
          return [
            {
              title: tr('Show in File Explorer'),
              icon: 'folder',
              run: () => run(host.startMenuAction(item.id, 'reveal', null)),
            },
            {
              title: path ? tr('Copy application path') : tr('Copy application ID'),
              icon: 'copy',
              run: () => run(Clipboard.writeText(path ?? item.id)),
            },
            ...(instance == null
              ? []
              : runningActions(item.name, 'minimize', (action) =>
                  run(host.startMenuAction(item.id, action, instance)),
                )),
          ];
        },
        match,
        remembered: true,
        run: () => void host.openStartMenuApplication(item.id).then(input.close, input.report),
      }),
    ),
  );
}

function Applications(props: { input: QuickToolInput; host: ApplicationHost }) {
  const { input, host } = props;
  const items = platform.os === 'windows' ? windowsItems(input, host) : macItems(input, host);
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
          platform.os === 'macos' || platform.os === 'windows' ? (
            <Applications input={input} host={context.application as ApplicationHost} />
          ) : null,
      },
    },
  };
};
