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

import type { UiLocale, UiCatalog } from '@maka/core/ui-locale';
import type { ExternalAgentSetupFailure } from '@maka/runtime-host/protocol';
const en = {
  programTitle: "Program",
  programName: "Antigravity ACP",
  install: "Install",
  installHelp: "Download the official program from Google and configure its path automatically.",
  programConfigured: "A program path is saved. Check the connection to verify it is available.",
  selectExisting: "Choose existing program",
  existingProgramHelp: "Already have ACP? Choose your existing program to use its local path without reinstalling.",
  reinstall: "Reinstall",
  source: "Download source",
  release: "Official download: v1.1.1 · macOS Apple Silicon · 316 MB",
  downloading: "Downloading official ACP…",
  installing: "Installing and checking the connection…",
  installed: "Installed and connected.",
  reverify: "Verify sign-in again",

  title: 'Antigravity',
  accountUnchecked: 'Sign-in has not been verified. Sign in with Google to continue.',
  accountBeforeSave: 'Configure the program connection above before signing in.',
  googleAccount: 'Sign-in status',
  accountDescription: 'Sign-in opens in your browser. Antigravity manages your credentials.',
  accountTitle: 'Google account',
  connectionVerified: 'Connection successful.',
  connectionStatus: 'Connection status',
  catalogTitle: 'Available agents',
  catalogDescription: 'Choose an external agent to configure its connection and sign in.',
  agentDescription: 'Google’s coding agent, connected through the official ACP distribution.',
  configured: 'Configured',
  backToAgents: 'Back to external agents',
  check: 'Check connection',
  login: 'Sign in with Google',
  cancel: 'Cancel',
  retry: 'Retry',
  loading: 'Checking availability…',
  unavailable: 'Available on local macOS Apple Silicon Hosts only.',
  unchecked: 'Connection and sign-in have not been verified.',
  connecting: 'Connecting…',
  awaiting_authorization: 'Complete Google sign-in in your browser.',
  cancelling: 'Cancelling and releasing the process…',
  connected: 'Connection successful. Sign-in has not been verified.',
  authenticated: 'Google sign-in verified for this attempt.',
  cancelled: 'Setup cancelled.',
  error: 'The operation failed. Check the saved path and Host connection, then retry.',
  failures: {
    download_failed: "Official download failed. Check network or proxy settings and retry.",
    integrity_failed: "The program did not match the verified official distribution. Use a complete official copy or retry installation.",
    installation_failed: "Installation failed. Check available disk space and directory permissions, then retry.",

    executable_unavailable:
      'The executable is missing or cannot run. Check the saved path and executable permissions.',
    helper_unavailable:
      'The matching localharness_external helper is missing or cannot run. Keep the official distribution together.',
    connection_failed:
      'ACP connection failed. Check that the executable and helper belong to the same official distribution.',
    authentication_unavailable: 'This agent does not offer the supported Google sign-in method.',
    authentication_failed: 'Antigravity could not complete sign-in. Retry Google sign-in.',
    account_ineligible:
      'Antigravity rejected account eligibility. Check official account and regional availability.',
    browser_failed:
      'The sign-in link could not be opened. Cancel other sign-in attempts and retry.',
    timed_out: 'Setup timed out and its process was stopped. Retry when ready.',
    cleanup_failed: 'The process could not be released. Restart the Host before retrying.',
  } satisfies Record<ExternalAgentSetupFailure, string>,
};
const zh = {
  programTitle: "程序",
  programName: "Antigravity ACP",
  install: "安装",
  installHelp: "从 Google 下载官方程序，安装后自动配置，无需填写路径。",
  programConfigured: "已保存程序位置，可检查连接以确认程序可用。",
  selectExisting: "选择已有程序",
  existingProgramHelp: "已有 ACP 程序？点击“选择已有程序”，使用本机路径，无需重新安装。",
  reinstall: "重新安装",
  source: "下载来源",
  release: "官方下载：v1.1.1 · macOS Apple 芯片 · 316 MB",
  downloading: "正在下载官方 ACP…",
  installing: "正在安装并检查连接…",
  installed: "安装完成，连接成功。",
  reverify: "重新验证登录",

  title: 'Antigravity',
  accountUnchecked: '登录状态尚未验证，使用 Google 登录后继续。',
  accountBeforeSave: '请先完成上方的程序连接配置，再登录。',
  googleAccount: '登录状态',
  accountDescription: '登录将在浏览器中完成，凭据由 Antigravity 管理。',
  accountTitle: 'Google 账号',
  connectionVerified: '连接成功。',
  connectionStatus: '连接状态',
  catalogTitle: '可用 Agent',
  catalogDescription: '选择外部 Agent，配置连接并登录。',
  agentDescription: 'Google 编程 Agent，通过官方 ACP 程序连接。',
  configured: '已配置',
  backToAgents: '返回外部 Agent',
  check: '检查连接',
  login: '使用 Google 登录',
  cancel: '取消',
  retry: '重试',
  loading: '正在检查可用性…',
  unavailable: '仅支持本地 macOS Apple Silicon Host。',
  unchecked: '连接和登录状态尚未验证。',
  connecting: '正在连接…',
  awaiting_authorization: '请在浏览器中完成 Google 登录。',
  cancelling: '正在取消并释放进程…',
  connected: '连接成功，登录状态尚未验证。',
  authenticated: '本次 Google 登录验证成功。',
  cancelled: '已取消设置操作。',
  error: '操作失败，请检查已保存路径和 Host 连接后重试。',
  failures: {
    download_failed: "官方下载失败，请检查网络或代理设置后重试。",
    integrity_failed: "程序与已验证的官方版本不匹配，请使用完整官方程序或重试安装。",
    installation_failed: "安装失败，请检查可用磁盘空间和目录权限后重试。",

    executable_unavailable: '可执行文件不存在或无法运行，请检查已保存路径及执行权限。',
    helper_unavailable: '匹配的 localharness_external 缺失或无法运行，请保留完整的官方分发目录。',
    connection_failed: 'ACP 连接失败，请确认程序和 helper 来自同一官方分发版本。',
    authentication_unavailable: '此程序未提供受支持的 Google 登录方式。',
    authentication_failed: 'Antigravity 未能完成认证，请重试 Google 登录。',
    account_ineligible: 'Antigravity 拒绝了账号资格。请检查官方账号及地区可用性。',
    browser_failed: '无法打开登录链接，请取消其他登录操作后重试。',
    timed_out: '操作超时，已停止临时进程。准备好后可重试。',
    cleanup_failed: '无法释放临时进程，请重启 Host 后重试。',
  } satisfies Record<ExternalAgentSetupFailure, string>,
};
const zhTW: typeof en = {
  programTitle: "程式",
  programName: "Antigravity ACP",
  install: "安裝",
  installHelp: "從 Google 下載官方程式，安裝後自動設定，無需填寫路徑。",
  programConfigured: "已儲存程式位置，可檢查連線以確認程式可用。",
  selectExisting: "選擇已有程式",
  existingProgramHelp: "已有 ACP 程式？點擊「選擇已有程式」，使用本機路徑，無需重新安裝。",
  reinstall: "重新安裝",
  source: "下載來源",
  release: "官方下載：v1.1.1 · macOS Apple 晶片 · 316 MB",
  downloading: "正在下載官方 ACP…",
  installing: "正在安裝並檢查連線…",
  installed: "安裝完成，連線成功。",
  reverify: "重新驗證登入",

  title: 'Antigravity',
  accountUnchecked: '登入狀態尚未驗證，使用 Google 登入後繼續。',
  accountBeforeSave: '請先完成上方的程式連線設定，再登入。',
  googleAccount: '登入狀態',
  accountDescription: '登入將在瀏覽器中完成，憑證由 Antigravity 管理。',
  accountTitle: 'Google 帳號',
  connectionVerified: '連線成功。',
  connectionStatus: '連線狀態',
  catalogTitle: '可用 Agent',
  catalogDescription: '選擇外部 Agent，設定連線並登入。',
  agentDescription: 'Google 程式開發 Agent，透過官方 ACP 程式連線。',
  configured: '已設定',
  backToAgents: '返回外部 Agent',
  check: '檢查連線',
  login: '使用 Google 登入',
  cancel: '取消',
  retry: '重試',
  loading: '正在檢查可用性…',
  unavailable: '僅支援本機 macOS Apple Silicon Host。',
  unchecked: '連線與登入狀態尚未驗證。',
  connecting: '正在連線…',
  awaiting_authorization: '請在瀏覽器中完成 Google 登入。',
  cancelling: '正在取消並釋放程序…',
  connected: '連線成功，登入狀態尚未驗證。',
  authenticated: '本次 Google 登入驗證成功。',
  cancelled: '已取消設定操作。',
  error: '操作失敗，請檢查已儲存路徑和 Host 連線後重試。',
  failures: {
    download_failed: "官方下載失敗，請檢查網路或代理設定後重試。",
    integrity_failed: "程式與已驗證的官方版本不符，請使用完整官方程式或重試安裝。",
    installation_failed: "安裝失敗，請檢查可用磁碟空間與目錄權限後重試。",

    executable_unavailable: '執行檔不存在或無法執行，請檢查已儲存路徑及執行權限。',
    helper_unavailable: '相符的 localharness_external 缺失或無法執行，請保留完整的官方分發目錄。',
    connection_failed: 'ACP 連線失敗，請確認程式與 helper 來自同一官方分發版本。',
    authentication_unavailable: '此程式未提供受支援的 Google 登入方式。',
    authentication_failed: 'Antigravity 未能完成驗證，請重試 Google 登入。',
    account_ineligible: 'Antigravity 拒絕了帳號資格。請檢查官方帳號及地區可用性。',
    browser_failed: '無法開啟登入連結，請取消其他登入操作後重試。',
    timed_out: '操作逾時，已停止暫時程序。準備好後可重試。',
    cleanup_failed: '無法釋放暫時程序，請重新啟動 Host 後重試。',
  },
};
const catalog = { en, 'zh-CN': zh, 'zh-TW': zhTW } satisfies UiCatalog<typeof en>;
export function getExternalAgentsCopy(locale: UiLocale) {
  return catalog[locale];
}
