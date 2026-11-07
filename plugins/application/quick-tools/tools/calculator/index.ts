/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See NOTICE. Licensed under the Apache
 * License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0 */
import { qt } from '../../shared/i18n.js';
import type { PluginFactory, Row } from '../../shared/plugin.js';
import { calculate } from './calculate.js';
const create: PluginFactory = (ctx) => {
  const rows = (query: string): Row[] => {
    const value = calculate(query)?.value;
    return value
      ? [
          {
            id: 'result',
            name: value,
            kind: qt('计算结果'),
            detail: query,
            featured: true,
            persistable: false,
            actions: [{ id: 'copy', title: qt('复制结果'), data: query }],
          },
        ]
      : [];
  };
  return {
    search: rows,
    view: (_id, query) => ({
      title: qt('计算器与换算'),
      rows: rows(query),
      notice: calculate(query)?.error ?? qt('输入算式或单位换算，例如 128 * 1.13、10 km to mi'),
    }),
    async run(action, data) {
      if (action === 'open') return { navigate: 'main' };
      if (action !== 'copy' || typeof data !== 'string') throw Error(qt('无效操作'));
      const value = calculate(data)?.value;
      if (!value) throw Error(qt('无效算式'));
      await ctx.call('clipboard.write', { text: value });
      await ctx.call('window.hide', undefined);
    },
  };
};
export default create;
