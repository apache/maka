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

export const configurationMessages = {
  Global: ['Global', '全局', '全域'],
  'Choose project…': ['Choose project…', '选择项目…', '選擇專案…'],
  'Search skills': ['Search skills', '搜索技能', '搜尋技能'],
  'Add skills': ['Add skills', '添加技能', '新增技能'],
  'Delete skill directory?': ['Delete skill directory?', '删除此技能目录？', '刪除此技能目錄？'],
  'Invalid skill': ['Invalid skill', '无效技能', '無效技能'],
  Overridden: ['Overridden', '已被覆盖', '已被覆寫'],
  Effective: ['Effective', '当前生效', '目前生效'],
  'Skill details': ['Skill details', '技能详情', '技能詳細資訊'],
  'No skills found.': ['No skills found.', '未找到技能。', '找不到技能。'],
  'Skill source': ['Skill source', '技能来源', '技能來源'],
  'Discover skills': ['Discover skills', '发现技能', '探索技能'],
  'Select skills to install': ['Select skills to install', '选择要安装的技能', '選擇要安裝的技能'],
  'No valid SKILL.md found in this source.': [
    'No valid SKILL.md found in this source.',
    '此来源中未找到有效的 SKILL.md。',
    '此來源中找不到有效的 SKILL.md。',
  ],
  'Install location': ['Install location', '安装位置', '安裝位置'],
  'Install selected skills': ['Install selected skills', '安装所选技能', '安裝所選技能'],
  'Overridden by {reference}': [
    'Overridden by {reference}',
    '被 {reference} 覆盖',
    '被 {reference} 覆寫',
  ],
  'Skill updated.': ['Skill updated.', '技能已更新。', '技能已更新。'],
  'Skill deleted.': ['Skill deleted.', '技能已删除。', '技能已刪除。'],
  'Search MCP servers': ['Search MCP servers', '搜索 MCP 服务器', '搜尋 MCP 伺服器'],
  'Add MCP server': ['Add MCP server', '添加 MCP 服务器', '新增 MCP 伺服器'],
  'Delete MCP server {name}?': [
    'Delete MCP server {name}?',
    '删除 MCP 服务器 {name}？',
    '刪除 MCP 伺服器 {name}？',
  ],
  'Edit MCP server': ['Edit MCP server', '编辑 MCP 服务器', '編輯 MCP 伺服器'],
  'No MCP servers found.': ['No MCP servers found.', '未找到 MCP 服务器。', '找不到 MCP 伺服器。'],
  'Configuration location': ['Configuration location', '配置位置', '設定位置'],
  'Server name': ['Server name', '服务器名称', '伺服器名稱'],
  'Local command': ['Local command', '本地命令', '本機命令'],
  Arguments: ['Arguments', '参数', '引數'],
  Argument: ['Argument', '参数', '引數'],
  'Remove argument': ['Remove argument', '移除此参数', '移除此引數'],
  'Add argument': ['Add argument', '添加参数', '新增引數'],
  'Server URL': ['Server URL', '服务器 URL', '伺服器 URL'],
  'Advanced options': ['Advanced options', '高级选项', '進階選項'],
  'Forward Host environment variables (one per line)': [
    'Forward Host environment variables (one per line)',
    '传递 Host 环境变量（每行一个名称）',
    '傳遞 Host 環境變數（每行一個名稱）',
  ],
  'Headers from Host environment variables': [
    'Headers from Host environment variables',
    '从 Host 环境变量读取请求头',
    '從 Host 環境變數讀取標頭',
  ],
  'Save MCP server': ['Save MCP server', '保存 MCP 服务器', '儲存 MCP 伺服器'],
  'MCP server saved.': ['MCP server saved.', 'MCP 服务器已保存。', 'MCP 伺服器已儲存。'],
  'MCP server deleted.': ['MCP server deleted.', 'MCP 服务器已删除。', 'MCP 伺服器已刪除。'],
  'Remove row': ['Remove row', '移除此行', '移除此列'],
  'Add row': ['Add row', '添加一行', '新增一列'],
  'Environment and header names must be nonempty and unique.': [
    'Environment and header names must be nonempty and unique.',
    '环境变量和请求头的名称不能为空或重复。',
    '環境變數與標頭的名稱不能為空白或重複。',
  ],
  'A server with this name already exists at this location.': [
    'A server with this name already exists at this location.',
    '此位置已存在同名服务器。',
    '此位置已有同名伺服器。',
  ],
  'MCP servers': ['MCP servers', 'MCP 服务器', 'MCP 伺服器'],
  Name: ['Name', '名称', '名稱'],
  Value: ['Value', '值', '值'],
  Refresh: ['Refresh', '刷新', '重新整理'],
  Delete: ['Delete', '删除', '刪除'],
  Command: ['Command', '命令', '命令'],
  'Built-in': ['Built-in', '内置', '內建'],
  'Previous page': ['Previous page', '上一页', '上一頁'],
  'Next page': ['Next page', '下一页', '下一頁'],
  'Project: {name}': ['Project: {name}', '项目：{name}', '專案：{name}'],
  'Update skill {name} at {path}': [
    'Update skill {name} at {path}',
    '更新 {path} 中的技能 {name}',
    '更新 {path} 中的技能 {name}',
  ],
  'Delete skill {name} at {path}': [
    'Delete skill {name} at {path}',
    '删除 {path} 中的技能 {name}',
    '刪除 {path} 中的技能 {name}',
  ],
  'Details for skill {name} at {path}': [
    'Details for skill {name} at {path}',
    '查看 {path} 中的技能 {name}',
    '檢視 {path} 中的技能 {name}',
  ],
  'Edit MCP server {name} at {path}': [
    'Edit MCP server {name} at {path}',
    '编辑 {path} 中的 MCP 服务器 {name}',
    '編輯 {path} 中的 MCP 伺服器 {name}',
  ],
  'Delete MCP server {name} at {path}': [
    'Delete MCP server {name} at {path}',
    '删除 {path} 中的 MCP 服务器 {name}',
    '刪除 {path} 中的 MCP 伺服器 {name}',
  ],
  Details: ['Details', '详情', '詳細資訊'],
  Edit: ['Edit', '编辑', '編輯'],
} as const satisfies Catalog;
