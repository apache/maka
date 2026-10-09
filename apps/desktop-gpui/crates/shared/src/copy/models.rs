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

//! Copy of the Models page: the connection list, the provider catalog, the
//! form that connects a provider, a connection's detail, and a model's
//! parameters. The wording is Maka Desktop's
//! (`apps/desktop/src/renderer/features/connection-settings/settings-provider-copy.ts`,
//! whose `zh-CN` and `zh-TW` are the Chinese columns here); a sentence
//! Desktop does not have says so above it. A provider's name and
//! description are in [`super::providers`].

use super::{Locale, plural};

texts! {
    // The connection list (`panel`).
    CONNECTIONS_HELP =
        "These connections and their enabled models appear in the chat model picker.",
        "已启用的模型会显示在任务的模型选择器中。",
        "已啟用的模型會顯示在任務的模型選擇器中。";
    EMPTY = "No model connections yet", "还没有模型连接", "還沒有模型連線";
    EMPTY_HELP =
        "Start with a common provider below, or browse them all.",
        "从下方的常用服务商开始，或浏览全部服务商。",
        "從下方的常用服務商開始，或瀏覽全部服務商。";
    BROWSE_ALL = "Browse all providers", "查看全部服务商", "查看全部服務商";
    RECOMMENDED_PROVIDERS = "Recommended providers", "推荐服务商", "推薦服務商";
    SET_DEFAULT_TITLE =
        "New chats will use this connection",
        "让新任务默认使用这个连接",
        "讓新任務預設使用這個連線";
    BACK_TO_LIST = "Back to model connections", "返回模型连接", "返回模型連線";
    BACK_TO_CATALOG = "Back to the provider list", "返回服务商列表", "返回服務商列表";
    CONNECTION_REMOVED =
        "The original connection was deleted or removed. Returned to the connection list.",
        "原连接已被删除或移除，已返回模型连接列表。",
        "原連線已刪除或移除，已返回模型連線列表。";
    CONNECTED_LOADING =
        "Connection added. Loading its details…",
        "连接已添加，正在载入详情…",
        "連線已新增，正在載入詳細資料…";
    /// The accessible name of a list row (`chipAria`).
    ROW_LABEL = "Model connection: {name}; provider: {provider}", "模型连接：{name}，供应商：{provider}", "模型連線：{name}，供應商：{provider}";
    ROW_LABEL_DEFAULT = "; default connection", "，默认连接", "，預設連線";
    ROW_LABEL_STATUS = "; {status}", "，{status}", "，{status}";

    // A connection's status beside its row (`connectionStatuses`).
    STATUS_RETIRED = "Retired · delete it", "已停用 · 请删除", "已停用 · 請刪除";
    STATUS_REAUTH = "Sign-in required", "需要重新登录", "需要重新登入";
    STATUS_DISABLED_FAILED = "Unavailable · last connection failed", "暂不可用 · 上次连接失败", "暫不可用 · 上次連線失敗";
    STATUS_DISABLED = "Unavailable", "暂不可用", "暫不可用";
    STATUS_FAILED = "Last connection failed", "上次连接失败", "上次連線失敗";

    // The provider catalog.
    CATALOG_HELP =
        "Choose account sign-in, a model plan, API, aggregator, or local runtime.",
        "选择账号登录、模型计划、API、聚合服务或本地运行时。",
        "選擇帳號登入、模型計劃、API、聚合服務或本地執行時。";
    SEARCH_PROVIDERS = "Search providers", "搜索服务商", "搜尋服務商";
    NO_MATCHING_PROVIDERS = "No matching providers", "未找到匹配的服务商", "沒有符合的服務商";
    CLEAR_SEARCH = "Clear search", "清除搜索", "清除搜尋";
    GROUP_RECOMMENDED = "Recommended", "推荐", "推薦";
    GROUP_PLANS = "Subscription plans", "订阅计划", "訂閱計劃";
    GROUP_API = "API", "API", "API";
    GROUP_AGGREGATORS = "Aggregators", "聚合服务", "聚合服務";
    GROUP_LOCAL = "Local", "本地", "本地";
    /// The account sign-ins the recommended group lists first (`oauthSection`).
    CODEX_DESCRIPTION =
        "Use a ChatGPT Plus / Pro account to add a connection.",
        "使用 ChatGPT Plus / Pro 账号添加连接。",
        "ChatGPT Plus / Pro 訂閱帳號登入。";
    COPILOT_DESCRIPTION =
        "Sign in with GitHub to connect a Copilot subscription, or import compatible credentials.",
        "使用 GitHub 登录连接 Copilot 订阅，或导入兼容凭据。",
        "匯入相容 GitHub 憑據連線 Copilot 訂閱。";
    XAI_DESCRIPTION =
        "Use a SuperGrok or X Premium account to add a connection.",
        "使用 SuperGrok / X Premium 账号添加连接。",
        "SuperGrok / X Premium 帳號登入。";
    ACCOUNTS_CONFIGURED_ONE =
        "{count} connection configured · Add another account",
        "已有 {count} 个连接 · 添加另一个账号",
        "已有 {count} 個連線 · 新增另一個帳號";
    ACCOUNTS_CONFIGURED_OTHER =
        "{count} connections configured · Add another account",
        "已有 {count} 个连接 · 添加另一个账号",
        "已有 {count} 個連線 · 新增另一個帳號";
    /// Not Desktop's: where an account sign-in row's link to its login
    /// would be. This client leaves account sign-ins to Maka Desktop.
    ACCOUNT_IN_DESKTOP =
        "Signing in with an account is done in Maka Desktop for now.",
        "目前请在 Maka Desktop 中用账号登录。",
        "目前請在 Maka Desktop 中以帳號登入。";
    /// Not Desktop's: the badge on an account sign-in row, which this
    /// client cannot add.
    ACCOUNT_NEEDS_DESKTOP = "Needs Maka Desktop", "需 Maka Desktop", "需 Maka Desktop";

    // Connecting a provider (`add`).
    CONNECT_TITLE = "Connect {name}", "连接 {name}", "連線 {name}";
    /// Not Desktop's: the custom provider's setup title, which "Connect
    /// Custom connection" would read badly as.
    ADD_CUSTOM_TITLE = "Add custom connection", "添加自定义连接", "新增自訂連線";
    CREATE_SUBTITLE =
        "After required setup, the connection appears above on the Models page.",
        "完成必要配置后，连接会出现在模型页上方。",
        "完成必要設定後，連線會出現在模型頁上方。";
    SLUG = "Connection identifier", "连接标识", "連線標識";
    DISPLAY_NAME = "Display name", "显示名称", "顯示名稱";
    ACCOUNT_ID = "Cloudflare Account ID", "Cloudflare Account ID", "Cloudflare Account ID";
    ACCOUNT_ID_PLACEHOLDER = "Enter account ID", "填写账户 ID", "填寫帳號 ID";
    CONNECTION_API_PROTOCOL = "Default request protocol", "默认请求协议", "預設請求協定";
    CONNECTION_API_PROTOCOL_HELP =
        "Used by models without their own protocol. It cannot be changed after the connection is added; each model can override it.",
        "模型未单独选择协议时使用。创建后不可更改，可在每个模型上单独覆盖。",
        "模型未單獨選擇協定時使用。建立後不可變更，可在每個模型上單獨覆寫。";
    DEFAULT_MODEL = "Default model", "默认模型", "預設模型";
    DEFAULT_MODEL_PLACEHOLDER =
        "Leave empty — fetched after saving",
        "留空即可，保存后自动拉取",
        "留空即可，儲存後自動拉取";
    DEFAULT_MODEL_HELP =
        "Maka fetches the model catalog from this endpoint after saving. Type a model id here only if the endpoint serves no catalog.",
        "保存后 Maka 会向该端点拉取模型目录。只有当端点不提供目录时，才需要在这里手填一个模型 ID。",
        "儲存後 Maka 會向該端點拉取模型目錄。只有當端點不提供目錄時，才需要在這裡手填一個模型 ID。";
    SHOW_ADVANCED_REQUEST = "Show advanced request settings", "展开高级请求设置", "展開高階請求設定";
    HIDE_ADVANCED_REQUEST = "Hide advanced request settings", "收起高级请求设置", "收起高階請求設定";
    SAVE_PROVIDER = "Save provider", "保存供应商", "儲存供應商";
    SAVING = "Saving…", "保存中…", "儲存中…";
    SLUG_REQUIRED = "Enter a connection identifier.", "请填写连接标识。", "請填寫連線標識。";
    SLUG_FORMAT =
        "Connection identifiers use lowercase letters, digits, and hyphens.",
        "连接标识只能包含小写字母、数字和连字符。",
        "連線標識只能包含小寫字母、數字和連字號。";
    SLUG_TOO_LONG =
        "Connection identifiers are at most 64 characters.",
        "连接标识不能超过 64 个字符。",
        "連線標識不能超過 64 個字元。";
    SLUG_DUPLICATE = "Connection identifier already exists.", "连接标识已存在。", "連線標識已存在。";
    ACCOUNT_ID_REQUIRED = "Enter the Cloudflare Account ID.", "请填写 Cloudflare Account ID。", "請填寫 Cloudflare Account ID。";
    STEPS_LABEL = "Steps to add the connection", "添加连接步骤", "新增連線步驟";
    STEP_KEY = "Key", "密钥", "金鑰";
    STEP_MODELS = "Choose models", "选择模型", "選擇模型";
    VERIFY_AND_CHOOSE = "Verify and choose models", "验证并选择模型", "驗證並選擇模型";
    VERIFYING = "Verifying the key and loading models…", "正在验证密钥并获取模型…", "正在驗證金鑰並取得模型…";
    CHOOSE_MODELS = "Choose models for this connection", "选择此连接使用的模型", "選擇此連線使用的模型";
    CHOOSE_MODELS_HELP =
        "You can enable more models from the connection details later.",
        "添加后仍可在连接详情中启用其他模型。",
        "新增後仍可在連線詳細資料中啟用其他模型。";
    ENABLED_MODELS = "Enabled models", "启用的模型", "啟用的模型";
    SEARCH_MODELS = "Search models", "搜索模型", "搜尋模型";
    BACK_TO_EDIT = "Back to edit", "返回修改", "返回修改";
    SELECTED_COUNT = "{selected} of {total} selected", "已选 {selected} / {total}", "已選 {selected} / {total}";
    SELECT_ALL = "Select all", "全选", "全選";
    DESELECT_ALL = "Deselect all", "取消全选", "取消全選";
    NO_MODELS_MATCH = "No matching models", "未找到匹配的模型", "找不到符合的模型";
    ONBOARDING_DEFAULT_MODEL_HELP =
        "New chats start on this model. Only selected models can be chosen.",
        "新任务将默认使用此模型，仅可在已勾选的模型中选择。",
        "新任務將預設使用此模型，僅可在已勾選的模型中選擇。";
    ONBOARDING_UNAVAILABLE =
        "The model connection service is unavailable. Try again later.",
        "模型连接服务暂时不可用，请稍后重试。",
        "模型連線服務暫時無法使用，請稍後重試。";
    NO_MODELS_FOUND =
        "No usable models were found. No connection was created.",
        "没有发现可用模型，当前未创建连接。",
        "未發現可用模型，目前未建立連線。";
    OUTCOME_UNKNOWN = "The save result cannot be confirmed", "保存结果暂时无法确认", "暫時無法確認儲存結果";
    OUTCOME_UNKNOWN_DETAIL =
        "Do not add it again yet, because that could create a duplicate connection. Reload the connection list and check whether this connection appeared; reconnect the Runtime Host if the result is still unclear.",
        "请勿再次添加，以免创建重复连接。重新加载连接列表并检查该连接是否已经出现；仍不确定时请先重连 Runtime Host。",
        "請勿再次新增，以免建立重複連線。重新載入連線列表並檢查該連線是否已出現；仍不確定時請先重新連線 Runtime Host。";
    RELOAD_CONNECTIONS = "Reload connection list", "重新加载连接列表", "重新載入連線列表";
    /// Not Desktop's: the catalog changed on every try while a connection
    /// was being added.
    CATALOG_KEPT_CHANGING =
        "The connection catalog kept changing. Try again.",
        "连接列表一直在变化，请重试。",
        "連線列表一直在變化，請重試。";
    /// Not Desktop's: the connection exists, but its key or its headers
    /// could not be saved, so it was removed again.
    CREATE_ROLLED_BACK =
        "The key or the request headers could not be saved, so the connection was not added.",
        "密钥或请求头未能保存，因此没有添加该连接。",
        "金鑰或請求頭未能儲存，因此沒有新增該連線。";

    // Advanced request settings, in the form and the detail.
    ADVANCED_REQUEST = "Advanced request settings", "高级请求设置", "高階請求設定";
    ADVANCED_REQUEST_HELP =
        "Add HTTP headers and extra JSON request-body fields for this connection. Header values stay in the local credential vault.",
        "为这个连接的 HTTP 请求添加请求头和额外 JSON 请求体。请求头值作为凭据保存在本机。",
        "為這個連線的 HTTP 請求新增請求頭和額外 JSON 請求體。請求頭值作為憑據儲存在本機。";
    REQUEST_HEADERS = "Custom request headers", "自定义请求头", "自訂請求頭";
    HEADER_NAME = "Header name", "请求头名称", "請求頭名稱";
    HEADER_VALUE = "Header value", "请求头值", "請求頭值";
    RETAINED_HEADER_VALUE = "Keep saved value", "保留已保存的值", "保留已儲存的值";
    ADD_HEADER = "Add header", "添加请求头", "新增請求頭";
    REMOVE_HEADER = "Remove", "移除", "移除";
    NO_REQUEST_HEADERS = "No custom request headers.", "未设置自定义请求头。", "未設定自訂請求頭。";
    EXTRA_REQUEST_BODY = "Extra request body (JSON)", "额外请求体（JSON）", "額外請求體（JSON）";
    EXTRA_REQUEST_BODY_HELP =
        "Adds top-level fields only. A collision with a Maka-generated field fails explicitly.",
        "仅添加顶层字段；若与 Maka 生成的字段重名，请求会明确失败。",
        "僅新增頂層欄位；若與 Maka 生成的欄位重名，請求會明確失敗。";
    EXTRA_REQUEST_BODY_HELP_ADD =
        "Adds top-level fields only. A collision with a Maka-generated field fails explicitly. Header values stay in the local credential vault.",
        "仅添加顶层字段；与 Maka 生成字段重名时会明确失败。请求头值将作为凭据保存在本机。",
        "僅新增頂層欄位；與 Maka 生成欄位重名時會明確失敗。請求頭值將作為憑據儲存在本機。";
    REQUEST_CUSTOMIZATION_INVALID = "Check the advanced request settings.", "请检查高级请求设置。", "請檢查高階請求設定。";
    REQUEST_HEADERS_INVALID = "Check the request header names and values.", "请检查请求头名称和值。", "請檢查請求頭名稱和值。";
    REQUEST_BODY_INVALID =
        "Enter a valid JSON object that meets the requirements.",
        "请输入符合要求的 JSON 对象。",
        "請輸入符合要求的 JSON 物件。";
    HEADERS_ONE = "{count} header", "{count} 个请求头", "{count} 個請求頭";
    HEADERS_OTHER = "{count} headers", "{count} 个请求头", "{count} 個請求頭";
    NOT_CONFIGURED = "Not configured", "未设置", "未設定";
    CONFIGURED = "Set", "已设置", "已設定";

    // A connection's detail (`detail`).
    CREDENTIALS = "Connection", "连接", "連線";
    CREDENTIALS_HELP = "The key stays on this machine.", "密钥只保存在本机。", "金鑰只儲存在本機。";
    CREDENTIALS_HELP_ACCOUNT = "The sign-in token stays on this machine.", "登录令牌只保存在本机。", "登入權杖只儲存在本機。";
    CONNECTION_NAME_PLACEHOLDER = "Name this connection", "给这个连接起个名字", "給這個連線起個名字";
    MODEL_KEY = "Model key", "模型密钥", "模型金鑰";
    PASTE_MODEL_KEY = "Paste model key", "粘贴模型密钥", "貼上模型金鑰";
    GET_MODEL_KEY = "Get model key", "获取模型密钥", "取得模型金鑰";
    KEY_READING = "Reading status", "正在读取状态", "正在讀取狀態";
    CREDENTIAL_UNKNOWN = "Credential status unavailable", "凭据状态未知", "憑據狀態未知";
    KEY_MISSING = "No key set", "尚未设置密钥", "尚未設定金鑰";
    CREDENTIAL_UNKNOWN_DETAIL =
        "Model credential status could not be refreshed, so the connection is not being mislabeled as signed out or unconfigured.",
        "模型凭据状态暂时没刷新成功，已避免把未知状态显示成未登录或未配置。",
        "模型憑據狀態暫時沒重新整理成功，已避免把未知狀態顯示成未登入或未設定。";
    EDIT = "Edit", "编辑", "編輯";
    CHANGE = "Change", "更换", "更換";
    SET = "Set", "设置", "設定";
    ENDPOINT_MANAGED = "Managed by account sign-in or the provider", "由账号登录或服务商管理", "由帳號登入或服務商管理";
    ENDPOINT_MISSING = "No service URL configured", "尚未配置服务地址", "尚未設定服務地址";
    ENDPOINT_CREDENTIALS_MASKED =
        "The saved URL embeds credentials and stays masked while editing",
        "已保存的地址内嵌凭据，编辑时默认隐藏",
        "已儲存的地址內嵌憑據，編輯時預設隱藏";
    REQUEST_URL = "Request URL: {url}", "请求地址：{url}", "請求地址：{url}";
    STATUS = "Connection status", "连接状态", "連線狀態";
    STATUS_HEALTHY = "Healthy", "正常", "正常";
    STATUS_UNTESTED = "Not tested", "未测试", "未測試";
    TEST_CONNECTION = "Test connection", "测试连接", "測試連線";
    PROVIDER_RETIRED = "This provider is retired", "此模型服务已停用", "此模型服務已停用";
    PROVIDER_RETIRED_DETAIL =
        "This connection can no longer be used for conversations. Add another provider and choose a new default model. Existing conversations are kept.",
        "这条连接已无法用于对话。请添加其他模型连接，并选择新的默认模型；原有对话记录会保留。",
        "這條連線已無法用於對話。請新增其他模型連線，並選擇新的預設模型；原有對話記錄會保留。";
    MODEL_MANAGEMENT_HELP =
        "These models appear in the chat model picker.",
        "这些模型会出现在任务的模型选择器里。",
        "這些模型會出現在任務的模型選擇器裡。";
    MODELS_SUMMARY = "{enabled} of {total} enabled", "已启用 {enabled} / {total}", "已啟用 {enabled} / {total}";
    UPDATE_MODELS = "Update model catalog", "更新模型目录", "更新模型目錄";
    ADD_MODEL = "Add model", "添加模型", "新增模型";
    NO_MODELS =
        "No models are available. Update the model catalog first.",
        "暂无可选模型，请先更新模型目录。",
        "暫無可選模型，請先更新模型目錄。";
    ENABLE_MODEL = "Enable model {name}", "启用模型 {name}", "啟用模型 {name}";
    SET_PARAMETERS = "Set parameters", "配置参数", "設定參數";
    SET_PARAMETERS_FOR = "Set model parameters: {name}", "配置模型参数：{name}", "設定模型參數：{name}";
    DANGER_ZONE = "Delete connection", "删除连接", "刪除連線";
    DELETE_ROW_HELP = "This cannot be undone.", "此操作不可撤销。", "此操作不可撤銷。";
    DELETE_CONNECTION_TITLE = "Delete model connection {name}?", "删除模型连接 {name}？", "刪除模型連線 {name}？";
    DELETE_DESCRIPTION =
        "This deletes the model connection and its local credential. Add it again to use it later.",
        "这会删除模型连接及其本机凭据；如需再次使用，需要重新添加。",
        "這會刪除模型連線及其本機憑據；如需再次使用，需要重新新增。";
    DELETE_DESCRIPTION_DEFAULT =
        "It is currently the default connection; the default model becomes unset and existing chats may need another model selected.",
        "它当前是默认连接；删除后默认模型会变成未设置，已有任务可能需要重新选择模型。",
        "它目前是預設連線；刪除後預設模型會變成未設定，已有任務可能需要重新選擇模型。";

    // What a test, a refresh, or a save found (Desktop shows them as toasts;
    // here they are the row's status line).
    CONNECTION_SUCCESS = "Connected · {model} · {ms} ms", "连接成功 · {model} · {ms} ms", "連線成功 · {model} · {ms} ms";
    CONNECTION_FALLBACK =
        "Connection works · Your selected {selected} didn’t respond; verified the connection with {tested} instead. Tasks using your selected model may fail.",
        "连接可用 · 你选择的 {selected} 当前未响应，已改用 {tested} 验证连接可用；任务中继续使用你选择的模型可能会失败。",
        "連線可用 · 你選擇的 {selected} 目前沒有回應，已改用 {tested} 驗證連線可用；任務中繼續使用你選擇的模型可能會失敗。";
    CONNECTION_FAILED = "Connection failed.", "连接失败。", "連線失敗。";
    CONNECTION_TEST_ERROR = "Connection test error.", "连接测试出错。", "連線測試出錯。";
    MODELS_FETCHED_ONE = "Fetched {count} model", "已拉取 {count} 个模型", "已拉取 {count} 個模型";
    MODELS_FETCHED_OTHER = "Fetched {count} models", "已拉取 {count} 个模型", "已拉取 {count} 個模型";
    MODELS_FETCH_FAILED = "Failed to fetch models.", "拉取模型失败。", "拉取模型失敗。";
    MODELS_FETCH_FAILED_DETAIL =
        "The static list remains visible. Check {troubleshooting} and try again.",
        "当前继续显示静态列表，请确认 {troubleshooting} 后重试。",
        "目前繼續顯示靜態列表，請確認 {troubleshooting} 後重試。";
    KEY_TROUBLESHOOTING = "model key, service URL, and proxy settings", "模型密钥 / 服务地址 / 代理设置", "模型金鑰 / 服務地址 / 代理設定";
    ENDPOINT_TROUBLESHOOTING = "local service, service URL, and proxy settings", "本地服务 / 服务地址 / 代理设置", "本地服務 / 服務地址 / 代理設定";
    OAUTH_TROUBLESHOOTING = "OAuth sign-in and proxy settings", "OAuth 登录 / 代理设置", "OAuth 登入 / 代理設定";
    AUTH_TROUBLESHOOTING = "Authentication failed. Check {value} and try again.", "鉴权失败，请确认 {value} 后重试。", "鑑權失敗，請確認 {value} 後重試。";
    RECHECK_TROUBLESHOOTING = "Check {value} and try again.", "检查 {value} 后重试。", "檢查 {value} 後重試。";
    RATE_LIMITED =
        "This account or model service is rate-limited. Try again later.",
        "当前账号或模型服务触发速率限制，请稍后重试。",
        "目前帳號或模型服務觸發速率限制，請稍後重試。";
    TIMED_OUT =
        "The request timed out. Check the network or proxy and try again.",
        "请求超时，请检查网络或代理后重试。",
        "請求超時，請檢查網路或代理後重試。";
    SERVICE_UNAVAILABLE =
        "The model service is temporarily unavailable. Try again later.",
        "模型服务暂时不可用，请稍后重试。",
        "模型服務暫時不可用，請稍後重試。";
    NETWORK_ERROR =
        "Network error. Check the service URL or proxy settings and try again.",
        "网络错误，请检查服务地址或代理设置后重试。",
        "網路錯誤，請檢查服務地址或代理設定後重試。";
    // The last test's failure, beside the status (`lastTest`).
    LAST_TEST_AUTH = "Authentication failed", "鉴权失败", "鑑權失敗";
    LAST_TEST_TIMEOUT = "Request timed out", "请求超时", "請求超時";
    LAST_TEST_PROVIDER = "Model service returned an error", "模型服务返回错误", "模型服務回傳錯誤";
    LAST_TEST_NETWORK = "Network error", "网络错误", "網路錯誤";
    LAST_TEST_UNKNOWN = "Connection test failed", "连接测试失败", "連線測試失敗";

    // What failed (`…Failed`), the first sentence of a failure.
    SAVE_CONNECTION_FAILED = "Couldn’t save the model connection.", "保存模型连接失败。", "儲存模型連線失敗。";
    SAVE_MODELS_FAILED = "Couldn’t save the enabled models.", "保存启用模型失败。", "儲存啟用模型失敗。";
    DELETE_FAILED = "Couldn’t delete the model connection.", "删除模型连接失败。", "刪除模型連線失敗。";
    CREDENTIAL_READ_FAILED = "Couldn’t read the model credential status.", "读取模型凭据状态失败。", "讀取模型憑據狀態失敗。";
    /// Not Desktop's (it reports the read under its invalid-settings title).
    HEADERS_READ_FAILED = "Couldn’t read the custom request headers.", "读取自定义请求头失败。", "讀取自訂請求頭失敗。";

    // Why an effect on a connection did not run (`ConnectionEffectRejection`,
    // `superseded`). Not Desktop's, which reports them all as unavailable.
    EFFECT_CONNECTION_NOT_FOUND = "The connection no longer exists.", "这个连接已不存在。", "這個連線已不存在。";
    EFFECT_CONNECTION_DISABLED = "The connection is disabled.", "这个连接已停用。", "這個連線已停用。";
    EFFECT_UNAVAILABLE =
        "This provider does not support this action.",
        "该服务商不支持此操作。",
        "該服務商不支援此操作。";
    EFFECT_SUPERSEDED =
        "The connection, its key, or the proxy changed meanwhile. Try again.",
        "期间连接、密钥或代理已发生变化，请重试。",
        "期間連線、金鑰或 Proxy 已變更，請重試。";
    /// Not Desktop's words (its main process says it in English): the
    /// model's parameters changed after the dialog opened.
    PARAMETERS_CHANGED =
        "The model’s parameters changed in the meantime. Open them again before saving.",
        "模型参数在此期间已发生变化，请重新打开后再保存。",
        "模型參數在此期間已變更，請重新開啟後再儲存。";
    /// Not Desktop's: a key or a header value another window changed first.
    CREDENTIAL_CHANGED =
        "The saved key changed in the meantime. Try again.",
        "已保存的密钥在此期间已发生变化，请重试。",
        "已儲存的金鑰在此期間已變更，請重試。";

    // A model's parameters (the capabilities copy).
    CAPABILITIES_HELP =
        "Applies to this model on this connection. Changes take effect on save.",
        "仅应用于此连接中的这个模型，保存后生效。",
        "僅套用至此連線中的這個模型，儲存後生效。";
    MODEL_DISPLAY_NAME = "Display name", "显示名称", "顯示名稱";
    MODEL_DISPLAY_NAME_HELP =
        "A label for this model. Requests still use the exact model ID.",
        "仅用于显示；请求仍使用模型 ID。",
        "僅供顯示；請求仍使用模型 ID。";
    THINKING_LEVELS = "Available thinking levels", "思考强度", "思考強度";
    THINKING_LEVELS_HELP =
        "These levels appear in the conversation’s thinking selector. Select only levels supported by this provider. Leave all unchecked to use existing model information.",
        "勾选服务商支持的强度，供对话时选择。留空时按模型资料设置。",
        "勾選服務商支援的強度，供對話時選擇。留空時依模型資料設定。";
    DEFAULT_THINKING_LEVEL = "Default thinking level", "默认思考级别", "預設思考級別";
    DEFAULT_THINKING_LEVEL_HELP =
        "Thinking level for new tasks that use this model. It can still be changed per task.",
        "新任务使用此模型时采用的思考级别；任务内仍可单独切换。",
        "新任務使用此模型時採用的思考級別；任務內仍可單獨切換。";
    PROVIDER_DEFAULT_THINKING = "Provider default", "服务商默认", "服務商預設";
    VISION = "Send images to the model", "图片识别", "圖片辨識";
    VISION_HELP =
        "Use provider and model information to decide whether to send images. Images are not sent when information is missing. Before choosing “Allow images”, confirm this provider supports images for this model.",
        "此服务商的模型是否支持图片。自动按模型资料判断，缺少资料时不发送图片。",
        "此服務商的模型是否支援圖片。自動依模型資料判斷，缺少資料時不傳送圖片。";
    VISION_AUTO = "Use model information", "自动", "自動";
    VISION_AUTO_ON = "Model information: allow images", "自动 · 支持", "自動 · 支援";
    VISION_AUTO_OFF = "Model information: no images", "自动 · 不支持", "自動 · 不支援";
    VISION_ON = "Allow images", "支持", "支援";
    VISION_OFF = "Do not send images", "不支持", "不支援";
    APPLY_PATCH = "ApplyPatch file editing", "ApplyPatch 文件编辑", "ApplyPatch 檔案編輯";
    APPLY_PATCH_HELP =
        "Automatic follows the model default. Enabled uses ApplyPatch to edit files; Disabled uses Write/Edit. Manual choices apply only to this model on this connection. Select Automatic to restore the default.",
        "自动跟随模型默认设置；手动启用或关闭仅影响此连接中的当前模型。启用时使用 ApplyPatch 编辑文件，关闭时使用 Write/Edit。选择自动可恢复默认设置。",
        "自動依模型預設設定；手動啟用或關閉僅影響此連線中的目前模型。啟用時使用 ApplyPatch 編輯檔案，關閉時使用 Write/Edit。選擇自動可恢復預設設定。";
    APPLY_PATCH_AUTO_ON = "Automatic: enabled", "自动 · 启用", "自動 · 啟用";
    APPLY_PATCH_AUTO_OFF = "Automatic: disabled", "自动 · 关闭", "自動 · 關閉";
    APPLY_PATCH_ON = "Enabled", "启用", "啟用";
    APPLY_PATCH_OFF = "Disabled", "关闭", "關閉";
    CONTEXT_WINDOW = "Context window", "上下文窗口", "上下文視窗";
    CONTEXT_WINDOW_HELP =
        "Model capacity offered by this provider. Leave empty to use known information.",
        "模型可处理的 token 总量。留空时按模型资料设置。",
        "模型可處理的 token 總量。留空時依模型資料設定。";
    INPUT_LIMIT = "Input limit", "输入上限", "輸入上限";
    INPUT_LIMIT_HELP =
        "Maximum input tokens per request. Leave empty to use model information.",
        "单次请求可输入的 token 数。留空时按模型资料设置。",
        "單次請求可輸入的 token 數。留空時依模型資料設定。";
    LIMITS_CONFLICT = "The input limit cannot exceed the context window.", "输入上限不能超过上下文窗口。", "輸入上限不能超過上下文視窗。";
    COMPACTION_THRESHOLD = "Compaction threshold", "压缩阈值", "壓縮門檻";
    COMPACTION_THRESHOLD_HELP =
        "Compact at this token count. Leave empty to disable proactive compaction.",
        "达到此 token 数时压缩上下文。留空则不主动压缩。",
        "達到此 token 數時壓縮上下文。留空則不主動壓縮。";
    MAX_OUTPUT_TOKENS = "Maximum output", "输出上限", "輸出上限";
    MAX_OUTPUT_TOKENS_HELP =
        "Output token budget per reply, including thinking. Leave empty for automatic limits.",
        "单次回复的输出 token 上限，含思考。留空自动设置。",
        "單次回覆的輸出 token 上限，含思考。留空自動設定。";
    MAX_OUTPUT_TOKENS_UNSUPPORTED =
        "The ChatGPT subscription (Codex) does not accept an output limit, so Maka does not send this setting.",
        "ChatGPT 订阅（Codex）不接受输出上限，Maka 不会发送此设置。",
        "ChatGPT 訂閱（Codex）不接受輸出上限，Maka 不會送出此設定。";
    FAST_MODE = "Fast mode", "Fast 模式", "Fast 模式";
    FAST_MODE_HELP =
        "Use the faster service tier. Additional charges may apply.",
        "选择更快的服务档位，可能产生额外费用。",
        "選擇更快的服務檔位，可能產生額外費用。";
    FAST_AUTO = "Auto", "自动", "自動";
    FAST_ON = "Fast", "Fast", "Fast";
    API_PROTOCOL = "Request protocol", "请求协议", "請求協定";
    API_PROTOCOL_HELP =
        "The API format this model uses. When one address serves several protocols, choose one per model.",
        "此模型使用的接口格式。同一地址同时提供多种协议时，可为单个模型单独选择。",
        "此模型使用的介面格式。同一位址同時提供多種協定時，可為單一模型單獨選擇。";
    API_PROTOCOL_DEFAULT = "Connection default: {protocol}", "跟随连接 · {protocol}", "跟隨連線 · {protocol}";
    TOKEN_COUNT_INVALID =
        "Enter a positive whole token count or K/M value, such as 128000, 128K, or 1.5M.",
        "请输入正整数 token 数或 K/M 缩写，例如 128000、128K、1.5M。",
        "請輸入正整數 token 數或 K/M 縮寫，例如 128000、128K、1.5M。";
    ADD_MODEL_CONFIRM = "Add", "添加", "新增";
    MODEL_ID = "Model ID", "模型 ID", "模型 ID";
    MODEL_ID_HELP = "Must match the provider exactly, including case.", "需与服务商完全一致，区分大小写。", "需與服務商完全一致，區分大小寫。";
    MODEL_ID_REQUIRED = "Enter a model ID.", "请填写模型 ID。", "請填寫模型 ID。";
    MODEL_ID_DUPLICATE = "This model is already in the list.", "该模型已在列表中。", "該模型已在列表中。";
}

