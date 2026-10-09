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

//! Interface copy of the Runtime Hosts a window talks to: Workspace's
//! Runtime Host block, adding a Host by connection code or by hand, the Host
//! pickers in the settings header and the sidebar footer, and the remote
//! project directory browser. The strings are Maka Desktop's
//! (`runtimeHost` in apps/desktop/src/renderer/locales/settings-projects-copy.ts,
//! `projectActions` in shell-copy.ts) where Desktop has one; where this
//! client behaves differently (one Host per window, no Direct peer, SSH in
//! batch mode only) the sentence is this client's, in Desktop's terms. Same
//! rules as the parent module.

use super::Locale;

texts! {
    // The Runtime Host group.
    HOST_BLOCK_TITLE = "Runtime Host", "Runtime Host", "Runtime Host";
    /// Desktop keeps every enabled Host connected together; a window here
    /// talks to one at a time.
    RUNTIME_HOST_DESCRIPTION =
        "This window works with one Host at a time. Each task remains owned by its Host.",
        "此窗口一次连接一个 Host；任务仍由其所属 Host 处理。",
        "此視窗一次連線一個 Host；任務仍由其所屬 Host 處理。";
    DEFAULT_HOST = "Default Host", "默认 Host", "預設 Host";
    DEFAULT_HOST_HELP =
        "New tasks and this window use the default Host",
        "新任务和此窗口使用默认 Host",
        "新任務和此視窗使用預設 Host";

    // Other Hosts.
    OTHER_HOSTS = "Other Hosts", "其他 Host", "遠端 Host";
    OTHER_HOSTS_DESCRIPTION =
        "Add Runtime Hosts on other computers with a connection code or their connection details.",
        "通过连接码或连接参数添加其他电脑上的 Runtime Host。",
        "透過連線碼或連線參數新增其他電腦上的 Runtime Host。";
    ADD_COMPUTER = "Add computer", "添加电脑", "新增電腦";
    USE_CONNECTION_CODE = "Use connection code", "使用连接码", "使用連線碼";
    USE_CONNECTION_CODE_DESCRIPTION =
        "Paste a one-time code created on another computer",
        "粘贴另一台电脑生成的一次性连接码",
        "貼上另一台電腦產生的一次性連線碼";
    /// Not Desktop's: why Use connection code is disabled. Every code
    /// Desktop or the CLI makes is a Direct peer, which this client refuses.
    CONNECTION_CODE_UNSUPPORTED =
        "This client does not support Direct peer yet; configure the Host manually",
        "此客户端暂不支持 Direct peer，请使用手动配置",
        "此用戶端暫不支援 Direct peer，請使用手動設定";
    CONFIGURE_MANUALLY = "Configure manually", "手动配置", "手動設定";
    CONFIGURE_MANUALLY_DESCRIPTION =
        "Enter TLS, SSH, or plain WebSocket details for an existing Host",
        "为已有 Host 填写 TLS、SSH 或明文 WebSocket 参数",
        "為已有 Host 填寫 TLS、SSH 或明文 WebSocket 參數";
    EMPTY = "No remote Hosts yet", "还没有远程 Host", "還沒有遠端 Host";
    DEFAULT_BADGE = "Default", "默认", "預設";
    /// The Host the window talks to now.
    THIS_WINDOW_BADGE = "This window", "此窗口", "此視窗";
    PAIRING_PENDING_BADGE = "Pairing unfinished", "配对未完成", "配對未完成";
    PAIRING_RECOVERY_TITLE = "Pairing is unfinished", "有未完成的配对", "有未完成的配對";
    PAIRING_RECOVERY_DESCRIPTION =
        "Retry from the affected Host menu, or discard the pairing to clean up the unfinished \
         connection.",
        "可在对应 Host 的菜单中重试；如果不再需要，也可以放弃配对并清理未完成的连接。",
        "可在對應 Host 的選單中重試；如果不再需要，也可以放棄配對並清理未完成的連線。";
    RETRY_PAIRING = "Retry pairing", "重试配对", "重試配對";
    DISCARD_PAIRING = "Discard pairing", "放弃配对", "放棄配對";
    REMOVE = "Remove", "移除", "移除";
    SET_AS_DEFAULT = "Set as default", "设为默认", "設為預設";
    USE_IN_THIS_WINDOW = "Use in this window", "在此窗口中使用", "在此視窗中使用";
    MORE_ACTIONS = "More actions for {name}", "更多操作：{name}", "更多操作：{name}";
    DEFAULT_DISABLE_HELP =
        "Choose another default Host before disabling this Host",
        "先选择另一个默认 Host，才能停用此 Host",
        "先選擇另一個預設 Host，才能停用此 Host";
    CURRENT_DISABLE_HELP =
        "Switch this window to another Host before disabling this Host",
        "先将此窗口切换到其他 Host，才能停用此 Host",
        "先將此視窗切換到其他 Host，才能停用此 Host";
    LOAD_FAILED = "Could not load Runtime Host profiles", "无法读取 Runtime Host profiles", "無法讀取 Runtime Host profiles";
    SELECT_FAILED = "Could not update the Runtime Host", "无法更新 Runtime Host", "無法更新 Runtime Host";
    SAVE_FAILED = "Could not save the Runtime Host profile", "无法保存 Runtime Host profile", "無法儲存 Runtime Host profile";
    REMOVE_FAILED = "Could not remove the Runtime Host profile", "无法移除 Runtime Host profile", "無法移除 Runtime Host profile";
    SWITCH_FAILED = "Could not switch to this Host", "无法切换到此 Host", "無法切換至此 Host";
    /// The sidebar footer's accessible name while the window talks to a
    /// remote Host (the local one's is `FOOTER_LABEL`).
    REMOTE_FOOTER_LABEL =
        "{name}, remote Host, {status}, {address}",
        "{name}，远程 Host，{status}，{address}",
        "{name}，遠端 Host，{status}，{address}";
    ADDED = "{name} is added and enabled.", "已添加并启用 {name}。", "已新增並啟用 {name}。";

    // Configure manually.
    ADD_REMOTE_HOST = "Add remote Host", "添加远程 Host", "新增遠端 Host";
    NAME = "Display name", "显示名称", "顯示名稱";
    NAME_HELP = "Used only to identify this Host on this device", "仅用于在这台设备上识别该 Host", "僅用於在這臺裝置上識別該 Host";
    TRANSPORT = "Connection method", "连接方式", "連線方式";
    TRANSPORT_HELP =
        "Prefer TLS, or use an SSH tunnel to reach a loopback-only Host on a private machine",
        "优先使用 TLS；内网中可通过 SSH tunnel 连接仅监听本机的 Host",
        "優先使用 TLS；內網中可透過 SSH tunnel 連線僅監聽本機的 Host";
    TRANSPORT_TLS = "TLS", "TLS", "TLS";
    TRANSPORT_SSH = "SSH tunnel", "SSH tunnel", "SSH tunnel";
    TRANSPORT_PLAINTEXT = "Plain WebSocket", "明文 WebSocket", "明文 WebSocket";
    URL = "WSS URL", "WSS 地址", "WSS 地址";
    URL_HELP = "The wss:// address of the remote Runtime Host", "远程 Runtime Host 的 wss:// 地址", "遠端 Runtime Host 的 wss:// 地址";
    PLAINTEXT_URL = "WS URL", "WS 地址", "WS 地址";
    PLAINTEXT_URL_HELP = "The ws:// address of the remote Runtime Host", "远程 Runtime Host 的 ws:// 地址", "遠端 Runtime Host 的 ws:// 地址";
    SSH_DESTINATION = "SSH destination", "SSH 目标", "SSH 目標";
    SSH_DESTINATION_HELP =
        "An OpenSSH user@host destination or SSH config alias",
        "OpenSSH 可识别的 user@host 或 SSH config 别名",
        "OpenSSH 可識別的 user@host 或 SSH config 別名";
    SSH_PORT = "SSH port", "SSH 端口", "SSH 埠";
    SSH_PORT_HELP =
        "Optional; leave empty to use the OpenSSH default or SSH config",
        "可选；留空使用 OpenSSH 默认值或 SSH config",
        "可選；留空使用 OpenSSH 預設值或 SSH config";
    /// Desktop's manual form reaches only a Host that already listens; its
    /// guided setup starts one with the deployment's operator.
    SSH_HOST = "Remote Host", "远程 Host", "遠端 Host";
    SSH_HOST_HELP =
        "Connect to a Host that already listens on the remote computer, or have its operator start one over SSH",
        "连接远程电脑上已在监听的 Host，或通过 SSH 让其 operator 启动一个",
        "連線遠端電腦上已在監聽的 Host，或透過 SSH 讓其 operator 啟動一個";
    SSH_HOST_LISTENING = "Already running", "已在运行", "已在執行";
    SSH_HOST_OPERATOR = "Start with operator", "用 operator 启动", "用 operator 啟動";
    REMOTE_PORT = "Remote Host port", "远程 Host 端口", "遠端 Host 埠";
    REMOTE_PORT_HELP =
        "WebSocket port where Runtime Host listens on 127.0.0.1 remotely",
        "远程 Runtime Host 在 127.0.0.1 上监听的 WebSocket 端口",
        "遠端 Runtime Host 在 127.0.0.1 上監聽的 WebSocket 埠";
    WEBSOCKET_PATH = "WebSocket path", "WebSocket 路径", "WebSocket 路徑";
    WEBSOCKET_PATH_HELP = "Usually /runtime-host", "通常为 /runtime-host", "通常為 /runtime-host";
    OPERATOR_PLATFORM = "Remote system", "远程系统", "遠端系統";
    PLATFORM_POSIX = "macOS or Linux", "macOS 或 Linux", "macOS 或 Linux";
    PLATFORM_WINDOWS = "Windows", "Windows", "Windows";
    OPERATOR_NODE = "Node path", "Node 路径", "Node 路徑";
    OPERATOR_NODE_HELP =
        "Absolute path of the Node the deployment runs on, on the remote computer",
        "远程电脑上该部署所用 Node 的绝对路径",
        "遠端電腦上該部署所用 Node 的絕對路徑";
    OPERATOR_MODULE = "Operator path", "operator 路径", "operator 路徑";
    OPERATOR_MODULE_HELP =
        "Absolute path of operator.mjs in the Host's deployment on the remote computer",
        "远程电脑上该 Host 部署中 operator.mjs 的绝对路径",
        "遠端電腦上該 Host 部署中 operator.mjs 的絕對路徑";
    PLAINTEXT_ACKNOWLEDGEMENT = "I understand the plaintext risk", "我了解明文连接的风险", "我瞭解明文連線的風險";
    PLAINTEXT_ACKNOWLEDGEMENT_HELP =
        "Access credentials and data may be intercepted by others on the network",
        "访问凭据和数据可能被同一网络中的第三方截获",
        "存取憑據和資料可能被同一網路中的第三方截獲";
    PLAINTEXT_WARNING =
        "Use only on a trusted, isolated network. Public connections should use TLS or an SSH tunnel.",
        "仅在可信且隔离的网络中使用；公网连接应使用 TLS 或 SSH tunnel",
        "僅在可信且隔離的網路中使用；公網連線應使用 TLS 或 SSH tunnel";
    STATE_ROOT_ID = "State Root ID", "State Root ID", "State Root ID";
    STATE_ROOT_ID_HELP =
        "Copied from the remote service ready output to verify the expected Host",
        "来自远程 service 的 ready 输出，用于确认连接的是预期 Host",
        "來自遠端 service 的 ready 輸出，用於確認連線的是預期 Host";
    CREDENTIAL = "Access credential", "访问凭据", "存取憑據";
    CREDENTIAL_HELP =
        "Issue it on the remote machine with the desktop-client preset",
        "在远程机器使用 desktop-client preset 签发",
        "在遠端機器使用 desktop-client preset 簽發";
    SAVE_AND_ENABLE = "Save and enable", "保存并启用", "儲存並啟用";
    VERIFYING = "Verifying access…", "正在验证凭据…", "正在驗證憑據…";

    // Why adding or pairing did not work.
    REFUSED_INVALID_CODE = "The connection code is invalid.", "连接码格式无效。", "連線碼格式無效。";
    REFUSED_DIRECT_PEER =
        "This code is for a Direct peer connection, which this client cannot make yet. Use Configure manually with the Host's TLS or SSH details instead.",
        "这个连接码使用 Direct peer 连接，此客户端暂不支持。请改用“手动配置”，填写该 Host 的 TLS 或 SSH 参数。",
        "這個連線碼使用 Direct peer 連線，此用戶端暫不支援。請改用「手動設定」，填寫該 Host 的 TLS 或 SSH 參數。";
    REFUSED_CREDENTIAL =
        "The Host refused this access credential: it expired, was used, or was revoked. Issue a new one on the remote computer.",
        "Host 拒绝了此访问凭据：它已过期、已被使用或已被撤销。请在远程电脑上重新签发。",
        "Host 拒絕了此存取憑據：它已過期、已被使用或已被撤銷。請在遠端電腦上重新簽發。";
    REFUSED_WRONG_HOST =
        "The Host that answered serves another State Root, or its version is incompatible with this client.",
        "应答的 Host 服务的是另一个 State Root，或其版本与此客户端不兼容。",
        "應答的 Host 服務的是另一個 State Root，或其版本與此用戶端不相容。";
    REFUSED_UNREACHABLE = "Could not reach a Host at {address}.", "无法连接到 {address} 上的 Host。", "無法連線至 {address} 上的 Host。";
    REFUSED_TLS =
        "This computer does not trust the TLS certificate of {host}.",
        "这台电脑不信任 {host} 的 TLS 证书。",
        "這台電腦不信任 {host} 的 TLS 憑證。";
    REFUSED_UPGRADE =
        "The Host refused the WebSocket connection (HTTP {status}). Check the address and the path.",
        "Host 拒绝了 WebSocket 连接（HTTP {status}）。请检查地址和路径。",
        "Host 拒絕了 WebSocket 連線（HTTP {status}）。請檢查地址和路徑。";
    REFUSED_NO_ANSWER = "The Host did not answer in time.", "Host 未及时响应。", "Host 未及時回應。";
    REFUSED_SSH_MISSING =
        "Could not run ssh. Install the OpenSSH client on this computer.",
        "无法运行 ssh。请在这台电脑上安装 OpenSSH 客户端。",
        "無法執行 ssh。請在這台電腦上安裝 OpenSSH 用戶端。";
    REFUSED_SSH_HOST_KEY =
        "SSH does not know the remote computer's host key, or it changed, and this client cannot ask in batch mode. Connect once with ssh in a terminal to verify it.",
        "SSH 不认识远程电脑的主机密钥，或密钥已变更；此客户端以批处理模式运行 ssh，无法询问。请先在终端中用 ssh 连接一次以确认。",
        "SSH 不認識遠端電腦的主機金鑰，或金鑰已變更；此用戶端以批次模式執行 ssh，無法詢問。請先在終端機中用 ssh 連線一次以確認。";
    REFUSED_SSH_AUTH =
        "SSH accepted no key or agent identity, and this client cannot ask for a password in batch mode. Set up key or agent authentication.",
        "SSH 未接受任何密钥或 agent 身份；此客户端以批处理模式运行，无法询问密码。请设置密钥或 agent 认证。",
        "SSH 未接受任何金鑰或 agent 身分；此用戶端以批次模式執行，無法詢問密碼。請設定金鑰或 agent 認證。";
    REFUSED_SSH_UNKNOWN_HOST = "The SSH destination does not resolve.", "无法解析 SSH 目标。", "無法解析 SSH 目標。";
    REFUSED_SSH_UNREACHABLE =
        "The remote computer did not accept the SSH connection.",
        "远程电脑没有接受 SSH 连接。",
        "遠端電腦沒有接受 SSH 連線。";
    REFUSED_SSH_OTHER =
        "SSH did not connect. This client runs ssh in batch mode: configure host verification and key or agent authentication.",
        "SSH 未能连接。此客户端以批处理模式运行 ssh：请配置主机验证以及密钥或 agent 认证。",
        "SSH 未能連線。此用戶端以批次模式執行 ssh：請設定主機驗證以及金鑰或 agent 認證。";
    REFUSED_SSH_FORWARDING =
        "The OpenSSH configuration for this destination adds its own port forwarding. Remove it, or use a dedicated Host entry.",
        "此目标的 OpenSSH 配置另外设置了端口转发。请移除它，或使用单独的 Host 条目。",
        "此目標的 OpenSSH 設定另外設定了連接埠轉發。請移除它，或使用單獨的 Host 項目。";
    REFUSED_ACTIVATION = "The operator did not start the Host: {reason}", "operator 未能启动 Host：{reason}", "operator 未能啟動 Host：{reason}";
    REFUSED_NOT_READY =
        "The Host connected but did not become ready.",
        "已连接到 Host，但它没有就绪。",
        "已連線至 Host，但它沒有就緒。";
    REFUSED_OUTCOME_UNKNOWN =
        "The connection outcome is unknown. Check the remote Host list before retrying.",
        "连接结果未知。请先检查远程 Host 列表，再决定是否重试。",
        "連線結果不明。請先檢查遠端 Host 清單，再決定是否重試。";

    // The remote project directory browser (Desktop's projectActions).
    REMOTE_DIRECTORY_TITLE = "Add a project on {host}", "在 {host} 上添加项目", "在 {host} 上新增專案";
    REMOTE_DIRECTORY_BREADCRUMBS = "Current folder", "当前文件夹", "目前資料夾";
    REMOTE_DIRECTORY_HOME = "Home", "主目录", "主目錄";
    REMOTE_DIRECTORY_EMPTY = "No folders here", "此文件夹中没有子文件夹", "此資料夾中沒有子資料夾";
    REMOTE_DIRECTORY_SELECT = "Add this folder", "添加此文件夹", "新增此資料夾";
    REMOTE_DIRECTORY_LOADING = "Loading folders…", "正在读取文件夹…", "正在讀取資料夾…";
    REMOTE_DIRECTORY_SHOW_HIDDEN = "Show hidden folders", "显示隐藏目录", "顯示隱藏目錄";
    REMOTE_DIRECTORY_HIDE_HIDDEN = "Hide hidden folders", "不显示隐藏目录", "不顯示隱藏目錄";
    REMOTE_DIRECTORY_READ_FAILED =
        "The project path is temporarily unavailable. Try again later.",
        "项目路径暂时无法读取，请稍后重试。",
        "專案路徑暫時無法讀取，請稍後重試。";
    REMOTE_DIRECTORY_REGISTER_FAILED =
        "The project could not be updated. Try again later.",
        "暂时无法更新项目，请稍后重试。",
        "暫時無法更新專案，請稍後重試。";
    /// The Host offers no folder to add projects from.
    REMOTE_DIRECTORY_NONE =
        "This Host offers no folders for adding projects.",
        "此 Host 没有提供可用于添加项目的文件夹。",
        "此 Host 沒有提供可用於新增專案的資料夾。";
}

