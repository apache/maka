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

import type { ClientLocale } from '@maka-agent/plugin-sdk/client';

const en = {
  title: 'External agents',
  description:
    'Configure agents that speak ACP over standard input and output. Paths refer to the machine running this Host. Saving configuration does not verify installation or connectivity.',
  refresh: 'Refresh',
  working: 'Working…',
  empty: 'No external agents configured.',
  add: 'Add agent',
  remove: 'Remove agent',
  agent: 'Agent',
  id: 'Agent ID',
  displayName: 'Display name',
  executable: 'Executable file (absolute path on Host)',
  args: 'Arguments (JSON array of strings)',
  env: 'Non-secret environment variables (optional JSON object of strings)',
  save: 'Save configuration',
  saved: 'Configuration saved.',
  invalidArgs: 'Arguments must be a JSON array containing only strings.',
  invalidEnv: 'Environment variables must be a JSON object containing only string values.',
  refreshed: 'The latest saved configuration has been reloaded. Check it before saving again.',
  refreshFailed: 'Could not reload the saved configuration. Refresh before saving again.',
  setupTitle: 'Check and sign in',
  setupDescription:
    'These actions use the saved configuration and start the agent on the Host. Save edits first. A successful check confirms ACP compatibility; it does not confirm account access.',
  check: 'Check saved agent',
  checking: 'Checking ACP connection…',
  checked: 'ACP connection verified.',
  authenticate: 'Sign in',
  authenticating: 'Waiting for agent authentication…',
  authenticated: 'The agent reported successful authentication.',
  cancelling: 'Cancelling…',
  cancelled: 'Request cancelled.',
  failed: 'Setup failed.',
  cancel: 'Cancel',
  openAuthorization: 'Open sign-in link',
  noAuthMethods: 'The agent did not offer a sign-in method.',
  unsupportedAuth:
    'This authentication method requires an unsupported flow. Use the agent’s own setup instructions.',
  invalidAuthUrl:
    'The agent provided an invalid sign-in link; only HTTPS links without embedded credentials are supported.',
  incompleteSetup: 'The agent connection ended before setup completed.',
  activationError: 'Saved configuration could not be fully activated',
  retryActivation: 'Retry activation',
  installTitle: 'Install Antigravity',
  installDescription:
    'Install Antigravity on the Host, then add it to the configuration draft. Review and save the draft to enable the agent.',
  installAntigravity: 'Install Antigravity',
  installing: 'Installing Antigravity…',
  installed: 'Installation completed. Configuration has not been saved.',
  incompleteInstall: 'Installation ended without reporting an installed agent.',
  addInstalled: 'Add installed agent to draft',
  replaceInstalled: 'Replace matching draft entry',
  replaceInstalledDescription:
    'The draft already contains this agent ID. Replacing it changes that entry’s name, executable, arguments, and environment variables.',
  installedDraft: 'Installed agent added to the draft. Review and save the configuration.',
};

