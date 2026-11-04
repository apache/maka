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
  'Sign in using the agent’s native login, then Refresh. Maka does not manage these credentials.': [
    'Sign in using the agent’s native login, then Refresh. Maka does not manage these credentials.',
    '请使用 Agent 原生登录方式登录，然后刷新。Maka 不管理这些凭据。',
    '請使用 Agent 原生登入方式登入，然後重新整理。Maka 不管理這些憑證。',
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
  'Enable {name}': ['Enable {name}', '启用 {name}', '啟用 {name}'],
  'Disable {name}': ['Disable {name}', '停用 {name}', '停用 {name}'],
  'Show {name} details': ['Show {name} details', '显示 {name} 详情', '顯示 {name} 詳細資訊'],
  'Hide {name} details': ['Hide {name} details', '收起 {name} 详情', '收合 {name} 詳細資訊'],
  'Hide details': ['Hide details', '收起详情', '收合詳細資訊'],
  'Not supported on this device': [
    'Not supported on this device',
    '此设备暂不支持',
    '此裝置暫不支援',
  ],
  'Could not check installation': [
    'Could not check installation',
    '暂时无法检查安装状态',
    '暫時無法檢查安裝狀態',
  ],
  'Sign in required': ['Sign in required', '需要登录', '需要登入'],
  'Could not verify sign-in': [
    'Could not verify sign-in',
    '暂时无法确认登录状态',
    '暫時無法確認登入狀態',
  ],
  'Choose a workspace to check status': [
    'Choose a workspace to check status',
    '选择工作区后可检查状态',
    '選擇工作區後可檢查狀態',
  ],
  'Status unavailable': ['Status unavailable', '暂时无法获取状态', '暫時無法取得狀態'],
  'Show external agent error details': [
    'Show external agent error details',
    '显示外部 Agent 错误详情',
    '顯示外部 Agent 錯誤詳細資訊',
  ],
  'This agent uses its own permissions, tools and accounts. It can read and write files, run commands and access the network outside the Maka sandbox.':
    [
      'This agent uses its own permissions, tools and accounts. It can read and write files, run commands and access the network outside the Maka sandbox.',
      '此 Agent 使用自身权限、工具和账号，可在 Maka 沙箱之外读写文件、运行命令和访问网络。',
      '此 Agent 使用自身權限、工具和帳號，可在 Maka 沙箱之外讀寫檔案、執行命令和存取網路。',
    ],
  'Other Maka permissions stay unchanged.': [
    'Other Maka permissions stay unchanged.',
    '不会改变 Maka 中其他功能的权限。',
    '不會改變 Maka 中其他功能的權限。',
  ],
  'I understand and accept these permissions': [
    'I understand and accept these permissions',
    '我理解并接受这些权限',
    '我理解並接受這些權限',
  ],
  'Automatic installation is not supported in Maka.': [
    'Automatic installation is not supported in Maka.',
    '暂不支持在 Maka 中自动安装。',
    '暫不支援在 Maka 中自動安裝。',
  ],
  'Open Antigravity installation guide': [
    'Open Antigravity installation guide',
    '打开 Antigravity 安装说明',
    '開啟 Antigravity 安裝說明',
  ],
  'Official installation guide': ['Official installation guide', '官方安装说明', '官方安裝說明'],
  'OAR links to an editor installation guide. The installed agent server must still be discoverable through PATH or OAR_ANTIGRAVITY_BIN.':
    [
      'OAR links to an editor installation guide. The installed agent server must still be discoverable through PATH or OAR_ANTIGRAVITY_BIN.',
      'OAR 提供编辑器安装说明；已安装的 Agent 服务程序仍须能被 OAR 找到（PATH 或 OAR_ANTIGRAVITY_BIN）。',
      'OAR 提供編輯器安裝說明；已安裝的 Agent 服務程式仍須能被 OAR 找到（PATH 或 OAR_ANTIGRAVITY_BIN）。',
    ],
  'Installation options for {name}': [
    'Installation options for {name}',
    '{name} 的安装方式',
    '{name} 的安裝方式',
  ],
  'Could not check external agents. Open details or refresh.': [
    'Could not check external agents. Open details or refresh.',
    '暂时无法检查外部 Agent。请查看详情或刷新。',
    '暫時無法檢查外部 Agent。請檢視詳細資訊或重新整理。',
  ],
  'Could not update external agents. Open details or refresh.': [
    'Could not update external agents. Open details or refresh.',
    '未能更新外部 Agent。请查看详情或刷新。',
    '未能更新外部 Agent。請檢視詳細資訊或重新整理。',
  ],
  'Could not open the installation guide.': [
    'Could not open the installation guide.',
    '未能打开安装说明。',
    '未能開啟安裝說明。',
  ],
} satisfies Catalog;
