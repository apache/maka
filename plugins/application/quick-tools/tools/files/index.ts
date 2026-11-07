/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See NOTICE. Licensed under the Apache
 * License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0 */
import { qt } from '../../shared/i18n.js';
import { homedir } from 'os';
import { basename, join, isAbsolute } from 'path';
import { stat, readdir } from 'fs/promises';
import type { PluginFactory, Row } from '../../shared/plugin.js';
import { searchFileNames, stopFileSearches } from './search.js';
const expand = (value: string) =>
  value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
const create: PluginFactory = async (ctx) => {
  let settings = await ctx.storage.read({ root: homedir() });
  const row = (path: string): Row => ({
    id: path,
    name: basename(path) || path,
    detail: path,
    kind: qt('文件'),
    icon: 'search',
    actions: [
      { id: 'launch', title: qt('打开'), data: path },
      { id: 'reveal', title: qt('在 Finder 中显示'), data: path },
      { id: 'copy', title: qt('复制路径'), data: path },
    ],
  });
  async function find(query: string, signal: AbortSignal): Promise<Row[]> {
    query = query.trim();
    if (query.length > 300) throw Error(qt('搜索词过长'));
    if (!query) return [];
    if (query.startsWith('/') || query.startsWith('~/')) {
      const path = expand(query),
        info = await stat(path).catch(() => undefined);
      if (signal.aborted) return [];
      if (!info) return [];
      if (!info.isDirectory()) return [row(path)];
      const children = await readdir(path, { withFileTypes: true });
      return [
        row(path),
        ...children
          .filter((x) => !x.name.startsWith('.'))
          .slice(0, 79)
          .map((x) => row(join(path, x.name))),
      ].map((x) => ({ ...x, featured: true }));
    }
    if (query.length < 2) return [];
    return (await searchFileNames(settings.root, query, signal)).map(row);
  }
  return {
    search: find,
    dispose: stopFileSearches,
    async resolve(id) {
      return isAbsolute(id) && (await stat(id).catch(() => undefined)) ? row(id) : undefined;
    },
    async view(_id, query, signal) {
      return {
        title: qt('文件搜索'),
        notice: qt(
          '搜索范围：${0}。输入至少两个字符，或粘贴完整路径；最多显示 80 项。文件名搜索依赖 Spotlight 索引。',
          settings.root,
        ),
        rows: query.trim()
          ? await find(query, signal)
          : [
              homedir(),
              join(homedir(), 'Desktop'),
              join(homedir(), 'Documents'),
              join(homedir(), 'Downloads'),
            ].map(row),
        actions: [
          {
            id: 'scope',
            title: qt('设置搜索范围'),
            form: {
              title: qt('设置搜索范围'),
              fields: [{ id: 'root', label: qt('文件夹路径'), required: true, maxLength: 4096 }],
              values: { root: settings.root },
            },
          },
        ],
      };
    },
    async run(action, data, values) {
      if (action === 'open') return { navigate: 'main' };
      if (action === 'scope') {
        const root = typeof values.root === 'string' ? expand(values.root.trim()) : '';
        if (!isAbsolute(root) || !(await stat(root).catch(() => undefined))?.isDirectory())
          throw Error(qt('请输入存在的文件夹绝对路径'));
        await ctx.storage.write({ root });
        settings = { root };
        ctx.changed();
        return;
      }
      if (
        typeof data !== 'string' ||
        !isAbsolute(data) ||
        !(await stat(data).catch(() => undefined))
      )
        throw Error(qt('文件已不存在'));
      if (action === 'copy') await ctx.call('clipboard.write', { text: data });
      else if (action === 'launch' || action === 'reveal') {
        await ctx.call(action === 'launch' ? 'system.open' : 'system.reveal', data);
        await ctx.call('window.hide', undefined);
      } else throw Error(qt('无效操作'));
    },
  };
};
export default create;
