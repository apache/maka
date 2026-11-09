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
import type { PluginFactory } from '../../shared/plugin.js';
import { parameters, validateTemplate, expandTemplate } from './template.js';
import { collection } from '../collection.js';
const create: PluginFactory = async (ctx) => {
  const plugin = await collection(ctx, {
    get title() {
      return qt('快捷链接');
    },
    get createTitle() {
      return qt('新建快捷链接');
    },
    prefix: 'link',
    field: 'target',
    get label() {
      return qt('目标（网站、应用深链或文件路径）');
    },
    validate: validateTemplate,
    actions: (item) => [
      {
        id: 'launch',
        get title() {
          return qt('打开');
        },
        data: item.id,
        form: parameters(item.target ?? '').length
          ? {
              get title() {
                return qt('打开快捷链接');
              },
              fields: parameters(item.target ?? '').map((name) => ({
                id: name,
                label: name === 'query' ? qt('搜索词') : name,
                required: true,
                maxLength: 4096,
              })),
            }
          : undefined,
      },
    ],
    async run(ctx, item, action, values) {
      if (action !== 'launch') throw Error(qt('无效操作'));
      await ctx.call('system.open', expandTemplate(item.target ?? '', values));
      await ctx.call('window.hide', undefined);
    },
  });
  const view = plugin.view!;
  plugin.view = async (...args) => ({
    ...(await view(...args)),
    notice: qt(
      '支持网站、应用深链和本地路径。网址可用 {query} 或 {参数名}。在条目设置中为每条链接设置别名和快捷键。',
    ),
  });
  return plugin;
};
export default create;
