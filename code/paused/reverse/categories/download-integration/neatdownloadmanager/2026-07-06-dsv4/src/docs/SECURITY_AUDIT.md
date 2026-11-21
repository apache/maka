# NeatDownloadManager Extension v1.9.92 — 安全审计

## 审计摘要

| 维度 | 评分 | 风险等级 | 关键发现 |
|------|------|----------|----------|
| 权限面 | 4/10 | **严重** | `<all_urls>` + `cookies` + `webRequest` 三高权限组合 |
| 数据流 | 4/10 | **严重** | Cookie 明文通过未加密 WebSocket 传输到 localhost |
| CSP | 8/10 | 低 | MV3 默认 CSP 提供基本保护 |
| 注入面 | 6/10 | 中 | Content Script 无 DOM 注入但有 innerHTML 等价风险 |
| 通信安全 | 3/10 | **严重** | WebSocket 无身份验证、无加密、无来源校验 |
| 存储安全 | 7/10 | 低 | 仅存储面板开关状态，无敏感数据 |
| 隐私 | 3/10 | **严重** | 全网 Cookie 可被任意读取并发送到本地应用 |
| 依赖 | 9/10 | 最低 | 零外部依赖，纯原生 Chrome API |
| 合规 | 5/10 | 中 | 未使用 Native Messaging 标准，Cookie 传输不透明 |

**综合评分: 5.4/10 — 需要关注**

---

## 1. 权限面分析

### 已声明权限

| 权限 | API | 风险 |
|------|-----|------|
| `cookies` | `chrome.cookies.getAll()` | **极高** — 可读取所有域名的 Cookie，包括 HttpOnly 和 Secure 标记的 Cookie |
| `webRequest` | 拦截/读取所有 HTTP 请求头+响应头+请求体 | **极高** — 可查看所有网络通信内容 |
| `webNavigation` | `onHistoryStateUpdated` | 中 — 跟踪浏览历史 |
| `contextMenus` | 右键菜单注册 | 低 |
| `storage` | `chrome.storage.local` | 低 |
| `downloads` | `chrome.downloads.cancel/erase` | 高 — 可取消用户发起的任何下载 |
| `host_permissions: <all_urls>` | 在所有网站注入 Content Script + 拦截所有请求 | **极高** |

### 权限组合风险

**Cookie 泄漏链路**: `<all_urls>` + `webRequest` + `cookies` 三者组合意味着：

1. 扩展可以拦截用户访问的**任何**网站的 HTTP 请求
2. 对于每个候选下载 URL，调用 `chrome.cookies.getAll({url})` 获取该域名的**全部 Cookie**
3. 这些 Cookie 包含会话令牌、认证凭据等敏感信息
4. Cookie 以明文格式通过 WebSocket 发送到 `ws://127.0.0.1:10007`

**潜在危害**: 如果桌面应用被植入恶意代码，或者另一个本地应用冒充监听 10007 端口，攻击者可以获取用户在任意网站的登录凭据。

### 建议

1. 使用 Native Messaging 替代原始 WebSocket，利用 Chrome 的沙箱机制
2. 仅提取与下载任务直接相关的 Cookie 子集，而非全量
3. 讨论是否可能通过 `webRequest.onBeforeSendHeaders` 的 `requestHeaders` 直接获取 (已有实现)，避免额外调用 `chrome.cookies.getAll`

---

## 2. 数据流安全

### 数据外传检测

对源代码执行安全关键词扫描 (`fetch(`, `XMLHttpRequest`, `send(`):

| 位置 | 调用 | 目标 | 风险 |
|------|------|------|------|
| `bg.js: R` (第10行) | `fetch(a["2"], {...})` | Vimeo config JSON / HEAD 请求 | 中 — 向目标服务器发起额外请求，但这是功能所需 |
| `bg.js: fetch` (第18行) | `fetch(a["2"], {method:"HEAD"})` | 下载链接的 HEAD 预检 | 中 |
| `bg.js: U.I` (第16-18行) | `this.G.send(b)` | WebSocket → `127.0.0.1:10007` | **严重** — 含 Cookie 的完整下载请求明文发送 |
| `ct.js: y` (第1行) | `fetch(c["2"], {mode:"no-cors"})` | Facebook video embed API | 中 |
| `ct.js: y` (第17行) | `fetch(...)` | Facebook 视频嵌入页面 | 中 |

### Cookie 传输路径

