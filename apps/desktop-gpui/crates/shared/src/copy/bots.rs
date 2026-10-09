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

//! Interface copy of the Remote access settings page (chat bots), in Maka
//! Desktop's words (apps/desktop/src/renderer/locales/settings-bot-copy.ts,
//! and the bot part of settings-test-result-copy.ts). Same rules as the
//! parent module. The lines about the bot runtime itself (starting, not
//! available, a token another client polls) are this client's own: Desktop
//! runs its bots in its main process and has no such states.

use super::{Locale, Text, plural};

/// The official setup guides Desktop links from a platform's detail
/// (`configDocUrl` in packages/ui/src/bot-brand.ts), by provider name.
pub const CONFIG_DOCS: [(&str, &str); 8] = [
    ("telegram", "https://core.telegram.org/bots/tutorial"),
    ("feishu", "https://open.feishu.cn/document/server-docs/bot-v3"),
    ("wecom", "https://developer.work.weixin.qq.com/document/"),
    ("wechat", "https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html"),
    ("discord", "https://discord.com/developers/docs/intro"),
    ("dingtalk", "https://open.dingtalk.com/document/"),
    ("qq", "https://bot.q.qq.com/wiki/"),
    ("slack", "https://api.slack.com/start/quickstart"),
];

/// Placeholders Desktop writes the same in every language.
pub const TELEGRAM_TOKEN_PLACEHOLDER: &str = "123456:ABC-DEF...";
pub const PROXY_PLACEHOLDER: &str = "http://127.0.0.1:7890";
pub const FEISHU_APP_ID_PLACEHOLDER: &str = "cli_xxxx";
pub const SECRET_PLACEHOLDER: &str = "xxxx";
pub const DISCORD_TOKEN_PLACEHOLDER: &str = "MTAx...";
pub const DINGTALK_ID_PLACEHOLDER: &str = "dingxxxxxxxx";
pub const QQ_ID_PLACEHOLDER: &str = "102xxxxxx";
pub const SLACK_TOKEN_PLACEHOLDER: &str = "xoxb-…";
pub const SLACK_APP_TOKEN_PLACEHOLDER: &str = "xapp-…";
pub const BRIDGE_PLACEHOLDER: &str = "http://127.0.0.1:18400";

