# IDM Integration Module — 安全审计报告

> 版本: v6.43.1 | Manifest V3 | Chrome Extension
> 审计日期: 2026-07-05
> 风险等级: **高** (基于权限组合分析)

---

## 一、审计概要

IDM Integration Module 是一个具备极高权限的浏览器扩展。虽然其宣称的功能（下载管理）是合理的，但权限组合使该扩展在理论上具备以下能力：

- 读取所有网站的 HTTP 请求/响应内容和请求体
- 读取所有网站的 Cookie
- 注入任意 JavaScript 到所有页面
- 监控和修改浏览器代理设置
- 与本地应用程序通信并执行操作
- 接管浏览器下载行为

本次审计基于对 v6.43.1 完整源代码的静态分析。

---

## 二、权限清单及风险评估

### 2.1 `proxy` 权限 — 严重高风险

```json
"permissions": ["proxy"]
```

**代码位置**: `background.js` line 27-28, `bb()` 函数

**实际行为**:
```javascript
// 监听代理配置变更
this.M(1, browser.proxy.settings.onChange, this.bb);
// 主动读取当前代理配置
browser.proxy.settings.get({}, this.bb);
```

**分析**:
- 扩展实时监听用户代理设置的每次变更
- 读取的代理信息包括: 代理模式 (direct/fixed_servers/pac_script/system)、代理服务器地址、端口、PAC 脚本 URL/内容、绕过列表
- 这些数据通过 `S()` 函数发送至 IDM 桌面应用 (Native Message type=1)
- `proxy` 权限在 Chrome Web Store 审查中被归类为"高敏感权限"
- **风险**: 代理配置泄露可暴露用户的网络拓扑、VPN 使用情况和隐私保护措施

**数据外传路径**:
```
Chrome Proxy API
  -> bb() 解析
  -> this.J (内存暂存)
  -> S(this, 1, 2, ...) 发送
  -> Native Messaging / WebSocket
  -> IDM 桌面应用
```

### 2.2 `nativeMessaging` 权限 — 严重高风险

```json
"permissions": ["nativeMessaging"]
```

**代码位置**: `background.js` line 37-38, `Ba()` 函数

