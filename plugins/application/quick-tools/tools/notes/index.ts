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
import { collection } from '../collection.js';
const create: PluginFactory = async (ctx) => {
  const plugin = await collection(ctx, {
    get title() {
      return qt('快速笔记');
    },
    prefix: 'note',
    field: 'content',
    get label() {
      return qt('笔记正文');
    },
    validate: (value) => {
      if (!value.trim()) throw Error(qt('请输入笔记正文'));
    },
    actions: (item) => [
      { id: 'copy', title: qt('复制正文'), data: item.id },
      { id: 'paste', title: qt('粘贴正文'), data: item.id },
    ],
    async run(ctx, item, action) {
      if (action === 'paste') await ctx.call('paste', { text: item.content ?? '' });
      else if (action === 'copy') await ctx.call('clipboard.write', { text: item.content ?? '' });
      else throw Error(qt('无效操作'));
    },
  });
  const search = plugin.search!;
  plugin.search = async (query, signal) =>
    (await search(query, signal)).map((row) => ({
      ...row,
      keywords: `${row.keywords ?? ''} ${row.detail ?? ''}`,
    }));
  return plugin;
};
export default create;
