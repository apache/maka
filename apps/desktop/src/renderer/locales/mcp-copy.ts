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

export type McpCopy = {
  errors: {
    load: string; save: string; import: string;
    update: string; test: string; remove: string; unavailableStatus: string; mapLine(line: number): string;
    importJson: string; importObject: string; importVersion(version: string): string; importServersObject: string; importProtocolVersion: string;
    writeDurabilityUnknown: string; writeOutOfSync: string;
  };
  toast: {
    saved: string; savedDetail: string;
    imported: string; importedDetail(count: number): string; connectionOk: string; toolLatency(count: number, latencyMs: number): string;
    connectionFailed: string; removed: string;
  };
  remove: { title(id: string): string; description: string; confirm: string; cancel: string };
  page: {
    actionsAria: string; refreshing: string; refresh: string; add: string;
    metaConnections(count: number): string; metaErrors(count: number): string;
    searchMatches(count: number): string;
    toolbarAria: string; connections: string; localStdio: string; searchPlaceholder: string; searchAria: string;
    clearSearch: string; loading: string;
    noConnectionsMatch: string; noConnectionsMatchDetail(query: string): string;
    recommended: string;
    suggestions: Record<'notion' | 'linear' | 'feishu' | 'mcp-docs', { name: string; description: string }>;
  };
  detail: {
    label: string; enabled: string; transport: string;
    toolsLabel: string; statusLabel: string; protocolLabel: string;
    negotiatedProtocol(era: 'legacy' | 'modern', revision: string): string;
    inspectorOpened(id: string): string;
  };
  row: {
    needsAuth: string; login: string; loginPending: string; cancelLogin: string; logout: string;
    testing: string; test: string; edit: string;
    delete: string; tools(count: number): string;
    disabled: string; disconnected: string; connecting: string; connected(count: number): string; failed: string;
  };
  editor: {
    importTitle: string; editTitle(id: string): string; addTitle: string; importSubtitle: string; manualSubtitle: string;
    manual: string; pasteJson: string; jsonConfig: string; jsonHelp: string; cancel: string;
    importConnect: string; transportAria: string; localStdio: string; remoteUrl: string;
    serverId: string; command: string; commandPlaceholder: string; commandHelp: string;
    workingDirectory: string; workingDirectoryPlaceholder: string; environment: string; environmentHelp: string;
    url: string; headers: string; headersHelp: string; saveConnect: string;
    idExists: string; oauth: string; oauthHelp: string; issuer: string; clientId: string; clientSecret: string; scopes: string; callbackPort: string;
    required: string; invalidUrl: string; unbalancedQuote: string;
    transportLabel: string; transportAuto: string; transportStreamableHttp: string; transportLegacySse: string;
    protocolLabel: string; protocolLegacy: string; protocolAuto: string; protocolModern: string;
    protocolHelp: string; sseProtocolHelp: string; expandAdvanced: string; collapseAdvanced: string; stdioProtocolHelp: string;
  };
};