**行为**:
```javascript
// Primary: Native Messaging
this.S = browser.runtime.connectNative("com.tonec.idm");
// Fallback: WebSocket
this.S = new WebSocket(
    `ws://${La[a]}/?cid=${this.ca || 0}&rnd=${F().toString().substr(2,9)}`,
    "plugin.v3.internetdownloadmanager.com"
);
```

**分析**:
- `com.tonec.idm` 是 IDM 注册的 Native Messaging Host，位于用户系统
- 降级路径使用 `ws://127.0.0.1:1001` 或 `ws://0.1.0.1:1001` (明文 WebSocket)
- WebSocket 子协议声明为 `plugin.v3.internetdownloadmanager.com`
- **风险 1**: WebSocket 连接为明文 (ws:// 而非 wss://)，虽然没有 TLS 但因为是 localhost 连接，风险相对可控
- **风险 2**: 如果本地有恶意应用监听 1001 端口，可冒充 IDM 接收所有下载请求
- **风险 3**: Native Messaging 理论上允许 IDM 桌面应用以高权限在浏览器中执行操作

### 2.3 `externally_connectable` 配置 — 中高风险

```json
"externally_connectable": {
    "matches": [
        "*://*.internetdownloadmanager.com/*",
        "*://*.tonec.com/*"
    ]
}
```

**分析**:
- 允许 `internetdownloadmanager.com` 和 `tonec.com` 域下的网页通过 `chrome.runtime.connect()` / `sendMessage()` 与扩展通信
- 虽然这两个域属于同一公司 (Tonec FZE)，但如果这些域存在 XSS 漏洞或被攻破，攻击者可以:
  - 发送消息激活/停用扩展
  - 通过消息通道触发下载 (message type 38, 42, 43, 44)
  - 触发扩展卸载 (message type 43)
- **风险**: 外部网站可以触发浏览器下载行为、扩展状态变更和卸载操作

### 2.4 `cookies` 权限 — 中高风险

```json
"permissions": ["cookies"]
```

**代码位置**: `background.js` line 113, `yb()` 函数; line 121, `U()` 函数

**行为**:
```javascript
// 读取所有 cookie (用于获取下载请求的认证信息)
browser.cookies.getAll({url: M.homepage_url});
// 设置扩展状态 cookie
browser.cookies.set({
    url: M.homepage_url,
    name: "idmwebext_cid",
    value: String(b),
    expirationDate: 2147483647
});
// 按 URL 读取 cookie (用于每次下载请求)
U(a) -> browser.cookies.getAll({url: a})
```

**分析**:
- 扩展读取 `internetdownloadmanager.com` 域的 cookie 用于获取客户端 ID
- 每次拦截到下载请求时，调用 `U(url)` 读取该 URL 域下的所有 cookie
- Cookie 值通过 Native Messaging 发送至 IDM 桌面应用
- **风险**: 虽然用于合法的下载认证，但技术上该扩展可以读取**任何已访问网站**的 cookie 并外传至桌面应用

### 2.5 `webRequest` + `<all_urls>` — 严重高风险

```json
"permissions": ["webRequest"],
"host_permissions": ["<all_urls>"]
```

**代码位置**: `background.js` line 29-30

**行为**:
```javascript
// 拦截所有 URL 的请求 (包括请求体)
this.M(4, browser.webRequest.onBeforeRequest, this.cb, {
    urls: O,  // ["*://*/*"]
    types: N  // main_frame, sub_frame, object, image, xmlhttprequest, media, other
}, ["requestBody"]);

// 拦截请求头
this.M(4, browser.webRequest.onBeforeSendHeaders, this.Rb, {
    urls: O, types: N
}, ["requestHeaders"].concat(b));

// 拦截响应头
this.M(4, browser.webRequest.onHeadersReceived, this.Ub, {
    urls: O, types: N
}, ["responseHeaders"]);
```

**分析**:
- 扩展拦截**所有** HTTP/HTTPS 请求的请求头、响应头和请求体
- `requestBody` 选项意味着 POST 表单数据（包括密码、信用卡号等）可以被读取
- 被分类为"下载"的请求数据通过 Native Messaging 发送至桌面应用
- 非下载请求的数据据称在分类后被丢弃 (action=1)，但代码中仍被暂存于内存
- **风险**: 该权限组合使扩展成为事实上的**全流量中间人**

### 2.6 `scripting` + `<all_urls>` + `document_start` — 严重高风险

```json
"content_scripts": [{
    "js": ["content.js"],
    "matches": ["*://*/*"],
    "all_frames": true,
    "run_at": "document_start"
}]
```

**分析**:
- 内容脚本在**每个页面**、**每个 frame**、在 `document_start` 阶段注入
- 这意味着扩展的 JavaScript 在每个网页的 DOM 构建之前就开始执行
- 配合 `scripting` 权限，可以在任何页面动态注入额外脚本
- `web_accessible_resources` 中包含 `document.js`，可被网页直接引用和交互
- **风险**: 理论上可以劫持任何网页的 JavaScript 执行环境

### 2.7 `downloads` + `downloads.shelf` + `downloads.ui` — 中风险

```json
"permissions": ["downloads", "downloads.shelf", "downloads.ui"]
```

**代码位置**: `background.js` line 29

**行为**:
```javascript
// 隐藏浏览器下载栏
browser.downloads.setShelfEnabled(!b);  // b = true 时隐藏
// 拦截浏览器下载
browser.downloads.onCreated.addListener(this.qb);
// 暂停下载以便 IDM 接管
browser.downloads.pause(c, Zb);
```

**分析**:
- 扩展隐藏 Chrome 内置下载栏，强迫用户使用 IDM
- 通过 `onCreated` 监听器拦截所有浏览器下载
- 调用 `downloads.pause()` 暂停下载，然后由 IDM 接管
- 不在 IDM 白名单中的下载会被 `cancel()` 然后 `resume()` 回到浏览器处理
- **风险**: 对用户下载行为的完全控制，可能在用户不知情的情况下替换下载目标

### 2.8 `management` 权限 — 中风险

```json
"permissions": ["management"]
```

**代码位置**: `background.js` line 127-128, `Oc()` 函数

**行为**:
```javascript
// 检测并禁用竞品扩展
function Oc() {
    let a = Ha == "llbjbkhnmlidjebalopleeepgdfgcpec" &&
            "ngpampappnmepgilojfohadhhmbhlaek";
    browser.management.get(a || "llbjbkhnmlidjebalopleeepgdfgcpec", function(b) {
        b && b.enabled && browser.management.setEnabled(a || Ha, !1);
    });
}
```

**分析**:
- 检测特定扩展 ID (`llbjbkhnmlidjebalopleeepgdfgcpec` = IDM 旧版, `ngpampappnmepgilojfohadhhmbhlaek` = 另一个下载管理器)
- 如果检测到竞品扩展已启用，禁用竞品扩展或禁用自身（代码逻辑取决于环境）
- 也可以调用 `browser.management.uninstallSelf()` 卸载自身
- **风险**: 反竞争行为，可能违反 Chrome Web Store 政策

---

## 三、数据外传向量汇总

| 数据类型 | 来源 API | 传输目标 | 传输方式 | 触发条件 |
|----------|---------|---------|---------|---------|
| HTTP 请求 URL | webRequest | IDM Desktop | Native/WS | 每次请求 |
| HTTP 请求头 | webRequest | IDM Desktop | Native/WS | 下载请求 |
| HTTP 响应头 | webRequest | IDM Desktop | Native/WS | 下载请求 |
| POST 请求体 | webRequest | IDM Desktop | Native/WS | POST 下载 |
| Cookie | cookies API | IDM Desktop | Native/WS | 下载请求 |
| 代理配置 | proxy API | IDM Desktop | Native/WS | 配置变更 |
| 浏览历史/标签页 | tabs/webNavigation | IDM Desktop | Native/WS | 页面导航 |
| 媒体元素 URL | content.js DOM | IDM Desktop | Native/WS | 媒体播放 |
| 页面标题 | content.js DOM | IDM Desktop | Native/WS | 页面加载 |
| 窗口尺寸/位置 | windows API | IDM Desktop | Native/WS | 持续同步 |
| User-Agent | navigator | IDM Desktop | Native/WS | 连接建立 |
| 键盘输入 | content.js keydown | IDM Desktop | Port | 快捷键检测 |

---

## 四、ROT13 混淆与规避分析

该扩展大量使用 ROT13 字符替换进行代码混淆。这是一种**规避而非安全**措施：

1. **目的**: 规避 Chrome Web Store 的自动代码审查（某些字符串如 "XMLHttpRequest"、"fetch"、"headers" 可能在审查中触发告警）
2. **效果**: ROT13 对人工审查者有阻挠作用，但对自动工具基本无效
3. **透明度**: 混淆降低了代码可审计性，与"最小权限"和"用户知情同意"原则相悖

混淆字符串的高危示例 (ROT13 解码后):
- 拦截 `XMLHttpRequest.open/send/setRequestHeader`
- 拦截 `fetch/headers/body/text/json`
- 拦截 `ReadableStream.getReader/pipeThrough`
- 监听 `upload/loadend` 事件
- 注入 `application/vnd.t1c` 自定义 MIME 类型标记

---

## 五、安全建议

### 5.1 对开发者的建议

1. **移除 `proxy` 权限**: 代理检测需求可通过 Native Messaging 由桌面应用自行查询
2. **限制 `cookies` 范围**: 仅读取 IDM 相关域或需要 cookie 认证的下载域
3. **移除 WebSocket 降级路径**: 仅使用 Native Messaging（标准、受审计的 Chrome API）
4. **移除 ROT13 混淆**: 提高代码透明度，接受公开审查
5. **限制 `webRequest` 范围**: 仅拦截明确的下载请求类型，移除 `requestBody` 捕获
6. **移除 `management` 竞品检测**: 这是明显的反竞争行为
7. **文档化所有外传数据**: 在隐私政策中列出完整的用户数据传输清单

### 5.2 对用户的建议

1. 确保从 Chrome Web Store 官方渠道安装扩展
2. 定期检查扩展权限变更
3. 在不需要时停用扩展，减少持续监控窗口
4. 使用 Chrome 的"此扩展可读取和更改网站数据"设置限制站点访问范围

### 5.3 对 Chrome Web Store 审查的建议

1. 对使用 `proxy` + `webRequest` + `cookies` + `nativeMessaging` 组合的扩展加强人工审查
2. 建立 ROT13/Base64 混淆自动检测机制
3. 要求扩展在清单中声明所有 Native Messaging Host 的应用名称

---

## 六、权限矩阵

| 权限 | 必要性 | 替代方案 | 风险等级 |
|------|--------|---------|---------|
| `nativeMessaging` | 是 (核心功能) | 无 | 高 |
| `proxy` | 否 (桌面应用可自查) | 移除,由桌面应用处理 | 高 |
| `cookies` | 部分 (仅下载认证) | 限制域名范围 | 中高 |
| `webRequest` | 部分 (下载拦截) | 限制请求类型,移除 requestBody | 高 |
| `scripting` | 部分是 (动态注入) | 限制触发条件 | 高 |
| `downloads` | 是 (下载接管) | 无 | 中 |
| `management` | 否 | 移除竞品检测逻辑 | 中 |
| `storage` | 是 (配置) | 无 | 低 |
| `tabs` | 是 (UI集成) | 无 | 低 |
| `webNavigation` | 是 (页面追踪) | 限制事件类型 | 低 |
| `contextMenus` | 是 (UI集成) | 无 | 低 |
| `declarativeNetRequest` | 否 | 移除 | 低 |

---

## 七、结论

IDM Integration Module v6.43.1 的权限组合使其在技术上具备**完整流量监控和用户行为追踪**的能力。虽然其商业功能（下载管理）需要其中大部分权限，但以下权限的使用值得关注：

- **`proxy` 权限的实时代理监控和数据外传**
- **`webRequest` 的 `requestBody` 捕获能力**
- **`cookies` 的跨站读取模式**
- **`externally_connectable` 的外部域消息接收**
- **ROT13 代码混淆降低透明度和可审计性**

建议在安装和使用该扩展时保持警惕，关注后续版本中的权限变更。
