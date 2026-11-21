# Proxy SwitchyOmega (V3) v3.0.5 — 安全审计报告

## 审计范围

- **目标**: Proxy SwitchyOmega (V3) v3.0.5 (Manifest V3)
- **源码**: 297 个文件, 包含 minified 核心模块
- **审计日期**: 2026-07-06
- **审计方法**: 静态代码分析 + 权限面评估 + 数据流追踪
- **风险评级**: 严重 / 高 / 中 / 低 / 信息

---

## 1. 权限面评估 (Permission Surface Analysis)

### 1.1 权限清单

| 权限 | Chrome API 作用 | 风险级别 | 风险评估 |
|---|---|---|---|
| `proxy` | 完全控制浏览器代理设置 | **严重** | 可重定向所有网络流量到任意服务器 |
| `webRequestAuthProvider` | 为代理认证提供凭据 | **严重** | 可拦截/提供代理认证凭据 (用户名/密码) |
| `webRequest` | 监控所有网络请求 | **高** | 可观察所有 URL 和请求头 |
| `<all_urls>` (host) | 访问所有网站数据 | **高** | 内容脚本在所有页面运行 + webRequest 全局监控 |
| `tabs` | 读写标签页 URL | **中** | 可获取用户所有标签页 URL |
| `storage` | 持久化本地存储 | **低** | 数据仅本地, 不自动外传 |
| `alarms` | 定时任务 | **低** | 用于定时更新远程规则/PAC |
| `contextMenus` | 右键菜单 | **低** | 仅用于启用快速切换 |

### 1.2 风险评估

**proxy + webRequestAuthProvider 组合是最危险的权限**。扩展理论上可以:
- 将所有 HTTP/HTTPS 流量路由到攻击者控制的代理服务器
- 在代理认证过程中注入或窃取凭据
- 执行中间人攻击 (如果配置了恶意代理)

**缓解措施**: 此扩展开源 (GitHub: mrfanii/SwitchyOmega-V3), 代码在 Chrome Web Store 审核范围内。代理配置完全由用户控制, 扩展自身不会自动设置未知代理。

---

## 2. 数据流安全 (Data Flow Security)

### 2.1 数据外传检测

发现 **1 处外部网络请求**:

| 位置 | 目标 | 数据内容 | 风险级别 |
|---|---|---|---|
| `page_statistics.js:22` | `https://analytics.editcookie.com/submit` | URL, referrer, timestamp, user_id | **高** |

```javascript
// page_statistics.js — 页面访问统计上报
await fetch('https://analytics.editcookie.com/submit', {
  method: 'POST',
  body: JSON.stringify({
    name: 'SO',
    url: url,           // 用户访问的完整 URL
    referrer: referer,  // 来源 URL
    timestamp: Date.now(),
    user_id: userId     // 持久化 UUID (chrome.storage.sync)
  }),
});
```

**风险分析:**
- 向第三方域名 (`analytics.editcookie.com`) 发送用户浏览的完整 URL
- `user_id` 是持久化 UUID (存储在 `chrome.storage.sync`), 可跨设备跟踪用户
- 数据以明文 JSON 通过 HTTPS 发送
- `analytics.editcookie.com` 域名的所有权和管理者不明

**缓解建议:**
- 应当在隐私政策中明确告知用户数据收集行为
- 建议提供 opt-out 选项
- URL 应当做脱敏处理 (如只上报域名而非完整 URL)

### 2.2 网络请求的其他用途

| 位置 | 用途 | 风险 |
|---|---|---|
| `js/omega.js:872` | `fetch(url)` — 加载 CSS 主题文件 (本地文件) | **低** — 仅加载本地 `lib/themes/` 下的 CSS |
| `js/omega.js:393-408` | `$http.get(restoreOnlineUrl)` — 用户手动触发的在线备份恢复 | **低** — URL 由用户提供, 但无 URL 白名单校验 |
| `js/omega_target_chromium_extension.min.js` | PAC 脚本/规则列表远程 URL 抓取 | **低** — URL 由用户配置, 用户知情 |

---

## 3. CSP 安全 (Content Security Policy)

### 3.1 实际情况

Manifest V3 扩展的 CSP 由 Chrome 强制设定:
- 不允许 `eval()` 和 `new Function()` 
- 不允许内联脚本
- 远程脚本默认被阻止

### 3.2 代码中的潜在问题

```javascript
// js/background_preload.js:9
window.UglifyJS_NoUnsafeEval = true;
```

此行代码暗示原代码可能包含不安全的 eval 调用。`UglifyJS_NoUnsafeEval` 是一个标志, 用于告知 UglifyJS 压缩器不要生成 `eval` 相关代码。

### 3.3 AngularJS CSP 兼容性

