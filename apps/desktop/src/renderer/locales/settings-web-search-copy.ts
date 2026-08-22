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

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

import type { WebSearchCredentialStatus, WebSearchErrorReason } from '@maka/core/web-search';

export type WebSearchSettingsCopy = {
  saveFailed: string; saveStatusFailed: string; keySaved: string; keySavedDetail: string; credentialsCleared: string; credentialsClearedDetail: string;
  credentialValid: string; resultCount(count: number): string; testFailed: string; testError: string; enabled: string; enabledHelp: string;
  provider: string; providerHelp: string; providerModel: string; providerTavily: string;
  modelCredential: string; modelCredentialHelp: string;
  statusAria: string; lastTest: string; enabledAria: string; key: string; envKeyHelp: string; savedKeyHelp: string;
  envPlaceholder: string; storedPlaceholder: string; keyPlaceholder: string; keyAria: string; actions: string; actionsHelp: string;
  saving: string; saveKey: string; testing: string; testKey: string; clearing: string; clearKey: string;
  testSearch: string; testSearchHelp: string; queryPlaceholder: string;
  searching: string; search: string; queryFailed(error: string): string; noResults: string; resultsAria: string;
  disabledReasons: { noKey: string; disabled: string; noQuery: string };
  statuses: Record<WebSearchCredentialStatus, string> & { validEnabled: string; validDisabled: string; unknownEnabled: string; modelEnabled: string; modelDisabled: string };
  sources: { model: string; envWithSaved: string; env: string; saved: string; none: string };
  errors: Record<WebSearchErrorReason, string>;
};