/// The accessible name of a list row: its name, provider, whether it is
/// the default, and its status.
pub fn row_label(
    locale: Locale,
    name: &str,
    provider: &str,
    default: bool,
    status: Option<&str>,
) -> String {
    let mut label = ROW_LABEL.fill(locale, &[("name", name), ("provider", provider)]);
    if default {
        label.push_str(ROW_LABEL_DEFAULT.in_locale(locale));
    }
    if let Some(status) = status {
        label.push_str(&ROW_LABEL_STATUS.fill(locale, &[("status", status)]));
    }
    label
}

/// How many connections an account sign-in already has.
pub fn accounts_configured(locale: Locale, count: usize) -> String {
    plural(count as u64, ACCOUNTS_CONFIGURED_ONE, ACCOUNTS_CONFIGURED_OTHER)
        .fill(locale, &[("count", &count.to_string())])
}

/// The setup page's title: Connect and the provider's name, or for the
/// custom provider, which has no name of its own, Add custom connection.
pub fn connect_title(locale: Locale, provider_type: &str, name: &str) -> String {
    if provider_type == "custom" {
        return ADD_CUSTOM_TITLE.in_locale(locale).to_owned();
    }
    CONNECT_TITLE.fill(locale, &[("name", name)])
}

/// How many of the verified models are selected.
pub fn selected_count(locale: Locale, selected: usize, total: usize) -> String {
    SELECTED_COUNT
        .fill(locale, &[("selected", &selected.to_string()), ("total", &total.to_string())])
}

