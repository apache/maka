/* Licensed under the Apache License, Version 2.0. See LICENSE. */
import { qt } from '../../shared/i18n.js';
import type { PluginFactory } from '../../shared/plugin.js';
const create: PluginFactory = (context) => ({
  search(query) {
    const text = query.trim();
    return text
      ? [
          {
            id: 'send',
            name: qt('在个人助手中起草：${0}', text),
            kind: qt('对话'),
            icon: 'star',
            persistable: false,
            actions: [{ id: 'send', title: qt('打开并填写草稿'), data: text }],
          },
        ]
      : [];
  },
  async run(action, data) {
    if (action === 'open') await context.call('assistant.open', {});
    else if (action === 'send' && typeof data === 'string' && data.trim())
      await context.call('assistant.open', { text: data.trim() });
    else throw Error(qt('无效的个人助手操作'));
  },
});
export default create;
