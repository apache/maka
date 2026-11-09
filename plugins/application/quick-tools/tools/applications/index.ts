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
  const rows = (): Row[] =>
    apps.map((a) => ({
      id: a.id,
      name: a.name,
      icon: a.icon,
      kind: qt('应用'),
      keywords: a.keywords,
      detail: a.target,
      actions: [
        { id: 'open', title: qt('打开'), data: a.id },
        { id: 'reveal', title: qt('在 Finder 中显示'), data: a.id },
      ],
    }));
  return {
    search: () => rows(),
    view: () => ({ title: qt('应用启动器'), rows: rows() }),
    async run(action, data) {
      if (action === 'browse') return { navigate: 'main' };
      const app = apps.find((a) => a.id === data);
      if (!app) throw Error(qt('应用已不存在'));
      if (action !== 'open' && action !== 'reveal') throw Error(qt('无效操作'));
      await ctx.call(action === 'open' ? 'system.open' : 'system.reveal', app.target);
      await ctx.call('window.hide', undefined);
    },
    dispose: () => clearInterval(refresh),
  };
};
export default create;
