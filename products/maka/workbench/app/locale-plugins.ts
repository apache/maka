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

import type { Catalog } from '../../../../plugins/shared/locale.js';

export const pluginMessages = {
  'Plugin services are not ready.': [
    'Plugin services are not ready.',
    '插件服务尚未就绪。',
    '外掛服務尚未就緒。',
  ],
  'The interface update could not be completed.': [
    'The interface update could not be completed.',
    '界面更新尚未完成。',
    '介面更新尚未完成。',
  ],
  'Close panel': ['Close panel', '关闭面板', '關閉面板'],
  'Plugin was disabled or replaced.': [
    'Plugin was disabled or replaced.',
    '插件已被禁用或替换。',
    '外掛已被停用或取代。',
  ],
  'Multiple plugins render the same tool presentation: {presentation}': [
    'Multiple plugins render the same tool presentation: {presentation}',
    '多个插件提供了相同的工具展示：{presentation}',
    '多個外掛提供了相同的工具呈現：{presentation}',
  ],
  'Unknown plugin panel: {panel}': [
    'Unknown plugin panel: {panel}',
    '找不到插件面板：{panel}',
    '找不到外掛面板：{panel}',
  ],
  'UI module must export activate(context).': [
    'UI module must export activate(context).',
    'UI 模块必须导出 activate(context)。',
    'UI 模組必須匯出 activate(context)。',
  ],
  'UI activate(context) must return its declared contributions.': [
    'UI activate(context) must return its declared contributions.',
    'UI activate(context) 必须返回已声明的扩展。',
    'UI activate(context) 必須回傳已宣告的擴充。',
  ],
  'Plugin contribution does not match its declaration: {contribution}': [
    'Plugin contribution does not match its declaration: {contribution}',
    '插件扩展与声明不一致：{contribution}',
    '外掛擴充與宣告不一致：{contribution}',
  ],
  'Plugin returned an undeclared contribution: {contribution}': [
    'Plugin returned an undeclared contribution: {contribution}',
    '插件返回了未声明的扩展：{contribution}',
    '外掛回傳了未宣告的擴充：{contribution}',
  ],
} satisfies Catalog;