```
用户访问任意网站
    ↓ (webRequest 拦截)
扩展识别潜在下载 URL
    ↓
chrome.cookies.getAll({url: downloadUrl})
    ↓ (返回该域名的所有 Cookie, 含 HttpOnly/Secure)
构造下载请求字符串: "Cookie: name1=value1; name2=value2\r\n"
    ↓
WebSocket.send(): ws://127.0.0.1:10007/download
    ↓
桌面应用接收 Cookie 明文
    ↓ (桌面应用可能用这些 Cookie 发起下载请求)
```

**风险点**:
- WebSocket 未加密 (`ws://` 而非 `wss://`)
- 任何有权限访问本机 10007 端口的进程可读取这些 Cookie
- 没有对 WebSocket 的 client 或 server 进行身份验证

---

## 3. CSP (内容安全策略)

MV3 Service Worker 没有直接 DOM 访问能力，CSP 主要由 `manifest.json` 中的 `content_security_policy` 控制。此扩展的 `manifest.json` 中**未声明** `content_security_policy` 字段，因此使用 MV3 默认 CSP：

```
script-src 'self'; object-src 'self'
```

这限制了扩展自身的脚本执行范围，但 **Content Script 不受此 CSP 约束**——Content Script 运行在宿主页面的上下文中。

### Content Script 中的 UI 注入

`ct.js` 在页面 DOM 中创建 `DIV` 元素 (`neatDiv` + `neatTable`) 显示下载面板。它使用 `document.createElement` + `style.cssText` + `innerText` (非 `innerHTML`) 构建 UI。经检查：

- 使用 `innerText` 而非 `innerHTML` —— 避免了 XSS
- 使用 `document.createElement` 而非字符串拼接 HTML
- 图标 `onclick` 设置了硬编码的函数引用

**评估: 注入面控制较好，无明显的 DOM XSS 风险。**

---

## 4. 注入面

### eval / Function / innerHTML 检查

| 关键词 | 结果 |
|--------|------|
| `eval(` | 未发现 |
| `Function(` | 未发现 |
| `innerHTML` | 未发现 |

### 反混淆代码中的潜在风险

代码经过变量名缩短混淆 (`h`, `q`, `w`, `z`, `A`, `B` 等单字母变量)，但未使用 eval/Function 等动态执行手段。混淆类型为"变量名缩短"，非"控制流混淆"或"字符串加密"，可读性保持良好。

### Content Script 的安全风险

`ct.js` 使用 `chrome.runtime.getURL("img/icon16.png")` 获取扩展内资源 URL 并注入到页面 DOM (`<img src="...">`)。这是设计用途，风险低。

### manifest.json 安全

- 存在 `update_url` 字段，指向 Google CWS 官方更新 URL —— **正常**
- 未发现 `content_security_policy` 允许不安全 eval 或远程脚本的配置

---

## 5. 通信安全

### WebSocket (扩展 <-> 桌面应用)

| 属性 | 值 | 安全评估 |
|------|-----|----------|
| 协议 | `ws://` (非加密) | **不安全** — 数据明文传输 |
| 地址 | `127.0.0.1:10007` | localhost 范围，但端口号固定 |
| 认证 | 无 | **严重** — 任何本地进程可连接到此端口 |
| 协议标识 | `neatextension.v1` | 仅版本标识，非安全机制 |
| 数据格式 | 纯文本键值对 (`key:value\r\n`) | 明文，含 Cookie |

### 攻击场景

1. **恶意本地应用抢占端口**: 另一个应用先于 NeatDownloadManager 绑定 10007 端口，接收所有下载请求及其附带的 Cookie
2. **本地网络嗅探**: 虽然 localhost 流量不经过物理网卡，但在某些代理配置下可能泄露
3. **进程间窥探**: 某些系统工具可以 hook WebSocket 通信

### 改进建议

1. 迁移到 Chrome Native Messaging (`chrome.runtime.connectNative`)
2. 如果保持 WebSocket，至少使用 `wss://` + 证书 pinning
3. 实现简单的 challenge-response 验证，确保与正确的桌面应用通信
4. 对 Cookie 数据进行最小化提取（只保留下载服务器需要的认证 Cookie）

---

## 6. 存储安全

### chrome.storage.local 使用

