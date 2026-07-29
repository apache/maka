import type { ChatConfigurationReason, UiCatalog, UiLocale } from '@maka/core';

export interface DesktopConversationCopy {
  actions: {
    stopFailedTitle: string;
    stopFailedFallback: string;
    refreshSessionsFailedTitle: string;
    refreshSessionsFailedFallback: string;
    conversationErrorTitle: string;
    conversationErrorFallback: string;
    regenerateStartedTitle: string;
    regenerateStartedDescription: string;
    branchCreatedTitle: string;
    branchCreatedDescription: (name: string) => string;
    revisionStartedTitle: string;
    revisionStartedDescription: string;
    revisionReadyTitle: string;
    revisionReadyDescription: string;
    revisionUnavailableTitle: string;
    revisionAttachmentsUnsupported: string;
    revisionTransformedTextUnsupported: string;
    revisionDraftAttachmentConflict: string;
    revisionCommandUnsupported: string;
    revisionAlreadyActive: string;
    revisionCancelLabel: string;
    revisionBannerTitle: string;
    revisionBannerDetail: string;
    revisionUnchanged: string;
    operationFailedTitle: string;
    operationFailedFallback: string;
    attachmentFailedTitle: string;
    tryAgain: string;
    modelReboundTitle: string;
    modelReboundDescription: (modelId?: string) => string;
    messageReadFailedTitle: string;
  };
  attachments: { tooMany: string; tooLarge: string; duplicate: string };
  model: {
    fakeBackendLabel: string;
    setupTitle: string;
    connectionMissingTitle: string;
    configurationFallback: string;
    configurationReason: Record<ChatConfigurationReason, string>;
  };
  footer: {
    labels: Record<'regenerate' | 'branch' | 'copy' | 'info', string>;
    pending: string;
    regenerateRunning: string;
    regenerateAgain: string;
    regenerate: string;
    branchRunning: string;
    branchAborted: string;
    branch: string;
    copy: string;
    copyEmpty: string;
  };
  lineage: {
    regeneratedFrom: string;
    regeneratedFromTooltip: string;
    regeneratedTo: string;
    regeneratedToTooltip: string;
  };
  workbar: { ariaLabel: string; sectionsAriaLabel: string; tasks: string; browser: string; files: string; quoteTab: string };
  quoteCompanion: {
    /** Read-only exploration hint shown in the empty companion panel. */
    hint: string;
    /** The exit / dismiss action label. */
    exit: string;
    /** Prefix for the companion fork's session name (followed by the excerpt). */
    namePrefix: string;
    errors: {
      /** Reading the source boundary or creating the companion fork failed. */
      forkSetupFailed: string;
      /** Fork could not be pinned read-only (`explore`), so the send was aborted. */
      permissionPinFailed: string;
      /** The companion run reported an error event. */
      runError: string;
      /** `sessions.send` was rejected without throwing (e.g. an unresolved skill). */
      sendRejected: string;
      /** `sessions.send` threw / the turn could not be started. */
      sendFailed: string;
      /** Responding to a permission / question prompt failed. */
      respondFailed: string;
    };
  };
  health: {
    blocked: Record<ChatConfigurationReason, { label: string; tooltip: (connection: string, model: string) => string }>;
    reauth: { label: string; tooltip: string };
    testError: { label: string; tooltip: string };
  };
  turnError: {
    unknown: string;
    contextOverflow: string;
    timeout: string;
    auth: string;
    providerBilling: string;
    rateLimit: string;
    network: string;
    provider: string;
    stepCap: string;
    tool: string;
    permission: string;
    restarted: string;
    sandboxBoundaryClosed: string;
    recovery: Record<'safeResume' | 'stepCap' | 'toolError' | 'connection' | 'partial' | 'toolRecord' | 'retry' | 'sandboxBoundaryClosed', string>;
  };
}

