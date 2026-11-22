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
  id: 'maka.dictation',
  displayName: 'Dictation',
  description: 'Speak into Quick Tools to search or ask a question on macOS.',
  localizations: {
    'zh-CN': {
      displayName: '语音听写',
      description: '在 macOS 快捷面板中说话，输入搜索词或问题。',
    },
    'zh-TW': {
      displayName: '語音聽寫',
      description: '在 macOS 快捷面板中說話，輸入搜尋詞或問題。',
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
            fallback: 'Dictation',
            translations: { 'zh-CN': '语音听写', 'zh-TW': '語音聽寫' },
          },
        },
      },
    },
  },
};
