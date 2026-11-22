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
  id: 'maka.symbols',
  displayName: 'Symbols',
  description: 'Type "sym" and a name in the quick launcher to copy an emoji or symbol.',
  localizations: {
    'zh-CN': {
      displayName: '符号',
      description: '在快捷启动器输入“符号”或 sym 加名称，复制表情和符号。',
    },
    'zh-TW': {
      displayName: '符號',
      description: '在快速啟動器輸入「符号」或 sym 加名稱，複製表情和符號。',
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
