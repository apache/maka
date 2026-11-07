import type { PluginFactory, Row } from '../../shared/plugin.js';
const create: PluginFactory = async (ctx) => {
  const t = (zh: string, english: string) => (ctx.locale === 'en' ? english : zh);
  const connect = () => ({
    id: 'connect',
    title: t('连接 Chrome / 安装扩展', 'Connect Chrome / Install extension'),
  });
  let cache: Row[] = [];
  async function rows(query: string) {
    const state = await ctx.call('browser.tabs.read', undefined);
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    cache = state.tabs
      .filter((tab) =>
        words.every((word) => `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(word)),
      )
      .map((tab) => ({
        id: tab.key,
        name: tab.title,
        detail: tab.url,
        kind: tab.pinned ? t('已固定', 'Pinned') : 'Chrome',
        icon: 'browser',
        persistable: false,
        actions: [
          { id: 'activate', title: t('切换标签页', 'Switch to tab'), data: tab.key },
          {
            id: 'pin',
            title: tab.pinned ? t('取消固定', 'Unpin') : t('固定标签页', 'Pin tab'),
            data: tab.key,
          },
          {
            id: 'close',
            title: t('关闭标签页', 'Close tab'),
            data: tab.key,
            confirm: t(
              `关闭「${tab.title}」？未保存的内容可能丢失。`,
              `Close “${tab.title}”? Unsaved content may be lost.`,
            ),
          },
        ],
      }));
    return { state, rows: cache };
  }
  return {
    async search(query) {
      return query.trim() ? (await rows(query)).rows.slice(0, 80) : [];
    },
    resolve(id) {
      return cache.find((row) => row.id === id);
    },
    async view(_id, query) {
      const result = await rows(query);
      return {
        title: t('Chrome 标签页', 'Chrome Tabs'),
        rows: result.rows,
        actions: [connect()],
        notice: result.state.connected
          ? result.rows.length
            ? undefined
            : t('没有匹配的标签页', 'No matching tabs')
          : t(
              '首次使用：选择「连接 Chrome」，然后在 chrome://extensions 开启开发者模式，加载打开的扩展文件夹。已安装时点击 Chrome 工具栏的 Maka Tabs 重新连接。',
              'Choose Connect Chrome, then load the revealed folder in chrome://extensions with Developer mode enabled. If installed, click Maka Tabs in the Chrome toolbar to reconnect.',
            ),
      };
    },
    async run(action, data) {
      if (action === 'open') return { navigate: 'main' };
      if (action === 'connect') {
        await ctx.call('browser.tabs.connect', undefined);
        return;
      }
      if (!['activate', 'close', 'pin'].includes(action) || typeof data !== 'string')
        throw Error('Invalid tab action');
      await ctx.call('browser.tabs.manage', {
        key: data,
        action: action as 'activate' | 'close' | 'pin',
      });
      return action === 'close' ? { removed: [data] } : undefined;
    },
  };
};
export default create;