const MCP_COPY = {
  'zh-CN': {
    errors: {
      load: '载入 MCP 失败', save: '保存 MCP 失败',
      writeDurabilityUnknown: '写入已发布，但无法确认断电后是否保留。请检查刷新后的配置再决定是否重试。',
      writeOutOfSync: '写入的持久性尚未确认，MCP 运行状态也未能与配置同步。请检查配置并重新同步后再重试。',
      import: '导入 MCP 失败', update: '更新 MCP 失败', test: 'MCP 测试失败', remove: '删除 MCP 失败', unavailableStatus: 'Server 没有返回可用状态。',
      mapLine: (line) => `第 ${line} 行应为 KEY=value`, importJson: 'MCP 配置必须是有效的 JSON', importObject: 'MCP JSON 必须是 object',
      importVersion: (version) => `不支持 MCP 配置版本 ${version}，当前支持 version 1、2 和 3`, importServersObject: 'mcpServers 必须是 object',
      importProtocolVersion: 'remote 的 protocol 需要 version 2 或 3；stdio 的 protocol 需要 version 3',
    },
    toast: {
      saved: 'MCP 已保存', savedDetail: '新工具会在下一轮对话中生效。', imported: '已导入 MCP',
      importedDetail: (count) => `已导入 ${count} 个连接。`, connectionOk: 'MCP 连接正常',
      toolLatency: (count, latencyMs) => `${count} 个工具 · ${latencyMs} ms`, connectionFailed: 'MCP 连接失败', removed: 'MCP 已删除',
    },
    remove: { title: (id) => `删除 MCP「${id}」？`, description: '它提供的工具会从下一轮对话中移除；删除后无法自动恢复此连接。', confirm: '删除', cancel: '取消' },
    page: {
      actionsAria: 'MCP 操作', refreshing: '刷新中…', refresh: '刷新', add: '添加 MCP',
      metaConnections: (count) => `${count} 个连接`, metaErrors: (count) => `${count} 个连接异常`,
      searchMatches: (count) => `${count} 个匹配`,
      toolbarAria: 'MCP 连接操作', connections: '已添加', localStdio: '本地命令',
      searchPlaceholder: '搜索连接…', searchAria: '搜索 MCP 连接',
      clearSearch: '清空搜索', loading: '正在读取 MCP 连接…',
      noConnectionsMatch: '没有匹配的 MCP 连接', noConnectionsMatchDetail: (query) => `换一个关键词，或清空「${query}」查看全部连接。`,
      recommended: '推荐',
      suggestions: {
        notion: { name: 'Notion', description: '访问工作区页面' },
        linear: { name: 'Linear', description: '访问问题与项目' },
        feishu: { name: '飞书', description: '访问飞书文档' },
        'mcp-docs': { name: 'MCP 官方文档', description: '搜索协议文档' },
      },
    },
    detail: {
      label: '连接详情', enabled: '启用', transport: '传输方式',
      toolsLabel: '工具', statusLabel: '状态', protocolLabel: 'MCP 协议',
      negotiatedProtocol: (era, revision) => `${era === 'modern' ? '现代' : '传统'} · ${revision}`,
      inspectorOpened: (id) => `已打开 ${id} 的详情`,
    },
    row: {
      needsAuth: '需要登录', login: '登录', loginPending: '请在浏览器中完成授权', cancelLogin: '取消登录', logout: '退出授权',
      testing: '测试中…', test: '测试', edit: '编辑',
      delete: '删除', tools: (count) => `${count} 个工具`,
      disabled: '已停用', disconnected: '未连接', connecting: '连接中', connected: (count) => `${count} 个工具`, failed: '连接失败',
    },
    editor: {
      idExists: '已有同名连接，请换个名称。', oauth: 'OAuth 设置', oauthHelp: '通常无需填写。只有服务提供固定客户端凭据时才配置；填写客户端 ID 时还需要授权服务器地址。', issuer: '授权服务器地址（issuer）', clientId: '客户端 ID', clientSecret: '客户端密钥', scopes: '权限范围（空格分隔）', callbackPort: '回调端口（可选）',
      importTitle: '通过 JSON 导入', editTitle: (id) => `编辑 ${id}`, addTitle: '添加 MCP', importSubtitle: '粘贴 MCP 配置；同名连接会被更新。',
      manualSubtitle: '此连接保存在当前工作区。',
      manual: '手动配置', pasteJson: '粘贴 JSON', jsonConfig: 'JSON 配置',
      jsonHelp: '可粘贴完整配置，或仅包含各连接的 JSON 对象；未列出的现有连接会保留。', cancel: '取消', importConnect: '导入配置',
      transportAria: '连接方式', localStdio: '本地命令', remoteUrl: '远程 URL',
      serverId: '连接名称', command: '启动命令',
      commandPlaceholder: 'node /path/to/server.js',
      commandHelp: '填写启动命令及参数；含空格的参数请加引号。',
      workingDirectory: '工作目录', workingDirectoryPlaceholder: '/path/to/project',
      environment: '环境变量', environmentHelp: '每行一个 KEY=value；只填写此服务要求的变量。', url: 'MCP URL', headers: 'HTTP 请求头', headersHelp: '每行一个 Header=value；按服务文档填写。',
      saveConnect: '保存连接',
      required: '此字段为必填项。', invalidUrl: '请输入有效的 HTTP 或 HTTPS URL。', unbalancedQuote: '引号未闭合。',
      transportLabel: '远程传输方式', transportAuto: '自动选择', transportStreamableHttp: 'Streamable HTTP', transportLegacySse: '旧版 SSE',
      protocolLabel: 'MCP 协议版本', protocolLegacy: '传统协议', protocolAuto: '自动协商', protocolModern: '仅 2026-07-28',
      protocolHelp: '自动协商会按服务支持的版本连接；遇到兼容性问题时再固定版本。', sseProtocolHelp: '旧版 SSE 使用传统协议。', expandAdvanced: '显示高级设置', collapseAdvanced: '隐藏高级设置',
      stdioProtocolHelp: '自动协商或仅使用新版协议时，会额外启动一次服务器进行探测。',
    },
  },
  'zh-TW': {
    errors: {
      load: '載入 MCP 失敗', save: '儲存 MCP 失敗',
      writeDurabilityUnknown: '寫入已發布，但無法確認斷電後是否保留。請檢查重新整理後的設定再決定是否重試。',
      writeOutOfSync: '寫入的持久性尚未確認，MCP 執行狀態也未能與設定同步。請檢查設定並重新同步後再重試。',
      import: '匯入 MCP 失敗', update: '更新 MCP 失敗', test: 'MCP 測試失敗', remove: '刪除 MCP 失敗', unavailableStatus: 'Server 沒有返回可用狀態。',
      mapLine: (line) => `第 ${line} 行應為 KEY=value`, importJson: 'MCP 設定必須是有效的 JSON', importObject: 'MCP JSON 必須是 object',
      importVersion: (version) => `不支援 MCP 設定版本 ${version}，目前支援 version 1、2 和 3`, importServersObject: 'mcpServers 必須是 object',
      importProtocolVersion: 'remote 的 protocol 需要 version 2 或 3；stdio 的 protocol 需要 version 3',
    },
    toast: {
      saved: 'MCP 已儲存', savedDetail: '新工具會在下一輪對話中生效。', imported: '已匯入 MCP',
      importedDetail: (count) => `已匯入 ${count} 個連線。`, connectionOk: 'MCP 連線正常',
      toolLatency: (count, latencyMs) => `${count} 個工具 · ${latencyMs} ms`, connectionFailed: 'MCP 連線失敗', removed: 'MCP 已刪除',
    },
    remove: { title: (id) => `刪除 MCP「${id}」？`, description: '它提供的工具會從下一輪對話中移除；刪除後無法自動恢復此連線。', confirm: '刪除', cancel: '取消' },
    page: {
      actionsAria: 'MCP 操作', refreshing: '重新整理中…', refresh: '重新整理', add: '新增 MCP',
      metaConnections: (count) => `${count} 個連線`, metaErrors: (count) => `${count} 個連線異常`,
      searchMatches: (count) => `${count} 個符合`,
      toolbarAria: 'MCP 連線操作', connections: '已新增', localStdio: '本地命令',
      searchPlaceholder: '搜尋連線…', searchAria: '搜尋 MCP 連線',
      clearSearch: '清空搜尋', loading: '正在讀取 MCP 連線…',
      noConnectionsMatch: '沒有符合的 MCP 連線', noConnectionsMatchDetail: (query) => `換一個關鍵詞，或清空「${query}」檢視全部連線。`,
      recommended: '推薦',
      suggestions: {
        notion: { name: 'Notion', description: '存取工作區頁面' },
        linear: { name: 'Linear', description: '存取議題與專案' },
        feishu: { name: '飛書', description: '存取飛書文件' },
        'mcp-docs': { name: 'MCP 官方文件', description: '搜尋協議文件' },
      },
    },
    detail: {
      label: '連線詳情', enabled: '啟用', transport: '傳輸方式',
      toolsLabel: '工具', statusLabel: '狀態', protocolLabel: 'MCP 協議',
      negotiatedProtocol: (era, revision) => `${era === 'modern' ? '現代' : '傳統'} · ${revision}`,
      inspectorOpened: (id) => `已開啟 ${id} 的詳情`,
    },
    row: {
      needsAuth: '需要登入', login: '登入', loginPending: '請在瀏覽器中完成授權', cancelLogin: '取消登入', logout: '登出授權',
      testing: '測試中…', test: '測試', edit: '編輯',
      delete: '刪除', tools: (count) => `${count} 個工具`,
      disabled: '已停用', disconnected: '未連線', connecting: '連線中', connected: (count) => `${count} 個工具`, failed: '連線失敗',
    },
    editor: {
      idExists: '已有同名連線，請換個名稱。', oauth: 'OAuth 設定', oauthHelp: '通常無需填寫。只有服務提供固定用戶端憑據時才設定；填寫用戶端 ID 時還需要授權伺服器地址。', issuer: '授權伺服器地址（issuer）', clientId: '用戶端 ID', clientSecret: '用戶端密鑰', scopes: '權限範圍（空格分隔）', callbackPort: '回呼連接埠（選填）',
      importTitle: '透過 JSON 匯入', editTitle: (id) => `編輯 ${id}`, addTitle: '新增 MCP', importSubtitle: '貼上 MCP 設定；同名連線會被更新。',
      manualSubtitle: '此連線儲存在目前工作區。',
      manual: '手動設定', pasteJson: '貼上 JSON', jsonConfig: 'JSON 設定',
      jsonHelp: '可貼上完整設定，或僅包含各連線的 JSON 物件；未列出的現有連線會保留。', cancel: '取消', importConnect: '匯入設定',
      transportAria: '連線方式', localStdio: '本地命令', remoteUrl: '遠端 URL',
      serverId: '連線名稱', command: '啟動命令',
      commandPlaceholder: 'node /path/to/server.js',
      commandHelp: '填寫啟動命令及引數；含空格的引數請加引號。',
      workingDirectory: '工作目錄', workingDirectoryPlaceholder: '/path/to/project',
      environment: '環境變數', environmentHelp: '每行一個 KEY=value；只填寫此服務要求的變數。', url: 'MCP URL', headers: 'HTTP 請求頭', headersHelp: '每行一個 Header=value；依服務文件填寫。',
      saveConnect: '儲存連線',
      required: '此欄位為必填項。', invalidUrl: '請輸入有效的 HTTP 或 HTTPS URL。', unbalancedQuote: '引號未閉合。',
      transportLabel: '遠端傳輸方式', transportAuto: '自動選擇', transportStreamableHttp: 'Streamable HTTP', transportLegacySse: '舊版 SSE',
      protocolLabel: 'MCP 協議版本', protocolLegacy: '傳統協議', protocolAuto: '自動協商', protocolModern: '僅 2026-07-28',
      protocolHelp: '自動協商會依服務支援的版本連線；遇到相容性問題時再固定版本。', sseProtocolHelp: '舊版 SSE 使用傳統協議。', expandAdvanced: '顯示進階設定', collapseAdvanced: '隱藏進階設定',
      stdioProtocolHelp: '自動協商或僅使用新版協議時，會額外啟動一次伺服器進行探測。',
    },
  },
  en: {
    errors: {
      load: 'Failed to load MCP', save: 'Failed to save MCP',
      writeDurabilityUnknown: 'The write was published, but survival after power loss could not be confirmed. Check the refreshed configuration before retrying.',
      writeOutOfSync: 'Write durability could not be confirmed, and MCP runtime state is out of sync with the configuration. Check the configuration and resynchronize before retrying.',
      import: 'Failed to import MCP', update: 'Failed to update MCP', test: 'MCP test failed', remove: 'Failed to delete MCP', unavailableStatus: 'The server did not return an available status.',
      mapLine: (line) => `Line ${line} must use KEY=value`, importJson: 'MCP configuration must be valid JSON', importObject: 'MCP JSON must be an object',
      importVersion: (version) => `Unsupported MCP config version ${version}; versions 1, 2, and 3 are supported`, importServersObject: 'mcpServers must be an object',
      importProtocolVersion: 'Remote protocol preferences require version 2 or 3; stdio protocol preferences require version 3',
    },
    toast: {
      saved: 'MCP saved', savedDetail: 'New tools become available in the next conversation turn.', imported: 'MCP imported', importedDetail: (count) => `Imported ${count} ${count === 1 ? 'connection' : 'connections'}.`,
      connectionOk: 'MCP connection healthy', toolLatency: (count, latencyMs) => `${count} ${count === 1 ? 'tool' : 'tools'} · ${latencyMs} ms`,
      connectionFailed: 'MCP connection failed', removed: 'MCP deleted',
    },
    remove: { title: (id) => `Delete MCP “${id}”?`, description: 'Its tools disappear from the next conversation turn. This connection cannot be restored automatically.', confirm: 'Delete', cancel: 'Cancel' },
    page: {
      actionsAria: 'MCP actions', refreshing: 'Refreshing…', refresh: 'Refresh', add: 'Add MCP',
      metaConnections: (count) => `${count} connections`, metaErrors: (count) => `${count} ${count === 1 ? 'connection error' : 'connection errors'}`,
      searchMatches: (count) => `${count} ${count === 1 ? 'match' : 'matches'}`,
      toolbarAria: 'MCP connection controls', connections: 'Added', localStdio: 'Local command',
      searchPlaceholder: 'Search connections…', searchAria: 'Search MCP connections',
      clearSearch: 'Clear search', loading: 'Loading MCP connections…',
      noConnectionsMatch: 'No matching MCP connections', noConnectionsMatchDetail: (query) => `Try another keyword, or clear “${query}” to view every connection.`,
      recommended: 'Recommended',
      suggestions: {
        notion: { name: 'Notion', description: 'Access workspace pages' },
        linear: { name: 'Linear', description: 'Access issues and projects' },
        feishu: { name: 'Feishu', description: 'Access Feishu documents' },
        'mcp-docs': { name: 'Official MCP docs', description: 'Search protocol docs' },
      },
    },
    detail: {
      label: 'Connection details', enabled: 'Enabled', transport: 'Transport',
      toolsLabel: 'Tools', statusLabel: 'Status', protocolLabel: 'MCP protocol',
      negotiatedProtocol: (era, revision) => `${era === 'modern' ? 'Modern' : 'Legacy'} · ${revision}`,
      inspectorOpened: (id) => `${id} details opened`,
    },
    row: {
      needsAuth: 'Login required', login: 'Log in', loginPending: 'Complete authorization in your browser', cancelLogin: 'Cancel login', logout: 'Log out',
      testing: 'Testing…', test: 'Test', edit: 'Edit',
      delete: 'Delete', tools: (count) => `${count} ${count === 1 ? 'tool' : 'tools'}`,
      disabled: 'Disabled', disconnected: 'Disconnected', connecting: 'Connecting', connected: (count) => `${count} ${count === 1 ? 'tool' : 'tools'}`, failed: 'Connection failed',
    },
    editor: {
      idExists: 'A connection with this name already exists. Choose another name.', oauth: 'OAuth settings', oauthHelp: 'Usually leave this blank. Configure it only when the service provides fixed client credentials; a client ID also requires the authorization server issuer.', issuer: 'Authorization server issuer', clientId: 'Client ID', clientSecret: 'Client secret', scopes: 'Scopes (space separated)', callbackPort: 'Callback port (optional)',
      importTitle: 'Import from JSON', editTitle: (id) => `Edit ${id}`, addTitle: 'Add MCP', importSubtitle: 'Paste MCP configuration; connections with matching names will be updated.',
      manualSubtitle: 'This connection is saved in the current workspace.',
      manual: 'Manual configuration', pasteJson: 'Paste JSON', jsonConfig: 'JSON configuration',
      jsonHelp: 'Paste a complete configuration or a JSON object of named connections. Existing connections not listed here are preserved.', cancel: 'Cancel', importConnect: 'Import configuration',
      transportAria: 'Connection method', localStdio: 'Local command', remoteUrl: 'Remote URL',
      serverId: 'Connection name', command: 'Launch command',
      commandPlaceholder: 'node /path/to/server.js',
      commandHelp: 'Enter the launch command and arguments; quote arguments that contain spaces.',
      workingDirectory: 'Working directory', workingDirectoryPlaceholder: '/path/to/project',
      environment: 'Environment variables', environmentHelp: 'Add only variables required by this service, one KEY=value per line.', url: 'MCP URL', headers: 'HTTP headers', headersHelp: 'Use one Header=value per line, as specified by the service.',
      saveConnect: 'Save connection',
      required: 'This field is required.', invalidUrl: 'Enter a valid HTTP or HTTPS URL.', unbalancedQuote: 'Unclosed quote.',
      transportLabel: 'Remote transport', transportAuto: 'Automatic', transportStreamableHttp: 'Streamable HTTP', transportLegacySse: 'Legacy SSE',
      protocolLabel: 'MCP protocol version', protocolLegacy: 'Legacy protocol', protocolAuto: 'Auto-negotiate', protocolModern: '2026-07-28 only',
      protocolHelp: 'Auto-negotiation uses a version the service supports; pin a version only for compatibility.', sseProtocolHelp: 'Legacy SSE uses the legacy protocol.', expandAdvanced: 'Show advanced settings', collapseAdvanced: 'Hide advanced settings',
      stdioProtocolHelp: 'Auto-negotiation or modern-only mode starts the server one extra time to check protocol support.',
    },
  },
} satisfies UiCatalog<McpCopy>;

export function getMcpCopy(locale: UiLocale): McpCopy {
  return MCP_COPY[locale];
}