texts! {
    // The platforms.
    PROVIDER_TELEGRAM = "Telegram", "Telegram", "Telegram";
    PROVIDER_FEISHU = "Feishu", "飞书", "飛書";
    PROVIDER_WECOM = "WeCom", "企业微信", "企業微信";
    PROVIDER_WECHAT = "WeChat", "微信", "微信";
    PROVIDER_DISCORD = "Discord", "Discord", "Discord";
    PROVIDER_DINGTALK = "DingTalk", "钉钉", "釘釘";
    PROVIDER_QQ = "QQ", "QQ", "QQ";
    PROVIDER_SLACK = "Slack", "Slack", "Slack";
    PROVIDER_LARK = "Lark", "Lark", "Lark";
    HELP_TELEGRAM =
        "Create a bot with @BotFather and get its token",
        "通过 @BotFather 创建 Bot 并获取 Token",
        "透過 @BotFather 建立 Bot 並取得 Token";
    HELP_FEISHU =
        "Create an app and credentials in Feishu Open Platform",
        "在飞书开放平台创建应用并获取凭证",
        "在飛書開放平台建立應用並取得憑證";
    HELP_WECOM =
        "Connect a WeCom AI app over a persistent WebSocket",
        "通过企业微信 AI 应用接入，使用 WebSocket 长连接",
        "透過企業微信 AI 應用串接，使用 WebSocket 長連線";
    HELP_WECHAT =
        "Connect personal WeChat through the local bridge; requires WeChat 8.0.70+ on iOS or Android.",
        "通过本机 wechat-bridge 接入个人微信，需 iOS / Android 微信 8.0.70+。",
        "透過本機 wechat-bridge 串接個人微信，需 iOS / Android 微信 8.0.70+。";
    HELP_DISCORD =
        "Create a bot in Discord Developer Portal",
        "在 Discord Developer Portal 创建 Bot",
        "在 Discord Developer Portal 建立 Bot";
    HELP_DINGTALK =
        "Create a bot app in DingTalk Developer Console",
        "在钉钉开发者后台创建机器人应用",
        "在釘釘開發者後臺建立機器人應用";
    HELP_QQ =
        "Create a bot in QQ Open Platform and get its AppID and AppSecret",
        "在 QQ 开放平台创建机器人并获取 AppID 和 AppSecret",
        "在 QQ 開放平台建立機器人並取得 AppID 和 AppSecret";
    HELP_SLACK =
        "Connect with a Bot Token and App-Level Token over Socket Mode",
        "使用 Bot Token 与 App-Level Token 通过 Socket Mode 接入",
        "使用 Bot Token 與 App-Level Token 透過 Socket Mode 串接";

    // Readiness, as the status beside a platform and the line under it.
    READINESS_UNSCAFFOLDED = "Unavailable", "未开放", "未開放";
    READINESS_UNSCAFFOLDED_DETAIL =
        "This platform cannot currently be used for remote access.",
        "该平台当前不可作为远程接入渠道。",
        "該平台目前不可作為遠端串接管道。";
    READINESS_SCAFFOLDED = "Setup required", "待配置", "待設定";
    READINESS_SCAFFOLDED_DETAIL =
        "Add the credentials required by this platform.",
        "等待补齐这个平台需要的凭据配置。",
        "等待補齊這個平台需要的憑證設定。";
    READINESS_CONFIGURED = "Configured", "已配置", "已設定";
    READINESS_CONFIGURED_DETAIL =
        "Configuration is saved; credential or runtime validation is still required.",
        "已填写配置；等待完成凭据或运行态验证。",
        "已填寫設定；等待完成憑證或執行狀態驗證。";
    READINESS_CREDENTIALS_VALID = "Credentials valid", "凭据有效", "憑證有效";
    READINESS_CREDENTIALS_VALID_DETAIL =
        "The credential check passed; this does not prove messages can be sent or received.",
        "凭据探测通过；这不代表已能收发消息。",
        "憑證探測透過；這不代表已能收發訊息。";
    READINESS_OPERATIONAL = "Operational", "运行可用", "執行可用";
    READINESS_OPERATIONAL_DETAIL =
        "The latest live runtime check succeeded.",
        "最近一次真实运行探测成功。",
        "最近一次真實執行探測成功。";
    READINESS_DEGRADED = "Degraded", "运行降级", "執行降級";
    READINESS_DEGRADED_DETAIL =
        "This channel worked before, but the latest runtime check failed.",
        "之前可用，但最近运行态探测失败。",
        "之前可用，但最近執行狀態探測失敗。";

    // A listener's state (`botStatusDetail`) and its connection.
    STATUS_DISABLED = "Turned off", "开关关闭", "開關關閉";
    STATUS_NO_TOKEN = "Waiting for Bot Token", "等待填写 Bot Token", "等待填寫 Bot Token";
    STATUS_MISSING_FEISHU =
        "Waiting for Feishu App ID or App Secret",
        "等待填写飞书 App ID 或 App Secret",
        "等待填寫飛書 App ID 或 App Secret";
    STATUS_FEISHU_DOMAIN_REQUIRED =
        "Feishu credentials are valid; add the event subscription domain",
        "飞书凭据有效，等待填写事件订阅域名",
        "飛書憑證有效，等待填寫事件訂閱域名";
    STATUS_FEISHU_EVENTS_NOT_CONNECTED =
        "Feishu credentials are valid; connect the event callback",
        "飞书凭据有效，等待事件回调接入",
        "飛書憑證有效，等待事件回呼串接";
    STATUS_UNAVAILABLE =
        "This platform cannot currently be used for remote access",
        "该平台当前不可作为远程接入渠道",
        "該平台目前不可作為遠端串接管道";
    STATUS_STOPPED = "Listener stopped", "监听已停止", "監聽已停止";
    STATUS_DETAILS_IN_LOGS = "See logs for runtime details", "运行态详情请见日志", "執行狀態詳情請見記錄";
    CONNECTION_POLLING = "Long polling", "长轮询", "長輪詢";
    CONNECTION_GATEWAY = "Event channel", "事件通道", "事件通道";
    CONNECTION_WEBHOOK = "Webhook", "Webhook", "Webhook";
    CONNECTION_NONE = "None", "无", "無";

    // A listener's failure reasons (`statusReasons`).
    REASON_SLACK_DISCONNECTED =
        "Slack disconnected; waiting to reconnect",
        "Slack 连接已断开，正在等待重新连接",
        "Slack 連線已中斷，正在等待重新連線";
    REASON_DISCONNECTED = "Connection lost", "连接已断开", "連線已中斷";
    REASON_RECONNECTING = "Reconnecting", "正在重新连接", "正在重新連線";
    REASON_STREAM_FAILED =
        "Failed to receive messages. Check the network and runtime logs",
        "消息接收失败，请检查网络和运行日志",
        "訊息接收失敗，請檢查網路和執行記錄";
    REASON_TIMEOUT = "Request timed out. Try again later", "请求超时，请稍后重试", "請求逾時，請稍後重試";
    REASON_RATE_LIMITED =
        "Too many requests. Try again later",
        "请求过于频繁，请稍后重试",
        "請求過於頻繁，請稍後重試";
    REASON_AUTH_FAILED =
        "Authentication failed. Check the credentials",
        "鉴权失败，请检查凭据",
        "驗證失敗，請檢查憑證";
    REASON_PROVIDER_ERROR =
        "The platform is temporarily unavailable. Try again later",
        "平台服务暂时不可用，请稍后重试",
        "平台服務暫時無法使用，請稍後重試";
    REASON_NETWORK_ERROR =
        "Network error. Check the network and proxy settings",
        "网络错误，请检查网络和代理设置",
        "網路錯誤，請檢查網路和代理設定";
    REASON_SEND_THROTTLED =
        "Sending was throttled (429); the last reply may be truncated, so ask the user to resend",
        "发送被节流（429）；上一条回复可能截断，可以请用户再发一次",
        "傳送被節流（429）；上一則回覆可能截斷，可以請使用者再發一次";
    REASON_POLLING_TIMEOUT =
        "Event polling timed out; the network or proxy may be unstable",
        "事件轮询超时；可能是网络抖动或代理失效",
        "事件輪詢逾時；可能是網路抖動或代理失效";
    REASON_SEND_FAILED =
        "Message send failed. Check the runtime logs and try again",
        "消息发送失败，请检查运行日志后重试",
        "訊息傳送失敗，請檢查執行記錄後重試";
    REASON_GET_ME_FAILED =
        "Connection probe failed. Check the network and try again",
        "连接探测失败，请检查网络后重试",
        "連線探測失敗，請檢查網路後重試";
    REASON_GATEWAY_BOT =
        "Failed to fetch the Gateway (HTTP {code})",
        "获取 Gateway 失败（HTTP {code}）",
        "取得 Gateway 失敗（HTTP {code}）";
    REASON_GATEWAY_CLOSED =
        "Gateway connection closed ({code}); reconnecting",
        "Gateway 连接关闭（{code}）；正在重连",
        "Gateway 連線關閉（{code}）；正在重連";
    REASON_CONNECTIONS_OPEN =
        "Failed to open the Stream subscription (HTTP {code})",
        "Stream 订阅打开失败（HTTP {code}）",
        "Stream 訂閱開啟失敗（HTTP {code}）";
    REASON_STREAM_CLOSED =
        "Stream connection closed ({code}); reconnecting",
        "Stream 连接关闭（{code}）；正在重连",
        "Stream 連線關閉（{code}）；正在重連";
    REASON_SEND_FAILED_CODE = "Send failed (HTTP {code})", "发送失败（HTTP {code}）", "傳送失敗（HTTP {code}）";
    REASON_APP_ACCESS_TOKEN =
        "Failed to fetch access_token (HTTP {code})",
        "获取 access_token 失败（HTTP {code}）",
        "取得 access_token 失敗（HTTP {code}）";

    // What a channel test found (`testErrors`, and `bot` of the test result
    // copy).
    TEST_CONNECTION_FAILED =
        "Check the credentials and network settings, then try again.",
        "请检查凭据和网络设置后重试。",
        "請檢查憑證和網路設定後重試。";
    TEST_TOKEN_MISSING =
        "Enter a Bot Token before testing the connection.",
        "请填写 Bot Token 后再测试。",
        "請填寫 Bot Token 後再測試。";
    TEST_TOKEN_INVALID =
        "The Bot Token is invalid. Check it and try again.",
        "Bot Token 无效，请检查后重试。",
        "Bot Token 無效，請檢查後重試。";
    TEST_SLACK_TOKENS_MISSING =
        "Enter a Slack Bot Token and App-Level Token before testing the connection.",
        "请填写 Slack Bot Token 和 App-Level Token 后再测试。",
        "請填寫 Slack Bot Token 和 App-Level Token 後再測試。";
    TEST_FEISHU_CREDENTIALS_MISSING =
        "Enter an App ID and App Secret before testing the connection.",
        "请填写 App ID 和 App Secret 后再测试。",
        "請填寫 App ID 和 App Secret 後再測試。";
    TEST_WECOM_CREDENTIALS_MISSING =
        "Enter a WeCom Bot ID and Secret before testing the connection.",
        "请填写企业微信 Bot ID 和 Secret 后再测试。",
        "請填寫企業微信 Bot ID 和 Secret 後再測試。";
    TEST_DINGTALK_CREDENTIALS_MISSING =
        "Enter a DingTalk Client ID (AppKey) and Client Secret before testing the connection.",
        "请填写钉钉 Client ID（AppKey）和 Client Secret 后再测试。",
        "請填寫釘釘 Client ID（AppKey）和 Client Secret 後再測試。";
    TEST_DINGTALK_NO_ACCESS_TOKEN =
        "DingTalk returned no access_token. Check the credentials and network, then try again.",
        "钉钉未返回 access_token，请检查凭据和网络后重试。",
        "釘釘未回傳 access_token，請檢查憑證和網路後重試。";
    TEST_QQ_CREDENTIALS_MISSING =
        "Enter a QQ App ID and AppSecret before testing the connection.",
        "请填写 QQ App ID 和 AppSecret 后再测试。",
        "請填寫 QQ App ID 和 AppSecret 後再測試。";
    TEST_QQ_NO_ACCESS_TOKEN =
        "QQ returned no access_token. Check the credentials and network, then try again.",
        "QQ 未返回 access_token，请检查凭据和网络后重试。",
        "QQ 未回傳 access_token，請檢查憑證和網路後重試。";
    TEST_WECHAT_BRIDGE_URL_INVALID =
        "The local WeChat bridge only accepts the local wechat-bridge, not a remote URL.",
        "微信本地桥接只允许访问本机 wechat-bridge，不能指向远端 URL。",
        "微信本機橋接只允許存取本機 wechat-bridge，不能指向遠端 URL。";
    TEST_WECHAT_ILINK_INCOMPLETE =
        "Complete WeChat QR sign-in first to save the iLink bot token and base URL.",
        "请先完成微信扫码登录，保存 iLink bot token 与 base URL。",
        "請先完成微信掃碼登入，儲存 iLink bot token 與 base URL。";
    CREDENTIALS_CHECK_PASSED =
        "The credential check passed. This does not mean the message listener is running.",
        "凭据检查已通过。这不代表消息收发服务已启动。",
        "憑證檢查已透過。這不代表訊息收發服務已啟動。";
    CREDENTIALS_CHECK_PASSED_AS =
        "The credential check passed · {username}. This does not mean the message listener is running.",
        "凭据检查已通过 · {username}。这不代表消息收发服务已启动。",
        "憑證檢查已透過 · {username}。這不代表訊息收發服務已啟動。";
    HINT_WECHAT_BRIDGE_REMOTE_URL =
        "WeChat QR sign-in only accepts the local wechat-bridge, not a remote URL.",
        "微信扫码登录只允许访问本机 wechat-bridge，不能指向远端 URL。",
        "微信掃碼登入只允許存取本機 wechat-bridge，不能指向遠端 URL。";
    HINT_WECHAT_BRIDGE_UNREACHABLE =
        "Start the local wechat-bridge first and make sure it exposes an iLink-compatible /api/weixin/qrcode or /qrcode endpoint.",
        "先启动本机 wechat-bridge，并确认它暴露了 iLink 兼容的 /api/weixin/qrcode 或 /qrcode 接口。",
        "先啟動本機 wechat-bridge，並確認它暴露了 iLink 相容的 /api/weixin/qrcode 或 /qrcode 介面。";

    // The overview.
    ACTIVE = "In use", "正在使用", "正在使用";
    SORT_HINT =
        "Sorted by attention needed and recent activity",
        "按需要处理、最近活动排序",
        "按需要處理、最近活動排序";
    EMPTY = "No channels are in use", "还没有正在使用的渠道", "還沒有正在使用的管道";
    MORE = "Connect more channels", "接入更多渠道", "串接更多管道";
    CHOOSE = "Choose a platform to begin setup", "选择平台开始配置", "選擇平台開始設定";
    LISTENING = "Listening", "监听中", "監聽中";
    MANAGE_LABEL = "Manage {name}, {status}", "管理 {name}，{status}", "管理 {name}，{status}";
    CONNECT_LABEL = "Connect {name}", "接入 {name}", "串接 {name}";

    // What an action found (Desktop's toasts).
    SAVE_FAILED = "Failed to save {name}", "{name} 保存失败", "{name} 儲存失敗";
    CREDENTIAL_VERIFIED = "{name} credentials verified", "{name} 凭据已验证", "{name} 憑證已驗證";
    CREDENTIAL_TEST_FAILED = "{name} credential test failed", "{name} 凭据测试失败", "{name} 憑證測試失敗";
    TEST_ERROR = "{name} test error", "{name} 测试出错", "{name} 測試出錯";
    NOW_LISTENING = "{name} is listening", "{name} 已开始监听", "{name} 已開始監聽";
    NOT_LISTENING = "{name} did not start listening", "{name} 启动后未进入监听", "{name} 啟動後未進入監聽";
    START_FAILED = "Failed to start {name}", "{name} 启动失败", "{name} 啟動失敗";
    DISCONNECT_TITLE = "Disconnect WeChat?", "断开微信登录？", "斷開微信登入？";
    DISCONNECT_DESCRIPTION =
        "This clears the saved local QR sign-in credentials. You will need to scan again to keep using WeChat.",
        "将清除本机保存的扫码登录凭据，之后需要重新扫码才能继续使用微信渠道。",
        "將清除本機儲存的掃碼登入憑證，之後需要重新掃碼才能繼續使用微信管道。";
    DISCONNECT = "Disconnect", "断开登录", "斷開登入";
    CANCEL = "Cancel", "取消", "取消";
    DISCONNECTED = "WeChat disconnected", "微信登录已断开", "微信登入已斷開";
    CREDENTIALS_CLEARED = "Local linked-session credentials cleared.", "本机关联凭据已清除。", "本機關聯憑證已清除。";

    // A platform's detail.
    UNAVAILABLE_HINT =
        "This platform is not available and cannot be enabled.",
        "该平台未开放，暂不能启用。",
        "該平台未開放，暫不能啟用。";
    SCAN_FIRST_HINT =
        "Scan to connect before enabling this channel.",
        "先扫码接入后才能启用。",
        "先掃碼串接後才能啟用。";
    TEST_FIRST_HINT =
        "Test and connect before enabling this channel.",
        "先测试并连接后才能启用。",
        "先測試並連線後才能啟用。";
    BACK = "Back to Remote access", "返回远程接入", "返回遠端串接";
    CONFIG_DOCS_LINK = "View setup guide", "查看配置文档", "檢視設定文件";
    ENABLE_LABEL = "Enable {name} channel", "启用{name}渠道", "啟用{name}管道";
    DETAIL_LISTENING = "Listening for new messages", "正在监听新消息", "正在監聽新訊息";
    HEALTHY = "Connection healthy. No action needed.", "连接正常，无需处理。", "連線正常，無需處理。";
    ACTIONS_LABEL = "{name} channel actions", "{name}渠道操作", "{name}管道操作";
    QUICK_BIND = "Quick connect", "快捷绑定", "快捷綁定";
    SCAN_LOGIN = "Scan to sign in", "扫码登录", "掃碼登入";
    SCAN_CONNECT = "Scan to connect", "扫码接入", "掃碼串接";
    DISCONNECTING = "Disconnecting…", "断开中…", "斷開中…";
    DISCONNECT_WECHAT = "Disconnect WeChat", "断开微信登录", "斷開微信登入";
    BRIDGE_QR = "Local bridge QR code", "本机桥接二维码", "本機橋接二維碼";
    TESTING = "Testing…", "测试中…", "測試中…";
    TEST = "Test connection", "测试连接", "測試連線";
    CONNECTING = "Connecting…", "连接中…", "連線中…";
    TEST_AND_CONNECT = "Test and connect", "测试并连接", "測試並連線";
    RESTARTING = "Restarting…", "重启中…", "重啟中…";
    RESTART = "Restart listener", "重启监听", "重啟監聽";
    RUNTIME_LABEL = "{name} runtime status", "{name}运行状态", "{name}執行狀態";
    IDENTITY = "Identity", "身份", "身份";
    UNKNOWN_IDENTITY = "Unavailable", "未获取", "未取得";
    CONNECTION_TYPE = "Connection type", "通道类型", "通道型別";
    LAST_EVENT = "Last event", "最近事件", "最近事件";
    NONE_YET = "None", "暂无", "暫無";
    LAST_TEST = "Last test", "最近一次测试", "最近一次測試";
    NEVER_TESTED = "Never tested", "从未测试", "從未測試";
    LATEST_FAILURE = "Latest failure", "最近一次失败", "最近一次失敗";
    SETUP_METHOD = "Connection method", "接入方式", "串接方式";
    CONNECTION_SETTINGS = "Connection settings", "连接配置", "連線設定";
    LOCAL_CREDENTIALS = "Credentials stay on this device", "凭据仅保存在本机", "憑證僅儲存在本機";
    AUTOSAVE = "Saved automatically", "自动保存", "自動儲存";
    SETUP_LABEL = "{name} connection method", "{name}接入方式", "{name}串接方式";
    QUICK_RECOMMENDED = "Quick setup (recommended)", "快捷接入（推荐）", "快捷串接（推薦）";
    QUICK_LABEL = "{name} quick setup", "{name}快捷接入", "{name}快捷串接";
    MANUAL = "Manual setup", "手动配置", "手動設定";
    QUICK_WECOM_TITLE = "Scan to create and connect a bot", "扫码创建并绑定机器人", "掃碼建立並綁定機器人";
    QUICK_TITLE = "Scan to create an app and bot", "扫码自动创建应用与机器人", "掃碼自動建立應用與機器人";
    QUICK_WECOM_DETAIL =
        "After an administrator confirms the scan, Maka saves the Bot ID and Secret and starts the persistent connection.",
        "企业管理员扫码确认后，Maka 会保存 Bot ID 与 Secret 并启动长连接。",
        "企業管理員掃碼確認後，Maka 會儲存 Bot ID 與 Secret 並啟動長連線。";
    QUICK_QQ_TITLE =
        "Scan with mobile QQ to create and bind a bot",
        "使用手机 QQ 扫码创建并绑定机器人",
        "使用手機 QQ 掃碼建立並綁定機器人";
    QUICK_QQ_DETAIL =
        "After confirmation, QQ securely returns the AppID and AppSecret; Maka stores them locally and starts the Gateway.",
        "确认后，QQ 会安全返回 AppID 与 AppSecret，Maka 在本机保存凭据并启动 Gateway。",
        "確認後，QQ 會安全返回 AppID 與 AppSecret，Maka 在本機儲存憑證並啟動 Gateway。";
    TELEGRAM_OFFICIAL_FLOW =
        "Telegram officially requires a Bot Token from @BotFather and does not provide an API that creates a bot by QR scan and returns its token.",
        "Telegram 官方目前仅支持通过 @BotFather 获取 Bot Token，不提供扫码创建 Bot 并回传 Token 的 API。",
        "Telegram 官方目前僅支援透過 @BotFather 取得 Bot Token，不提供掃碼建立 Bot 並回傳 Token 的 API。";
    // Desktop says "in the main process"; here the bot runtime saves them.
    QUICK_DETAIL =
        "After confirmation, Maka stores the credentials on this device and starts the message connection.",
        "扫码确认后，Maka 会在本机保存凭据并启动消息连接。",
        "掃碼確認後，Maka 會在本機儲存憑證並啟動訊息連線。";
    FEISHU_REGION_LABEL = "Choose Feishu account region", "选择飞书账号区域", "選擇飛書帳號區域";
    BEGIN_QUICK_BIND = "Start quick connect", "开始快捷绑定", "開始快捷綁定";
    SCAN_WITH = "Scan with {name}", "使用{name}扫码接入", "使用{name}掃碼串接";
    CREDENTIALS_SAVED = "{name} credentials saved", "{name}凭据已保存", "{name}憑證已儲存";
    SCAN_COMPLETE = "{name} QR setup complete", "{name}已完成扫码接入", "{name}已完成掃碼串接";
    SAVED_AND_CONNECTED =
        "Credentials saved securely and connection started",
        "凭据已安全保存并开始连接",
        "憑證已安全儲存並開始連線";

    // The credential fields.
    TELEGRAM_TOKEN = "Telegram Bot Token", "Telegram Bot Token", "Telegram Bot Token";
    DISCORD_TOKEN = "Discord Bot Token", "Discord Bot Token", "Discord Bot Token";
    SLACK_TOKEN = "Slack Bot Token", "Slack Bot Token", "Slack Bot Token";
    SLACK_APP_TOKEN = "Slack App-Level Token", "Slack App-Level Token", "Slack App-Level Token";
    QQ_SECRET = "QQ AppSecret", "QQ AppSecret", "QQ AppSecret";
    // Captions under their fields: sentences, without Desktop's
    // parentheses (review round 10).
    CHINA_REQUIRED =
        "Required on networks in mainland China.",
        "国内网络必填。",
        "國內網路必填。";
    AUTH_ONLY = "Used only for Bot authentication.", "仅用于 Bot 鉴权。", "僅用於 Bot 鑑權。";
    TELEGRAM_PROXY = "Telegram proxy URL", "Telegram 代理地址", "Telegram 代理地址";
    TELEGRAM_NOTICE =
        "Enable TUN mode in your network tool and restart the app to complete Telegram Bot setup.",
        "请打开网络的 TUN 模式后重启应用，以便完成 Telegram Bot 设置",
        "請開啟網路的 TUN 模式後重啟應用，以便完成 Telegram Bot 設定";
    FEISHU_CREDENTIAL_ID = "Feishu credential ID", "飞书凭据 ID", "飛書憑證 ID";
    FEISHU_SECRET = "Feishu App Secret", "飞书 App Secret", "飛書 App Secret";
    FEISHU_DOMAIN = "Feishu domain", "飞书域名", "飛書域名";
    FEISHU_OPTION = "Feishu (feishu.cn)", "飞书 (feishu.cn)", "飛書 (feishu.cn)";
    LARK_OPTION = "Lark (larksuite.com)", "Lark (larksuite.com)", "Lark (larksuite.com)";
    DISCORD_PROXY = "Discord proxy URL", "Discord 代理地址", "Discord 代理地址";
    DISCORD_NOTICE =
        "For Discord access from mainland China, the proxy above covers Bot authentication only. Message WebSockets require a system-level proxy. Enable TUN mode and restart the app.",
        "国内网络访问 Discord：上方代理仅作用于 Bot 鉴权请求，消息收发走 WebSocket 长连接需要系统级代理。请打开网络的 TUN 模式后重启应用。",
        "國內網路存取 Discord：上方代理僅作用於 Bot 鑑權請求，訊息收發走 WebSocket 長連線需要系統級代理。請開啟網路的 TUN 模式後重啟應用。";
    DINGTALK_ID = "DingTalk app key", "钉钉应用密钥", "釘釘應用金鑰";
    DINGTALK_SECRET = "DingTalk Client Secret", "钉钉 Client Secret", "釘釘 Client Secret";
    WECOM_BOT_PLACEHOLDER = "WeCom AI app Bot ID", "企业微信 AI 应用 Bot ID", "企業微信 AI 應用 Bot ID";
    WECOM_BOT = "WeCom Bot ID", "企业微信 Bot ID", "企業微信 Bot ID";
    WECOM_SECRET_PLACEHOLDER = "AI app Secret", "AI 应用 Secret", "AI 應用 Secret";
    WECOM_SECRET = "WeCom Secret", "企业微信 Secret", "企業微信 Secret";
    QQ_ID = "QQ app ID", "QQ 应用编号", "QQ 應用編號";
    ALLOWED_USERS = "Allowed user IDs ({count} / {max})", "允许的用户 ID（{count} / {max}）", "允許的使用者 ID（{count} / {max}）";
    ALLOWED_USERS_PLACEHOLDER =
        "One user ID per line; leave empty to allow everyone\nExample: 123456789",
        "每行一个用户 ID，留空表示不限\n例如：123456789",
        "每行一個使用者 ID，留空表示不限\n例如：123456789";
    ALLOWED_USERS_HELP =
        "Telegram user IDs are 64-bit integers. When set, only messages from these IDs are accepted; all others are silently ignored.",
        "Telegram 用户 ID 是 64 位整数；填入后只接收列表里这些 ID 的来信，其它人发的消息会被静默忽略（不会回弹任何提示）。",
        "Telegram 使用者 ID 是 64 位整數；填入後只接收列表裡這些 ID 的來信，其它人發的訊息會被靜默忽略（不會回彈任何提示）。";
    ALLOWED_USERS_HELP_AT_CAP =
        "Telegram user IDs are 64-bit integers. When set, only messages from these IDs are accepted; all others are silently ignored. (limit reached)",
        "Telegram 用户 ID 是 64 位整数；填入后只接收列表里这些 ID 的来信，其它人发的消息会被静默忽略（不会回弹任何提示）。 （已达到上限）",
        "Telegram 使用者 ID 是 64 位整數；填入後只接收列表裡這些 ID 的來信，其它人發的訊息會被靜默忽略（不會回彈任何提示）。 （已達到上限）";
    INVALID_USERS =
        "These entries are not numeric IDs and may be usernames, so they will not match anyone: {preview}",
        "下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：{preview}",
        "下列不是數字 ID，可能是使用者名稱之類的輸入，符合不到任何人：{preview}";
    // `{count}` is how many more in English, how many in all in Chinese, as
    // Desktop counts them.
    INVALID_USERS_MORE =
        "These entries are not numeric IDs and may be usernames, so they will not match anyone: {preview} and {count} more",
        "下列不是数字 ID，可能是用户名之类的输入，匹配不到任何人：{preview} 等 {count} 项",
        "下列不是數字 ID，可能是使用者名稱之類的輸入，符合不到任何人：{preview} 等 {count} 項";
    INVALID_USERS_SEPARATOR = ", ", "、", "、";
    /// A secret field's placeholder once one is saved: it is never shown.
    SECRET_SAVED =
        "Saved (enter a new one to replace)",
        "已保存（输入新值可替换）",
        "已儲存（輸入新值可替換）";

    // The QR onboarding dialog.
    DINGTALK_TITLE = "Set up DingTalk", "配置钉钉", "設定釘釘";
    DINGTALK_SUBTITLE = "Scan in DingTalk to register the app", "在钉钉中扫码完成应用注册", "在釘釘中掃碼完成應用註冊";
    DINGTALK_WAITING =
        "Scan with DingTalk and confirm authorization",
        "请使用钉钉扫描二维码并确认授权",
        "請使用釘釘掃描二維碼並確認授權";
    DINGTALK_SCANNED =
        "Scanned. Complete confirmation in DingTalk.",
        "已扫码，请在钉钉中完成确认",
        "已掃碼，請在釘釘中完成確認";
    DINGTALK_QR_ALT = "DingTalk setup QR code", "配置钉钉二维码", "設定釘釘二維碼";
    FEISHU_TITLE = "Set up Feishu", "配置飞书", "設定飛書";
    FEISHU_SUBTITLE =
        "Scan with Feishu to create and configure the bot",
        "使用飞书扫描二维码，自动创建并配置机器人",
        "使用飛書掃描二維碼，自動建立並設定機器人";
    FEISHU_WAITING =
        "Scan with Feishu and confirm creation",
        "请使用飞书扫描二维码并确认创建",
        "請使用飛書掃描二維碼並確認建立";
    FEISHU_SCANNED =
        "Scanned. Complete confirmation in Feishu.",
        "已扫码，请在飞书中完成确认",
        "已掃碼，請在飛書中完成確認";
    FEISHU_QR_ALT = "Feishu setup QR code", "配置飞书二维码", "設定飛書二維碼";
    LARK_TITLE = "Set up Lark", "配置 Lark", "設定 Lark";
    LARK_SUBTITLE =
        "Scan with Lark to create and configure the bot",
        "使用 Lark 扫描二维码，自动创建并配置机器人",
        "使用 Lark 掃描二維碼，自動建立並設定機器人";
    LARK_WAITING =
        "Scan with Lark and confirm creation",
        "请使用 Lark 扫描二维码并确认创建",
        "請使用 Lark 掃描二維碼並確認建立";
    LARK_SCANNED =
        "Scanned. Complete confirmation in Lark.",
        "已扫码，请在 Lark 中完成确认",
        "已掃碼，請在 Lark 中完成確認";
    LARK_QR_ALT = "Lark setup QR code", "配置 Lark 二维码", "設定 Lark 二維碼";
    WECOM_TITLE = "Set up WeCom", "配置企业微信", "設定企業微信";
    WECOM_SUBTITLE =
        "Quick setup creates and connects a WeCom bot",
        "快捷绑定会自动创建并连接企业微信机器人",
        "快捷綁定會自動建立並連線企業微信機器人";
    WECOM_WAITING =
        "Open WeCom and scan to create the bot",
        "打开企业微信，扫描二维码完成机器人创建",
        "開啟企業微信，掃描二維碼完成機器人建立";
    WECOM_SCANNED =
        "Scanned. Complete confirmation in WeCom.",
        "已扫码，请在企业微信中完成确认",
        "已掃碼，請在企業微信中完成確認";
    WECOM_QR_ALT = "WeCom setup QR code", "配置企业微信二维码", "設定企業微信二維碼";
    WECHAT_TITLE = "Scan to sign in", "扫码登录", "掃碼登入";
    WECHAT_SUBTITLE = "Scan with WeChat to connect", "请使用微信扫描二维码完成连接", "請使用微信掃描二維碼完成連線";
    WECHAT_WAITING =
        "Scan with WeChat and confirm on your phone",
        "请使用微信扫描二维码并在手机上确认",
        "請使用微信掃描二維碼並在手機上確認";
    WECHAT_SCANNED =
        "Scanned. Complete confirmation in WeChat.",
        "已扫码，请在微信中完成确认",
        "已掃碼，請在微信中完成確認";
    WECHAT_QR_ALT = "WeChat sign-in QR code", "微信扫码登录二维码", "微信掃碼登入二維碼";
    QQ_TITLE = "Set up QQ", "配置 QQ", "設定 QQ";
    QQ_SUBTITLE =
        "Scan with mobile QQ to create and bind a bot",
        "使用手机 QQ 扫码创建并绑定机器人",
        "使用手機 QQ 掃碼建立並綁定機器人";
    QQ_WAITING =
        "Scan with mobile QQ and confirm binding",
        "请使用手机 QQ 扫描二维码并确认绑定",
        "請使用手機 QQ 掃描二維碼並確認綁定";
    QQ_SCANNED = "Scanned. Complete confirmation in QQ.", "已扫码，请在 QQ 中完成确认", "已掃碼，請在 QQ 中完成確認";
    QQ_QR_ALT = "QQ setup QR code", "配置 QQ 二维码", "設定 QQ 二維碼";
    CONNECTED_REFRESH_FAILED =
        "Connected, but status refresh failed: {message}",
        "连接已完成，但状态刷新失败：{message}",
        "連線已完成，但狀態重新整理失敗：{message}";
    GENERATING_LABEL = "Generating QR code", "正在生成二维码", "正在生成二維碼";
    // Desktop's line names its renderer; here no page ever reads them.
    PRIVACY =
        "Credentials stay on this device and are never shown in settings or sent to Maka cloud.",
        "凭据仅保存在本机，不会显示在设置中，也不会传给 Maka 云端。",
        "憑證僅儲存在本機，不會顯示在設定中，也不會傳給 Maka 雲端。";
    OPEN_BROWSER = "Cannot scan? Open in browser", "无法扫码？在浏览器中打开", "無法掃碼？在瀏覽器中開啟";
    DONE = "Done", "完成", "完成";
    REGENERATE = "Generate again", "重新生成", "重新生成";
    REFRESH_QR = "Refresh QR code", "刷新二维码", "重新整理二維碼";
    GENERATING = "Generating a secure QR code…", "正在生成安全二维码…", "正在生成安全二維碼…";
    ONBOARDING_CONNECTING =
        "Authorization complete. Saving credentials and starting connection…",
        "授权完成，正在保存凭据并启动连接…",
        "授權完成，正在儲存憑證並啟動連線…";
    CONNECTED = "{name} connected", "{name} 已连接", "{name} 已連線";
    RETRYING_ONE =
        "{reason}; {count} consecutive failure. Retrying automatically in about {seconds}s.",
        "{reason}；连续失败 {count} 次，约 {seconds} 秒后自动重试。",
        "{reason}；連續失敗 {count} 次，約 {seconds} 秒後自動重試。";
    RETRYING_OTHER =
        "{reason}; {count} consecutive failures. Retrying automatically in about {seconds}s.",
        "{reason}；连续失败 {count} 次，约 {seconds} 秒后自动重试。",
        "{reason}；連續失敗 {count} 次，約 {seconds} 秒後自動重試。";
    RETRY_TIMEOUT = "The request timed out", "请求超时", "請求逾時";
    RETRY_NETWORK = "The network is temporarily unavailable", "网络暂时异常", "網路暫時異常";
    RETRY_RATE_LIMITED = "The service is rate limiting requests", "服务请求频率受限", "服務請求頻率受限";
    RETRY_SERVER = "The service is temporarily unavailable", "服务端暂时异常", "服務端暫時異常";
    RETRY_OTHER = "The service is temporarily unavailable", "服务暂时异常", "服務暫時異常";
    ONBOARDING_EXPIRED = "QR code expired. Generate a new one.", "二维码已过期，请重新生成", "二維碼已過期，請重新生成";
    ONBOARDING_DENIED =
        "Authorization cancelled. Generate a new QR code.",
        "授权已取消，请重新生成二维码",
        "授權已取消，請重新生成二維碼";
    ONBOARDING_CANCELLED = "QR setup cancelled", "扫码接入已取消", "掃碼串接已取消";
    ONBOARDING_FAILED = "QR setup failed. Try again.", "扫码接入失败，请重试", "掃碼串接失敗，請重試";
    ONBOARDING_PREPARING = "Preparing QR setup…", "准备扫码接入…", "準備掃碼串接…";
    SAVED_NOT_CONNECTED =
        "Credentials were saved, but the connection did not start. Retry from settings later.",
        "凭据已保存，但连接未建立，可稍后在设置中重试。",
        "憑證已儲存，但連線未建立，可稍後在設定中重試。";
    SAVED_NOT_CONNECTED_DETAIL =
        "Credentials were saved, but the connection did not start: {detail}. Retry from settings later.",
        "凭据已保存，但连接未建立：{detail}，可稍后在设置中重试。",
        "憑證已儲存，但連線未建立：{detail}，可稍後在設定中重試。";
    ONBOARDING_ERROR_CANCELLED = "QR setup was cancelled.", "扫码接入已取消。", "掃碼串接已取消。";
    ONBOARDING_ERROR_UNAVAILABLE =
        "QR setup is temporarily unavailable. Try again later.",
        "扫码接入暂时不可用，请稍后重试。",
        "掃碼串接暫時無法使用，請稍後重試。";

    // WeChat: the bridge token, the advanced fields, and the local bridge's
    // QR sign-in.
    WECHAT_TOKEN = "WeChat Bot Token", "微信 Bot Token", "微信 Bot Token";
    WECHAT_TOKEN_PLACEHOLDER =
        "Local wechat-bridge Bearer Token",
        "本机 wechat-bridge Bearer Token",
        "本機 wechat-bridge Bearer Token";
    COLLAPSE_ADVANCED = "Hide advanced settings", "收起高级设置", "收起進階設定";
    EXPAND_ADVANCED =
        "Advanced settings (Official Account / local bridge URL)",
        "高级设置（公众号 / 本机 bridge 地址）",
        "進階設定（公眾號 / 本機 bridge 地址）";
    BRIDGE_ADDRESS = "Local bridge URL", "本机 bridge 地址", "本機 bridge 地址";
    WECHAT_APP_ID = "Official Account App ID", "公众号 App ID", "公眾號 App ID";
    WECHAT_APP_ID_PLACEHOLDER = "WeChat Official Account App ID", "微信公众号 App ID", "微信公眾號 App ID";
    WECHAT_APP_SECRET = "Official Account App Secret", "公众号 App Secret", "公眾號 App Secret";
    WECHAT_APP_SECRET_PLACEHOLDER =
        "WeChat Official Account App Secret",
        "微信公众号 App Secret",
        "微信公眾號 App Secret";
    ADVANCED_NOTICE =
        "The local bridge defaults to http://127.0.0.1:18400. Official Account App ID and App Secret are used only for Official Account messaging; personal WeChat QR sign-in uses the local bridge.",
        "本机 bridge 默认为 http://127.0.0.1:18400。公众号 App ID / App Secret 仅用于公众号消息发送，个人微信扫码登录走本机 bridge。",
        "本機 bridge 預設為 http://127.0.0.1:18400。公眾號 App ID / App Secret 僅用於公眾號訊息傳送，個人微信掃碼登入走本機 bridge。";
    READ_QR_FAILED =
        "Could not read a QR code from the local wechat-bridge. Make sure the bridge is running.",
        "读取本机 wechat-bridge 二维码失败，请确认 bridge 已启动。",
        "讀取本機 wechat-bridge 二維碼失敗，請確認 bridge 已啟動。";
    BRIDGE_TITLE = "WeChat QR sign-in", "微信扫码登录", "微信掃碼登入";
    BRIDGE_SUBTITLE =
        "Scan the QR code with WeChat and confirm signing in to the local wechat-bridge on your phone.",
        "使用手机微信扫描二维码，并在手机上确认登录本机 wechat-bridge。",
        "使用手機微信掃描二維碼，並在手機上確認登入本機 wechat-bridge。";
    BRIDGE_GENERATING = "Generating QR code…", "正在生成二维码…", "正在生成二維碼…";
    LOGGED_IN =
        "WeChat is signed in. Return to test the connection or restart the listener.",
        "微信已登录，返回后可以测试连接或重启监听。",
        "微信已登入，返回後可以測試連線或重啟監聽。";
    BRIDGE_EXPIRED = "QR code expired", "二维码已过期", "二維碼已過期";
    EXPIRED_HINT =
        "Refresh the QR code and scan again to continue signing in.",
        "刷新二维码后重新扫码即可继续登录。",
        "重新整理二維碼後重新掃碼即可繼續登入。";
    REFRESHING = "Refreshing…", "刷新中…", "重新整理中…";
    BRIDGE_QR_ALT = "WeChat sign-in QR code", "微信扫码登录二维码", "微信掃碼登入二維碼";
    BRIDGE_WAITING =
        "Waiting for confirmation… Sign-in status refreshes every 3 seconds.",
        "等待扫码确认… 窗口会每 3 秒刷新登录状态。",
        "等待掃碼確認… 視窗會每 3 秒重新整理登入狀態。";
    RETRYING = "Retrying…", "重试中…", "重試中…";
    RETRY = "Retry", "重试", "重試";
    BRIDGE_PENDING = "The bridge is generating a QR code", "bridge 正在生成二维码", "bridge 正在生成二維碼";
    BRIDGE_PENDING_HINT =
        "The QR code appears automatically once ready; you can also fetch it again.",
        "二维码就绪后会自动显示，也可以手动重新获取。",
        "二維碼就緒後會自動顯示，也可以手動重新取得。";
    FETCHING = "Fetching…", "获取中…", "取得中…";
    FETCH_AGAIN = "Fetch again", "重新获取", "重新取得";

    // The bot runtime this client runs beside the Host (the sidecar), and a
    // Telegram token another client polls: states Desktop does not have.
    RUNTIME_STARTING = "Starting the chat bots…", "正在启动远程接入服务…", "正在啟動遠端串接服務…";
    RUNTIME_RESTARTING =
        "The chat bots stopped and restart in a moment.",
        "远程接入服务已停止，稍后会自动重启。",
        "遠端串接服務已停止，稍後會自動重啟。";
    RUNTIME_UNAVAILABLE =
        "The chat bots cannot run:",
        "远程接入服务无法运行：",
        "遠端串接服務無法執行：";
    RUNTIME_HELD_ELSEWHERE =
        "Another Maka window or app already runs the chat bots of this data folder.",
        "另一个 Maka 窗口或应用已在运行这个数据文件夹的远程接入。",
        "另一個 Maka 視窗或應用已在執行這個資料夾的遠端串接。";
    RUNTIME_NOT_RUNNING =
        "Connection tests and QR setup need the chat bots running.",
        "测试连接和扫码接入需要远程接入服务在运行。",
        "測試連線和掃碼串接需要遠端串接服務在執行。";
    SETTINGS_UNREADABLE =
        "The chat bot settings can’t be read:",
        "无法读取远程接入设置：",
        "無法讀取遠端串接設定：";
    CONFLICT_POLLING =
        "Another client is receiving messages with this bot token, so Maka stopped listening. Stop the other client, then restart the listener.",
        "另一个客户端正在用这个 Bot Token 接收消息，Maka 已停止监听。请先停止另一个客户端，再重启监听。",
        "另一個用戶端正在用這個 Bot Token 接收訊息，Maka 已停止監聽。請先停止另一個用戶端，再重啟監聽。";
    CONFLICT_WEBHOOK =
        "This bot delivers its messages to a webhook, so Maka cannot receive them. Remove the webhook, then restart the listener.",
        "这个 Bot 已设置 Webhook，Maka 无法接收它的消息。请先移除 Webhook，再重启监听。",
        "這個 Bot 已設定 Webhook，Maka 無法接收它的訊息。請先移除 Webhook，再重啟監聽。";
    CONFLICT_STATUS = "Used by another client", "已被其他客户端占用", "已被其他用戶端佔用";
}

