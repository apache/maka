import type { StatusSemantic } from '@maka/ui';
import type { BotProvider, BotReadinessState } from '@maka/core/bot-chat-settings';

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

type WidenCopy<T> = T extends string
  ? string
  : T extends (...args: infer Args) => string
    ? (...args: Args) => string
    : { [K in keyof T]: K extends 'tone' ? T[K] : WidenCopy<T[K]> };

const zhCopy = {
  providers: {
    telegram: { label: 'Telegram', help: '通过 @BotFather 创建 Bot 并获取 Token' },
    feishu: { label: '飞书', help: '在飞书开放平台创建应用并获取凭证' },
    wecom: { label: '企业微信', help: '通过企业微信 AI 应用接入，使用 WebSocket 长连接' },
    wechat: { label: '微信', help: '通过本机 wechat-bridge 接入个人微信，需 iOS / Android 微信 8.0.70+。' },
    discord: { label: 'Discord', help: '在 Discord Developer Portal 创建 Bot' },
    dingtalk: { label: '钉钉', help: '在钉钉开发者后台创建机器人应用' },
    qq: { label: 'QQ', help: '在 QQ 开放平台创建机器人并获取 AppID 和 AppSecret' },
    slack: { label: 'Slack', help: '使用 Bot Token 与 App-Level Token 通过 Socket Mode 接入' },
  } satisfies Record<BotProvider, { label: string; help: string }>,
  readiness: {
    unscaffolded: { label: '未开放', detail: '该平台当前不可作为远程接入渠道。', tone: 'neutral' },
    scaffolded: { label: '待配置', detail: '等待补齐这个平台需要的凭据配置。', tone: 'neutral' },
    configured: { label: '已配置', detail: '已填写配置；等待完成凭据或运行态验证。', tone: 'attention' },
    credentials_valid: { label: '凭据有效', detail: '凭据探测通过；这不代表已能收发消息。', tone: 'attention' },
    operational: { label: '运行可用', detail: '最近一次真实运行探测成功。', tone: 'success' },
    degraded: { label: '运行降级', detail: '之前可用，但最近运行态探测失败。', tone: 'error' },
  } satisfies Record<BotReadinessState, { label: string; detail: string; tone: StatusSemantic }>,
  planned: { label: '未开放', detail: '该平台当前不会保存为远程接入渠道或定时任务投递目标。', tone: 'neutral' as const },
  status: {
    disabled: '开关关闭', noToken: '等待填写 Bot Token', missingFeishuCredentials: '等待填写飞书 App ID 或 App Secret',
    feishuDomainRequired: '飞书凭据有效，等待填写事件订阅域名', feishuEventsNotConnected: '飞书凭据有效，等待事件回调接入',
    unavailable: '该平台当前不可作为远程接入渠道', stopped: '监听已停止', detailsInLogs: '运行态详情请见日志',
    polling: '长轮询', gateway: '事件通道', webhook: 'Webhook', none: '无',
  },
  overview: {
    loadFailed: '远程接入状态载入失败', reload: '重新载入', active: '正在使用', sortHint: '按需要处理、最近活动排序',
    empty: '还没有正在使用的渠道', emptyHelp: '从下方选择一个消息平台开始配置。', more: '接入更多渠道', choose: '选择平台开始配置',
    listening: '监听中', manageAria: (name: string, status: string) => `管理 ${name}，${status}`, connectAria: (name: string) => `接入 ${name}`,
  },
  page: {
    saveFailed: (name: string) => `${name} 保存失败`, loadFailed: '载入远程接入状态失败', refreshFailed: '刷新远程接入状态失败',
    credentialVerified: (name: string) => `${name} 凭据已验证`, credentialVerifiedDetail: '凭据检查已通过。', credentialTestFailed: (name: string) => `${name} 凭据测试失败`, credentialTestFailedDetail: '请检查凭据和网络设置后重试。', testError: (name: string) => `${name} 测试出错`,
    listening: (name: string) => `${name} 已开始监听`, notListening: (name: string) => `${name} 启动后未进入监听`, startFailed: (name: string) => `${name} 启动失败`,
    disconnectTitle: '断开微信登录？', disconnectDescription: '将清除本机保存的扫码登录凭据，之后需要重新扫码才能继续使用微信渠道。',
    disconnect: '断开登录', cancel: '取消', disconnected: '微信登录已断开', credentialsCleared: '本机关联凭据已清除。',
  },
  detail: {
    unavailableHint: '该平台未开放，暂不能启用。', scanFirstHint: '先扫码接入后才能启用。', testFirstHint: '先测试并连接后才能启用。',
    back: '返回远程接入', configDocs: '查看配置文档', enableAria: (name: string) => `启用${name}渠道`, listening: '正在监听新消息', healthy: '连接正常，无需处理。',
    actionsAria: (name: string) => `${name}渠道操作`, quickBind: '快捷绑定', scanLogin: '扫码登录', scanConnect: '扫码接入', disconnecting: '断开中…', disconnectWechat: '断开微信登录', bridgeQr: '本机桥接二维码',
    testing: '测试中…', test: '测试连接', connecting: '连接中…', testAndConnect: '测试并连接', restarting: '重启中…', restart: '重启监听',
    runtimeAria: (name: string) => `${name}运行状态`, identity: '身份', unknownIdentity: '未获取', connectionType: '通道类型', lastEvent: '最近事件', noneYet: '暂无', lastTest: '最近一次测试', neverTested: '从未测试',
    statusRefreshFailed: '运行状态刷新失败', latestFailure: '最近一次失败', latestFailureDetail: '请检查配置、网络和运行日志后重试。', savedButNotConnected: '凭据已保存，但连接尚未成功启动。', setupMethod: '接入方式', connectionSettings: '连接配置', localCredentials: '凭据仅保存在本机', autosave: '自动保存',
    setupAria: (name: string) => `${name}接入方式`, quickRecommended: '快捷接入（推荐）', manual: '手动配置', quickAria: (name: string) => `${name}快捷接入`,
    quickWecomTitle: '扫码创建并绑定机器人', quickTitle: '扫码自动创建应用与机器人', quickWecomDetail: '企业管理员扫码确认后，Maka 会保存 Bot ID 与 Secret 并启动长连接。',
    quickQqTitle: '使用手机 QQ 扫码创建并绑定机器人', quickQqDetail: '确认后，QQ 会安全返回 AppID 与 AppSecret，Maka 在本机保存凭据并启动 Gateway。',
    telegramOfficialFlow: 'Telegram 官方目前仅支持通过 @BotFather 获取 Bot Token，不提供扫码创建 Bot 并回传 Token 的 API。',
    quickDetail: '扫码确认后，Maka 会在 main process 内保存凭据并启动消息连接。', feishuRegionAria: '选择飞书账号区域', feishu: '飞书',
    beginQuickBind: '开始快捷绑定', scanWith: (name: string) => `使用${name}扫码接入`, planned: '这个平台当前只作为平台清单展示，不会进入可用渠道，也不会保存为定时任务投递目标。',
    credentialsSaved: (name: string) => `${name}凭据已保存`, scanComplete: (name: string) => `${name}已完成扫码接入`, savedAndConnected: '凭据已安全保存并开始连接',
    proxy: '代理地址', chinaRequired: '（国内网络必填）', authOnly: '（仅用于 Bot 鉴权）', telegramProxyAria: 'Telegram 代理地址',
    telegramNotice: '请打开网络的 TUN 模式后重启应用，以便完成 Telegram Bot 设置', feishuCredentialId: '飞书凭据 ID', feishuSecret: '飞书 App Secret',
    feishuDomain: '飞书域名', feishuOption: '飞书 (feishu.cn)', discordProxyAria: 'Discord 代理地址',
    discordNotice: '国内网络访问 Discord：上方代理仅作用于 Bot 鉴权请求，消息收发走 WebSocket 长连接需要系统级代理。请打开网络的 TUN 模式后重启应用。',
    dingtalkId: '钉钉应用密钥', dingtalkSecret: '钉钉 Client Secret', wecomBotPlaceholder: '企业微信 AI 应用 Bot ID', wecomBotAria: '企业微信 Bot ID',
    wecomSecretPlaceholder: 'AI 应用 Secret', wecomSecretAria: '企业微信 Secret', qqId: 'QQ 应用编号',
    allowedUsersLabel: (count: number, max: number) => `允许的用户 ID（${count} / ${max}）`, allowedUsersPlaceholder: '每行一个用户 ID，留空表示不限\n例如：123456789',
    allowedUsersHelp: 'Telegram 用户 ID 是 64 位整数；填入后只接收列表里这些 ID 的来信，其它人发的消息会被静默忽略（不会回弹任何提示）。',
    limitReached: '（已达到上限）', invalidUsers: (values: string) => `下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：${values}`, moreInvalid: (count: number) => ` 等 ${count} 项`,
  },
  onboarding: {
    providers: {
      dingtalk: { title: '配置钉钉', ariaLabel: '配置钉钉扫码接入', qrAlt: '配置钉钉二维码', subtitle: '在钉钉中扫码完成应用注册', waiting: '请使用钉钉扫描二维码并确认授权', scanned: '已扫码，请在钉钉中完成确认' },
      feishu: { title: '配置飞书', ariaLabel: '配置飞书扫码接入', qrAlt: '配置飞书二维码', subtitle: '使用飞书扫描二维码，自动创建并配置机器人', waiting: '请使用飞书扫描二维码并确认创建', scanned: '已扫码，请在飞书中完成确认' },
      wecom: { title: '配置企业微信', ariaLabel: '配置企业微信扫码接入', qrAlt: '配置企业微信二维码', subtitle: '快捷绑定会自动创建并连接企业微信机器人', waiting: '打开企业微信，扫描二维码完成机器人创建', scanned: '已扫码，请在企业微信中完成确认' },
      wechat: { title: '扫码登录', ariaLabel: '微信扫码登录', qrAlt: '微信扫码登录二维码', subtitle: '请使用微信扫描二维码完成连接', waiting: '请使用微信扫描二维码并在手机上确认', scanned: '已扫码，请在微信中完成确认' },
      qq: { title: '配置 QQ', ariaLabel: '配置 QQ 扫码接入', qrAlt: '配置 QQ 二维码', subtitle: '使用手机 QQ 扫码创建并绑定机器人', waiting: '请使用手机 QQ 扫描二维码并确认绑定', scanned: '已扫码，请在 QQ 中完成确认' },
    },
    lark: { title: '配置 Lark', ariaLabel: '配置 Lark 扫码接入', qrAlt: '配置 Lark 二维码', subtitle: '使用 Lark 扫描二维码，自动创建并配置机器人', waiting: '请使用 Lark 扫描二维码并确认创建', scanned: '已扫码，请在 Lark 中完成确认' },
    connectedRefreshFailed: (message: string) => `连接已完成，但状态刷新失败：${message}`, close: (title: string) => `关闭${title}`,
    generatingAria: '正在生成二维码', privacy: '凭据仅保存在本机，不会传给 renderer 或 Maka 云端。', openBrowser: '无法扫码？在浏览器中打开',
    done: '完成', regenerate: '重新生成', refreshQr: '刷新二维码', cancel: '取消', generating: '正在生成安全二维码…', connecting: '授权完成，正在保存凭据并启动连接…',
    connected: (name: string) => `${name} 已连接`, connectedWarning: '凭据已保存，但连接尚未成功启动。', expired: '二维码已过期，请重新生成', denied: '授权已取消，请重新生成二维码', cancelled: '扫码接入已取消', failed: '扫码接入失败，请重试', preparing: '准备扫码接入…',
  },
  wechat: {
    token: '微信 Bot Token', tokenPlaceholder: '本机 wechat-bridge Bearer Token', collapseAdvanced: '收起高级设置', expandAdvanced: '高级设置（公众号 / 本机 bridge 地址）',
    bridgeAddress: '本机 bridge 地址', appId: '公众号 App ID', appIdPlaceholder: '微信公众号 App ID',
    appSecret: '公众号 App Secret', appSecretPlaceholder: '微信公众号 App Secret',
    advancedNotice: '本机 bridge 默认为 http://127.0.0.1:18400。公众号 App ID / App Secret 仅用于公众号消息发送，个人微信扫码登录走本机 bridge。',
    readQrFailed: '读取本机 wechat-bridge 二维码失败，请确认 bridge 已启动。', title: '微信扫码登录', subtitle: '使用手机微信扫描二维码，并在手机上确认登录本机 wechat-bridge。', close: '关闭微信扫码登录',
    generating: '正在生成二维码…', loggedIn: '微信已登录，返回后可以测试连接或重启监听。', expired: '二维码已过期', expiredHint: '刷新二维码后重新扫码即可继续登录。', refreshing: '刷新中…', refresh: '刷新二维码', qrAlt: '微信扫码登录二维码',
    waiting: '等待扫码确认… 窗口会每 3 秒刷新登录状态。', retrying: '重试中…', retry: '重试', bridgeGenerating: 'bridge 正在生成二维码', bridgeGeneratingHint: '二维码就绪后会自动显示，也可以手动重新获取。', fetching: '获取中…', fetchAgain: '重新获取',
  },
} as const;

