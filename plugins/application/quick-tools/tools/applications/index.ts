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

import { qt } from '../../shared/i18n.js';
import type { PluginFactory, Row } from '../../shared/plugin.js';
const create: PluginFactory = async (ctx) => {
  let apps = await ctx.call('applications.list', undefined);
  const refresh = setInterval(
    () =>
      void ctx
        .call('applications.list', undefined)
        .then((value) => {
          apps = value;
          ctx.changed();
        })
        .catch(() => {}),
    60000,
  );
  let snapshot: Promise<Record<string, number>> | undefined;
  let checked = 0;
  const rows = async (): Promise<Row[]> => {
    if (!snapshot || Date.now() - checked >= 1000) {
      checked = Date.now();
      snapshot = ctx.call(
        'applications.running',
        apps.map((app) => app.target),
      ).catch(() => ({}));
    }
    const running = await snapshot;
    return apps.map((a) => {
      const pid = running[a.target];
      const instance = { id: a.id, pid };
      return {
        id: a.id,
        name: a.name,
        icon: a.icon,
        kind: qt('应用'),
        keywords: a.keywords,
        detail: a.target,
        actions: [
          { id: 'open', title: qt('打开'), data: a.id },
          ...(pid
            ? [
                { id: 'hide', title: qt('隐藏应用'), data: instance },
                { id: 'restart', title: qt('重启应用'), data: instance },
                { id: 'quit', title: qt('退出应用'), data: instance },
                {
                  id: 'forceQuit',
                  title: qt('强制退出应用'),
                  data: instance,
                  confirm: qt('强制退出“${0}”？未保存的更改可能会丢失。', a.name),
                },
              ]
            : []),
          { id: 'copyPath', title: qt('复制路径'), data: a.id },
          { id: 'reveal', title: qt('在 Finder 中显示'), data: a.id },
        ],
      };
    });
  };
  return {
    search: () => rows(),
    view: async () => ({ title: qt('应用'), rows: await rows() }),
    async run(action, data) {
      if (action === 'browse') return { navigate: 'main' };
      const instance =
        data && typeof data === 'object' && 'id' in data && 'pid' in data ? data : null;
      const app = apps.find((a) => a.id === (instance?.id ?? data));
      if (!app) throw Error(qt('应用已不存在'));
      if (action === 'open' || action === 'reveal') {
        await ctx.call(action === 'open' ? 'system.open' : 'system.reveal', app.target);
      } else if (action === 'copyPath') {
        await ctx.call('clipboard.write', { text: app.target });
      } else if (
        (action === 'hide' ||
          action === 'restart' ||
          action === 'quit' ||
          action === 'forceQuit') &&
        typeof instance?.pid === 'number'
      ) {
        snapshot = undefined;
        await ctx.call('applications.manage', { target: app.target, pid: instance.pid, action });
      } else throw Error(qt('无效操作'));
      await ctx.call('window.hide', undefined);
    },
    dispose: () => clearInterval(refresh),
  };
};
export default create;
