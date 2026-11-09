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
