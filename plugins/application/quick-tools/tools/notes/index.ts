/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See NOTICE. Licensed under the Apache
 * License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0 */
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
