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
  id: 'maka.clipboard-history',
  displayName: 'Clipboard History',
  description:
    'Type "cb" in the quick launcher to copy recent text, images, PDFs and files again on macOS. Kept in memory only, and password managers are skipped.',
  localizations: {
    'zh-CN': {
      displayName: '剪贴板历史',
      description:
        '在 macOS 的快捷启动器输入“剪贴板”或 cb，再次复制最近的文本、图片、PDF 和文件。仅保存在内存中，并跳过密码管理器的内容。',
    },
    'zh-TW': {
      displayName: '剪貼簿歷史',
      description:
        '在 macOS 的快速啟動器輸入「剪贴板」或 cb，再次複製最近的文字、圖片、PDF 和檔案。僅保存在記憶體中，並跳過密碼管理器的內容。',
    },
  },
  application: {
    ui: {
      module: 'ui.js',
      configuration: empty,
      imports: {},
      contributions: {
        tool: { kind: 'view', contract: 'maka.quick-launcher.tool' },
        history: {
          kind: 'settings',
          title: {
            fallback: 'Clipboard History',
            translations: { 'zh-CN': '剪贴板历史', 'zh-TW': '剪貼簿歷史' },
          },
        },
      },
    },
  },
};
