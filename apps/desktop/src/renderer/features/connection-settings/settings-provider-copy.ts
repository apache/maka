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

type WidenCopy<T> = T extends string
  ? string
  : T extends (...args: infer Args) => string
    ? (...args: Args) => string
    : { [K in keyof T]: WidenCopy<T[K]> };

// Capability-section strings for the connection detail page — the add-provider
// form deliberately carries no declaration controls (capabilities are edited
// after the connection exists).
const zhCapabilitiesCopy = {
  capabilities: '能力',
  thinkingEffort: '思考档位（reasoning_effort）',
  thinkingEffortHelp: '勾选需要的思考强度档位，不勾选即为不声明。',
  thinkingUndeclared: '未声明',
  thinkingSelectedCount: (count: number) => `已选择 ${count} 个`,
  thinkingBulk: '批量设置思考档位',
  thinkingBulkHelp: '勾选写入下方全部已启用模型，取消勾选则从全部模型移除；其余档位不受影响。',
  thinkingBulkTrigger: '应用到全部模型',
  thinkingBulkCoverage: (declared: number, total: number) =>
    declared === 0 ? '全部未声明' : `${declared}/${total} 个模型`,
  visionInput: '视觉输入（vision）',
  visionInputHelp: '「自动」跟随内置元数据；「启用/禁用」是显式声明，覆盖自动判断。',
  visionAuto: '自动',
  visionEnabledOption: '启用',
  visionDisabledOption: '禁用',
  contextWindow: '上下文窗口（tokens）',
  contextWindowHelp: '设置后作为 Maka 压缩的触发阈值。留空则不主动压缩，由供应商决定何时超限。',
  contextWindowHint: (tokens: number) => `该模型声明的窗口为 ${tokens} tokens`,
  contextWindowApplyHint: '填入',
  saveCapabilities: '保存能力声明',
  fastMode: 'Fast 模式',
  fastModeHelp: '使用 OpenAI 的 fast service tier；留空跟随服务商默认值。',
  fastAuto: '自动',
  fastEnabled: 'Fast',
};
const enCapabilitiesCopy = {
  capabilities: 'Capabilities',
  thinkingEffort: 'Thinking levels (reasoning_effort)',
  thinkingEffortHelp: 'Tick the thinking levels this model supports; none ticked means undeclared.',
  thinkingUndeclared: 'Undeclared',
  thinkingSelectedCount: (count: number) => `${count} selected`,
  thinkingBulk: 'Set thinking levels for all models',
  thinkingBulkHelp:
    'Ticking adds the level to every enabled model below; unticking removes it from all of them. Other levels are left alone.',
  thinkingBulkTrigger: 'Apply to all models',
  thinkingBulkCoverage: (declared: number, total: number) =>
    declared === 0 ? 'On no model' : `On ${declared} of ${total} models`,
  visionInput: 'Vision input',
  visionInputHelp: 'Auto follows built-in metadata; Enabled/Disabled overrides it explicitly.',
  visionAuto: 'Auto',
  visionEnabledOption: 'Enabled',
  visionDisabledOption: 'Disabled',
  contextWindow: 'Context window (tokens)',
  contextWindowHelp: 'When set, Maka compacts once the previous request\'s real usage exceeds it. Leave empty to never compact proactively; the provider decides.',
  contextWindowHint: (tokens: number) => `This model declares a ${tokens}-token window`,
  contextWindowApplyHint: 'Use it',
  saveCapabilities: 'Save capability declarations',
  fastMode: 'Fast mode',
  fastModeHelp: "Use OpenAI's fast service tier; empty follows the provider default.",
  fastAuto: 'Auto',
  fastEnabled: 'Fast',
};

