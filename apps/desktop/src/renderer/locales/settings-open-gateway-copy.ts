import type { UiCatalog, UiLocale } from '@maka/core';

type EndpointCopy = { title: string; detail: string; copyAria?: string };

export type OpenGatewaySettingsCopy = {
  errors: {
    save: string;
    loadStatus: string;
    copyTitle: string;
    copyDetail: string;
    start: string;
    portInUse: string;
  };
  toast: {
    tokenSaved: string;
    tokenCleared: string;
    tokenGenerated: string;
    tokenGeneratedDetail: string;
    baseUrlCopied: string;
    overviewCopied: string;
    overviewDetail: string;
    openApiCopied: string;
    openApiDetail: string;
    sessionStateCopied: string;
    sessionStateTemplateDetail: string;
    sessionStateDetail: string;
    eventStreamCopied: string;
    eventStreamTemplateDetail: string;
    eventStreamDetail: string;
    recentEventsCopied: string;
    recentEventsTemplateDetail: string;
    recentEventsDetail: string;
    recentRequestsCopied: string;
    recentRequestsDetail: string;
  };
  summary: {
    aria: string;
    status: string;
    address: string;
    lanAccessible: string;
    localOnly: string;
    credentials: string;
    configured: string;
    waitingToken: string;
    credentialsDetail: string;
    connections: string;
    connectionsDetail: string;
    capability: string;
    endpointCount: string;
    capabilityDetail: string;
  };
  status: {
    disabled: string;
    disabledDetail: string;
    waitingToken: string;
    waitingTokenDetail: string;
    loading: string;
    loadingDetail: string;
    running: string;
    startedDetail: string;
    listeningDetail: string;
    failed: string;
    loadFailed(error: string): string;
    startStatus(error: string): string;
  };
  form: {
    enabled: string;
    enabledHelp: string;
    host: string;
    port: string;
    token: string;
    tokenPlaceholder: string;
    sessionId: string;
    sessionPlaceholder: string;
    waitingNotice: string;
  };
  actions: {
    aria: string;
    generateToken: string;
    clearToken: string;
    copying: string;
    copyAddress: string;
    copyCurl: string;
  };
  endpoints: {
    health: EndpointCopy;
    openApi: EndpointCopy;
    overview: EndpointCopy;
    capabilities: EndpointCopy;
    sessions: EndpointCopy;
    sessionsState: EndpointCopy;
    sessionState: EndpointCopy;
    messages: EndpointCopy;
    messagesState: EndpointCopy;
    sendMessage: EndpointCopy;
    events: EndpointCopy;
    eventsState: EndpointCopy;
    recentEvents: EndpointCopy;
    globalEventsState: EndpointCopy;
    recentRequests: EndpointCopy;
    incidents: EndpointCopy;
    incidentIndex: EndpointCopy;
    incidentState: EndpointCopy;
    search: EndpointCopy;
  };
  help: string;
};

