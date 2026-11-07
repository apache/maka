/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See NOTICE. Licensed under the Apache
 * License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0 */
import type { PluginFactory, Row, ToolIcon, Action } from '../../shared/plugin.js';
import { qt } from '../../shared/i18n.js';
import { expandTemplate } from '../links/template.js';
import manifest from './manifest.json';
import { createLibrary } from './library.js';
const icon = manifest.icon as ToolIcon;
type SearchType = 'video' | 'user';
const links = {
  home: 'https://www.bilibili.com/',
  dynamic: 'https://t.bilibili.com/',
  watchlater: 'https://www.bilibili.com/watchlater/#/list',
  space: 'https://space.bilibili.com/{uid}',
};
const uid = (value: unknown): string => {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d{0,19}$/.test(text)) throw Error(qt('请输入有效的 B站 UID（正整数）'));
  return text;
};
const create: PluginFactory = async (ctx) => {
  let spaceError = '';
  const library = createLibrary(ctx, icon);
  const states = {
    video: { rows: [] as Row[], query: '', page: 1, error: '' },
    user: { rows: [] as Row[], query: '', page: 1, error: '' },
  };
  const title = (type: SearchType) =>
    type === 'video' ? qt('搜索 B站视频') : qt('搜索 B站 UP 主');
  const actionId = (type: SearchType) => (type === 'video' ? 'search' : 'search-user');
  const connect = (): Action => ({ id: 'connect', title: qt('连接 BrowserMCP / Chrome') });
  const spaceAction = (): Action => ({ id: 'space', title: qt('打开我的个人空间') });
  const searchAction = (type: SearchType): Action => ({
    id: actionId(type),
    title: title(type),
    form: {
      title: title(type),
      fields: [{ id: 'query', label: qt('搜索词'), required: true, maxLength: 200 }],
      values: { query: states[type].query },
    },
  });
  const searchRow = (query: string, type: SearchType): Row => ({
    id: `search-${type}`,
    name: `${title(type)} · ${query}`,
    icon,
    kind: qt('哔哩哔哩'),
    persistable: false,
    featured: true,
    actions: [{ id: actionId(type), title: title(type), data: query }],
  });
  const commands = (): Row[] =>
    [
      { id: 'home', name: qt('打开 B站首页'), actions: [{ id: 'home', title: qt('打开') }] },
      { id: 'dynamic', name: qt('打开 B站动态'), actions: [{ id: 'dynamic', title: qt('打开') }] },
      {
        id: 'space',
        name: qt('打开我的个人空间'),
        detail: qt('自动识别 Chrome 当前登录的 B站账号'),
        actions: [spaceAction()],
      },
      {
        id: 'watchlater',
        name: qt('打开 B站稍后再看'),
        actions: [{ id: 'watchlater', title: qt('打开') }],
      },
      { id: 'videos', name: title('video'), actions: [{ id: 'open-video', title: qt('打开') }] },
      {
        id: 'favorites',
        name: qt('B站收藏夹'),
        actions: [{ id: 'library-favorites', title: qt('打开') }],
      },
      {
        id: 'history',
        name: qt('B站观看历史'),
        actions: [{ id: 'library-history', title: qt('打开') }],
      },
      { id: 'users', name: title('user'), actions: [{ id: 'open-user', title: qt('打开') }] },
    ].map((row) => ({ ...row, icon, kind: qt('哔哩哔哩') }));
  const openLink = (target: string, values: Record<string, string | boolean> = {}) =>
    ctx.call('system.open', expandTemplate(target, values));
  return {
    search(query) {
      const match = /^(?:b站|bilibili|bili)\s+(.+)$/i.exec(query.trim());
      return match
        ? [searchRow(match[1].slice(0, 200), 'video'), searchRow(match[1].slice(0, 200), 'user')]
        : [];
    },
    resolve(id) {
      return (
        library.resolve(id) ??
        commands().find((row) => row.id === id) ??
        states.video.rows.find((row) => row.id === id) ??
        states.user.rows.find((row) => row.id === id)
      );
    },
    view(id, query) {
      const libraryView = library.view(id, query);
      if (libraryView) return libraryView;
      const text = query.trim().slice(0, 200);
      if (id === 'main')
        return {
          title: qt('哔哩哔哩'),
          rows: text
            ? [...commands(), searchRow(text, 'video'), searchRow(text, 'user')]
            : commands(),
          actions: [connect()],
        };
      if (id === 'space')
        return {
          title: qt('个人空间'),
          notice: spaceError || qt('自动识别 Chrome 当前登录的 B站账号'),
          rows: [commands()[2], commands()[0]],
          actions: [connect()],
        };
      const type: SearchType = id === 'users' ? 'user' : 'video',
        state = states[type];
      return {
        title: title(type),
        notice:
          state.error ||
          (state.query
            ? qt('「${0}」· 第 ${1} 页 · ${2} 个结果', state.query, state.page, state.rows.length)
            : qt('输入关键词，按回车搜索；网页操作使用已连接的 BrowserMCP。')),
        rows: text
          ? [searchRow(text, type)]
          : state.error && state.query
            ? [searchRow(state.query, type)]
            : state.rows.length
              ? state.rows
              : [
                  {
                    id: 'start',
                    name: title(type),
                    icon,
                    actions: [searchAction(type)],
                    persistable: false,
                  },
                ],
        actions: [
          searchAction(type),
          ...(state.query && !state.error && state.rows.length
            ? [{ id: type === 'video' ? 'next' : 'next-user', title: qt('下一页') }]
            : []),
          connect(),
        ],
      };
    },
    async run(action, data, values) {
      if (action.startsWith('library-')) return library.run(action, data);
      if (action === 'open') return { navigate: 'main' };
      if (action === 'open-video' || action === 'open-user')
        return { navigate: action === 'open-video' ? 'videos' : 'users' };
      if (action === 'home' || action === 'dynamic' || action === 'watchlater') {
        await openLink(links[action]);
        return;
      }
      if (action === 'space') {
        spaceError = '';
        try {
          const reply = await ctx.call('web.run', { command: 'me', args: {} });
          const account = reply.rows[0] as Record<string, unknown> | undefined;
          const accountUid = uid(account?.uid);
          await openLink(links.space, { uid: accountUid });
        } catch (failure) {
          spaceError = `${qt('无法识别当前账号。请确认 Chrome 已连接并登录 B站，然后重试。')} ${failure instanceof Error ? failure.message : String(failure)}`;
          return { navigate: 'space' };
        }
        return;
      }
      if (action === 'profile') {
        await openLink(links.space, { uid: uid(data) });
        return;
      }
      if (action === 'connect') {
        await ctx.call('web.connect', undefined);
        return;
      }
      if (action === 'video') {
        if (
          typeof data !== 'string' ||
          !/^https:\/\/www\.bilibili\.com\/video\/BV[A-Za-z0-9]+\/?$/.test(data)
        )
          throw Error(qt('无效的视频地址'));
        await openLink(data);
        return;
      }
      if (!['search', 'search-user', 'next', 'next-user'].includes(action))
        throw Error(qt('无效操作'));
      const type: SearchType = action.endsWith('-user') ? 'user' : 'video',
        state = states[type];
      const nextPage = action.startsWith('next') ? state.page + 1 : 1;
      const query = action.startsWith('next')
        ? state.query
        : typeof data === 'string'
          ? data.trim()
          : String(values.query ?? '').trim();
      if (!query || query.length > 200) throw Error(qt('请输入 1–200 个字符的搜索词'));
      state.query = query;
      state.error = '';
      try {
        const reply = await ctx.call('web.run', {
          command: 'search',
          args: { query, type, page: nextPage, limit: 20 },
        });
        const rows: Row[] = [];
        for (const value of reply.rows) {
          if (!value || typeof value !== 'object') continue;
          const item = value as Record<string, unknown>;
          if (type === 'user') {
            if (!/^[1-9]\d{0,19}$/.test(String(item.mid ?? '')) || typeof item.name !== 'string')
              continue;
            rows.push({
              id: `user:${item.mid}`,
              name: item.name.slice(0, 500),
              icon,
              kind: 'UP',
              persistable: false,
              detail: [
                qt('${0} 粉丝', String(item.fans ?? 0).slice(0, 30)),
                typeof item.sign === 'string' ? item.sign.slice(0, 300) : '',
              ]
                .filter(Boolean)
                .join(' · '),
              actions: [{ id: 'profile', title: qt('打开个人空间'), data: String(item.mid) }],
            });
          } else {
            if (
              typeof item.bvid !== 'string' ||
              !/^BV[A-Za-z0-9]+$/.test(item.bvid) ||
              typeof item.title !== 'string'
            )
              continue;
            rows.push({
              id: item.bvid,
              name: item.title.slice(0, 500),
              icon,
              kind: 'Bilibili',
              persistable: false,
              detail: [
                typeof item.author === 'string' ? item.author.slice(0, 200) : '',
                typeof item.plays === 'number' || typeof item.plays === 'string'
                  ? qt('${0} 次播放', String(item.plays).slice(0, 30))
                  : '',
              ]
                .filter(Boolean)
                .join(' · '),
              actions: [
                {
                  id: 'video',
                  title: qt('打开视频'),
                  data: `https://www.bilibili.com/video/${item.bvid}`,
                },
              ],
            });
          }
        }
        state.rows = [...new Map(rows.map((row) => [row.id, row])).values()];
        state.page = nextPage;
        if (!state.rows.length) state.error = qt('没有找到匹配结果，请换个搜索词重试。');
      } catch (failure) {
        state.rows = [];
        state.error = `${qt('搜索失败，可重试或连接 BrowserMCP。')} ${failure instanceof Error ? failure.message : String(failure)}`;
      }
      return { navigate: type === 'video' ? 'videos' : 'users' };
    },
  };
};
export default create;
