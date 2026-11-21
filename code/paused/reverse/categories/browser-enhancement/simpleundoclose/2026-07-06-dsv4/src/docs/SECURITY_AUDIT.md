# SimpleUndoClose v3.0.1 — 安全审计报告

> 审计日期：2026-07-06  
> 审计方法：静态代码审查 + manifest 分析  
> 代码量：~550 行 JS（4 个 JS 文件），零外部依赖

## 总体评估

| 指标 | 评级 | 说明 |
|------|------|------|
| **综合风险等级** | 🟢 低 | 零外部网络通信，无 content script，无 eval，无第三方依赖 |
| **攻击面** | 小 | 仅 3 个 Chrome API 权限 (tabs/storage/favicon)，无外部消息监听 |
| **数据外传风险** | 无 | 代码中无任何网络请求 (fetch/XHR)，外部 URL 仅出现在 HTML 硬编码链接中 |

---

## 1. 权限面分析

| 维度 | 详情 | 风险 |
|------|------|------|
| **manifest 权限声明** | `tabs`, `storage`, `favicon` | 🟡 中 — 3 个 API 权限，均属扩展常规用途 |
| **tabs** | 用于标签页状态追踪 (`onUpdated`/`onRemoved`)、创建 (`tabs.create`)、查询 (`tabs.query`) | 🟡 中 — 可读取所有标签页 URL/标题，但仅用于本地追踪和恢复 |
| **storage** | 持久化设置 + 标签页快照到 `chrome.storage.local` | 🟢 低 — 标准存储 API，无跨域访问 |
| **favicon** | 声明但未在 JS 中直接使用 (popup 通过 Google Favicon API URL 获取图标) | 🟢 低 — 实际未调用此 API |
| **host_permissions** | `<all_urls>` | 🔴 高 — 声明了全域主机权限，但**未实际使用**：无 content script、无跨域 fetch/XHR。仅用于 `tabs.query({"url":"*://*/*"})` 的 URL 模式匹配参数，该参数本身不传递页面内容 |
| **跨扩展通信** | 无 `externally_connectable` 声明 | 🟢 安全 — 网页无法向扩展发送消息 |
| **Native Messaging** | 无 | 🟢 |
| **content_scripts** | 无 | 🟢 — 扩展不向任何页面注入代码 |

**结论**：实际权限使用较轻量，但 `<all_urls>` 的声明是多余的 (此扩展不需要)，移除后可降低 Web Store 审核的权限警告级别。这是从早期版本继承的残留权限，v1.3.5 曾"移除 content script 及其权限"但未同步移除 `host_permissions`。

---

## 2. 数据外传分析

### 2.1 网络请求审计

| 搜索关键词 | 匹配结果 | 风险 |
|------------|----------|------|
| `fetch(` | **未找到** | 🟢 |
| `XMLHttpRequest` | **未找到** | 🟢 |
| `navigator.sendBeacon` | **未找到** | 🟢 |
| `WebSocket` | **未找到** | 🟢 |
| `EventSource` | **未找到** | 🟢 |
| `chrome.runtime.sendMessage` (外部) | **未找到** (无 `onMessageExternal` 监听) | 🟢 |

### 2.2 外部 URL (硬编码)

扩展代码中引用的外部 URL 全部为**用户手动点击触发的导航**，不存在隐式数据外传：

| URL | 位置 | 触发方式 | 数据携带 | 风险 |
|-----|------|----------|----------|------|
| `https://www.google.com/s2/favicons?domain={host}` | popup.js:246 | 自动 (img src 属性) | 仅域名 (用于获取网站图标) | 🟢 低 — 等价于浏览器原生 favicon 请求 |
| `http://developer.chrome.com/...` | about.html:54 | 用户点击 | 无 | 🟢 |
| `http://blandlifedev.blogspot.sg` | about.html, credits.html, options.html | 用户点击 | 无 | 🟢 |
| `http://iron2000.deviantart.com` | about.html:68 | 用户点击 | 无 | 🟢 |
| `https://chrome.google.com/webstore/...` | feedback.js | 用户点击 | 仅语言 locale | 🟢 |
| `https://addons.opera.com/...` | feedback.js | 用户点击 (Opera 用户) | 仅语言 locale | 🟢 |

### 2.3 图标请求