const SETTINGS_OPEN_GATEWAY_COPY = {
  zh: {
    errors: {
      save: '保存开放网关设置失败',
      loadStatus: '读取开放网关状态失败',
      copyTitle: '复制失败',
      copyDetail: '剪贴板不可用或被系统拒绝。',
      start: '开放网关暂时无法启动，请检查监听地址和端口。',
      portInUse: '端口已被占用',
    },
    toast: {
      tokenSaved: '网关 token 已保存',
      tokenCleared: '网关 token 已清空',
      tokenGenerated: '网关 token 已生成',
      tokenGeneratedDetail: '本机 API 需要 Authorization Bearer token。',
      baseUrlCopied: '已复制网关地址',
      overviewCopied: '已复制总览 curl',
      overviewDetail: '可在终端验证开放网关状态。',
      openApiCopied: '已复制接口说明 curl',
      openApiDetail: '可交给外部工具发现本机 API。',
      sessionStateCopied: '已复制单会话状态 curl',
      sessionStateTemplateDetail: '把 <SESSION_ID> 替换成目标会话 ID 后运行。',
      sessionStateDetail: '可在终端查看单个会话状态。',
      eventStreamCopied: '已复制事件流 curl',
      eventStreamTemplateDetail: '把 <SESSION_ID> 替换成目标会话 ID 后运行。',
      eventStreamDetail: '可在终端观察当前会话事件。',
      recentEventsCopied: '已复制最近事件 curl',
      recentEventsTemplateDetail: '把 <SESSION_ID> 替换成目标会话 ID 后运行。',
      recentEventsDetail: '可在终端查看最近事件摘要。',
      recentRequestsCopied: '已复制最近请求 curl',
      recentRequestsDetail: '可在终端查看网关请求元数据。',
    },
    summary: {
      aria: '开放网关状态', status: '状态', address: '监听地址', lanAccessible: '局域网可访问', localOnly: '仅本机',
      credentials: '访问凭据', configured: '已配置', waitingToken: '等待 token', credentialsDetail: 'Bearer token 保护所有 /v1 API',
      connections: '实时连接', connectionsDetail: 'SSE 客户端', capability: '能力', endpointCount: '19 个端点',
      capabilityDetail: '/health · openapi · state · sessions · events · requests',
    },
    status: {
      disabled: '已关闭', disabledDetail: '设置开关关闭', waitingToken: '等待 token', waitingTokenDetail: '生成访问 token 后服务会自动启动',
      loading: '读取中', loadingDetail: '正在读取运行状态', running: '运行中', startedDetail: '本机 API 已启动', listeningDetail: '服务已监听', failed: '启动失败',
      loadFailed: (error) => `开放网关运行状态读取失败：${error}`,
      startStatus: (error) => `启动状态：${error}`,
    },
    form: {
      enabled: '开放本机 API 网关', enabledHelp: '启动一个本机 HTTP 服务，让外部工具读取会话、消息和本地搜索结果。',
      host: '监听地址', port: '端口', token: '访问 token',
      tokenPlaceholder: '生成或输入 token', sessionId: '会话 sessionId',
      sessionPlaceholder: '留空则复制 <SESSION_ID> 模板',
      waitingNotice: '网关已开启，等待生成访问 token。生成 token 后服务会自动启动。',
    },
    actions: { aria: '开放网关操作', generateToken: '生成 token', clearToken: '清空 token', copying: '复制中…', copyAddress: '复制地址', copyCurl: '复制 curl' },
    endpoints: {
      health: { title: '健康检查', detail: '不需要 token，用于确认网关进程是否启动。' },
      openApi: { title: '接口说明', detail: '需要 Bearer token，返回 OpenAPI 3.1 描述，方便外部工具自动发现开放网关能力。', copyAria: '复制接口说明 curl' },
      overview: { title: '总览状态', detail: '需要 Bearer token，返回网关运行态、会话状态、请求状态、失败索引状态和能力清单，不含正文或预览。', copyAria: '复制总览 curl' },
      capabilities: { title: '能力清单', detail: '需要 Bearer token，返回当前开放的本机 API 能力。' },
      sessions: { title: '会话列表', detail: '需要 Bearer token，返回本地 session summary。' },
      sessionsState: { title: '会话状态', detail: '需要 Bearer token，返回会话数量、未读数、状态分布和最近失败计数，不含标题或预览。' },
      sessionState: { title: '单会话状态', detail: '需要 Bearer token，返回单个会话的状态、消息计数、事件缓冲和失败计数，不含标题、正文或预览。', copyAria: '复制单会话状态 curl' },
      messages: { title: '会话消息', detail: '需要 Bearer token，按 sessionId 读取本地消息；支持 limit / before 分页。' },
      messagesState: { title: '消息状态', detail: '需要 Bearer token，返回消息数量和边界摘要，不含正文。' },
      sendMessage: { title: '发送消息', detail: '需要 Bearer token，向已有会话追加一条用户消息并返回 turnId。' },
      events: { title: '实时事件', detail: '需要 Bearer token，SSE 输出当前会话 live 事件；支持 Last-Event-ID / after 补发最近事件。', copyAria: '复制事件流 curl' },
      eventsState: { title: '事件状态', detail: '需要 Bearer token，返回当前事件 replay buffer 和实时连接状态，不含事件正文。' },
      recentEvents: { title: '最近事件摘要', detail: '需要 Bearer token，返回当前会话最近事件的 id、类型、turnId 和时间，不含事件正文。', copyAria: '复制最近事件 curl' },
      globalEventsState: { title: '全局事件状态', detail: '需要 Bearer token，跨会话返回事件 replay buffer 和实时连接聚合状态，不含事件正文。' },
      recentRequests: { title: '最近请求', detail: '需要 Bearer token，返回最近网关请求的 requestId、方法、路径、状态码和耗时，不含 query、header 或 body。', copyAria: '复制最近请求 curl' },
      incidents: { title: '失败记录', detail: '需要 Bearer token，返回最近错误和中断摘要，用于外部恢复面板。' },
      incidentIndex: { title: '失败索引', detail: '需要 Bearer token，跨会话返回最近错误和中断摘要。' },
      incidentState: { title: '失败索引状态', detail: '需要 Bearer token，跨会话返回最近失败总数、涉及会话数和边界摘要。' },
      search: { title: '本地搜索', detail: '需要 Bearer token，复用 Maka 的 thread search。' },
    },
    help: '/v1 接口默认关闭且都需要 token；发送消息会走当前会话的模型和权限边界。把监听地址设成 0.0.0.0 会让同一局域网设备可访问，请只在可信网络中使用。',
  },
  en: {
    errors: {
      save: 'Failed to save Open Gateway settings', loadStatus: 'Failed to read Open Gateway status', copyTitle: 'Copy failed',
      copyDetail: 'The clipboard is unavailable or access was denied by the system.',
      start: 'Open Gateway could not start. Check the listening address and port.', portInUse: 'The port is already in use',
    },
    toast: {
      tokenSaved: 'Gateway token saved', tokenCleared: 'Gateway token cleared', tokenGenerated: 'Gateway token generated',
      tokenGeneratedDetail: 'The local API requires an Authorization Bearer token.', baseUrlCopied: 'Gateway address copied',
      overviewCopied: 'Overview curl copied', overviewDetail: 'Run it in a terminal to verify the Open Gateway status.',
      openApiCopied: 'API description curl copied', openApiDetail: 'External tools can use it to discover the local API.',
      sessionStateCopied: 'Session state curl copied', sessionStateTemplateDetail: 'Replace <SESSION_ID> with the target session ID before running it.',
      sessionStateDetail: 'Run it in a terminal to view one session state.', eventStreamCopied: 'Event stream curl copied',
      eventStreamTemplateDetail: 'Replace <SESSION_ID> with the target session ID before running it.', eventStreamDetail: 'Run it in a terminal to watch events for the current session.',
      recentEventsCopied: 'Recent events curl copied', recentEventsTemplateDetail: 'Replace <SESSION_ID> with the target session ID before running it.',
      recentEventsDetail: 'Run it in a terminal to view a recent-event summary.', recentRequestsCopied: 'Recent requests curl copied',
      recentRequestsDetail: 'Run it in a terminal to view gateway request metadata.',
    },
    summary: {
      aria: 'Open Gateway status', status: 'Status', address: 'Listening address', lanAccessible: 'Available on LAN', localOnly: 'This device only',
      credentials: 'Credentials', configured: 'Configured', waitingToken: 'Waiting for token', credentialsDetail: 'A Bearer token protects every /v1 API',
      connections: 'Live connections', connectionsDetail: 'SSE clients', capability: 'Capabilities', endpointCount: '19 endpoints',
      capabilityDetail: '/health · openapi · state · sessions · events · requests',
    },
    status: {
      disabled: 'Off', disabledDetail: 'Disabled in settings', waitingToken: 'Waiting for token', waitingTokenDetail: 'The service starts automatically after you generate an access token',
      loading: 'Loading', loadingDetail: 'Reading runtime status', running: 'Running', startedDetail: 'Local API started', listeningDetail: 'Service is listening', failed: 'Failed to start',
      loadFailed: (error) => `Could not read Open Gateway runtime status: ${error}`,
      startStatus: (error) => `Startup status: ${error}`,
    },
    form: {
      enabled: 'Enable local API gateway', enabledHelp: 'Start a local HTTP service so external tools can read sessions, messages, and local search results.',
      host: 'Listening address', port: 'Port', token: 'Access token',
      tokenPlaceholder: 'Generate or enter a token', sessionId: 'Session ID',
      sessionPlaceholder: 'Leave blank to copy a <SESSION_ID> template',
      waitingNotice: 'The gateway is enabled and waiting for an access token. It starts automatically after you generate one.',
    },
    actions: { aria: 'Open Gateway actions', generateToken: 'Generate token', clearToken: 'Clear token', copying: 'Copying…', copyAddress: 'Copy address', copyCurl: 'Copy curl' },
    endpoints: {
      health: { title: 'Health check', detail: 'Requires no token. Use it to confirm that the gateway process is running.' },
      openApi: { title: 'API description', detail: 'Requires a Bearer token. Returns an OpenAPI 3.1 description so external tools can discover Open Gateway capabilities.', copyAria: 'Copy API description curl' },
      overview: { title: 'Overview state', detail: 'Requires a Bearer token. Returns gateway, session, request, incident-index, and capability state without message bodies or previews.', copyAria: 'Copy overview curl' },
      capabilities: { title: 'Capability list', detail: 'Requires a Bearer token. Returns the currently exposed local API capabilities.' },
      sessions: { title: 'Session list', detail: 'Requires a Bearer token. Returns local session summaries.' },
      sessionsState: { title: 'Session state', detail: 'Requires a Bearer token. Returns session counts, unread counts, status distribution, and recent failure counts without titles or previews.' },
      sessionState: { title: 'Single-session state', detail: 'Requires a Bearer token. Returns one session’s state, message counts, event buffer, and failure counts without titles, bodies, or previews.', copyAria: 'Copy single-session state curl' },
      messages: { title: 'Session messages', detail: 'Requires a Bearer token. Reads local messages by session ID and supports limit / before pagination.' },
      messagesState: { title: 'Message state', detail: 'Requires a Bearer token. Returns message counts and boundary summaries without message bodies.' },
      sendMessage: { title: 'Send message', detail: 'Requires a Bearer token. Appends a user message to an existing session and returns its turn ID.' },
      events: { title: 'Live events', detail: 'Requires a Bearer token. Streams live session events over SSE and supports Last-Event-ID / after replay.', copyAria: 'Copy event stream curl' },
      eventsState: { title: 'Event state', detail: 'Requires a Bearer token. Returns the current replay buffer and live connection state without event bodies.' },
      recentEvents: { title: 'Recent event summary', detail: 'Requires a Bearer token. Returns recent event IDs, types, turn IDs, and timestamps without event bodies.', copyAria: 'Copy recent events curl' },
      globalEventsState: { title: 'Global event state', detail: 'Requires a Bearer token. Aggregates replay buffers and live connections across sessions without event bodies.' },
      recentRequests: { title: 'Recent requests', detail: 'Requires a Bearer token. Returns recent request IDs, methods, paths, status codes, and durations without query, header, or body data.', copyAria: 'Copy recent requests curl' },
      incidents: { title: 'Failure records', detail: 'Requires a Bearer token. Returns recent error and interruption summaries for external recovery dashboards.' },
      incidentIndex: { title: 'Failure index', detail: 'Requires a Bearer token. Returns recent error and interruption summaries across sessions.' },
      incidentState: { title: 'Failure index state', detail: 'Requires a Bearer token. Returns aggregate recent failures, affected session counts, and boundary summaries.' },
      search: { title: 'Local search', detail: 'Requires a Bearer token. Reuses Maka thread search.' },
    },
    help: '/v1 APIs are disabled by default and require a token. Sending a message uses the current session’s model and permission boundaries. Setting the listening address to 0.0.0.0 exposes it to devices on the same LAN, so use it only on trusted networks.',
  },
} satisfies UiCatalog<OpenGatewaySettingsCopy>;

export function getOpenGatewaySettingsCopy(locale: UiLocale): OpenGatewaySettingsCopy {
  return SETTINGS_OPEN_GATEWAY_COPY[locale];
}
