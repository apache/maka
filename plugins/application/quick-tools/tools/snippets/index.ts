/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See NOTICE. Licensed under the Apache
 * License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0 */
import { qt } from '../../shared/i18n.js';
import type { PluginFactory } from '../../shared/plugin.js';
import { collection } from '../collection.js';
const create: PluginFactory = (ctx) =>
  collection(ctx, {
    get title() {
      return qt('文本片段');
    },
    prefix: 'snippet',
    field: 'content',
    get label() {
      return qt('片段内容');
    },
    validate: (value) => {
      if (!value.trim()) throw Error(qt('请输入片段内容'));
    },
    actions: (item) => [
      { id: 'paste', title: qt('粘贴'), data: item.id },
      { id: 'copy', title: qt('复制'), data: item.id },
    ],
    async run(ctx, item, action) {
      if (action === 'paste') await ctx.call('paste', { text: item.content ?? '' });
      else if (action === 'copy') {
        await ctx.call('clipboard.write', { text: item.content ?? '' });
        await ctx.call('window.hide', undefined);
      } else throw Error(qt('无效操作'));
    },
  });
export default create;