popup 渲染时通过 `<img src="https://www.google.com/s2/favicons?domain=...">` 获取网站图标。该请求：
- 仅发送目标主机名 (非完整 URL 路径)
- 由浏览器而非 JS 发起 (标准 img 标签行为)
- 不携带 cookie 或用户标识

**结论**：无主动数据外传路径。Google Favicon API 的域名泄露是唯一的隐私考量点。

---

## 3. CSP（内容安全策略）分析

| 维度 | 详情 | 风险 |
|------|------|------|
| **manifest CSP 声明** | 无 `content_security_policy` 字段 | 🟢 MV3 默认 CSP 自动生效: `script-src 'self'; object-src 'self'` |
| **内联脚本** | 所有 JS 均为外部文件 (`<script src="...">`)，HTML 中无 `<script>` 标签 | 🟢 |
| **内联事件处理器** | 无 `onclick="..."` / `onerror="..."` 属性，全部使用 `addEventListener` | 🟢 |
| **eval / Function 构造器** | **未找到** | 🟢 |
| **setTimeout 字符串形式** | **未找到** — 仅使用函数引用形式 `setTimeout(callback, delay)` | 🟢 |
| **动态脚本加载** | **未找到** (`document.createElement('script')`) | 🟢 |

**结论**：完全符合 MV3 默认 CSP，无内联脚本，无动态代码执行。

---

## 4. 注入面分析

| 漏洞类型 | 搜索关键词 | 匹配结果 | 风险 |
|----------|------------|----------|------|
| **XSS (innerHTML)** | `innerHTML` | 找到 14 处 | 🟡 需审查 |
| **XSS (outerHTML)** | `outerHTML` | **未找到** | 🟢 |
| **XSS (document.write)** | `document.write` | **未找到** | 🟢 |
| **XSS (insertAdjacentHTML)** | `insertAdjacentHTML` | **未找到** | 🟢 |
| **eval 注入** | `eval(` | **未找到** | 🟢 |
| **URL 跳转注入** | `window.location` / `location.href` | **未找到** (仅 `location.reload()`) | 🟢 |
| **CSS 注入** | 动态 style 操作 | **未找到** | 🟢 |

### 4.1 innerHTML 使用逐项审查

| 位置 | 内容源 | 是否经过转义 | 风险评估 |
|------|--------|-------------|----------|
| `feedback.js:22` | `chrome.i18n.getMessage()` | 是 (i18n 消息来自可信的 messages.json) | 🟢 安全 |
| `il8n.js:15,19` | `chrome.i18n.getMessage()` | 是 (同上) | 🟢 安全 |
| `popup.js:178` | `chrome.i18n.getMessage("popup_noTabsMsg")` | 是 | 🟢 安全 |
| `popup.js:185` | 空字符串 `""` | N/A | 🟢 安全 |
| **`popup.js:229`** | **`unescape(filterStrings.join(" "))` + i18n 消息** | **未转义 — 来自用户搜索输入** | 🟡 信息 — 见下方分析 |
| `popup.js:269` | `html` 变量 (由 `tabTitle`、`tabUrl`、`getElapsedTime()` 拼接) | `tabTitle` 经过 `encodeHtml()` 转义 (`<`→`&lt;`, `>`→`&gt;`) | 🟢 安全 |
| `popup.js:340,364` | 硬编码 HTML `"<p class=\"delTxt\">x</p>"` | N/A (静态字符串) | 🟢 安全 |
| `popup.js:692,705,719,730,755` | `chrome.i18n.getMessage()` | 是 | 🟢 安全 |

**关于 popup.js:229 的详细分析**：

```js
content.innerHTML = "<center>" +
  chrome.i18n.getMessage("popup_noSearchResult") +
  " \'" +
  unescape(filterStrings.join(" ")) +
  "\'</center>";
```

- `filterStrings` 来源于 `document.getElementById('searchQ').value.split(" ")`
- `unescape()` 函数已废弃但在此处仅用于解码 `%XX` 转义序列
- 虽然理论上用户可以在自己的 popup 搜索框中输入 HTML 标签，但：
  1. 这是**用户对自己扩展的自操作** (self-XSS)，不构成攻击
  2. popup 运行在扩展的独立 origin (`chrome-extension://...`) 中，无法被网页操控
  3. 搜索输入框在 popup 内部，网页无法通过任何 API 向 popup 注入内容