export type BotSettingsCopy = WidenCopy<typeof zhCopy>;

const enCopy: BotSettingsCopy = {
  providers: {
    telegram: { label: 'Telegram', help: 'Create a bot with @BotFather and get its token' }, feishu: { label: 'Feishu', help: 'Create an app and credentials in Feishu Open Platform' },
    wecom: { label: 'WeCom', help: 'Connect a WeCom AI app over a persistent WebSocket' }, wechat: { label: 'WeChat', help: 'Connect personal WeChat through the local bridge; requires WeChat 8.0.70+ on iOS or Android.' },
    discord: { label: 'Discord', help: 'Create a bot in Discord Developer Portal' }, dingtalk: { label: 'DingTalk', help: 'Create a bot app in DingTalk Developer Console' }, qq: { label: 'QQ', help: 'Create a bot in QQ Open Platform and get its AppID and AppSecret' },
    slack: { label: 'Slack', help: 'Connect with a Bot Token and App-Level Token over Socket Mode' },
  },
  readiness: {
    unscaffolded: { label: 'Unavailable', detail: 'This platform cannot currently be used for remote access.', tone: 'neutral' }, scaffolded: { label: 'Setup required', detail: 'Add the credentials required by this platform.', tone: 'neutral' },
    configured: { label: 'Configured', detail: 'Configuration is saved; credential or runtime validation is still required.', tone: 'attention' }, credentials_valid: { label: 'Credentials valid', detail: 'The credential check passed; this does not prove messages can be sent or received.', tone: 'attention' },
    operational: { label: 'Operational', detail: 'The latest live runtime check succeeded.', tone: 'success' }, degraded: { label: 'Degraded', detail: 'This channel worked before, but the latest runtime check failed.', tone: 'error' },
  },
  planned: { label: 'Unavailable', detail: 'This platform is not saved as a remote-access channel or scheduled-task delivery target.', tone: 'neutral' },
  status: { disabled: 'Turned off', noToken: 'Waiting for Bot Token', missingFeishuCredentials: 'Waiting for Feishu App ID or App Secret', feishuDomainRequired: 'Feishu credentials are valid; add the event subscription domain', feishuEventsNotConnected: 'Feishu credentials are valid; connect the event callback', unavailable: 'This platform cannot currently be used for remote access', stopped: 'Listener stopped', detailsInLogs: 'See logs for runtime details', polling: 'Long polling', gateway: 'Event channel', webhook: 'Webhook', none: 'None' },
  overview: { loadFailed: 'Failed to load remote-access status', reload: 'Reload', active: 'In use', sortHint: 'Sorted by attention needed and recent activity', empty: 'No channels are in use', emptyHelp: 'Choose a messaging platform below to begin setup.', more: 'Connect more channels', choose: 'Choose a platform to begin setup', listening: 'Listening', manageAria: (name, status) => `Manage ${name}, ${status}`, connectAria: (name) => `Connect ${name}` },
  page: { saveFailed: (name) => `Failed to save ${name}`, loadFailed: 'Failed to load remote-access status', refreshFailed: 'Failed to refresh remote-access status', credentialVerified: (name) => `${name} credentials verified`, credentialVerifiedDetail: 'The credential check passed.', credentialTestFailed: (name) => `${name} credential test failed`, credentialTestFailedDetail: 'Check the credentials and network settings, then try again.', testError: (name) => `${name} test error`, listening: (name) => `${name} is listening`, notListening: (name) => `${name} did not start listening`, startFailed: (name) => `Failed to start ${name}`, disconnectTitle: 'Disconnect WeChat?', disconnectDescription: 'This clears the saved local QR sign-in credentials. You will need to scan again to keep using WeChat.', disconnect: 'Disconnect', cancel: 'Cancel', disconnected: 'WeChat disconnected', credentialsCleared: 'Local linked-session credentials cleared.' },
  detail: {
    unavailableHint: 'This platform is not available and cannot be enabled.', scanFirstHint: 'Scan to connect before enabling this channel.', testFirstHint: 'Test and connect before enabling this channel.', back: 'Back to Remote access', configDocs: 'View setup guide', enableAria: (name) => `Enable ${name} channel`, listening: 'Listening for new messages', healthy: 'Connection healthy. No action needed.', actionsAria: (name) => `${name} channel actions`, quickBind: 'Quick connect', scanLogin: 'Scan to sign in', scanConnect: 'Scan to connect', disconnecting: 'Disconnecting…', disconnectWechat: 'Disconnect WeChat', bridgeQr: 'Local bridge QR code', testing: 'Testing…', test: 'Test connection', connecting: 'Connecting…', testAndConnect: 'Test and connect', restarting: 'Restarting…', restart: 'Restart listener', runtimeAria: (name) => `${name} runtime status`, identity: 'Identity', unknownIdentity: 'Unavailable', connectionType: 'Connection type', lastEvent: 'Last event', noneYet: 'None', lastTest: 'Last test', neverTested: 'Never tested', statusRefreshFailed: 'Failed to refresh runtime status', latestFailure: 'Latest failure', latestFailureDetail: 'Check the configuration, network, and runtime logs, then try again.', savedButNotConnected: 'Credentials were saved, but the connection did not start.', setupMethod: 'Connection method', connectionSettings: 'Connection settings', localCredentials: 'Credentials stay on this device', autosave: 'Saved automatically', setupAria: (name) => `${name} connection method`, quickRecommended: 'Quick setup (recommended)', manual: 'Manual setup', quickAria: (name) => `${name} quick setup`, quickWecomTitle: 'Scan to create and connect a bot', quickTitle: 'Scan to create an app and bot', quickWecomDetail: 'After an administrator confirms the scan, Maka saves the Bot ID and Secret and starts the persistent connection.', quickQqTitle: 'Scan with mobile QQ to create and bind a bot', quickQqDetail: 'After confirmation, QQ securely returns the AppID and AppSecret; Maka stores them locally and starts the Gateway.', telegramOfficialFlow: 'Telegram officially requires a Bot Token from @BotFather and does not provide an API that creates a bot by QR scan and returns its token.', quickDetail: 'After confirmation, Maka stores credentials in the main process and starts the message connection.', feishuRegionAria: 'Choose Feishu account region', feishu: 'Feishu', beginQuickBind: 'Start quick connect', scanWith: (name) => `Scan with ${name}`, planned: 'This platform is shown in the catalog only. It will not become an active channel or a scheduled-task delivery target.', credentialsSaved: (name) => `${name} credentials saved`, scanComplete: (name) => `${name} QR setup complete`, savedAndConnected: 'Credentials saved securely and connection started', proxy: 'Proxy URL', chinaRequired: '(required on networks in mainland China)', authOnly: '(Bot authentication only)', telegramProxyAria: 'Telegram proxy URL', telegramNotice: 'Enable TUN mode in your network tool and restart the app to complete Telegram Bot setup.', feishuCredentialId: 'Feishu credential ID', feishuSecret: 'Feishu App Secret', feishuDomain: 'Feishu domain', feishuOption: 'Feishu (feishu.cn)', discordProxyAria: 'Discord proxy URL', discordNotice: 'For Discord access from mainland China, the proxy above covers Bot authentication only. Message WebSockets require a system-level proxy. Enable TUN mode and restart the app.', dingtalkId: 'DingTalk app key', dingtalkSecret: 'DingTalk Client Secret', wecomBotPlaceholder: 'WeCom AI app Bot ID', wecomBotAria: 'WeCom Bot ID', wecomSecretPlaceholder: 'AI app Secret', wecomSecretAria: 'WeCom Secret', qqId: 'QQ app ID', allowedUsersLabel: (count, max) => `Allowed user IDs (${count} / ${max})`, allowedUsersPlaceholder: 'One user ID per line; leave empty to allow everyone\nExample: 123456789', allowedUsersHelp: 'Telegram user IDs are 64-bit integers. When set, only messages from these IDs are accepted; all others are silently ignored.', limitReached: '(limit reached)', invalidUsers: (values) => `These entries are not numeric IDs and may be usernames, so they will not match anyone: ${values}`, moreInvalid: (count) => ` and ${count} more`,
  },
  onboarding: {
    providers: { dingtalk: { title: 'Set up DingTalk', ariaLabel: 'Set up DingTalk with a QR code', qrAlt: 'DingTalk setup QR code', subtitle: 'Scan in DingTalk to register the app', waiting: 'Scan with DingTalk and confirm authorization', scanned: 'Scanned. Complete confirmation in DingTalk.' }, feishu: { title: 'Set up Feishu', ariaLabel: 'Set up Feishu with a QR code', qrAlt: 'Feishu setup QR code', subtitle: 'Scan with Feishu to create and configure the bot', waiting: 'Scan with Feishu and confirm creation', scanned: 'Scanned. Complete confirmation in Feishu.' }, wecom: { title: 'Set up WeCom', ariaLabel: 'Set up WeCom with a QR code', qrAlt: 'WeCom setup QR code', subtitle: 'Quick setup creates and connects a WeCom bot', waiting: 'Open WeCom and scan to create the bot', scanned: 'Scanned. Complete confirmation in WeCom.' }, wechat: { title: 'Scan to sign in', ariaLabel: 'WeChat QR sign-in', qrAlt: 'WeChat sign-in QR code', subtitle: 'Scan with WeChat to connect', waiting: 'Scan with WeChat and confirm on your phone', scanned: 'Scanned. Complete confirmation in WeChat.' }, qq: { title: 'Set up QQ', ariaLabel: 'Set up QQ with a QR code', qrAlt: 'QQ setup QR code', subtitle: 'Scan with mobile QQ to create and bind a bot', waiting: 'Scan with mobile QQ and confirm binding', scanned: 'Scanned. Complete confirmation in QQ.' } },
    lark: { title: 'Set up Lark', ariaLabel: 'Set up Lark with a QR code', qrAlt: 'Lark setup QR code', subtitle: 'Scan with Lark to create and configure the bot', waiting: 'Scan with Lark and confirm creation', scanned: 'Scanned. Complete confirmation in Lark.' }, connectedRefreshFailed: (message) => `Connected, but status refresh failed: ${message}`, close: (title) => `Close ${title}`, generatingAria: 'Generating QR code', privacy: 'Credentials stay on this device and are never sent to the renderer or Maka cloud.', openBrowser: 'Cannot scan? Open in browser', done: 'Done', regenerate: 'Generate again', refreshQr: 'Refresh QR code', cancel: 'Cancel', generating: 'Generating a secure QR code…', connecting: 'Authorization complete. Saving credentials and starting connection…', connected: (name) => `${name} connected`, connectedWarning: 'Credentials were saved, but the connection did not start.', expired: 'QR code expired. Generate a new one.', denied: 'Authorization cancelled. Generate a new QR code.', cancelled: 'QR setup cancelled', failed: 'QR setup failed. Try again.', preparing: 'Preparing QR setup…',
  },
  wechat: { token: 'WeChat Bot Token', tokenPlaceholder: 'Local wechat-bridge Bearer Token', collapseAdvanced: 'Hide advanced settings', expandAdvanced: 'Advanced settings (Official Account / local bridge URL)', bridgeAddress: 'Local bridge URL', appId: 'Official Account App ID', appIdPlaceholder: 'WeChat Official Account App ID', appSecret: 'Official Account App Secret', appSecretPlaceholder: 'WeChat Official Account App Secret', advancedNotice: 'The local bridge defaults to http://127.0.0.1:18400. Official Account App ID and App Secret are used only for Official Account messaging; personal WeChat QR sign-in uses the local bridge.', readQrFailed: 'Could not read a QR code from the local wechat-bridge. Make sure the bridge is running.', title: 'WeChat QR sign-in', subtitle: 'Scan the QR code with WeChat and confirm signing in to the local wechat-bridge on your phone.', close: 'Close WeChat QR sign-in', generating: 'Generating QR code…', loggedIn: 'WeChat is signed in. Return to test the connection or restart the listener.', expired: 'QR code expired', expiredHint: 'Refresh the QR code and scan again to continue signing in.', refreshing: 'Refreshing…', refresh: 'Refresh QR code', qrAlt: 'WeChat sign-in QR code', waiting: 'Waiting for confirmation… Sign-in status refreshes every 3 seconds.', retrying: 'Retrying…', retry: 'Retry', bridgeGenerating: 'The bridge is generating a QR code', bridgeGeneratingHint: 'The QR code appears automatically once ready; you can also fetch it again.', fetching: 'Fetching…', fetchAgain: 'Fetch again' },
};

const BOT_SETTINGS_COPY = { zh: zhCopy, en: enCopy } satisfies UiCatalog<BotSettingsCopy>;

export function getBotSettingsCopy(locale: UiLocale): BotSettingsCopy {
  return BOT_SETTINGS_COPY[locale];
}