const zhCopy = {
  detail: {
    delete: '删除', cancel: '取消', deleteUnused: '不再需要，删除连接',
    deleteFailed: '删除模型连接失败', credentialReadFailed: '读取模型凭据状态失败', refreshFailed: '刷新模型连接失败',
    saveFailed: '保存模型连接失败', saveModelsFailed: '保存启用模型失败',
    modelKey: '模型密钥', pasteModelKey: '粘贴模型密钥', getModelKey: '获取模型密钥', saving: '保存中…',
    advancedRequest: '高级请求设置', advancedRequestHelp: '为这个连接的 HTTP 请求添加请求头和额外 JSON 请求体。请求头值作为凭据保存在本机。',
    requestHeaders: '自定义请求头', headerName: '请求头名称', headerValue: '请求头值', retainedHeaderValue: '保留已保存的值', addHeader: '添加请求头', removeHeader: '移除', noRequestHeaders: '未设置自定义请求头。',
    extraRequestBody: '额外请求体（JSON）', extraRequestBodyHelp: '仅添加顶层字段；若与 Maka 生成的字段重名，请求会明确失败。', requestCustomizationInvalid: '请求设置无效', requestHeadersInvalidDetail: '请检查请求头名称和值。', requestBodyInvalidDetail: '请输入符合要求的 JSON 对象。', saveAdvancedRequest: '保存高级请求设置', configuredHeaders: (count: number) => `${count} 个请求头`, noAdvancedRequest: '未设置',
    oauthLoggedIn: 'OAuth 已登录', oauthLoading: 'OAuth 状态读取中', oauthUnknown: 'OAuth 状态未知', oauthWaiting: '等待 OAuth 登录',
    oauthLoggedInDetail: '该模型连接使用主进程保存的 OAuth access token；若请求提示需要重新登录，请到账号连接重新授权。',
    oauthLoadingDetail: '正在读取本机 OAuth 登录状态，读取完成前不会把未知状态显示成未登录。',
    oauthUnknownDetail: '暂时无法读取本机 OAuth 登录状态；请刷新页面或重新打开设置。',
    oauthWaitingDetail: '请到账号连接完成登录；登录成功后会自动出现在模型连接里。',
    oauthRetired: '此登录方式已停用',
    oauthRetiredDetail:
      '这条连接使用的登录方式已从 Maka 移除，无法再登录，也无法用于对话。改用 Anthropic API Key 连接即可继续使用 Claude 模型；删除这条连接会一并清除本机保存的登录凭据。',
    credentialLoadingDetail: '正在读取模型凭据状态，读取完成前暂不测试连接或刷新模型。',
    credentialUnknownDetail: '模型凭据状态暂时没刷新成功，已避免把未知状态显示成未登录或未配置。',
    testConnection: '测试连接',
    updateModels: '更新模型目录', endpoint: '服务地址',
    connectionName: '名称',
    connectionNamePlaceholder: '给这个连接起个名字',
    addModel: '添加模型',
    addModelConfirm: '添加',
    addModelIdField: '模型 ID',
    addModelIdFieldHelp: '需与服务商完全一致，区分大小写。',
    addModelIdPlaceholder: 'deepseek-v4-pro-beta',
    addModelIdRequired: '请填写模型 ID。',
    addModelIdDuplicate: '该模型已在列表中。',
    addModelContextWindow: '上下文窗口',
    addModelContextWindowHelp: '服务商模型页给出的最大 token 数。缺少它 Maka 只能按 32k 处理，长对话会被提前截断。',
    addModelContextWindowRequired: '请填写上下文窗口。',
    credentials: '连接', dangerZone: '删除连接', deleteRowHelp: '此操作不可撤销。',
    credentialsHelp: '密钥只保存在本机。',
    credentialsHelpAccount: '登录令牌只保存在本机。',
    modelManagementHelp: '这些模型会出现在任务的模型选择器里。',
    ...zhCapabilitiesCopy,
    capabilitiesHelp: '声明每个已启用模型的思考档位、视觉与上下文窗口；保存后生效。',
    // Row affordances (settings-sidebar 的 InfoRow / ExpandableRow 语言)：一行
    // 只报状态，改的时候才展开成输入框。
    change: '更换', set: '设置', edit: '编辑', save: '保存',
    endpointManaged: '由账号登录或服务商管理',
    endpointMissing: '尚未配置服务地址',
    endpointModelOverridesNote: '部分模型会通过其他服务端点发送请求',
    endpointCredentialsMasked: '已保存的地址内嵌凭据,编辑时默认隐藏',
    modelManagement: '模型',
    disconnectAndDelete: '退出账号并删除',
    login: '登录', loggingIn: '登录中…', relogin: '重新登录',
    oauthReloginDetail: '若请求提示需要重新登录，点这里重新走一遍授权。', deviceCode: '登录码：',
    oauthStartDetail: '点下方按钮打开浏览器完成登录，授权成功后会自动刷新这里的状态。',
    enabledModels: '启用的模型',
    searchModels: '搜索模型', selectAllModels: '全部启用',
    noModels: '暂无可选模型，请先更新模型目录。',
    keySet: '已设置', statusLoading: '正在读取状态', credentialUnknown: '凭据状态未知', keyMissing: '尚未设置密钥',
    keyTroubleshooting: '模型密钥 / 服务地址 / 代理设置', endpointTroubleshooting: '本地服务 / 服务地址 / 代理设置', oauthTroubleshooting: 'OAuth 登录 / 代理设置',
    unknownDescription: (provider: string) => `该连接使用的 provider「${provider}」在当前版本未注册。配置和凭据会保留，切回支持它的版本即可继续使用。`,
    deleteProviderTitle: (name: string) => `删除供应商 ${name}？`,
    deleteConnectionTitle: (name: string) => `删除模型连接 ${name}？`,
    deleteUnknownDescription: '删除后，支持该 provider 的其他版本也无法恢复这条连接及其凭据。',
    deleteDescription: (isDefault: boolean, disconnectsAccount: boolean) => [
      disconnectsAccount
        ? '这会退出本机账号、删除 OAuth 凭据和模型连接；刷新后不会自动重新创建。'
        : '这会删除模型连接及其本机凭据；如需再次使用，需要重新添加。',
      isDefault
        ? '它当前是默认连接；删除后默认模型会变成未设置，已有任务可能需要重新选择模型。'
        : '',
    ].filter(Boolean).join(' '),
    connectionSuccess: (name: string) => `连接成功 · ${name}`, connectionFailed: (name: string) => `连接失败 · ${name}`,
    connectionFallbackTitle: (name: string) => `连接可用 · ${name}`,
    connectionFallbackDetail: (selected: readonly string[], tested: string) =>
      `你选择的 ${selected.join('、')} 当前未响应，已改用 ${tested} 验证连接可用；任务中继续使用你选择的模型可能会失败。`,
    connectionTestError: (name: string) => `连接测试出错 · ${name}`, modelsFetched: (count: number, name: string) => `已拉取 ${count} 个模型 · ${name}`,
    modelsFetchFailed: (name: string) => `拉取模型失败 · ${name}`,
    modelsFetchFailedDetail: (message: string, troubleshooting: string) => `${message} · 当前继续显示静态列表，请确认 ${troubleshooting} 后重试。`,
    authTroubleshooting: (value: string) => `鉴权失败，请确认 ${value} 后重试。`, recheckTroubleshooting: (value: string) => `检查 ${value} 后重试。`,
    modelKeyAria: (name: string) => `${name} 模型密钥`,
  },
  shared: {
    actionFallback: '模型连接服务暂时不可用，请稍后重试。', rateLimit: '当前账号或模型服务触发速率限制，请稍后重试。',
    timeout: '请求超时，请检查网络或代理后重试。', unavailable: '模型服务暂时不可用，请稍后重试。',
    network: '网络错误，请检查服务地址或代理设置后重试。', statusUnavailable: '连接测试状态暂时无法显示，请重新测试。',
    categories: { oauth: 'OAuth', domestic: '国内', overseas: '海外', local: '本地', custom: 'Custom' },
    connectionStatuses: { retired: '已停用 · 请删除', reauth: '需要重新登录', disabledFailed: '暂不可用 · 上次连接失败', disabled: '暂不可用', failed: '上次连接失败' },
    lastTest: {
      '连接已验证': '连接已验证', '鉴权失败': '鉴权失败', '请求超时': '请求超时', '网络错误': '网络错误', '模型服务返回错误': '模型服务返回错误', '连接测试失败': '连接测试失败',
      'connection verified': '连接已验证', 'authentication failed': '鉴权失败', 'request timed out': '请求超时', 'network error': '网络错误', 'provider returned an error': '模型服务返回错误', 'connection test failed': '连接测试失败',
      'claude oauth 未登录。': 'Claude OAuth 未登录。', 'claude oauth 本地凭据读取失败。': 'Claude OAuth 本地凭据读取失败。', 'claude oauth 需要重新登录。': 'Claude OAuth 需要重新登录。', 'claude oauth 已登录。': 'Claude OAuth 已登录。', 'claude oauth 已退出登录。': 'Claude OAuth 已退出登录。',
      'codex oauth 未登录。': 'Codex OAuth 未登录。', 'codex oauth 本地凭据读取失败。': 'Codex OAuth 本地凭据读取失败。', 'codex oauth 需要重新登录。': 'Codex OAuth 需要重新登录。', 'codex oauth 已登录。': 'Codex OAuth 已登录。', 'codex oauth 已退出登录。': 'Codex OAuth 已退出登录。',
      '当前账号无可用 codex 模型。': '当前账号无可用 Codex 模型。', 'codex 模型列表获取失败。': 'Codex 模型列表获取失败。',
      'github copilot 需要重新导入 github cli 登录。': 'GitHub Copilot 需要重新导入 GitHub CLI 登录。', 'github copilot 无法读取当前账号可用模型，请重新验证登录。': 'GitHub Copilot 无法读取当前账号可用模型，请重新验证登录。', 'github copilot 登录已导入。': 'GitHub Copilot 登录已导入。', 'github copilot 连接未能保存，请重新导入登录。': 'GitHub Copilot 连接未能保存，请重新导入登录。', 'github copilot 已移除本地登录。': 'GitHub Copilot 已移除本地登录。',
    },
  },
  panel: {
    tabs: { all: '全部', recommended: '推荐', accounts: '账号', plans: '模型计划', api: 'API', aggregators: '聚合服务', local: '本地' },
    loadFailed: '载入模型连接失败', loadingAria: '正在加载模型供应商', connections: '模型连接',
    retry: '点击重试。', empty: '还没有模型连接', connectionRemoved: '原连接已被删除或移除，已返回模型连接列表。',
    connectedLoading: '连接已添加，正在载入详情…', connectedLoadFailed: '连接已添加，但暂时无法刷新连接列表。',
    connectionIdentityChanged: '新连接的身份与登录结果不一致，请返回连接列表后重试。',
    emptyHelp: '从下方选择一种连接方式开始。', default: '默认', setDefault: '设为默认', setDefaultTitle: '让新任务默认使用这个连接', setDefaultPending: '设置中…', setDefaultFailed: '设为默认失败', addHelp: '选择账号登录、模型计划、API、聚合服务或本地运行时。',
    categoriesAria: '模型供应商分类', searchPlaceholder: '搜索服务商', searchAria: '搜索模型服务商', noMatch: '没有匹配的服务商', clearSearch: '清除搜索',
    createSubtitle: '完成必要配置后，连接会出现在模型页上方。', connection: '模型连接',
    count: (value: number) => `· ${value}`, connectTitle: (name: string) => `连接 ${name}`,
    chipAria: (name: string, provider: string, isDefault: boolean, status?: string) => `模型连接：${name}，供应商：${provider}${isDefault ? '，默认连接' : ''}${status ? `，${status}` : ''}`,
    addConnection: '添加连接', category: '分类', backToList: '返回模型连接', backToCatalog: '返回服务商列表',
  },
  catalog: {
    unavailable: '未开放',
    cardAria: (name: string, description: string) => `添加模型供应商：${name}，${description}`,
  },
  add: {
    invalidSlug: '连接标识格式不正确', duplicateSlug: '连接标识已存在', cloudflareAccount: '请填写 Cloudflare Account ID', endpointRequired: '这个供应商需要填写服务地址',
    accountLogin: '请到账号连接完成登录；登录成功后会自动创建模型连接。',
    apiKeyPlaceholder: '输入或粘贴 API Key', cancel: '取消', accountTitle: '使用账号连接登录',
    advancedRequest: '高级请求设置', expandAdvancedRequest: '展开高级请求设置', collapseAdvancedRequest: '收起高级请求设置',
    requestHeaders: '自定义请求头', headerName: '请求头名称', headerValue: '请求头值', retainedHeaderValue: '保留已保存的值', addHeader: '添加请求头', removeHeader: '移除', noRequestHeaders: '未设置自定义请求头。',
    extraRequestBody: '额外请求体（JSON）', extraRequestBodyHelp: '仅添加顶层字段；与 Maka 生成字段重名时会明确失败。请求头值将作为凭据保存在本机。', requestCustomizationInvalid: '请检查高级请求设置。',
    accountDetail: '不要在这里手动添加；请回到模型连接页的账号连接完成登录，Maka 会自动创建并刷新模型连接。',
    slug: '连接标识', name: '显示名称',
    accountIdPlaceholder: '填写账户 ID',
    saving: '保存中…', save: '保存供应商', keyRequired: (name: string) => `请填写 ${name} API Key`,
    apiKeyLabel: 'API Key', accountIdLabel: 'Cloudflare Account ID', endpointLabel: '服务地址',
    defaultModel: '默认模型', defaultModelPlaceholder: '留空即可，保存后自动拉取', defaultModelHelp: '保存后 Maka 会向该端点拉取模型目录。只有当端点不提供目录时，才需要在这里手填一个模型 ID。',
    onboardingVerifyAndChoose: '验证并选择模型', onboardingVerifying: '正在验证密钥并获取模型…',
    onboardingChooseModels: '选择此连接使用的模型', onboardingChooseModelsHelp: '添加后仍可在连接详情中启用其他模型。', onboardingEnabledModels: '启用的模型', onboardingSearchModels: '搜索模型', onboardingAddConnection: '添加连接', onboardingBack: '返回修改',
    onboardingAuthFailed: '密钥验证失败，请检查后重试。', onboardingTimeout: '验证超时，请检查网络或代理后重试。', onboardingNetwork: '无法连接模型服务，请检查网络、代理或服务地址。', onboardingUnavailable: '模型连接服务暂时不可用，请稍后重试。', onboardingInvalidResponse: '模型服务返回了无法识别的结果，请稍后重试。', onboardingCatalogFull: '连接数量已达上限，请先删除不再使用的连接。', onboardingModelsChanged: '可用模型已发生变化，请重新验证后选择。', onboardingNoModels: '没有发现可用模型，当前未创建连接。', onboardingSelectModel: '请至少启用一个模型。',
    onboardingOutcomeUnknown: '保存结果暂时无法确认', onboardingOutcomeUnknownDetail: '请勿再次添加，以免创建重复连接。重新加载连接列表并检查该连接是否已经出现；仍不确定时请先重连 Runtime Host。', onboardingReloadConnections: '重新加载连接列表', onboardingRestart: '仍要添加另一个连接',
    ...zhCapabilitiesCopy,
  },
  oauthFlow: {
    refreshFailed: '刷新登录状态失败', accountActionFailed: (name: string) => `${name} 账号操作失败`, loginFailedRetry: '登录失败，请稍后重试。',
    retry: '请稍后再试。', startFailed: '无法开始登录', startFailedRetry: '无法开始登录，请稍后再试。', openFailed: '无法打开浏览器',
    openFailedRetry: '无法打开浏览器，请稍后重试。', loginSuccess: '登录成功', bound: (name: string) => `${name} 已绑定本机。`,
    incomplete: '登录未完成', incompleteRetry: '登录未完成，请重新打开浏览器授权。', loginFailed: '登录失败',
    logoutDescription: '将删除本机保存的订阅凭据，之后需要重新登录才能继续使用这些 OAuth 模型。', logout: '退出登录', cancel: '取消',
    loggedOut: '已退出登录', credentialsCleared: '本地凭据已清除。', logoutFailed: '退出失败', logoutFailedRetry: '退出登录失败，请稍后重试。',
    serviceUnavailable: '登录服务暂时不可用，请检查网络后重试。',
    logoutTitle: (name: string) => `退出 ${name} 登录？`,
  },
  oauthSection: {
    signedIn: '已登录', codexDescription: '使用 ChatGPT Plus / Pro 账号添加连接。', xaiDescription: '使用 SuperGrok / X Premium 账号添加连接。',
    configuredConnections: (count: number) => `已有 ${count} 个连接 · 添加另一个账号`,
    copilotDescription: '使用 GitHub 登录连接 Copilot 订阅，或导入兼容凭据。', serviceUnavailable: '登录服务暂时不可用，请检查网络后重试。',
    aria: 'OAuth 登录',
    staleState: 'OAuth 登录状态暂时没刷新成功，已保留上一次状态。',
    codexDetail: '点击下方按钮打开设备授权页，并在页面中输入这里显示的登录码。', xaiDetail: '点击下方按钮打开浏览器登录，授权完成后会自动回写。', deviceCode: '登录码：',
    openingBrowser: '打开浏览器…', waitingAuthorization: '等待浏览器授权…', logout: '退出登录', loggingOut: '退出中…',
    copilotSubtitle: '使用 GitHub 登录，或导入兼容凭据；token 不会暴露给渲染进程。', copilotImported: '已导入 GitHub Copilot 订阅账号。',
    copilotSetup: '使用 GitHub 登录以连接 Copilot，或导入已有的 gh 凭据。', importing: '导入中…',
    copilotSignIn: '使用 GitHub 登录', copilotActionFailed: 'GitHub Copilot 账号操作失败',
    copilotSignInDisabledHint: '本机未启用 GitHub 登录；请改用导入兼容凭据，或由管理员启用后重试。',
    importCredential: '导入兼容凭据',
    loadingAccount: '正在加载账号状态…', authorizing: '请在弹出的浏览器窗口完成登录。', refreshing: '正在刷新访问令牌…', refreshTokenFailed: '令牌刷新失败，请重新登录。',
    cardAria: (intent: 'add' | 'import' | 'manage', name: string, status: string | undefined, description: string) => `${intent === 'add' ? '添加' : intent === 'import' ? '导入' : '管理'}账号连接：${name}${status ? `，状态：${status}` : ''}，${description.replace(/[。.!！？?]+$/u, '')}`,
    connectTitle: (name: string) => `连接 ${name}`, addAccountTitle: (name: string) => `添加 ${name} 账号`, login: (name: string) => `登录 ${name}`, loginAndAdd: '登录并添加', signedOut: (name: string) => `${name} 尚未登录。`,
    storageFailed: (name: string) => `${name} 本地凭据读取失败，请重新登录。`, providerUnavailable: (name: string) => `${name} 已登录，但当前 provider 状态不可用。`,
  },
} as const;