export const copy = {
  en,
  'zh-CN': {
    title: '外部 Agent',
    description:
      '配置通过标准输入和输出使用 ACP 的 Agent。路径指向运行此 Host 的机器。保存配置不会验证安装或连接状态。',
    refresh: '刷新',
    working: '处理中…',
    empty: '尚未配置外部 Agent。',
    add: '添加 Agent',
    remove: '移除 Agent',
    agent: 'Agent',
    id: 'Agent ID',
    displayName: '显示名称',
    executable: '可执行文件（Host 上的绝对路径）',
    args: '参数（字符串 JSON 数组）',
    env: '非敏感环境变量（可选，值为字符串的 JSON 对象）',
    save: '保存配置',
    saved: '配置已保存。',
    invalidArgs: '参数必须是仅包含字符串的 JSON 数组。',
    invalidEnv: '环境变量必须是值仅为字符串的 JSON 对象。',
    refreshed: '已重新加载最新保存的配置，请检查后再保存。',
    refreshFailed: '无法重新加载已保存的配置，请刷新后再保存。',
    setupTitle: '检查与登录',
    setupDescription:
      '这些操作使用已保存的配置，在 Host 上启动 Agent。请先保存修改。检查成功表示 ACP 兼容，不代表账户已授权。',
    check: '检查已保存的 Agent',
    checking: '正在检查 ACP 连接…',
    checked: 'ACP 连接已验证。',
    authenticate: '登录',
    authenticating: '等待 Agent 完成认证…',
    authenticated: 'Agent 已报告认证成功。',
    cancelling: '正在取消…',
    cancelled: '请求已取消。',
    failed: '设置失败。',
    cancel: '取消',
    openAuthorization: '打开登录链接',
    noAuthMethods: 'Agent 未提供登录方式。',
    unsupportedAuth: '此认证方式需要尚不支持的流程，请使用 Agent 自身的设置说明。',
    invalidAuthUrl: 'Agent 提供的登录链接无效，仅支持不含嵌入凭据的 HTTPS 链接。',
    incompleteSetup: '设置完成前 Agent 连接已结束。',
    activationError: '已保存的配置未能完全激活',
    retryActivation: '重试激活',
    installTitle: '安装 Antigravity',
    installDescription:
      '在 Host 上安装 Antigravity，然后将其加入配置草稿。检查并保存草稿后启用 Agent。',
    installAntigravity: '安装 Antigravity',
    installing: '正在安装 Antigravity…',
    installed: '安装已完成，配置尚未保存。',
    incompleteInstall: '安装已结束，但未返回已安装的 Agent。',
    addInstalled: '将已安装的 Agent 加入草稿',
    replaceInstalled: '替换草稿中的同名 ID 条目',
    replaceInstalledDescription:
      '草稿中已有此 Agent ID。替换会更改该条目的名称、可执行文件、参数和环境变量。',
    installedDraft: '已安装的 Agent 已加入草稿，请检查并保存配置。',
  },
  'zh-TW': {
    title: '外部 Agent',
    description:
      '設定透過標準輸入與輸出使用 ACP 的 Agent。路徑指向執行此 Host 的機器。儲存設定不會驗證安裝或連線狀態。',
    refresh: '重新整理',
    working: '處理中…',
    empty: '尚未設定外部 Agent。',
    add: '新增 Agent',
    remove: '移除 Agent',
    agent: 'Agent',
    id: 'Agent ID',
    displayName: '顯示名稱',
    executable: '執行檔（Host 上的絕對路徑）',
    args: '參數（字串 JSON 陣列）',
    env: '非機密環境變數（選填，值為字串的 JSON 物件）',
    save: '儲存設定',
    saved: '設定已儲存。',
    invalidArgs: '參數必須是僅包含字串的 JSON 陣列。',
    invalidEnv: '環境變數必須是值僅為字串的 JSON 物件。',
    refreshed: '已重新載入最新儲存的設定，請檢查後再儲存。',
    refreshFailed: '無法重新載入已儲存的設定，請重新整理後再儲存。',
    setupTitle: '檢查與登入',
    setupDescription:
      '這些操作使用已儲存的設定，在 Host 上啟動 Agent。請先儲存修改。檢查成功表示 ACP 相容，不代表帳戶已授權。',
    check: '檢查已儲存的 Agent',
    checking: '正在檢查 ACP 連線…',
    checked: 'ACP 連線已驗證。',
    authenticate: '登入',
    authenticating: '等待 Agent 完成驗證…',
    authenticated: 'Agent 已回報驗證成功。',
    cancelling: '正在取消…',
    cancelled: '請求已取消。',
    failed: '設定失敗。',
    cancel: '取消',
    openAuthorization: '開啟登入連結',
    noAuthMethods: 'Agent 未提供登入方式。',
    unsupportedAuth: '此驗證方式需要尚未支援的流程，請使用 Agent 自身的設定說明。',
    invalidAuthUrl: 'Agent 提供的登入連結無效，僅支援不含內嵌憑證的 HTTPS 連結。',
    incompleteSetup: '設定完成前 Agent 連線已結束。',
    activationError: '已儲存的設定未能完全啟用',
    retryActivation: '重試啟用',
    installTitle: '安裝 Antigravity',
    installDescription:
      '在 Host 上安裝 Antigravity，然後將其加入設定草稿。檢查並儲存草稿後啟用 Agent。',
    installAntigravity: '安裝 Antigravity',
    installing: '正在安裝 Antigravity…',
    installed: '安裝已完成，設定尚未儲存。',
    incompleteInstall: '安裝已結束，但未回傳已安裝的 Agent。',
    addInstalled: '將已安裝的 Agent 加入草稿',
    replaceInstalled: '取代草稿中相同 ID 的項目',
    replaceInstalledDescription:
      '草稿中已有此 Agent ID。取代會變更該項目的名稱、執行檔、參數和環境變數。',
    installedDraft: '已安裝的 Agent 已加入草稿，請檢查並儲存設定。',
  },
} satisfies Record<ClientLocale, typeof en>;