/// "More actions for Build box".
pub fn more_actions(locale: Locale, name: &str) -> String {
    MORE_ACTIONS.fill(locale, &[("name", name)])
}

/// The sidebar footer's accessible name for the remote Host `name` at
/// `address`.
pub fn remote_footer_label(locale: Locale, name: &str, status: &str, address: &str) -> String {
    REMOTE_FOOTER_LABEL.fill(locale, &[("name", name), ("status", status), ("address", address)])
}

/// The status line after a Host was added.
pub fn added(locale: Locale, name: &str) -> String {
    ADDED.fill(locale, &[("name", name)])
}

pub fn refused_unreachable(locale: Locale, address: &str) -> String {
    REFUSED_UNREACHABLE.fill(locale, &[("address", address)])
}

pub fn refused_tls(locale: Locale, host: &str) -> String {
    REFUSED_TLS.fill(locale, &[("host", host)])
}

pub fn refused_upgrade(locale: Locale, status: u16) -> String {
    REFUSED_UPGRADE.fill(locale, &[("status", &status.to_string())])
}

pub fn refused_activation(locale: Locale, reason: &str) -> String {
    REFUSED_ACTIVATION.fill(locale, &[("reason", reason)])
}

/// The directory browser's title.
pub fn remote_directory_title(locale: Locale, host: &str) -> String {
    REMOTE_DIRECTORY_TITLE.fill(locale, &[("host", host)])
}