const COPY = {
  zh: {
    actions: { stopFailedTitle: '停止失败', stopFailedFallback: '会话操作失败，请稍后重试。', refreshSessionsFailedTitle: '刷新会话列表失败', refreshSessionsFailedFallback: '刷新会话列表失败，请稍后重试。', conversationErrorTitle: '对话出错', conversationErrorFallback: '对话运行失败，请稍后重试。', regenerateStartedTitle: '已发起重新生成', regenerateStartedDescription: '正在生成新的一轮回答', branchCreatedTitle: '已创建分支', branchCreatedDescription: (name) => `新会话 ${name}`, revisionStartedTitle: '已创建修改版草稿', revisionStartedDescription: '原对话仍会保留；修改后发送将在新版本中继续', revisionReadyTitle: '可以修改并重发了', revisionReadyDescription: '已回到该消息之前；编辑后发送即可', revisionUnavailableTitle: '暂时无法编辑这条消息', revisionAttachmentsUnsupported: '包含附件的历史消息暂不支持编辑并重发，请复制文字后新建消息。', revisionTransformedTextUnsupported: '通过显式技能发送的历史消息暂不支持编辑并重发，请复制文字后重新选择技能。', revisionDraftAttachmentConflict: 'Composer 中已有待发送附件，请先发送或移除附件，再编辑历史消息。', revisionCommandUnsupported: '修改消息时不能执行 /compact，请取消修改后再试。', revisionAlreadyActive: '已有一条消息正在修改，请先发送或取消当前修改。', revisionCancelLabel: '取消', revisionBannerTitle: '正在修改已发送消息', revisionBannerDetail: '· 发送后创建新版本', revisionUnchanged: '内容没有变化。如需重新回答，请使用“重新生成”。', operationFailedTitle: '操作失败', operationFailedFallback: '对话操作失败，请稍后重试。', attachmentFailedTitle: '添加附件失败', tryAgain: '请稍后重试。', modelReboundTitle: '已切换到可用模型', modelReboundDescription: (modelId) => `原会话使用的连接已不可用${modelId ? ` · ${modelId}` : ''}`, messageReadFailedTitle: '读取对话失败' },
    attachments: { tooMany: '附件数量超过 8 个', tooLarge: '附件大小超过 50MB', duplicate: '附件来源重复，请勿重复添加同一文件。' },
    model: {
      fakeBackendLabel: '本地模拟连接',
      setupTitle: '等待配置真实模型',
      connectionMissingTitle: '连接已删除',
      configurationFallback: '模型连接暂时无法用于发送，请到 设置 · 模型 检查后重试。',
      configurationReason: {
        missing_default_connection: '等待配置默认模型。请到 设置 · 模型 添加一个可用模型连接后再发送。',
        connection_missing: '该会话依赖的模型连接已删除，请到 设置 · 模型 重新选择或重建连接。',
        connection_disabled: '当前模型连接已禁用。请到 设置 · 模型 启用或选择其他默认模型。',
        missing_api_key: '当前模型连接还没有可用凭据。请到 设置 · 模型 补齐 API key 或重新登录后再发送。',
        missing_model: '当前模型连接还没有可用模型。请到 设置 · 模型 选择默认模型后再发送。',
        empty_model_list: '当前模型连接没有启用模型。请到 设置 · 模型 添加或启用模型后再发送。',
        model_not_enabled: '当前会话选择的模型未启用。请到 设置 · 模型 重新选择可用模型后再发送。',
        model_not_chat_capable: '当前会话选择的模型不能用于聊天。请到 设置 · 模型 重新选择支持聊天的模型后再发送。',
        oauth_subscription_not_wired: '这个订阅账号暂时不能作为聊天模型。请先选择可用的 API key 或已接入 OAuth 模型连接。',
        fake_backend: '当前会话来自旧的本地模拟连接。请到 设置 · 模型 添加真实模型后新建会话。',
      },
    },
    footer: { labels: { regenerate: '重新生成', branch: '分支', copy: '复制', info: '详情' }, pending: '正在处理…', regenerateRunning: '当前回答仍在进行中，结束后再重新生成', regenerateAgain: '已重新生成过，再次点击将创建新的并行回答', regenerate: '让模型重新生成本轮回答', branchRunning: '当前回答仍在进行中，结束后再分支', branchAborted: '从中断前的上下文分支出新对话', branch: '基于此回答的上下文分支出新对话', copy: '复制回答到剪贴板', copyEmpty: '此回答尚无可复制的内容' },
    lineage: { regeneratedFrom: '重新生成自旧回答', regeneratedFromTooltip: '这是重新生成的并行回答，点击查看被保留的旧回答', regeneratedTo: '已重新生成 → 新回答', regeneratedToTooltip: '点击跳转到重新生成的新回答' },
    workbar: { ariaLabel: '会话工作栏', sectionsAriaLabel: '会话工作栏栏目', tasks: '任务', browser: '浏览器', files: '文件', quoteTab: '追问引用' },
    quoteCompanion: {
      hint: '这里的追问会带上主对话的完整上下文：只做解释和只读探索，不会改动文件，也不写回主对话。在主对话里继续选中文本追问，会加进这个侧栏。',
      exit: '退出',
      namePrefix: '追问：',
      errors: {
        forkSetupFailed: '无法创建追问会话，请稍后重试。',
        permissionPinFailed: '无法将追问会话设为只读探索模式，已取消（避免以主对话的高权限执行）。',
        runError: '追问出错了，请重试。',
        sendRejected: '追问未能开始，请稍后重试。',
        sendFailed: '追问失败，请稍后重试。',
        respondFailed: '响应失败，请稍后重试。',
      },
    },
    health: {
      blocked: {
        fake_backend: { label: '会话已过期 · 请先配置真实模型', tooltip: () => '原会话使用旧的本地模拟连接，需要先到 设置 · 模型 添加并启用一个真实模型才能发送。' },
        missing_default_connection: { label: '未配置可用模型', tooltip: () => '当前会话没有可用的模型连接，发送会失败。请到 设置 · 模型 添加并启用一个模型。' },
        connection_missing: { label: '连接已删除', tooltip: () => '此会话依赖的模型连接已被删除，发送会失败。请到 设置 · 模型 检查连接配置。' },
        connection_disabled: { label: '连接已禁用', tooltip: (name) => `会话绑定的连接 "${name}" 已禁用，发送会失败。请到 设置 · 模型 启用它或选择其他连接。` },
        missing_api_key: { label: '连接缺少密钥', tooltip: (name) => `连接 "${name}" 未填写 API key 或未完成登录，发送会失败。请到 设置 · 模型 补齐凭据。` },
        missing_model: { label: '连接未选择模型', tooltip: (name) => `连接 "${name}" 没有默认模型，发送会失败。请到 设置 · 模型 选择一个模型。` },
        empty_model_list: { label: '连接没有启用模型', tooltip: (name) => `连接 "${name}" 没有启用任何模型，发送会失败。请到 设置 · 模型 先添加模型。` },
        model_not_enabled: { label: '会话模型未启用', tooltip: (name, model) => `模型 "${model}" 不在连接 "${name}" 的启用列表中，发送会失败。请到 设置 · 模型 重新选择。` },
        model_not_chat_capable: { label: '会话模型不支持聊天', tooltip: (name, model) => `模型 "${model}" 不能用于聊天，发送会失败。请到 设置 · 模型 选择支持聊天的模型。` },
        oauth_subscription_not_wired: { label: '订阅连接不能用于聊天', tooltip: (name) => `订阅连接 "${name}" 只用于账号状态查看，发送会失败。请先选择 API key 模型连接。` },
      },
      reauth: { label: '上次连接测试鉴权失败', tooltip: '最近一次连接测试返回鉴权失败（401 / 403），密钥可能已过期或被吊销。这不会拦截发送，但若发送失败请到 设置 · 模型 重新登录。' },
      testError: { label: '上次连接测试失败', tooltip: '最近一次连接测试因网络 / 超时 / 5xx 失败。这不会拦截发送，但若问题持续请到 设置 · 模型 检查 Base URL / 代理。' },
    },
    turnError: { unknown: '未知错误', contextOverflow: '上下文窗口已超出限制', timeout: '请求超时', auth: '鉴权失败', providerBilling: '模型服务计费受限', rateLimit: '触发模型速率限制', network: '网络错误', provider: '模型服务返回错误', stepCap: '达到工具步骤上限', tool: '工具调用失败', permission: '等待权限确认', restarted: '本地应用重启，上一轮没有完成', sandboxBoundaryClosed: '本地应用重启，等待确认的「允许访问工作区以外的内容」请求已按拒绝关闭', recovery: { safeResume: '检查当前状态后，可尝试安全恢复', stepCap: '任务可能尚未完成，可以继续', toolError: '先检查工具结果，再决定是否重试', connection: '先检查模型连接或登录状态', partial: '已保留部分输出，可从这里继续', toolRecord: '工具记录已保留，重试前先看结果', retry: '没有执行工具，可直接重试', sandboxBoundaryClosed: '访问范围没有放开，重试本轮后可重新决定' } },
  },
  en: {
    actions: { stopFailedTitle: 'Failed to stop', stopFailedFallback: 'The conversation action failed. Try again later.', refreshSessionsFailedTitle: 'Failed to refresh conversations', refreshSessionsFailedFallback: 'The conversation list could not be refreshed. Try again later.', conversationErrorTitle: 'Conversation error', conversationErrorFallback: 'The conversation run failed. Try again later.', regenerateStartedTitle: 'Regeneration started', regenerateStartedDescription: 'Generating a new response', branchCreatedTitle: 'Branch created', branchCreatedDescription: (name) => `New conversation: ${name}`, revisionStartedTitle: 'Edit draft ready', revisionStartedDescription: 'The original conversation is kept; sending creates a new version', revisionReadyTitle: 'Ready to edit and resend', revisionReadyDescription: 'Rewound to before that message; edit and send when ready', revisionUnavailableTitle: 'This message cannot be edited yet', revisionAttachmentsUnsupported: 'Edit & resend does not yet support historical attachments. Copy the text into a new message instead.', revisionTransformedTextUnsupported: 'Edit & resend does not yet support messages sent with an explicit skill. Copy the text and select the skill again instead.', revisionDraftAttachmentConflict: 'The composer already has pending attachments. Send or remove them before editing a sent message.', revisionCommandUnsupported: 'You cannot run /compact while editing a sent message. Cancel the edit first.', revisionAlreadyActive: 'Another message is already being edited. Send or cancel that edit first.', revisionCancelLabel: 'Cancel', revisionBannerTitle: 'Editing sent message', revisionBannerDetail: '· New version on send', revisionUnchanged: 'Nothing changed. Use Regenerate if you only want a new answer.', operationFailedTitle: 'Action failed', operationFailedFallback: 'The conversation action failed. Try again later.', attachmentFailedTitle: 'Failed to add attachment', tryAgain: 'Try again later.', modelReboundTitle: 'Switched to an available model', modelReboundDescription: (modelId) => `The previous connection is unavailable${modelId ? ` · ${modelId}` : ''}`, messageReadFailedTitle: 'Failed to load conversation' },
    attachments: { tooMany: 'You can attach at most 8 files', tooLarge: 'Attachments must be 50 MB or smaller', duplicate: 'This attachment was already added.' },
    model: {
      fakeBackendLabel: 'Local simulation',
      setupTitle: 'Configure a real model',
      connectionMissingTitle: 'Connection deleted',
      configurationFallback: 'This model connection cannot send right now. Check it in Settings · Models and try again.',
      configurationReason: {
        missing_default_connection: 'Set a default model in Settings · Models before sending.',
        connection_missing: 'The model connection used by this conversation was deleted. Select or create one in Settings · Models.',
        connection_disabled: 'The current model connection is disabled. Enable it or choose another default in Settings · Models.',
        missing_api_key: 'The current model connection has no usable credentials. Add an API key or sign in again under Settings · Models.',
        missing_model: 'The current connection has no usable model. Select a default model in Settings · Models.',
        empty_model_list: 'The current connection has no enabled models. Add or enable one in Settings · Models.',
        model_not_enabled: 'The model selected for this conversation is disabled. Choose an enabled model in Settings · Models.',
        model_not_chat_capable: 'The model selected for this conversation cannot chat. Choose a chat-capable model in Settings · Models.',
        oauth_subscription_not_wired: 'This subscription account cannot be used as a chat model yet. Choose an available API-key or supported OAuth connection.',
        fake_backend: 'This conversation used the retired local simulation. Add a real model in Settings · Models, then start a new conversation.',
      },
    },
    footer: { labels: { regenerate: 'Regenerate', branch: 'Branch', copy: 'Copy', info: 'Details' }, pending: 'Working…', regenerateRunning: 'Wait for the current response to finish before regenerating', regenerateAgain: 'A regenerated response already exists; click again to create another parallel response', regenerate: 'Generate another response to this turn', branchRunning: 'Wait for the current response to finish before branching', branchAborted: 'Branch from the context before the interruption', branch: 'Branch a new conversation from this response', copy: 'Copy response to clipboard', copyEmpty: 'This response has no content to copy' },
    lineage: { regeneratedFrom: 'Regenerated from previous response', regeneratedFromTooltip: 'This is a parallel regenerated response; click to view the retained previous response', regeneratedTo: 'Regenerated → New response', regeneratedToTooltip: 'Jump to the regenerated response' },
    workbar: { ariaLabel: 'Conversation workbar', sectionsAriaLabel: 'Conversation workbar sections', tasks: 'Tasks', browser: 'Browser', files: 'Files', quoteTab: 'Quoted' },
    quoteCompanion: {
      hint: 'Questions here carry the full context of the main conversation: read-only exploration and explanation, no file changes, and nothing is written back to the main conversation. Select more text in the main transcript to add it to this side panel.',
      exit: 'Exit',
      namePrefix: 'Quote: ',
      errors: {
        forkSetupFailed: 'Could not create the companion conversation. Please try again.',
        permissionPinFailed: 'Could not set the companion to read-only exploration mode; canceled (to avoid running with the main conversation’s elevated permissions).',
        runError: 'The companion run errored. Please try again.',
        sendRejected: 'The companion could not start. Please try again.',
        sendFailed: 'The companion request failed. Please try again.',
        respondFailed: 'The response failed. Please try again.',
      },
    },
    health: {
      blocked: {
        fake_backend: { label: 'Stale conversation · Configure a real model', tooltip: () => 'This conversation used the retired local simulation. Add and enable a real model in Settings · Models before sending.' },
        missing_default_connection: { label: 'No model configured', tooltip: () => 'This conversation has no available model connection. Add and enable one in Settings · Models.' },
        connection_missing: { label: 'Connection deleted', tooltip: () => 'The model connection used by this conversation was deleted. Check Settings · Models.' },
        connection_disabled: { label: 'Connection disabled', tooltip: (name) => `Connection "${name}" is disabled. Enable it or choose another connection in Settings · Models.` },
        missing_api_key: { label: 'Connection credentials missing', tooltip: (name) => `Connection "${name}" has no API key or completed sign-in. Add credentials in Settings · Models.` },
        missing_model: { label: 'No model selected', tooltip: (name) => `Connection "${name}" has no default model. Select one in Settings · Models.` },
        empty_model_list: { label: 'No models enabled', tooltip: (name) => `Connection "${name}" has no enabled models. Add one in Settings · Models.` },
        model_not_enabled: { label: 'Conversation model disabled', tooltip: (name, model) => `Model "${model}" is not enabled for connection "${name}". Choose another model in Settings · Models.` },
        model_not_chat_capable: { label: 'Conversation model cannot chat', tooltip: (_name, model) => `Model "${model}" cannot be used for chat. Choose a chat-capable model in Settings · Models.` },
        oauth_subscription_not_wired: { label: 'Subscription connection cannot chat', tooltip: (name) => `Subscription connection "${name}" is available only for account status. Choose an API-key model connection.` },
      },
      reauth: { label: 'Last connection test failed authentication', tooltip: 'The latest test returned 401 / 403. Sending is not blocked, but sign in again under Settings · Models if it fails.' },
      testError: { label: 'Last connection test failed', tooltip: 'The latest test failed because of a network, timeout, or 5xx error. Sending is not blocked; check Base URL or proxy settings if it persists.' },
    },
    turnError: { unknown: 'Unknown error', contextOverflow: 'Context window exceeded', timeout: 'Request timed out', auth: 'Authentication failed', providerBilling: 'Provider billing required', rateLimit: 'Model rate limit reached', network: 'Network error', provider: 'Model service error', stepCap: 'Tool-step limit reached', tool: 'Tool call failed', permission: 'Waiting for permission', restarted: 'The app restarted before the previous turn completed', sandboxBoundaryClosed: 'The app restarted, so the pending request to reach outside the workspace was closed as denied', recovery: { safeResume: 'Inspect the current state, then try safe recovery', stepCap: 'The task may be incomplete; continue from here', toolError: 'Inspect the tool result before retrying', connection: 'Check the model connection or sign-in status', partial: 'Partial output was retained; continue from here', toolRecord: 'Tool history was retained; inspect it before retrying', retry: 'No tools ran; retry directly', sandboxBoundaryClosed: 'Access was not widened; retry the turn to decide again' } },
  },
} satisfies UiCatalog<DesktopConversationCopy>;

export function getDesktopConversationCopy(locale: UiLocale): DesktopConversationCopy {
  return COPY[locale];
}