```javascript
// bg.js: 读取
chrome.storage.local.get(["ShowMediaPanel"], function(d) {
  -1 == d.ShowMediaPanel && (c.F = false);
});

// bg.js: 写入
chrome.storage.local.set({ka: a ? 1 : -1}, function() {});
```

**分析**:
- 仅存储一个键: `ShowMediaPanel` (值: `1` 或 `-1`)
- 未存储密码、令牌、URL 或任何用户隐私数据
- 存储键名存在不一致: 读取时用 `ShowMediaPanel`，写入时用 `ka` —— 这是一个**明显的 bug**: 写入和读取使用了不同的键名。读取的 `ShowMediaPanel` 永远不会被写入更新，而写入的 `ka` 永远不会被读取。这意味着 `ShowMediaPanel` 状态无法持久化保存。

**风险: 低** — 即使数据泄露，也只是面板开关状态。

---

## 7. 隐私分析

### Cookie 收集范围

```javascript
// bg.js: 每次下载触发时
chrome.cookies.getAll({url: c["2"]}, this.J);
```

`chrome.cookies.getAll({url})` 返回该 URL 域名及其子域名的**所有 Cookie**，包括：
- Session Cookie
- 持久化 Cookie
- HttpOnly Cookie (JS 无法访问，但 Chrome 扩展 API 可以)
- Secure Cookie (仅 HTTPS，但扩展 API 可读)

这些 Cookie 被**全量打包**进 WebSocket 消息中的 `Cookie:` 头。

### 用户无感知

- 扩展安装时 Chrome 不会对 `cookies` + `<all_urls>` + `webRequest` 组合给出特别警告
- 普通用户无法理解其 Cookie 会被读取并发送到本地应用
- 没有提供 Cookie 发送的白名单或黑名单机制

### 改进建议

1. 在扩展描述和隐私政策中明确说明 Cookie 使用方式
2. 提供选项让用户选择是否发送 Cookie
3. 允许用户配置 Cookie 域名白名单
4. 对敏感域名的 Cookie (banking, email 等) 默认排除

---

## 8. 依赖安全

**该扩展无外部 JavaScript 依赖。**

- `bg.js`: 纯原生 Chrome Extension API，代码自包含
- `ct.js`: 纯原生 Chrome Extension API，代码自包含

无 npm 包、CDN 脚本、第三方 SDK 引用。依赖面极小，供应链风险最低。

---

## 9. 合规性评估

### Chrome Web Store 合规

| 要求 | 状态 | 说明 |
|------|------|------|
| MV3 要求 | 符合 | 使用 Service Worker (非 background page) |
| 权限最小化 | **不符合** | `<all_urls>` + `cookies` + `webRequest` 组合超出功能实际需要 |
| Native Messaging | **不符合** | CWS 推荐扩展与本地应用通信使用 Native Messaging，此扩展使用裸 WebSocket |
| 隐私披露 | **不符合** | 未在 manifest 或商店页面说明 Cookie 传输行为 |

### 敏感权限申明

Chrome Web Store 对此类权限组合(`cookies` + `webRequest` + `<all_urls>`) 的审核越来越严格。2024 年后的审核标准可能要求此类扩展提供详细的隐私说明和合规证明。

---

## 附录: Bug 发现

### Bug 1: storage 键名不一致 (低严重度)

**位置**: `bg.js`

- 读取: `chrome.storage.local.get(["ShowMediaPanel"], ...)` (第14行)
- 写入: `chrome.storage.local.set({ka: a ? 1 : -1}, ...)` (第19行)

读取用 `ShowMediaPanel`，写入用 `ka`——两个不同的键名。导致 `ShowMediaPanel` 状态无法正确持久化。这很可能是混淆过程中的疏忽，或早期版本的遗留问题。

### Bug 2: 下载 URL 拼写错误 (低严重度)

**位置**: `manifest.json` 第8行

```json
"description": "Sends Download Links to Neat Download Manager",
```

文件名拼写正确 (`NeatDownloadManager Extension`)，但描述中写的是 `Neat Download Manager` (有空格)。

---

## 总体建议

1. **紧急**: 将 WebSocket 通信替换为 Chrome Native Messaging
2. **高优先级**: 提供 Cookie 发送控制选项，默认最少化收集
3. **中优先级**: 修复 storage 键名 Bug (`ka` -> `ShowMediaPanel`)
4. **低优先级**: 整理 manifest.json，统一名称拼写
5. **建议**: 增加用户首次安装时的隐私说明提示页
