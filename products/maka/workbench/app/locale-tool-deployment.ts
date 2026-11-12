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

export const deploymentToolMessages = {
  'Inspect plugin deployment': ['Inspect plugin deployment', '查看插件部署', '查看外掛部署'],
  'Inspect interface plugins': ['Inspect interface plugins', '查看界面插件', '查看介面外掛'],
  'List plugin instances': ['List plugin instances', '列出插件实例', '列出外掛執行個體'],
  'Read deployment configuration': [
    'Read deployment configuration',
    '读取部署配置',
    '讀取部署設定',
  ],
  'Read plugin source': ['Read plugin source', '读取插件源码', '讀取外掛原始碼'],
  'Install plugin from source': [
    'Install plugin from source',
    '从源码安装插件',
    '從原始碼安裝外掛',
  ],
  'Install plugin from URL': ['Install plugin from URL', '从网址安装插件', '從網址安裝外掛'],
  'Edit plugin deployment': ['Edit plugin deployment', '编辑插件部署', '編輯外掛部署'],
  'Change plugin availability': ['Change plugin availability', '启用或停用插件', '啟用或停用外掛'],
  'Inspect plugin settings': ['Inspect plugin settings', '查看插件设置', '查看外掛設定'],
  'Update plugin settings': ['Update plugin settings', '更新插件设置', '更新外掛設定'],
  'Find compatible plugins': ['Find compatible plugins', '查找兼容插件', '尋找相容外掛'],
  'Inspect package settings': ['Inspect package settings', '查看软件包设置', '查看套件設定'],
  'Replace plugin deployment': ['Replace plugin deployment', '替换插件部署', '取代外掛部署'],
  'Available packages': ['Available packages', '可用软件包', '可用套件'],
  'Base composition': ['Base composition', '基础组合', '基礎組合'],
  'Root plugins': ['Root plugins', '顶层插件', '頂層外掛'],
  'Interface plugins': ['Interface plugins', '界面插件', '介面外掛'],
  'Selected interface': ['Selected interface', '当前界面', '目前介面'],
  'Plugin instances': ['Plugin instances', '插件实例', '外掛執行個體'],
  'No packages available': ['No packages available', '没有可用软件包', '沒有可用套件'],
  'No interface plugins': ['No interface plugins', '没有界面插件', '沒有介面外掛'],
  'No plugin instances on this page': [
    'No plugin instances on this page',
    '这页没有插件实例',
    '這一頁沒有外掛執行個體',
  ],
  'Configuration excerpt': ['Configuration excerpt', '配置片段', '設定片段'],
  'Bytes {first}–{last} of {total}': [
    'Bytes {first}–{last} of {total}',
    '第 {first}–{last} 字节，共 {total} 字节',
    '第 {first}–{last} 位元組，共 {total} 位元組',
  ],
  'Empty configuration': ['Empty configuration', '配置为空', '設定為空'],
  'More pages available': ['More pages available', '还有后续页', '還有後續頁'],
  'More source available': ['More source available', '还有后续源码', '還有後續原始碼'],
  'Plugin source excerpt': ['Plugin source excerpt', '插件源码片段', '外掛原始碼片段'],
  'No files in this package': ['No files in this package', '软件包里没有文件', '套件中沒有檔案'],
  'Download location': ['Download location', '下载地址', '下載位置'],
  'Plugin package installed': ['Plugin package installed', '已安装插件包', '已安裝外掛套件'],
  'Deployment change saved': ['Deployment change saved', '已保存部署更改', '已儲存部署變更'],
  'The deployment changed before this edit could be saved.': [
    'The deployment changed before this edit could be saved.',
    '部署已发生变化，这次编辑未保存。',
    '部署已發生變更，這次編輯未儲存。',
  ],
  'The plugin bundle is invalid.': [
    'The plugin bundle is invalid.',
    '插件包无效。',
    '外掛套件無效。',
  ],
  'The plugin bundle could not be downloaded.': [
    'The plugin bundle could not be downloaded.',
    '无法下载插件包。',
    '無法下載外掛套件。',
  ],
  'The deployment document is invalid.': [
    'The deployment document is invalid.',
    '部署文档无效。',
    '部署文件無效。',
  ],
  'The selected deployment source is invalid.': [
    'The selected deployment source is invalid.',
    '所选的部署来源无效。',
    '所選的部署來源無效。',
  ],
  'The selected package is unavailable.': [
    'The selected package is unavailable.',
    '所选的软件包不可用。',
    '所選的套件無法使用。',
  ],
  'The selected plugin instance is unavailable.': [
    'The selected plugin instance is unavailable.',
    '所选的插件实例不可用。',
    '所選的外掛執行個體無法使用。',
  ],
  'Enable the parent plugin first.': [
    'Enable the parent plugin first.',
    '请先启用上级插件。',
    '請先啟用上層外掛。',
  ],
  'Deployment change rejected': ['Deployment change rejected', '部署更改被拒绝', '部署變更遭拒'],
  'Deployment conflict': ['Deployment conflict', '部署更改冲突', '部署變更衝突'],
  'Add {name}': ['Add {name}', '添加 {name}', '新增 {name}'],
  'Update {name}': ['Update {name}', '更新 {name}', '更新 {name}'],
  'Enable plugin': ['Enable plugin', '启用插件', '啟用外掛'],
  'Disable plugin': ['Disable plugin', '停用插件', '停用外掛'],
  'Requested change': ['Requested change', '请求的更改', '要求的變更'],
  'Requested changes': ['Requested changes', '请求的更改', '要求的變更'],
  'Settings to update': ['Settings to update', '要更新的设置', '要更新的設定'],
  'No settings on this page': ['No settings on this page', '这页没有设置', '這一頁沒有設定'],
  'Has a value': ['Has a value', '已设置', '已設定'],
  'Compatible plugins': ['Compatible plugins', '兼容的插件', '相容的外掛'],
  'No compatible plugins on this page': [
    'No compatible plugins on this page',
    '这页没有兼容的插件',
    '這一頁沒有相容的外掛',
  ],
  'Requested connection': ['Requested connection', '请求的连接', '要求的連線'],
  'Plugin connections': ['Plugin connections', '插件连接', '外掛連線'],
  'Included packages': ['Included packages', '包含的软件包', '包含的套件'],
  '{count} more': ['{count} more', '另有 {count} 项', '另有 {count} 項'],
} satisfies Catalog;
