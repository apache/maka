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
  id: 'maka.calculator',
  displayName: 'Calculator',
  description: 'Calculate and convert units in the quick launcher, then copy the result.',
  localizations: {
    'zh-CN': {
      displayName: '计算器',
      description: '在快捷启动器里计算和换算单位，并复制结果。',
    },
    'zh-TW': {
      displayName: '計算機',
      description: '在快速啟動器裡計算和換算單位，並複製結果。',
    },
  },
  application: {
    ui: {
      module: 'ui.js',
      configuration: empty,
      imports: {},
      contributions: { tool: { kind: 'view', contract: 'maka.quick-launcher.tool' } },
    },
  },
};