AngularJS 1.x 默认使用 `eval` 进行表达式求值, 但在 MV3 环境下可能受限。`lib/angular-loader/angular-loader.min.js` 和 AngularJS 的 `$parse` 服务需要 CSP 兼容模式 (`ng-csp`)。

**风险级别: 低** — MV3 的 CSP 限制已经提供了足够的保护。

---

## 4. 注入面评估 (Injection Surface)

### 4.1 DOM 注入

AngularJS 通过 `$sanitize` 服务 (angular-sanitize.min.js) 进行 HTML 净化:
- `ng-bind-html` 会自动调用 sanitize
- 自定义指令 `omega-html` 使用 `$compile` 动态编译, 但有 sanitization 白名单

```javascript
// js/omega.js:49-52
$compileProvider.aHrefSanitizationWhitelist(
  /^\s*(https?|ftp|mailto|chrome-extension|moz-extension):/
);
$compileProvider.imgSrcSanitizationWhitelist(
  /^\s*(https?|local|data|chrome-extension|moz-extension):/
);
```

**风险级别: 低** — AngularJS 的 sanitization 和 CSP 提供了双层保护。

### 4.2 JS 代码执行

搜索 `eval(` 和 `new Function(` 未发现直接调用 (只在 minified 库文件中出现, 属于 AngularJS 框架正常使用)。

AngularJS 表达式 `{{ }}` 由 framework 管理, 但在 Controller 中使用 `$eval()` 时需要关注 (未发现未授权使用)。

**风险级别: 低** — 未发现用户可控的代码执行路径。

---

## 5. 通信安全 (Inter-Component Communication)

### 5.1 内部消息

所有消息通过 `chrome.runtime.sendMessage` 传递:
- 每个消息包含 `method` 字段, 后台根据方法名分发
- 请求带 `noReply: true` 标记的为单向消息
- 错误通过 `encodeError()` 序列化后回传

```javascript
// js/background.js:435-492
chrome.runtime.onMessage.addListener(function(request, sender, respond) {
  // 验证 request.method 存在
  // 动态调用 options[request.method] 或 state[request.method]
  // 返回 Promise 结果或错误
});
```

### 5.2 外部 API

`ExternalApi` (omega_target.min.js 中) 允许其他扩展远程控制:
- 调用 `options.externalApi.listen()` 启用
- 通过 `chrome.runtime.onMessageExternal` 监听
- 支持的方法: `setProfile`, `getState`, `addProfile` 等

**风险**: 外部扩展可以远程切换代理配置, 如果恶意扩展知道 SwitchyOmega 的扩展 ID, 可以进行未授权控制。

### 5.3 内容脚本通信

`content_scripts.js` 仅发送 URL 变更通知:
```javascript
chrome.runtime.sendMessage({
  type: 'url-change',
  hasTransition: !document.referrer,
});
```

**风险级别: 低** — 通信内容极小, 无敏感数据。

---

## 6. 存储安全 (Storage Security)

### 6.1 存储分布

| 存储 | 数据类型 | 加密 | 暴露面 |
|---|---|---|---|
| `chrome.storage.local` | 代理配置 (host/port/auth) | 否 (明文) | 本地文件系统 |
| `chrome.storage.sync` | 同步配置 + user_id | 否 (明文) | Chrome Sync 云端 |
| `localStorage` | 运行状态 + 错误日志 | 否 (明文) | 本地文件系统 |
| IndexedDB | localStorage polyfill | 否 (明文) | 本地文件系统 |

### 6.2 敏感数据风险

**代理认证凭据存储**:
```typescript
// 代理认证凭据以明文存储
proxy.auth = {
  username: "user123",
  password: "plaintext_password"  // 明文存储
}
```

**风险级别: 高** — 代理密码以明文存储在 `chrome.storage.local` 中。如果用户导出配置备份 (`OmegaOptions.bak`), 密码会以明文 JSON 暴露。

**缓解建议:**
- 使用 `chrome.storage.session` 存储敏感凭据 (会话结束后清除)
- 或至少对密码字段使用 WebCrypto API 加密

### 6.3 日志中的潜在泄密

```javascript
// js/log_error.js + js/background.js
localStorage['log'] += error.stack + '\n\n';
localStorage['logLastError'] = content;
```

错误日志可能包含 URL、配置片段等敏感信息。`omegaDebug.downloadLog()` 可以将日志下载为文件。

**风险级别: 中** — 日志仅本地, 但 `reportIssue()` 功能会将日志片段 URL 编码后附加到 GitHub Issue URL 中。

---

## 7. 隐私评估 (Privacy Assessment)

### 7.1 数据收集