/// How many models of the detail's list are enabled.
pub fn models_summary(locale: Locale, enabled: usize, total: usize) -> String {
    MODELS_SUMMARY.fill(locale, &[("enabled", &enabled.to_string()), ("total", &total.to_string())])
}

/// How many custom request headers are saved.
pub fn headers_count(locale: Locale, count: usize) -> String {
    plural(count as u64, HEADERS_ONE, HEADERS_OTHER).fill(locale, &[("count", &count.to_string())])
}

/// The URL a custom connection's requests go to.
pub fn request_url(locale: Locale, url: &str) -> String {
    REQUEST_URL.fill(locale, &[("url", url)])
}

/// The accessible name of a model's switch.
pub fn enable_model(locale: Locale, name: &str) -> String {
    ENABLE_MODEL.fill(locale, &[("name", name)])
}

/// The accessible name of a model's parameters button.
pub fn set_parameters_for(locale: Locale, name: &str) -> String {
    SET_PARAMETERS_FOR.fill(locale, &[("name", name)])
}

/// The deletion question's title.
pub fn delete_connection_title(locale: Locale, name: &str) -> String {
    DELETE_CONNECTION_TITLE.fill(locale, &[("name", name)])
}

/// What deleting a connection does, and what it means for the default.
pub fn delete_description(locale: Locale, default: bool) -> String {
    let description = DELETE_DESCRIPTION.in_locale(locale);
    if default {
        super::sentences(locale, description, DELETE_DESCRIPTION_DEFAULT.in_locale(locale))
    } else {
        description.to_owned()
    }
}