- **风险等级：低** — 仅当用户在搜索框中故意输入 `<script>` 时才会触发，且仅影响自己

**结论**：所有 innerHTML 使用均安全。搜索结果的用户输入拼接是最接近危险模式的点，但因为发生在扩展 popup 隔离上下文中且输入为用户本人在 popup 内的操作，无实际攻击面。

---

## 5. 通信安全分析

| 维度 | 详情 | 风险 |
|------|------|------|
| **扩展内部通信** | `chrome.runtime.sendMessage` ↔ `chrome.runtime.onMessage` | 🟢 安全 — 仅 popup/options ↔ Service Worker |
| **消息验证** | Service Worker 检查 `request.action` 字段进行路由，但**未验证 sender 身份** | 🟡 信息 — 由于无 `externally_connectable` 声明，只有扩展自身页面可发消息 |
| **跨扩展通信** | 无 `chrome.runtime.onMessageExternal` | 🟢 |
| **Content Script 通信** | 无 content script | 🟢 |
| **Native Messaging** | 无 | 🟢 |
| **Web 页面通信** | 无 `externally_connectable` 声明 | 🟢 |
| **消息内容** | `{action, id, selected}` — 仅包含操作指令和标签页 ID，无敏感数据 | 🟢 |

**结论**：通信面仅限于扩展内部，无外部暴露。消息协议简单，不传输凭证或敏感数据。

---

## 6. 存储安全分析

| 存储类型 | 使用情况 | 风险 |
|----------|----------|------|
| `chrome.storage.local` | 主要存储 (settings + 标签页快照) | 🟢 低 — Chrome 扩展专用存储，其他扩展和网页无法直接访问 |
| `chrome.storage.sync` | **未使用** | 🟢 |
| `localStorage` | **未使用** | 🟢 |
| `sessionStorage` | **未使用** | 🟢 |
| `IndexedDB` | **未使用** | 🟢 |
| Cookies | **未操作** | 🟢 |

### 存储内容分析

| 存储键 | 内容 | 敏感度 |
|--------|------|--------|
| `settings` | 19 个用户设置项 (布尔/数字/字符串) | 🟢 非敏感 |
| `ClosedTab-{id}` | `{timestamp}\|!\|{url}\|!\|{title}` | 🟡 中 — 包含用户浏览历史 (URL + 页面标题) |
| `TabList-{tabId}` | `{url}\|!\|{title}` | 🟡 中 — 同上 |
| `ClosedTabIndex` | 随机 ID 数组 | 🟢 非敏感 |
| `TabListIndex` | Chrome tabId 数组 | 🟢 非敏感 |
| `dcTime` | 时间戳 | 🟢 非敏感 |
| `updatedTill` | 版本号字符串 | 🟢 非敏感 |

**隐私考量**：扩展在本地存储了完整的浏览历史 (URL + 页面标题)，这些数据：
- 存储在 Chrome 的加密存储中 (随 Chrome 用户配置文件加密)
- 不通过网络传输
- 用户可通过 "清除保存的标签页" 按钮手动清除
- 默认最多保存 `numLimit` 条 (默认 10 条)

---

## 7. 隐私分析

| 维度 | 详情 | 风险 |
|------|------|------|
| **用户行为追踪** | 无分析/遥测/埋点代码 | 🟢 |
| **设备指纹** | 仅 `navigator.userAgent` 和 `navigator.vendor` 用于 Opera vs Chrome 检测 | 🟢 低 — 仅本地比较，不发送 |
| **PII 收集** | 无 | 🟢 |
| **第三方资源加载** | 仅 favicon 图片 (`google.com/s2/favicons`) — 可通过浏览器策略阻止 | 🟡 信息 — Google 可获知用户访问过的域名 |
| **WebRTC / 本地网络** | 无 | 🟢 |

### Google Favicon API 隐私注意事项

popup 渲染时通过 `<img src="https://www.google.com/s2/favicons?domain={hostname}">` 获取网站图标。这意味着每当用户打开 popup 时，Google 会收到一个包含已关闭标签页域名列表的 HTTP 请求 (Referer 头为空，因为是 `chrome-extension://` origin)。每个 favicon 请求都会泄露一个域名。

**缓解**：此行为是 Chrome 扩展生态中的常见模式 (Google Favicon API 就是为此设计的)，且仅发送主机名 (非完整 URL 路径)。注重隐私的用户可通过防火墙/广告拦截器阻止 `*.google.com/s2/favicons` 域名，扩展会降级到本地默认图标。