const SETTINGS_WEB_SEARCH_COPY = {
  zh: {
    saveFailed: '保存联网搜索设置失败', saveStatusFailed: '保存联网搜索状态失败', keySaved: '已保存 Tavily 密钥', keySavedDetail: '可点击「测试」做一次真实请求验证。',
    credentialsCleared: '已清空 Tavily 凭据', credentialsClearedDetail: '联网搜索已自动关闭。', credentialValid: 'Tavily 凭据可用', resultCount: (count) => `返回 ${count} 条结果。`,
    testFailed: '联网搜索测试失败', testError: '联网搜索测试出错', enabled: '启用联网搜索', enabledHelp: '启用后，Maka 可以在需要最新外部信息时调用所选搜索来源。',
    provider: '搜索来源', providerHelp: '优先复用当前模型的服务端搜索；不支持时可显式改用 Tavily。', providerModel: '当前模型', providerTavily: 'Tavily',
    modelCredential: '主模型原生搜索', modelCredentialHelp: 'Maka 会在每个任务回合开始时，根据当前连接与精确模型决定是否把原生 web_search 注入同一次模型请求。不保存第二份搜索密钥，也不会从设置页另发一次模型调用。',
    statusAria: '联网搜索凭据状态', lastTest: '最近测试 ', enabledAria: '启用联网搜索', key: 'Tavily 密钥',
    envKeyHelp: '当前使用环境变量 TAVILY_API_KEY / MAKA_TAVILY_API_KEY；如需改用保存的密钥，请移除环境变量后重启。', savedKeyHelp: '密钥只保存在本机。申请地址：',
    envPlaceholder: '由环境变量提供', storedPlaceholder: '已保存（输入新密钥可替换）', keyPlaceholder: 'tvly-xxxxxxxx', keyAria: 'Tavily 密钥',
    actions: '凭据操作', actionsHelp: '保存后可以测试一次真实请求；清空凭据会同步关闭联网搜索。', saving: '保存中…', saveKey: '保存密钥', testing: '测试中…', testKey: '测试凭据', clearing: '清空中…', clearKey: '清空密钥',
    testSearch: '测试搜索', testSearchHelp: '发一条真实查询，确认所选联网搜索来源是否配置可用。结果只显示在这里，不写入任务。', queryPlaceholder: '例如：本周 AI 产品发布动态',
    searching: '搜索中…', search: '搜索', queryFailed: (error) => `查询失败：${error}`, noResults: '没有结果。', resultsAria: '联网搜索真实查询结果',
    disabledReasons: { noKey: '先配置所选搜索来源', disabled: '先启用联网搜索', noQuery: '输入查询后再搜索' },
    statuses: { valid: '已验证', invalid_credentials: '密钥无效', rate_limited: '服务限流', timeout: '测试超时', network_error: '网络异常', not_configured: '等待配置', untested: '未测试', validEnabled: '已验证 · 已启用', validDisabled: '已验证 · 未启用', unknownEnabled: '未测试 · 已启用', modelEnabled: '已启用 · 按任务模型判定', modelDisabled: '当前模型来源 · 未启用' },
    sources: { model: '来源：当前模型连接', envWithSaved: '来源：环境变量（已保存密钥备用）', env: '来源：环境变量', saved: '来源：本机已保存密钥', none: '来源：未配置' },
    errors: { invalid_query: '请输入有效的搜索内容。', incognito_active: '无痕模式下无法使用联网搜索。', not_configured: '所选搜索来源尚未配置完成。', invalid_credentials: '搜索来源拒绝了当前凭据，请更新后重试。', rate_limited: '搜索请求过于频繁，请稍后重试。', network_error: '网络请求失败，请检查网络后重试。', timeout: '搜索请求超时，请重试。', unsupported_provider: '当前模型不支持服务端搜索，或 Maka 尚未实现它的协议；可改用 Tavily。', experimental_disabled: '联网搜索实验功能当前已关闭。' },
  },
  en: {
    saveFailed: 'Failed to save web search settings', saveStatusFailed: 'Failed to save web search status', keySaved: 'Tavily key saved', keySavedDetail: 'Select Test credentials to verify it with a real request.',
    credentialsCleared: 'Tavily credentials cleared', credentialsClearedDetail: 'Web search was disabled automatically.', credentialValid: 'Tavily credentials work', resultCount: (count) => `Returned ${count} ${count === 1 ? 'result' : 'results'}.`,
    testFailed: 'Web search test failed', testError: 'Web search test error', enabled: 'Enable web search', enabledHelp: 'When enabled, Maka can call the selected search source for current external information.',
    provider: 'Search source', providerHelp: 'Reuse the current model provider when it supports hosted search, or explicitly use Tavily.', providerModel: 'Current model', providerTavily: 'Tavily',
    modelCredential: 'Primary-model native search', modelCredentialHelp: 'At the start of each turn, Maka uses the current connection and exact model to decide whether to inject native web_search into the same model request. It stores no second search key and sends no separate model call from Settings.',
    statusAria: 'Web search credential status', lastTest: 'Last tested ', enabledAria: 'Enable web search', key: 'Tavily key',
    envKeyHelp: 'Currently using TAVILY_API_KEY / MAKA_TAVILY_API_KEY from the environment. Remove the environment variable and restart to use a saved key.', savedKeyHelp: 'The key is stored only on this machine. Apply at:',
    envPlaceholder: 'Provided by environment variable', storedPlaceholder: 'Saved (enter a new key to replace)', keyPlaceholder: 'tvly-xxxxxxxx', keyAria: 'Tavily key',
    actions: 'Credential actions', actionsHelp: 'After saving, test with a real request. Clearing credentials also disables web search.', saving: 'Saving…', saveKey: 'Save key', testing: 'Testing…', testKey: 'Test credentials', clearing: 'Clearing…', clearKey: 'Clear key',
    testSearch: 'Test search', testSearchHelp: 'Send a real query to confirm the selected web search source is configured and working. Results appear here only and are not written to the task.', queryPlaceholder: 'For example: AI product launches this week',
    searching: 'Searching…', search: 'Search', queryFailed: (error) => `Query failed: ${error}`, noResults: 'No results.', resultsAria: 'Web search live query results',
    disabledReasons: { noKey: 'Configure the selected search source first', disabled: 'Enable web search first', noQuery: 'Enter a query before searching' },
    statuses: { valid: 'Verified', invalid_credentials: 'Invalid key', rate_limited: 'Rate limited', timeout: 'Test timed out', network_error: 'Network error', not_configured: 'Needs setup', untested: 'Not tested', validEnabled: 'Verified · enabled', validDisabled: 'Verified · disabled', unknownEnabled: 'Not tested · enabled', modelEnabled: 'Enabled · checked per task model', modelDisabled: 'Current model source · disabled' },
    sources: { model: 'Source: current model connection', envWithSaved: 'Source: environment variable (saved key available as backup)', env: 'Source: environment variable', saved: 'Source: key saved on this device', none: 'Source: not configured' },
    errors: { invalid_query: 'Enter a valid search query.', incognito_active: 'Web search is unavailable in incognito mode.', not_configured: 'The selected search source is not configured.', invalid_credentials: 'The search provider rejected the current credential. Update it and try again.', rate_limited: 'The search provider is receiving too many requests. Try again later.', network_error: 'The network request failed. Check your connection and try again.', timeout: 'The search request timed out. Try again.', unsupported_provider: 'The current model does not support hosted search, or Maka has not implemented its protocol yet. Select Tavily to continue.', experimental_disabled: 'The experimental web search feature is currently disabled.' },
  },
} satisfies UiCatalog<WebSearchSettingsCopy>;

export function getWebSearchSettingsCopy(locale: UiLocale): WebSearchSettingsCopy { return SETTINGS_WEB_SEARCH_COPY[locale]; }
