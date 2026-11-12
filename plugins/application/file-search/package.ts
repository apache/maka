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
  id: 'maka.file-search',
  displayName: 'File Search',
  description:
    'Type "f" and a name in the quick launcher to find files in your home folder on macOS.',
  localizations: {
    'zh-CN': {
      displayName: '文件搜索',
      description: '在 macOS 的快捷启动器输入“文件”或 f 加名称，查找主目录下的文件。',
    },
    'zh-TW': {
      displayName: '檔案搜尋',
      description: '在 macOS 的快速啟動器輸入「文件」或 f 加名稱，尋找家目錄下的檔案。',
    },
  },
  application: {
    ui: {
      module: 'ui.js',
      configuration: empty,
      imports: {},
      contributions: {
        tool: { kind: 'view', contract: 'maka.quick-launcher.tool' },
      },
    },
  },
};
