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

import { empty } from '../../shared/package.js';

export default {
  schemaVersion: 1,
  id: 'maka.screenshot',
  displayName: 'Screenshot',
  description: 'Capture a screen region to the clipboard from the quick launcher on macOS.',
  localizations: {
    'zh-CN': {
      displayName: '截图',
      description: '在 macOS 的快捷启动器里截取屏幕区域并复制到剪贴板。',
    },
    'zh-TW': {
      displayName: '截圖',
      description: '在 macOS 的快速啟動器裡擷取螢幕區域並複製到剪貼簿。',
    },
  },
  application: {
    ui: {
      module: 'ui.js',
      configuration: empty,
      imports: {},
      contributions: {
        tool: { kind: 'view', contract: 'maka.quick-launcher.tool' },
        preferences: {
          kind: 'settings',
          title: {
            fallback: 'Screenshot',
            translations: { 'zh-CN': '截图', 'zh-TW': '截圖' },
          },
        },
      },
    },
  },
};