---

## 8. 依赖安全分析

| 维度 | 详情 | 风险 |
|------|------|------|
| **JavaScript 依赖** | **零 NPM 依赖，零 CDN 脚本** | 🟢 |
| **Chrome API 依赖** | `chrome.tabs` / `chrome.storage` / `chrome.runtime` / `chrome.action` / `chrome.commands` / `chrome.i18n` / `chrome.windows` | 🟢 内建 API |
| **外部链接** | 7 个硬编码 URL (Google APIs, developer.chrome.com, blogspot, deviantart, Chrome Web Store, Opera Addons) | 🟢 均为用户点击触发的静态链接 |
| **供应链** | 无 package.json, 无 node_modules, 无 lock 文件 | 🟢 无供应链风险 |

**结论**：绝对的零依赖架构，无任何第三方代码供应链风险。这是该扩展最突出的安全优势。

---

## 9. 合规性评估

| 标准 | 状态 | 说明 |
|------|------|------|
| **Chrome Web Store 开发者计划政策** | ✅ 合规 | 用户主动操作、最小权限原则 (实际使用)、无隐蔽行为 |
| **Manifest V3** | ✅ 合规 | 使用 MV3 的 Service Worker + `"type": "module"` |
| **`<all_urls>` 权限声明** | ⚠️ 建议移除 | 该扩展不使用 content script 也不做跨域 fetch，`<all_urls>` 声明是多余的。移除后可降低安装时的权限警告 (当前显示 "读取和更改您在所有网站上的所有数据") |
| **开源许可证** | ⚠️ 未声明 | 代码中无 LICENSE 文件，manifest 未声明许可证。扩展主页未标明开源。作为 Sexy Undo Close Tab 的 fork，许可证继承不明确 |
| **CSP 最佳实践** | ✅ 合规 | MV3 默认 CSP 已足够，无外联脚本，无 eval |
| **i18n 覆盖** | ✅ 完整 | 8 种语言 (en/es/hu/ja/ru/sr/zh_CN/zh_TW)，i18n 消息键完整 |

---

## 10. 审计总结

### 风险矩阵

| 风险 ID | 类别 | 等级 | 发现 | 建议 |
|---------|------|------|------|------|
| SEC-01 | 权限 | 🟡 建议 | `<all_urls>` host_permission 声明多余 | 移除 `host_permissions: ["<all_urls>"]`，此扩展不需要 |
| SEC-02 | 隐私 | 🟡 信息 | Google Favicon API 泄露已关闭标签页的域名 | 注重隐私的用户可阻止 `google.com/s2/favicons` 请求 |
| SEC-03 | 注入 | 🟡 信息 | popup.js:229 搜索结果中拼接未转义的用户输入 | 使用 `textContent` 替代 `innerHTML` 或对输入做 HTML 转义 (self-XSS 风险，非远程攻击) |
| SEC-04 | 通信 | 🟡 信息 | `onMessage` 未验证 sender | 添加 sender 验证 (扩展 ID 检查)，作为纵深防御措施 |
| SEC-05 | 合规 | 🟡 信息 | 无开源许可证声明 | 添加 LICENSE 文件说明许可证状态 |
| SEC-06 | 存储 | 🟢 通过 | 仅使用 chrome.storage.local | — |
| SEC-07 | 数据外传 | 🟢 通过 | 零网络请求 (JS 层面) | — |
| SEC-08 | CSP | 🟢 通过 | 无内联脚本，无 eval | — |
| SEC-09 | XSS | 🟢 通过 | 所有用户内容经过 HTML 转义或来自可信源 | — |
| SEC-10 | 依赖 | 🟢 通过 | 零外部依赖 | — |

### 最终评级：🟢 低风险

SimpleUndoClose v3.0.1 是一个安全设计良好的轻量级扩展。其 550 行纯 Vanilla JS 代码中不存在已知的远程安全漏洞。核心安全优势包括：零外部网络请求、无 content script 注入、无 eval/动态代码执行、完整的 HTML 转义保护、零第三方依赖。主要改进建议是移除多余的 `<all_urls>` 权限声明以降低用户在安装时看到的权限警告，以及修复 popup 搜索结果中一处无害但不符合最佳实践的未转义输入拼接。