/// A platform's action or status line with its name (`{name}`).
pub fn named(text: Text, locale: Locale, name: &str) -> String {
    text.fill(locale, &[("name", name)])
}

/// A failure reason that carries a code (`gateway-closed-4004`).
pub fn with_code(text: Text, locale: Locale, code: &str) -> String {
    text.fill(locale, &[("code", code)])
}

pub fn manage_label(locale: Locale, name: &str, status: &str) -> String {
    MANAGE_LABEL.fill(locale, &[("name", name), ("status", status)])
}

pub fn allowed_users(locale: Locale, count: usize, max: usize) -> String {
    ALLOWED_USERS.fill(locale, &[("count", &count.to_string()), ("max", &max.to_string())])
}

/// The allowlist entries that are not numeric ids, the first three named.
pub fn invalid_users(locale: Locale, entries: &[&str]) -> String {
    let preview = entries[..entries.len().min(3)].join(INVALID_USERS_SEPARATOR.in_locale(locale));
    if entries.len() <= 3 {
        return INVALID_USERS.fill(locale, &[("preview", &preview)]);
    }
    let count = if locale == Locale::English { entries.len() - 3 } else { entries.len() };
    INVALID_USERS_MORE.fill(locale, &[("preview", &preview), ("count", &count.to_string())])
}

pub fn credentials_check_passed(locale: Locale, username: Option<&str>) -> String {
    match username.filter(|name| !name.trim().is_empty()) {
        Some(username) => CREDENTIALS_CHECK_PASSED_AS.fill(locale, &[("username", username)]),
        None => CREDENTIALS_CHECK_PASSED.in_locale(locale).to_owned(),
    }
}

/// The onboarding's line while it backs off after `count` failures in a row.
pub fn retrying(locale: Locale, reason: &str, count: u32, seconds: u64) -> String {
    plural(u64::from(count), RETRYING_ONE, RETRYING_OTHER).fill(
        locale,
        &[("reason", reason), ("count", &count.to_string()), ("seconds", &seconds.to_string())],
    )
}

pub fn saved_not_connected(locale: Locale, detail: Option<&str>) -> String {
    match detail {
        Some(detail) => SAVED_NOT_CONNECTED_DETAIL.fill(locale, &[("detail", detail)]),
        None => SAVED_NOT_CONNECTED.in_locale(locale).to_owned(),
    }
}
