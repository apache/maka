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
  'Checking external agents…': [
    'Checking external agents…',
    '正在检查外部 Agent…',
    '正在檢查外部 Agent…',
  ],
  'Not installed': ['Not installed', '未安装', '未安裝'],
  'Error: {detail}': ['Error: {detail}', '错误：{detail}', '錯誤：{detail}'],
  '{count} models available': [
    '{count} models available',
    '{count} 个可用模型',
    '{count} 個可用模型',
  ],
  'Models unavailable': ['Models unavailable', '模型不可用', '模型無法使用'],
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
  'This agent belongs to another deployment and cannot be configured here.': [
    'This agent belongs to another deployment and cannot be configured here.',
    '此 Agent 属于其他部署，无法在此配置。',
    '此 Agent 屬於其他部署，無法在此設定。',
  ],
  'Enable {name}': ['Enable {name}', '启用 {name}', '啟用 {name}'],
  'Disable {name}': ['Disable {name}', '停用 {name}', '停用 {name}'],
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
  'This agent runs in its native full-access mode. It can read and write files, run commands and access the network outside the Maka sandbox.':
    [
      'This agent runs in its native full-access mode. It can read and write files, run commands and access the network outside the Maka sandbox.',
      '此 Agent 使用原生完全访问模式，可在 Maka 沙箱之外读写文件、运行命令和访问网络。',
      '此 Agent 使用原生完整存取模式，可在 Maka 沙箱之外讀寫檔案、執行命令及存取網路。',
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
} satisfies Catalog;
