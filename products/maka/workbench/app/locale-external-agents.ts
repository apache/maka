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

export const externalAgentMessages = {
  'External agents': ['External agents', '外部 Agent', '外部 Agent'],
  'External agent runtimes': [
    'External agent runtimes',
    '外部 Agent 运行环境',
    '外部 Agent 執行環境',
  ],
  'Manage external agents': ['Manage external agents', '管理外部 Agent', '管理外部 Agent'],
  'Enable external agents in Settings to use their models.': [
    'Enable external agents in Settings to use their models.',
    '在设置中启用外部 Agent 以使用其模型。',
    '在設定中啟用外部 Agent 以使用其模型。',
  ],
  'Installed ({version})': ['Installed ({version})', '已安装（{version}）', '已安裝（{version}）'],
  Installed: ['Installed', '已安装', '已安裝'],
  'Not installed': ['Not installed', '未安装', '未安裝'],
  'Unsupported: {detail}': ['Unsupported: {detail}', '不支持：{detail}', '不支援：{detail}'],
  'Error: {detail}': ['Error: {detail}', '错误：{detail}', '錯誤：{detail}'],
  'Signed in ({source})': ['Signed in ({source})', '已登录（{source}）', '已登入（{source}）'],
  'Not signed in ({source})': [
    'Not signed in ({source})',
    '未登录（{source}）',
    '未登入（{source}）',
  ],
  'Authentication status is not supported': [
    'Authentication status is not supported',
    '不支持查询登录状态',
    '不支援查詢登入狀態',
  ],
  'Authentication status unknown': [
    'Authentication status unknown',
    '登录状态未知',
    '登入狀態未知',
  ],
  '{count} models available': [
    '{count} models available',
    '{count} 个可用模型',
    '{count} 個可用模型',
  ],
  'Sign in to discover models': ['Sign in to discover models', '登录后发现模型', '登入後探索模型'],
  'Models unavailable': ['Models unavailable', '模型不可用', '模型無法使用'],
  'Refresh external agents': ['Refresh external agents', '刷新外部 Agent', '重新整理外部 Agent'],
  'Checking external agents…': [
    'Checking external agents…',
    '正在检查外部 Agent…',
    '正在檢查外部 Agent…',
  ],
  'External agents enabled': ['External agents enabled', '外部 Agent 已启用', '外部 Agent 已啟用'],
  'External agents disabled': [
    'External agents disabled',
    '外部 Agent 已禁用',
    '外部 Agent 已停用',
  ],
  'External agents are enabled for some targets': [
    'External agents are enabled for some targets',
    '部分目标已启用外部 Agent',
    '部分目標已啟用外部 Agent',
  ],
  'Target {target}: {status}': [
    'Target {target}: {status}',
    '目标 {target}：{status}',
    '目標 {target}：{status}',
  ],
  'Enable external agents': ['Enable external agents', '启用外部 Agent', '啟用外部 Agent'],
  'Disable external agents': ['Disable external agents', '禁用外部 Agent', '停用外部 Agent'],
  'Disabling does not uninstall agents or sign out. Maka still settles executions already running.':
    [
      'Disabling does not uninstall agents or sign out. Maka still settles executions already running.',
      '禁用不会卸载 Agent 或退出登录。已经开始的执行仍由 Maka 负责收尾。',
      '停用不會解除安裝 Agent 或登出。已經開始的執行仍由 Maka 負責收尾。',
    ],
  'External agents use their own default permissions, native tools and existing accounts. They can read and write files, run commands and access the network outside the Maka session sandbox.':
    [
      'External agents use their own default permissions, native tools and existing accounts. They can read and write files, run commands and access the network outside the Maka session sandbox.',
      '外部 Agent 使用自身的默认权限、原生工具和已有账号。它们可以在 Maka 会话沙箱之外读写文件、运行命令和访问网络。',
      '外部 Agent 使用自身的預設權限、原生工具和既有帳號。它們可以在 Maka 對話沙箱之外讀寫檔案、執行命令和存取網路。',
    ],
  'This does not expand permissions for ordinary plugins, Code Mode or Computer Use.': [
    'This does not expand permissions for ordinary plugins, Code Mode or Computer Use.',
    '这不会扩大普通插件、Code Mode 或 Computer Use 的权限。',
    '這不會擴大一般外掛、Code Mode 或 Computer Use 的權限。',
  ],
  'I understand and accept the external agent permissions': [
    'I understand and accept the external agent permissions',
    '我理解并接受外部 Agent 的权限',
    '我理解並接受外部 Agent 的權限',
  ],
  'Confirm permissions and enable': [
    'Confirm permissions and enable',
    '确认权限并启用',
    '確認權限並啟用',
  ],
  'Cancel enabling external agents': [
    'Cancel enabling external agents',
    '取消启用外部 Agent',
    '取消啟用外部 Agent',
  ],
  'External agents are disabled for the active settings Agent.': [
    'External agents are disabled for the active settings Agent.',
    '当前设置 Agent 的外部 Agent 功能已禁用。',
    '目前設定 Agent 的外部 Agent 功能已停用。',
  ],
  'Choose a workspace before checking external agents.': [
    'Choose a workspace before checking external agents.',
    '请先选择工作区，再检查外部 Agent。',
    '請先選擇工作區，再檢查外部 Agent。',
  ],
  'Runtime status is checked in the active settings Agent workspace; other scopes may differ.': [
    'Runtime status is checked in the active settings Agent workspace; other scopes may differ.',
    '运行时状态来自当前设置 Agent 的工作区；其他作用域的状态可能不同。',
    '執行環境狀態來自目前設定 Agent 的工作區；其他範圍的狀態可能不同。',
  ],
  'Sign in using the agent’s native login, then Refresh. Maka does not manage these credentials.': [
    'Sign in using the agent’s native login, then Refresh. Maka does not manage these credentials.',
    '请使用 Agent 原生登录方式登录，然后刷新。Maka 不管理这些凭据。',
    '請使用 Agent 原生登入方式登入，然後重新整理。Maka 不管理這些憑證。',
  ],
  'Installation: {status}': ['Installation: {status}', '安装状态：{status}', '安裝狀態：{status}'],
  'Authentication: {status}': [
    'Authentication: {status}',
    '登录状态：{status}',
    '登入狀態：{status}',
  ],
  'Select {name} installation line {line}': [
    'Select {name} installation line {line}',
    '选择 {name} 安装版本线 {line}',
    '選擇 {name} 安裝版本線 {line}',
  ],
  'View installation plan for {name}': [
    'View installation plan for {name}',
    '查看 {name} 的安装计划',
    '檢視 {name} 的安裝計畫',
  ],
  'View installation plan': ['View installation plan', '查看安装计划', '檢視安裝計畫'],
  'Installation plan for {name}': [
    'Installation plan for {name}',
    '{name} 的安装计划',
    '{name} 的安裝計畫',
  ],
  'Installation source: {source}': [
    'Installation source: {source}',
    '安装来源：{source}',
    '安裝來源：{source}',
  ],
  'Network access: yes. Elevated privileges: no. Installation changes files on this machine.': [
    'Network access: yes. Elevated privileges: no. Installation changes files on this machine.',
    '网络访问：是。提升权限：否。安装会修改本机文件。',
    '網路存取：是。提升權限：否。安裝會修改本機檔案。',
  ],
  'Install {name}': ['Install {name}', '安装 {name}', '安裝 {name}'],
  Install: ['Install', '安装', '安裝'],
  'Cancel external agent installation': [
    'Cancel external agent installation',
    '取消安装外部 Agent',
    '取消安裝外部 Agent',
  ],
  'Invalid external agent installation plan.': [
    'Invalid external agent installation plan.',
    '外部 Agent 安装计划无效。',
    '外部 Agent 安裝計畫無效。',
  ],
  'No external agent configuration targets are bound.': [
    'No external agent configuration targets are bound.',
    '未绑定外部 Agent 配置目标。',
    '未繫結外部 Agent 設定目標。',
  ],
  'External agent installation failed. Refresh to check its status.': [
    'External agent installation failed. Refresh to check its status.',
    '外部 Agent 安装失败。请刷新以检查状态。',
    '外部 Agent 安裝失敗。請重新整理以檢查狀態。',
  ],
  'External agent installation returned an unknown result. Refresh to check its status.': [
    'External agent installation returned an unknown result. Refresh to check its status.',
    '外部 Agent 安装返回未知结果。请刷新以检查状态。',
    '外部 Agent 安裝傳回未知結果。請重新整理以檢查狀態。',
  ],
  'This agent belongs to another deployment and cannot be configured here.': [
    'This agent belongs to another deployment and cannot be configured here.',
    '此 Agent 属于其他部署，无法在此配置。',
    '此 Agent 屬於其他部署，無法在此設定。',
  ],
} satisfies Catalog;