export type ProviderSettingsCopy = WidenCopy<typeof zhCopy>;

const enCopy: ProviderSettingsCopy = {
  detail: {
    delete: 'Delete', cancel: 'Cancel', deleteUnused: 'Delete unused connection',
    deleteFailed: 'Failed to delete model connection', credentialReadFailed: 'Failed to read model credential status', refreshFailed: 'Failed to refresh model connection',
    saveFailed: 'Failed to save model connection', saveModelsFailed: 'Failed to save enabled models',
    modelKey: 'Model key', pasteModelKey: 'Paste model key', getModelKey: 'Get model key', saving: 'Saving…',
    advancedRequest: 'Advanced request settings', advancedRequestHelp: 'Add HTTP headers and extra JSON request-body fields for this connection. Header values stay in the local credential vault.',
    requestHeaders: 'Custom request headers', headerName: 'Header name', headerValue: 'Header value', retainedHeaderValue: 'Keep saved value', addHeader: 'Add header', removeHeader: 'Remove', noRequestHeaders: 'No custom request headers.',
    extraRequestBody: 'Extra request body (JSON)', extraRequestBodyHelp: 'Adds top-level fields only. A collision with a Maka-generated field fails explicitly.', requestCustomizationInvalid: 'Invalid request settings', requestHeadersInvalidDetail: 'Check the request header names and values.', requestBodyInvalidDetail: 'Enter a valid JSON object that meets the requirements.', saveAdvancedRequest: 'Save advanced request settings', configuredHeaders: (count: number) => `${count} ${count === 1 ? 'header' : 'headers'}`, noAdvancedRequest: 'Not configured',
    oauthLoggedIn: 'OAuth signed in', oauthLoading: 'Reading OAuth status', oauthUnknown: 'OAuth status unavailable', oauthWaiting: 'Waiting for OAuth sign-in',
    oauthLoggedInDetail: 'This model connection uses an OAuth access token stored by the main process. If a request asks you to sign in again, reauthorize it under account connections.',
    oauthLoadingDetail: 'Reading the local OAuth status. An unknown state will not be shown as signed out.',
    oauthUnknownDetail: 'The local OAuth status is temporarily unavailable. Refresh the page or reopen Settings.',
    oauthWaitingDetail: 'Complete sign-in under account connections. The model connection appears automatically afterward.',
    oauthRetired: 'This sign-in path is retired',
    oauthRetiredDetail:
      'The sign-in this connection uses was removed from Maka. It can no longer be signed into or used in a conversation. Add an Anthropic API key connection to keep using Claude models; deleting this connection also clears the sign-in credential stored on this machine.',
    credentialLoadingDetail: 'Reading model credential status. Connection tests and model refresh are paused until it finishes.',
    credentialUnknownDetail: 'Model credential status could not be refreshed, so the connection is not being mislabeled as signed out or unconfigured.',
    testConnection: 'Test connection',
    updateModels: 'Update model catalog', endpoint: 'Service URL',
    connectionName: 'Name',
    connectionNamePlaceholder: 'Name this connection',
    addModel: 'Add model',
    addModelConfirm: 'Add',
    addModelIdField: 'Model ID',
    addModelIdFieldHelp: 'Must match the provider exactly, including case.',
    addModelIdPlaceholder: 'deepseek-v4-pro-beta',
    addModelIdRequired: 'Enter a model ID.',
    addModelIdDuplicate: 'This model is already in the list.',
    addModelContextWindow: 'Context window',
    addModelContextWindowHelp:
      "The maximum token count from the provider's model page. Without it Maka can only assume 32k, and long conversations get truncated early.",
    addModelContextWindowRequired: 'Enter a context window.',
    credentials: 'Connection', dangerZone: 'Delete connection', deleteRowHelp: 'This cannot be undone.',
    credentialsHelp: 'The key stays on this machine.',
    credentialsHelpAccount: 'The sign-in token stays on this machine.',
    modelManagementHelp: 'These models appear in the chat model picker.',
    ...enCapabilitiesCopy,
    capabilitiesHelp: 'Declares thinking levels, vision, and context window per enabled model; applies on save.',
    change: 'Change', set: 'Set', edit: 'Edit', save: 'Save',
    endpointManaged: 'Managed by account sign-in or the provider',
    endpointMissing: 'No service URL configured',
    endpointModelOverridesNote: 'Some models send requests through a different endpoint',
    endpointCredentialsMasked: 'The saved URL embeds credentials and stays masked while editing',
    modelManagement: 'Models',
    disconnectAndDelete: 'Sign out and delete',
    login: 'Sign in', loggingIn: 'Signing in…', relogin: 'Sign in again',
    oauthReloginDetail: 'If a request asks you to sign in again, restart authorization here.', deviceCode: 'Sign-in code:',
    oauthStartDetail: 'Open the browser below to sign in. This status refreshes automatically after authorization.',
    enabledModels: 'Enabled models',
    searchModels: 'Search models', selectAllModels: 'Enable all',
    noModels: 'No models are available. Update the model catalog first.',
    keySet: 'Set', statusLoading: 'Reading status', credentialUnknown: 'Credential status unavailable', keyMissing: 'No key set',
    keyTroubleshooting: 'model key, service URL, and proxy settings', endpointTroubleshooting: 'local service, service URL, and proxy settings', oauthTroubleshooting: 'OAuth sign-in and proxy settings',
    unknownDescription: (provider: string) => `The provider “${provider}” used by this connection is not registered in the current version. Its configuration and credentials are preserved for a supported version.`,
    deleteProviderTitle: (name: string) => `Delete provider ${name}?`,
    deleteConnectionTitle: (name: string) => `Delete model connection ${name}?`,
    deleteUnknownDescription: 'After deletion, another version that supports this provider cannot restore the connection or its credentials.',
    deleteDescription: (isDefault: boolean, disconnectsAccount: boolean) => [
      disconnectsAccount
        ? 'This signs out the local account and deletes its OAuth credential and model connection. It will not be recreated on refresh.'
        : 'This deletes the model connection and its local credential. Add it again to use it later.',
      isDefault
        ? 'It is currently the default connection; the default model becomes unset and existing chats may need another model selected.'
        : '',
    ].filter(Boolean).join(' '),
    connectionSuccess: (name: string) => `Connected · ${name}`, connectionFailed: (name: string) => `Connection failed · ${name}`,
    connectionFallbackTitle: (name: string) => `Connection works · ${name}`,
    connectionFallbackDetail: (selected: readonly string[], tested: string) =>
      `Your selected ${selected.join(', ')} didn't respond; verified the connection with ${tested} instead. Tasks using your selected model may fail.`,
    connectionTestError: (name: string) => `Connection test error · ${name}`, modelsFetched: (count: number, name: string) => `Fetched ${count} ${count === 1 ? 'model' : 'models'} · ${name}`,
    modelsFetchFailed: (name: string) => `Failed to fetch models · ${name}`,
    modelsFetchFailedDetail: (message: string, troubleshooting: string) => `${message} · The static list remains visible. Check ${troubleshooting} and try again.`,
    authTroubleshooting: (value: string) => `Authentication failed. Check ${value} and try again.`, recheckTroubleshooting: (value: string) => `Check ${value} and try again.`,
    modelKeyAria: (name: string) => `${name} model key`,
  },
  shared: {
    actionFallback: 'The model connection service is temporarily unavailable. Try again later.', rateLimit: 'This account or model service is rate-limited. Try again later.',
    timeout: 'The request timed out. Check the network or proxy and try again.', unavailable: 'The model service is temporarily unavailable. Try again later.',
    network: 'Network error. Check the service URL or proxy settings and try again.', statusUnavailable: 'The connection test status is temporarily unavailable. Test again.',
    categories: { oauth: 'OAuth', domestic: 'China', overseas: 'Global', local: 'Local', custom: 'Custom' },
    connectionStatuses: { retired: 'Retired · delete it', reauth: 'Sign-in required', disabledFailed: 'Unavailable · last connection failed', disabled: 'Unavailable', failed: 'Last connection failed' },
    lastTest: {
      '连接已验证': 'Connection verified', '鉴权失败': 'Authentication failed', '请求超时': 'Request timed out', '网络错误': 'Network error', '模型服务返回错误': 'Model service returned an error', '连接测试失败': 'Connection test failed',
      'connection verified': 'Connection verified', 'authentication failed': 'Authentication failed', 'request timed out': 'Request timed out', 'network error': 'Network error', 'provider returned an error': 'Model service returned an error', 'connection test failed': 'Connection test failed',
      'claude oauth 未登录。': 'Claude OAuth is signed out.', 'claude oauth 本地凭据读取失败。': 'Could not read local Claude OAuth credentials.', 'claude oauth 需要重新登录。': 'Claude OAuth requires sign-in.', 'claude oauth 已登录。': 'Claude OAuth is signed in.', 'claude oauth 已退出登录。': 'Claude OAuth signed out.',
      'codex oauth 未登录。': 'Codex OAuth is signed out.', 'codex oauth 本地凭据读取失败。': 'Could not read local Codex OAuth credentials.', 'codex oauth 需要重新登录。': 'Codex OAuth requires sign-in.', 'codex oauth 已登录。': 'Codex OAuth is signed in.', 'codex oauth 已退出登录。': 'Codex OAuth signed out.',
      '当前账号无可用 codex 模型。': 'No Codex models are available for this account.', 'codex 模型列表获取失败。': 'Failed to fetch the Codex model list.',
      'github copilot 需要重新导入 github cli 登录。': 'GitHub Copilot requires the GitHub CLI sign-in to be imported again.', 'github copilot 无法读取当前账号可用模型，请重新验证登录。': 'GitHub Copilot could not read models available to this account. Verify sign-in again.', 'github copilot 登录已导入。': 'GitHub Copilot sign-in imported.', 'github copilot 连接未能保存，请重新导入登录。': 'The GitHub Copilot connection could not be saved. Import sign-in again.', 'github copilot 已移除本地登录。': 'Local GitHub Copilot sign-in removed.',
    },
  },
  panel: {
    tabs: { all: 'All', recommended: 'Recommended', accounts: 'Accounts', plans: 'Model plans', api: 'API', aggregators: 'Aggregators', local: 'Local' },
    loadFailed: 'Failed to load model connections', loadingAria: 'Loading model providers', connections: 'Connections',
    retry: 'Select to retry.', empty: 'No model connections yet', connectionRemoved: 'The original connection was deleted or removed. Returned to the connection list.',
    connectedLoading: 'Connection added. Loading its details…', connectedLoadFailed: 'Connection added, but the connection list could not be refreshed yet.',
    connectionIdentityChanged: 'The new connection identity did not match the sign-in result. Return to the connection list and try again.',
    emptyHelp: 'Choose a connection method below to begin.', default: 'Default', setDefault: 'Set as default', setDefaultTitle: 'New chats will use this connection', setDefaultPending: 'Setting…', setDefaultFailed: 'Could not set as default', addHelp: 'Choose account sign-in, a model plan, API, aggregator, or local runtime.',
    categoriesAria: 'Model provider categories', searchPlaceholder: 'Search providers', searchAria: 'Search model providers', noMatch: 'No matching providers', clearSearch: 'Clear search',
    createSubtitle: 'After required setup, the connection appears above on the Models page.', connection: 'Model connection',
    count: (value: number) => `· ${value}`, connectTitle: (name: string) => `Connect ${name}`,
    chipAria: (name: string, provider: string, isDefault: boolean, status?: string) => `Model connection: ${name}; provider: ${provider}${isDefault ? '; default connection' : ''}${status ? `; ${status}` : ''}`,
    addConnection: 'Add connection', category: 'Category', backToList: 'Back to model connections', backToCatalog: 'Back to the provider list',
  },
  catalog: {
    unavailable: 'Unavailable',
    cardAria: (name: string, description: string) => `Add model provider: ${name}; ${description}`,
  },
  add: {
    invalidSlug: 'The connection identifier format is invalid', duplicateSlug: 'Connection identifier already exists', cloudflareAccount: 'Enter the Cloudflare Account ID', endpointRequired: 'This provider requires a service URL',
    accountLogin: 'Complete sign-in under account connections. A model connection is created automatically afterward.',
    apiKeyPlaceholder: 'Enter or paste API key', cancel: 'Cancel', accountTitle: 'Sign in with an account connection',
    advancedRequest: 'Advanced request settings', expandAdvancedRequest: 'Show advanced request settings', collapseAdvancedRequest: 'Hide advanced request settings',
    requestHeaders: 'Custom request headers', headerName: 'Header name', headerValue: 'Header value', retainedHeaderValue: 'Keep saved value', addHeader: 'Add header', removeHeader: 'Remove', noRequestHeaders: 'No custom request headers.',
    extraRequestBody: 'Extra request body (JSON)', extraRequestBodyHelp: 'Adds top-level fields only. A collision with a Maka-generated field fails explicitly. Header values stay in the local credential vault.', requestCustomizationInvalid: 'Check the advanced request settings.',
    accountDetail: 'Do not add this provider manually here. Return to account connections and sign in; Maka creates and refreshes the model connection automatically.',
    slug: 'Connection identifier', name: 'Display name',
    accountIdPlaceholder: 'Enter account ID',
    saving: 'Saving…', save: 'Save provider', keyRequired: (name: string) => `Enter the ${name} API key`,
    apiKeyLabel: 'API key', accountIdLabel: 'Cloudflare Account ID', endpointLabel: 'Service URL',
    defaultModel: 'Default model', defaultModelPlaceholder: 'Leave empty — fetched after saving', defaultModelHelp: 'Maka fetches the model catalog from this endpoint after saving. Type a model id here only if the endpoint serves no catalog.',
    onboardingVerifyAndChoose: 'Verify and choose models', onboardingVerifying: 'Verifying the key and loading models…',
    onboardingChooseModels: 'Choose models for this connection', onboardingChooseModelsHelp: 'You can enable more models from the connection details later.', onboardingEnabledModels: 'Enabled models', onboardingSearchModels: 'Search models', onboardingAddConnection: 'Add connection', onboardingBack: 'Back to edit',
    onboardingAuthFailed: 'The key could not be verified. Check it and try again.', onboardingTimeout: 'Verification timed out. Check the network or proxy and try again.', onboardingNetwork: 'Could not reach the model provider. Check the network, proxy, or service URL.', onboardingUnavailable: 'The model connection service is unavailable. Try again later.', onboardingInvalidResponse: 'The model provider returned an unrecognized response. Try again later.', onboardingCatalogFull: 'The connection limit has been reached. Remove an unused connection first.', onboardingModelsChanged: 'The available models changed. Verify again and make a new selection.', onboardingNoModels: 'No usable models were found. No connection was created.', onboardingSelectModel: 'Enable at least one model.',
    onboardingOutcomeUnknown: 'The save result cannot be confirmed', onboardingOutcomeUnknownDetail: 'Do not add it again yet, because that could create a duplicate connection. Reload the connection list and check whether this connection appeared; reconnect the Runtime Host if the result is still unclear.', onboardingReloadConnections: 'Reload connection list', onboardingRestart: 'Add another connection anyway',
    ...enCapabilitiesCopy,
  },
  oauthFlow: {
    refreshFailed: 'Failed to refresh sign-in status', accountActionFailed: (name: string) => `${name} account action failed`, loginFailedRetry: 'Sign-in failed. Try again later.',
    retry: 'Try again later.', startFailed: 'Could not start sign-in', startFailedRetry: 'Could not start sign-in. Try again later.', openFailed: 'Could not open browser',
    openFailedRetry: 'Could not open the browser. Try again.', loginSuccess: 'Signed in', bound: (name: string) => `${name} is connected to this device.`,
    incomplete: 'Sign-in incomplete', incompleteRetry: 'Sign-in did not finish. Reopen the browser authorization and try again.', loginFailed: 'Sign-in failed',
    logoutDescription: 'This removes the locally stored subscription credentials. You must sign in again to use these OAuth models.', logout: 'Sign out', cancel: 'Cancel',
    loggedOut: 'Signed out', credentialsCleared: 'Local credentials cleared.', logoutFailed: 'Sign-out failed', logoutFailedRetry: 'Sign-out failed. Try again later.',
    serviceUnavailable: 'The sign-in service is temporarily unavailable. Check the network and try again.',
    logoutTitle: (name: string) => `Sign out of ${name}?`,
  },
  oauthSection: {
    signedIn: 'Signed in', codexDescription: 'Use a ChatGPT Plus / Pro account to add a connection.', xaiDescription: 'Use a SuperGrok or X Premium account to add a connection.',
    configuredConnections: (count: number) => `${count} ${count === 1 ? 'connection' : 'connections'} configured · Add another account`,
    copilotDescription: 'Sign in with GitHub to connect a Copilot subscription, or import compatible credentials.', serviceUnavailable: 'The sign-in service is temporarily unavailable. Check the network and try again.',
    aria: 'OAuth sign-in',
    staleState: 'OAuth sign-in status could not be refreshed. The last known state is preserved. ',
    codexDetail: 'Open the device page below and enter the sign-in code shown here.', xaiDetail: 'Open the browser below to sign in. Authorization is written back automatically.', deviceCode: 'Sign-in code:',
    openingBrowser: 'Opening browser…', waitingAuthorization: 'Waiting for browser authorization…', logout: 'Sign out', loggingOut: 'Signing out…',
    copilotSubtitle: 'Sign in with GitHub, or import compatible credentials. The token is never exposed to the renderer.', copilotImported: 'GitHub Copilot subscription account imported.',
    copilotSetup: 'Sign in with GitHub to connect Copilot, or import an existing gh credential.', importing: 'Importing…',
    copilotSignIn: 'Sign in with GitHub', copilotActionFailed: 'GitHub Copilot account action failed',
    copilotSignInDisabledHint: 'GitHub sign-in is not enabled on this install. Import a compatible credential instead, or ask an operator to enable it.',
    importCredential: 'Import compatible credentials',
    loadingAccount: 'Loading account status…', authorizing: 'Complete sign-in in the browser window.', refreshing: 'Refreshing access token…', refreshTokenFailed: 'Token refresh failed. Sign in again.',
    cardAria: (intent: 'add' | 'import' | 'manage', name: string, status: string | undefined, description: string) => `${intent === 'add' ? 'Add' : intent === 'import' ? 'Import' : 'Manage'} account connection: ${name}${status ? `; status: ${status}` : ''}; ${description.replace(/[。.!！？?]+$/u, '')}`,
    connectTitle: (name: string) => `Connect ${name}`, addAccountTitle: (name: string) => `Add ${name} account`, login: (name: string) => `Sign in to ${name}`, loginAndAdd: 'Sign in and add', signedOut: (name: string) => `${name} is signed out.`,
    storageFailed: (name: string) => `Could not read local credentials for ${name}. Sign in again.`, providerUnavailable: (name: string) => `${name} is signed in, but the provider status is currently unavailable.`,
  },
};

const PROVIDER_SETTINGS_COPY = { zh: zhCopy, en: enCopy } satisfies UiCatalog<ProviderSettingsCopy>;

export function getProviderSettingsCopy(locale: UiLocale): ProviderSettingsCopy {
  return PROVIDER_SETTINGS_COPY[locale];
}
