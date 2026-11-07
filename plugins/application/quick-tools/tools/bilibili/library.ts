/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See NOTICE. Licensed under the Apache
 * License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0 */
import type { Context, Row, ToolIcon, Action } from '../../shared/plugin.js';
import { qt } from '../../shared/i18n.js';

type Kind = 'favorites' | 'history';
export function createLibrary(ctx: Context, icon: ToolIcon) {
  let account = '',
    folders: Row[] = [],
    folderId = '',
    folderName = '',
    folderError = '';
  const states = {
    favorites: { rows: [] as Row[], query: '', page: 1, more: false, cursor: '', error: '' },
    history: { rows: [] as Row[], query: '', page: 1, more: false, cursor: '', error: '' },
  };
  const connect: Action = { id: 'connect', title: qt('连接 BrowserMCP / Chrome') };
  const api = async (command: string, args: Record<string, unknown>) => {
    const reply = await ctx.call('web.run', { command, args });
    const envelope = reply.value as { code?: number; message?: string; data?: any } | undefined;
    if (!envelope || envelope.code !== 0)
      throw Error(envelope?.message || qt('请在 Chrome 中登录 B站后重试'));
    return envelope.data;
  };
  const identify = async () => {
    const result = await ctx.call('web.run', { command: 'me', args: {} });
    const id = String((result.rows[0] as { uid?: unknown } | undefined)?.uid ?? '');
    if (!/^[1-9]\d{0,19}$/.test(id)) throw Error(qt('请在 Chrome 中登录 B站后重试'));
    if (account !== id) {
      account = id;
      folders = [];
      folderId = '';
      folderName = '';
      for (const state of Object.values(states))
        Object.assign(state, { rows: [], query: '', page: 1, more: false, cursor: '', error: '' });
    }
    return id;
  };
  const videoRows = (items: any[], kind: Kind): Row[] =>
    items.flatMap((item) => {
      const bvid = item.bvid ?? item.history?.bvid;
      if (
        typeof bvid !== 'string' ||
        !/^BV[A-Za-z0-9]+$/.test(bvid) ||
        typeof item.title !== 'string'
      )
        return [];
      const author = item.author_name ?? item.upper?.name ?? item.author ?? '';
      const date =
        typeof item.view_at === 'number' ? new Date(item.view_at * 1000).toLocaleString() : '';
      return [
        {
          id: `${kind}:${bvid}`,
          name: item.title.replace(/<[^>]*>/g, '').slice(0, 500),
          icon,
          persistable: false,
          detail: [String(author).slice(0, 200), date].filter(Boolean).join(' · '),
          actions: [
            { id: 'video', title: qt('打开视频'), data: `https://www.bilibili.com/video/${bvid}` },
          ],
        },
      ];
    });
  const loadFolders = async () => {
    folders = [];
    folderError = '';
    try {
      const id = await identify();
      const data = await api('folders', { up_mid: id });
      folders = (data?.list ?? []).flatMap((f: any) =>
        /^[1-9]\d*$/.test(String(f.id)) && typeof f.title === 'string'
          ? [
              {
                id: `folder:${f.id}`,
                name: f.title.slice(0, 500),
                icon,
                persistable: false,
                detail: qt('${0} 个视频', f.media_count ?? 0),
                actions: [{ id: 'library-folder', title: qt('打开收藏夹'), data: String(f.id) }],
              },
            ]
          : [],
      );
    } catch (error) {
      folderError = String(error instanceof Error ? error.message : error);
    }
    return { navigate: 'folders' };
  };
  return {
    resolve(id: string) {
      return [...folders, ...states.favorites.rows, ...states.history.rows].find(
        (row) => row.id === id,
      );
    },
    view(id: string, query: string) {
      if (id === 'folders')
        return {
          title: qt('B站收藏夹'),
          rows: folders.length
            ? folders
            : [
                {
                  id: 'folders-retry',
                  name: qt('刷新收藏夹'),
                  icon,
                  featured: true,
                  persistable: false,
                  actions: [{ id: 'library-favorites', title: qt('刷新收藏夹') }],
                },
              ],
          notice:
            folderError || (folders.length ? qt('选择收藏夹；输入名称筛选') : qt('暂无收藏夹')),
          actions: [{ id: 'library-favorites', title: qt('刷新收藏夹') }, connect],
        };
      if (id !== 'favorites' && id !== 'history') return;
      const state = states[id],
        text = query.trim().slice(0, 200);
      const search: Row = {
        id: `library-search-${id}`,
        name: `${qt('搜索')} · ${text}`,
        icon,
        featured: true,
        persistable: false,
        actions: [{ id: `library-search-${id}`, title: qt('搜索'), data: text }],
      };
      return {
        title: id === 'favorites' ? folderName || qt('B站收藏夹') : qt('B站观看历史'),
        notice:
          state.error ||
          `${state.query ? `「${state.query}」 · ` : ''}${qt('第 ${0} 页 · ${1} 个视频', state.page, state.rows.length)}${!state.rows.length ? ' · ' + qt('暂无匹配视频') : ''}`,
        rows: text
          ? [search]
          : state.rows.length
            ? state.rows
            : [
                {
                  id: `library-retry-${id}`,
                  name: qt('刷新'),
                  icon,
                  featured: true,
                  persistable: false,
                  actions: [{ id: `library-refresh-${id}`, title: qt('刷新') }],
                },
              ],
        actions: [
          { id: `library-refresh-${id}`, title: qt('刷新') },
          ...(state.more ? [{ id: `library-next-${id}`, title: qt('下一页') }] : []),
          ...(id === 'favorites' ? [{ id: 'library-favorites', title: qt('返回收藏夹') }] : []),
          connect,
        ],
      };
    },
    async run(action: string, value: unknown) {
      if (action === 'library-favorites') return loadFolders();
      let kind: Kind = action.endsWith('history') ? 'history' : 'favorites';
      if (action === 'library-folder') {
        const folder = folders.find((row) => row.id === `folder:${value}`);
        if (!folder) throw Error(qt('请重新选择收藏夹'));
        folderId = String(value);
        folderName = folder.name;
      }
      const state = states[kind];
      const next = action.startsWith('library-next-');
      if (next && !state.more) return { navigate: kind };
      let query = action.startsWith('library-search-')
        ? String(value ?? '')
            .trim()
            .slice(0, 200)
        : next || action.startsWith('library-refresh-')
          ? state.query
          : '';
      let page = next ? state.page + 1 : 1,
        cursor = next ? state.cursor : '';
      state.rows = [];
      state.error = '';
      state.more = false;
      try {
        const previousAccount = account;
        await identify();
        if (previousAccount !== account) {
          query = '';
          page = 1;
          cursor = '';
        }
        if (kind === 'favorites' && !folderId) return loadFolders();
        const data =
          kind === 'favorites'
            ? await api('favorite-items', {
                media_id: folderId,
                pn: page,
                ps: 20,
                keyword: query,
                type: 0,
              })
            : query
              ? await api('history-search', { keyword: query, pn: page, business: 'archive' })
              : await api('history-items', {
                  ps: 20,
                  type: 'archive',
                  ...(cursor ? { view_at: cursor } : {}),
                });
        const items = kind === 'favorites' ? (data?.medias ?? []) : (data?.list ?? []);
        if (!Array.isArray(items)) throw Error(qt('网页返回的数据格式无效'));
        state.rows = [...new Map(videoRows(items, kind).map((row) => [row.id, row])).values()];
        state.query = query;
        state.page = page;
        state.cursor = String(data?.cursor?.view_at || '');
        state.more =
          kind === 'favorites'
            ? Boolean(data?.has_more)
            : query
              ? Boolean(data?.has_more ?? page * 20 < (data?.page?.total ?? 0))
              : items.length > 0 && !!state.cursor && state.cursor !== cursor;
      } catch (error) {
        state.error = `${qt('读取失败，请确认 Chrome 已连接并登录 B站后重试。')} ${error instanceof Error ? error.message : String(error)}`;
        state.query = query;
      }
      return { navigate: kind };
    },
  };
}