/// A test that passed on `model` in `milliseconds`.
pub fn connection_success(locale: Locale, model: &str, milliseconds: u64) -> String {
    CONNECTION_SUCCESS.fill(locale, &[("model", model), ("ms", &milliseconds.to_string())])
}

/// A test that passed, but on another model than the ones enabled.
pub fn connection_fallback(locale: Locale, selected: &[&str], tested: &str) -> String {
    CONNECTION_FALLBACK
        .fill(locale, &[("selected", &super::list(locale, selected)), ("tested", tested)])
}

/// A refresh that listed `count` models.
pub fn models_fetched(locale: Locale, count: u64) -> String {
    plural(count, MODELS_FETCHED_ONE, MODELS_FETCHED_OTHER)
        .fill(locale, &[("count", &count.to_string())])
}

/// What to check after a refresh failed.
pub fn models_fetch_failed_detail(locale: Locale, troubleshooting: &str) -> String {
    MODELS_FETCH_FAILED_DETAIL.fill(locale, &[("troubleshooting", troubleshooting)])
}

/// An authentication failure, with what to check.
pub fn auth_troubleshooting(locale: Locale, value: &str) -> String {
    AUTH_TROUBLESHOOTING.fill(locale, &[("value", value)])
}

/// Any other failure, with what to check.
pub fn recheck_troubleshooting(locale: Locale, value: &str) -> String {
    RECHECK_TROUBLESHOOTING.fill(locale, &[("value", value)])
}

