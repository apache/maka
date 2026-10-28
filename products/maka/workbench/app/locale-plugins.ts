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
  'This deployment has no root UI selected.': [
    'This deployment has no root UI selected.',
    '当前部署没有选择根界面。',
    '目前部署尚未選擇根介面。',
  ],
  'The selected root UI does not handle panels.': [
    'The selected root UI does not handle panels.',
    '当前根界面没有提供面板展示。',
    '目前根介面未提供面板呈現。',
  ],
  Interface: ['Interface', '界面', '介面'],
  'Choose interface': ['Choose interface', '选择界面', '選擇介面'],
  'Search interfaces': ['Search interfaces', '搜索界面', '搜尋介面'],
  'Search interfaces…': ['Search interfaces…', '搜索界面…', '搜尋介面…'],
  'No matching interfaces.': ['No matching interfaces.', '没有匹配的界面。', '沒有符合的介面。'],
  'Use interface {name}': ['Use interface {name}', '使用界面 {name}', '使用介面 {name}'],
  'Interface selected.': ['Interface selected.', '已选择界面。', '已選擇介面。'],
  'Check interface changes': ['Check interface changes', '检查界面更改', '檢查介面變更'],
  'Abandon unconfirmed interface change': [
    'Abandon unconfirmed interface change',
    '放弃未确认的界面更改',
    '放棄未確認的介面變更',
  ],
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
  'Unknown UI view: {view}': [
    'Unknown UI view: {view}',
    '找不到界面视图：{view}',
    '找不到介面檢視：{view}',
  ],
  'UI contribution is not an embedded view: {view}': [
    'UI contribution is not an embedded view: {view}',
    '界面扩展不是嵌入视图：{view}',
    '介面擴充不是嵌入檢視：{view}',
  ],
  'UI view {view} does not implement contract {contract}.': [
    'UI view {view} does not implement contract {contract}.',
    '界面视图 {view} 未实现契约 {contract}。',
    '介面檢視 {view} 未實作契約 {contract}。',
  ],
  'UI module must export activate(context).': [
    'UI module must export activate(context).',
    'UI 模块必须导出 activate(context)。',
    'UI 模組必須匯出 activate(context)。',
  ],
  'UI activate(context) must return an activation.': [
    'UI activate(context) must return an activation.',
    'UI activate(context) 必须返回激活结果。',
    'UI activate(context) 必須回傳啟用結果。',
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
