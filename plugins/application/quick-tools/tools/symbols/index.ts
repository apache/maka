/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See NOTICE. Licensed under the Apache
 * License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0 */
import { qt } from '../../shared/i18n.js';
import type { PluginFactory, Row } from '../../shared/plugin.js';
import icons from './icons.json';
// Curated common characters, not a claim to cover the full Unicode catalog.
export const symbols = [
  ['😀', '开心笑脸', 'smile happy kaixin'],
  ['😄', '大笑', 'laugh daxiao'],
  ['😂', '笑哭', 'joy tears xiaoku'],
  ['🤣', '笑翻', 'rofl laugh'],
  ['😊', '微笑', 'blush smile weixiao'],
  ['🥰', '喜爱', 'love adore'],
  ['😍', '心动', 'heart eyes love'],
  ['😎', '酷', 'cool sunglasses'],
  ['🤔', '思考', 'think sikao'],
  ['🤗', '拥抱', 'hug yongbao'],
  ['😅', '尴尬', 'sweat awkward'],
  ['😢', '难过', 'sad cry'],
  ['😭', '大哭', 'cry tears'],
  ['😡', '生气', 'angry shengqi'],
  ['😴', '睡觉', 'sleep shuijiao'],
  ['🤯', '震惊', 'mind blown'],
  ['🥳', '庆祝', 'party celebrate'],
  ['🙏', '感谢', 'thanks pray ganxie'],
  ['👍', '赞', 'thumbs up good zan'],
  ['👎', '不赞同', 'thumbs down'],
  ['👏', '鼓掌', 'clap guzhang'],
  ['👋', '你好再见', 'wave hello bye'],
  ['👌', '好的', 'ok hao'],
  ['💪', '加油', 'muscle strong jiayou'],
  ['❤️', '红心', 'heart love hongxin'],
  ['💙', '蓝心', 'blue heart'],
  ['💚', '绿心', 'green heart'],
  ['💛', '黄心', 'yellow heart'],
  ['💜', '紫心', 'purple heart'],
  ['💔', '心碎', 'broken heart'],
  ['🔥', '火热', 'fire hot'],
  ['🎉', '庆祝彩带', 'party tada qingzhu'],
  ['🎂', '生日蛋糕', 'birthday cake'],
  ['🎁', '礼物', 'gift present'],
  ['🌟', '闪亮星星', 'star bright'],
  ['⭐', '星星', 'star xingxing'],
  ['✨', '闪光', 'sparkles'],
  ['💡', '灵感', 'idea light bulb'],
  ['📌', '图钉', 'pin tuding'],
  ['📎', '回形针', 'paperclip attachment'],
  ['📝', '笔记', 'note memo biji'],
  ['📅', '日历', 'calendar rili'],
  ['⏰', '闹钟', 'alarm clock'],
  ['☕', '咖啡', 'coffee kafei'],
  ['🍵', '茶', 'tea cha'],
  ['🍎', '苹果', 'apple pingguo'],
  ['🌈', '彩虹', 'rainbow caihong'],
  ['☀️', '太阳', 'sun sunny'],
  ['🌙', '月亮', 'moon night'],
  ['🐱', '猫', 'cat mao'],
  ['🐶', '狗', 'dog gou'],
  ['🚀', '火箭', 'rocket launch'],
  ['💻', '电脑', 'computer laptop'],
  ['✅', '完成', 'check done wancheng'],
  ['❌', '错误', 'cross wrong cuowu'],
  ['⚠️', '警告', 'warning jinggao'],
  ['❓', '问号', 'question wenhao'],
  ['➡️', '右箭头', 'right arrow'],
  ['←', '左箭头', 'left arrow zuo'],
  ['→', '右箭头符号', 'right arrow you'],
  ['↑', '上箭头', 'up arrow shang'],
  ['↓', '下箭头', 'down arrow xia'],
  ['✓', '对勾', 'check tick duigou'],
  ['×', '乘号', 'multiply cheng'],
  ['÷', '除号', 'divide chu'],
  ['±', '正负号', 'plus minus'],
  ['≠', '不等于', 'not equal'],
  ['≤', '小于等于', 'less equal'],
  ['≥', '大于等于', 'greater equal'],
  ['∞', '无穷', 'infinity wuqiong'],
  ['°', '度数', 'degree du'],
  ['℃', '摄氏度', 'celsius'],
  ['©', '版权', 'copyright'],
  ['®', '注册商标', 'registered'],
  ['™', '商标', 'trademark'],
  ['…', '省略号', 'ellipsis'],
  ['—', '破折号', 'dash'],
  ['·', '间隔号', 'middle dot'],
  ['⌘', 'Command 键', 'command cmd'],
  ['⌥', 'Option 键', 'option alt'],
  ['⇧', 'Shift 键', 'shift'],
  ['⌃', 'Control 键', 'control ctrl'],
  ['€', '欧元', 'euro'],
  ['£', '英镑', 'pound'],
  ['¥', '人民币日元', 'yen yuan'],
] as const;
const create: PluginFactory = async (ctx) => {
  let state = await ctx.storage.read<{ favorites: string[]; recent: string[] }>({
    favorites: [],
    recent: [],
  });
  const row = (item: readonly [string, string, string]): Row => ({
    id: item[0],
    name: qt(item[1]),
    icon: icons[item[0] as keyof typeof icons] as `data:image/png;base64,${string}`,
    keywords: `${item[0]} ${item[1]} ${qt(item[1])} ${item[2]}`,
    kind: state.favorites.includes(item[0]) ? qt('收藏') : qt('符号'),
    actions: [
      { id: 'paste', title: qt('粘贴'), data: item[0] },
      { id: 'copy', title: qt('复制'), data: item[0] },
      {
        id: 'favorite',
        title: state.favorites.includes(item[0]) ? qt('取消收藏') : qt('收藏'),
        data: item[0],
      },
    ],
  });
  const matches = (q: string) =>
    symbols.filter((x) =>
      `${x.join(' ')} ${qt(x[1])}`.toLocaleLowerCase().includes(q.trim().toLocaleLowerCase()),
    );
  return {
    search: (query) => (query.trim() ? matches(query).map(row) : []),
    resolve: (id) => {
      const item = symbols.find((x) => x[0] === id);
      return item ? row(item) : undefined;
    },
    view: (_id, query) => ({
      title: qt('Emoji 与符号'),
      notice: qt(
        '${0} 个常用 Emoji 与符号，支持中英文搜索；收藏和最近使用优先显示。',
        symbols.length,
      ),
      rows: query.trim()
        ? matches(query).map(row)
        : [...symbols]
            .sort((a, b) => {
              const score = (s: string) =>
                state.favorites.includes(s)
                  ? 100
                  : state.recent.includes(s)
                    ? 50 - state.recent.indexOf(s)
                    : 0;
              return score(b[0]) - score(a[0]);
            })
            .map(row),
    }),
    async run(action, data) {
      if (action === 'open') return { navigate: 'main' };
      if (typeof data !== 'string' || !symbols.some((x) => x[0] === data))
        throw Error(qt('符号不存在'));
      let next = state;
      if (action === 'favorite')
        next = {
          ...state,
          favorites: state.favorites.includes(data)
            ? state.favorites.filter((x) => x !== data)
            : [...state.favorites, data],
        };
      else if (action === 'copy' || action === 'paste') {
        await ctx.call(action === 'copy' ? 'clipboard.write' : 'paste', { text: data });
        next = { ...state, recent: [data, ...state.recent.filter((x) => x !== data)].slice(0, 24) };
      } else throw Error(qt('无效操作'));
      await ctx.storage.write(next);
      state = next;
      ctx.changed();
    },
  };
};
export default create;
