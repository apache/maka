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
  id: 'maka.quick-library',
  displayName: 'Quick Library',
  description:
    'Snippets, notes and links you manage in Settings, one search away in the quick launcher.',
  localizations: {
    'zh-CN': {
      displayName: '快捷资料',
      description: '在设置里管理片段、笔记和链接，在快捷启动器里随时搜索。',
    },
    'zh-TW': {
      displayName: '快速資料',
      description: '在設定裡管理片段、筆記和連結，在快速啟動器裡隨時搜尋。',
    },
  },
  application: {
    ui: {
      module: 'ui.js',
      configuration: empty,
      imports: {},
      contributions: {
        links: { kind: 'view', contract: 'maka.quick-launcher.tool' },
        linksSettings: {
          kind: 'settings',
          title: {
            fallback: 'Quick Links',
            translations: { 'zh-CN': '快捷链接', 'zh-TW': '快速連結' },
          },
        },
        snippets: { kind: 'view', contract: 'maka.quick-launcher.tool' },
        snippetsSettings: {
          kind: 'settings',
          title: {
            fallback: 'Text Snippets',
            translations: { 'zh-CN': '文本片段', 'zh-TW': '文字片段' },
          },
        },
        notes: { kind: 'view', contract: 'maka.quick-launcher.tool' },
        notesSettings: {
          kind: 'settings',
          title: { fallback: 'Notes', translations: { 'zh-CN': '笔记', 'zh-TW': '筆記' } },
        },
      },
    },
  },
};
