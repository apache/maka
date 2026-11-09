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