| 数据类型 | 收集方式 | 传输目标 | 用户知情 |
|---|---|---|---|
| 浏览 URL | `page_statistics.js` 自动 | analytics.editcookie.com | **未知** |
| 用户 UUID | `chrome.storage.sync` 生成并持久化 | analytics.editcookie.com | **未知** |
| 扩展版本 | `omega_debug.js` 手动触发 | GitHub Issues | 是 (用户主动) |
| 用户代理 | `omega_debug.js` 手动触发 | GitHub Issues | 是 (用户主动) |
| 代理配置 | 无自动外传 | 无 | N/A |

### 7.2 隐私风险

1. **隐蔽分析追踪**: `page_statistics.js` 在后台自动运行, 无需用户同意即上报浏览 URL。文件未在 manifest 或 README 中声明此行为。
2. **跨设备追踪**: UUID 存储在 `chrome.storage.sync`, 可在同一 Google 账号下的不同设备间追踪同一用户。
3. **无 opt-out 机制**: 代码中未提供关闭统计上报的配置选项。

**风险级别: 高** — 存在用户不知情的数据收集行为。

---

## 8. 依赖安全 (Supply Chain Security)

### 8.1 第三方库审计

| 库 | 引用方式 | 是否有已知漏洞 | 评估 |
|---|---|---|---|
| AngularJS 1.x | 本地 bundling | 1.x 已停止维护, 可能存在已知漏洞 | **中** — 建议迁移到现代框架 |
| jQuery | 本地 bundling | 版本需确认 | **低** |
| jsondiffpatch | 本地 bundling | — | **低** |
| idb-keyval | 本地 bundling | — | **低** |

### 8.2 远程资源加载

`options.js` 中加载的脚本为本地相对路径, 不涉及 CDN 加载。所有第三方库均打包在扩展内。

**风险级别: 低** — 无远程代码加载风险。

---

## 9. 合规评估 (Compliance Assessment)

### 9.1 Chrome Web Store 合规

| 要求 | 状态 | 说明 |
|---|---|---|
| 最小权限原则 | **未完全遵守** | `webRequestAuthProvider` 和 `<all_urls>` 范围较宽 |
| 数据使用披露 | **未知** | 未确认是否在商店页面披露分析追踪 |
| 用户同意 | **未明确** | 统计追踪无 opt-out |
| HTTPS 传输 | **遵守** | 分析上报使用 HTTPS |
| 无混淆代码 | **部分遵守** | 核心模块 minified 但可读性尚可 |

### 9.2 GDPR/隐私合规

| 要求 | 状态 |
|---|---|
| 数据收集透明度 | 需要提供隐私政策 |
| 用户同意机制 | 需要添加 opt-out |
| 数据最小化 | URL 完整上报不满足最小化原则 |

---

## 审计总结

### 严重风险 (Critical): 0

### 高风险 (High): 2

| ID | 风险 | 描述 |
|---|---|---|
| SEC-001 | 分析追踪未披露 | `page_statistics.js` 自动上报浏览 URL 到 `analytics.editcookie.com`, 用户不知情且无 opt-out |
| SEC-002 | 代理凭证明文存储 | 代理用户名和密码以明文 JSON 存储在 `chrome.storage.local`, 导出备份直接暴露 |

### 中风险 (Medium): 3

| ID | 风险 | 描述 |
|---|---|---|
| SEC-003 | 外部 API 无认证 | `ExternalApi.listen()` 允许任何扩展通过消息控制代理, 可被恶意扩展利用 |
| SEC-004 | AngularJS 1.x EOL | AngularJS 1.x 已停止安全更新, 长期来看存在已知漏洞风险 |
| SEC-005 | 日志含敏感信息 | 错误日志可能包含 URL/配置片段, Issue 报告会泄露部分环境信息 |

### 低风险 (Low): 3

| ID | 风险 | 描述 |
|---|---|---|
| SEC-006 | 在线备份恢复无 URL 白名单 | `restoreOnlineUrl` 可指向任意 URL, 可能被用于 SSRF |
| SEC-007 | 远程规则/PAC URL 无完整性校验 | 远程抓取的规则列表和 PAC 脚本无哈希校验 |
| SEC-008 | `localStorage` polyfill 在 SW 中 | Service Worker 中 localStorage 不可靠, 可能导致状态丢失 |

### 总体风险评级: **中高**

Proxy SwitchyOmega 的主要安全风险集中在两个方面:
1. **隐私**: 未披露的分析追踪和用户数据的自动上报
2. **凭据管理**: 代理密码的明文存储

由于其 `proxy` + `webRequestAuthProvider` 的敏感权限组合, 用户应当仅从可信来源 (Chrome Web Store 官方发布) 安装此扩展, 并注意审查所配置的代理服务器的可信度。