/// The request protocol choice that follows the connection's.
pub fn api_protocol_default(locale: Locale, protocol: &str) -> String {
    API_PROTOCOL_DEFAULT.fill(locale, &[("protocol", protocol)])
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::English;
    const ZH: Locale = Locale::SimplifiedChinese;

    #[test]
    fn sentences_with_parts_read_in_each_language() {
        assert_eq!(
            row_label(EN, "DeepSeek", "DeepSeek", true, Some("Unavailable")),
            "Model connection: DeepSeek; provider: DeepSeek; default connection; Unavailable"
        );
        assert_eq!(row_label(ZH, "甲", "乙", false, None), "模型连接：甲，供应商：乙");
        assert_eq!(accounts_configured(EN, 1), "1 connection configured · Add another account");
        assert_eq!(headers_count(EN, 2), "2 headers");
        assert_eq!(models_fetched(EN, 1), "Fetched 1 model");
        assert_eq!(
            connection_fallback(EN, &["a", "b"], "c"),
            "Connection works · Your selected a, b didn’t respond; verified the connection with c \
             instead. Tasks using your selected model may fail."
        );
        assert!(connection_fallback(ZH, &["a", "b"], "c").contains("a、b"));
        assert_eq!(
            delete_description(EN, true),
            format!("{} {}", DELETE_DESCRIPTION.en(), DELETE_DESCRIPTION_DEFAULT.en())
        );
    }
}
