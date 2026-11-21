# ADB v0.9.8 — 安全审计报告

> 审计日期：2026-07-06  
> 审计方法：静态代码审查 + manifest 分析  
> 代码量：~130 行（HTML + JS），零外部依赖

## 总体评估

| 指标 | 评级 | 说明 |
|------|------|------|
| **综合风险等级** | 🟢 低 | 极简代码，零权限，无外部通信，无注入面 |
| **攻击面** | 极小 | 仅 3 个导航函数，无 content script，无消息监听 |
| **数据外传风险** | 无 | 无任何网络请求（fetch/XHR），无分析/遥测代码 |

---

## 1. 权限面分析

| 维度 | 详情 | 风险 |
|------|------|------|
| **manifest 权限声明** | 无 `permissions` 字段 | 🟢 无 |
| **隐含权限** | `chrome.tabs.create`（无需声明）| 🟢 低 — 仅创建标签页导航，不读取标签页内容 |
| **跨扩展通信** | `chrome.extension.getBackgroundPage()`（无需声明）| 🟢 低 — 仅内部 popup ↔ background 通信 |
| **host_permissions** | 无 | 🟢 无 |
| **NPAPI 插件权限** | `<object type="application/x-adbplugin">` | 🟡 信息 — 遗留声明，现代 Chrome 中不可用；即使可用也仅限已安装的 NPAPI 插件 |

**结论**：该扩展声明的权限为零，属于 Chrome Web Store 中可以发布的最低权限扩展。

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
| `chrome.runtime.sendMessage` | **未找到** | 🟢 |
| `window.postMessage` | **未找到** | 🟢 |
| `navigator.userAgent` | **找到**（`popup.js:2`） | 🟢 低 — 仅用于本地平台检测，不发送到任何远程服务器 |

### 2.2 外部 URL 导航

扩展通过 `chrome.tabs.create()` 打开以下 URL，这些是**用户主动点击触发**的导航，而非自动外传：

| URL | 触发场景 | 数据携带 | 风险 |
|-----|----------|----------|------|
| `chrome://inspect` | 用户点击 "View Inspection Targets" | 无 | 🟢 |
| `https://developers.google.com/...` | 用户点击 "Help & Documentation" | 无 | 🟢 |
| `https://github.com/GoogleChrome/ADBPlugin` | 用户点击 "File a ticket" | 无 | 🟢 |

以上导航均为用户意图驱动的显式操作，不涉及隐式数据传输。

---

## 3. CSP（内容安全策略）分析

| 维度 | 详情 | 风险 |
|------|------|------|
| **manifest CSP 声明** | 无 `content_security_policy` 字段 | 🟡 信息 — MV2 默认 CSP 为 `script-src 'self'; object-src 'self'` |
| **内联脚本** | popup.js 和 background.js 均为外部脚本文件（`<script src="...">`） | 🟢 |
| **内联样式** | popup.html 使用 `<style>` 标签（内联 CSS） | 🟢 — CSP 不限制内联 style（仅限制 script） |
| **eval / Function 构造器** | **未找到** | 🟢 |
| **动态脚本加载** | **未找到**（无 `document.createElement('script')`） | 🟢 |

**结论**：符合 MV2 默认 CSP，无不安全的内联脚本或动态代码执行。

---

## 4. 注入面分析

| 漏洞类型 | 搜索关键词 | 匹配结果 | 风险 |
|----------|------------|----------|------|
| **XSS (innerHTML)** | `innerHTML` | **未找到** | 🟢 |
| **XSS (outerHTML)** | `outerHTML` | **未找到** | 🟢 |
| **XSS (document.write)** | `document.write` | **未找到** | 🟢 |
| **XSS (insertAdjacentHTML)** | `insertAdjacentHTML` | **未找到** | 🟢 |
| **HTML 拼接** | 字符串拼接创建 HTML | **未找到** | 🟢 |
| **eval 注入** | `eval(` | **未找到** | 🟢 |
| **setTimeout/setInterval 字符串** | `setTimeout(` / `setInterval(` | **未找到** | 🟢 |
| **URL 跳转注入** | `window.location` / `location.href` | **未找到** | 🟢 |
| **CSS 注入** | 动态 style 操作 | **未找到** | 🟢 |

**结论**：代码中不存在任何已知的 DOM-based XSS 攻击向量。所有 DOM 操作均为对现有元素的只读查询（`querySelectorAll` / `getElementById`）或 class 操作（`classList.add`）。

---

## 5. 通信安全分析

| 维度 | 详情 | 风险 |
|------|------|------|
| **扩展内部通信** | `chrome.extension.getBackgroundPage()` — 同步、同源、同进程 | 🟢 安全 — 无法被第三方扩展或网页拦截 |
| **跨扩展通信** | 无 `chrome.runtime.onMessageExternal` / `sendMessage` | 🟢 |
| **Content Script 通信** | 无 content script | 🟢 |
| **Native Messaging** | 无 | 🟢 |
| **Web 页面通信** | 无 `externally_connectable` 声明 | 🟢 |
| **NPAPI 插件通信** | `<object type="application/x-adbplugin">` 标签存在但插件不可用 | 🟡 信息 — NPAPI 本身是遗留技术，但此扩展并未实际调用插件方法 |

**结论**：扩展通信面极小，仅存在安全的内部同进程函数调用。

---

## 6. 存储安全分析

| 存储类型 | 使用情况 | 风险 |
|----------|----------|------|
| `chrome.storage.local` | **未使用** | 🟢 |
| `chrome.storage.sync` | **未使用** | 🟢 |
| `localStorage` | **未使用** | 🟢 |
| `sessionStorage` | **未使用** | 🟢 |
| `IndexedDB` | **未使用** | 🟢 |
| Cookies | **未操作** | 🟢 |

**结论**：扩展完全不使用任何客户端存储，无数据泄露或持久化攻击面。

---

## 7. 隐私分析

| 维度 | 详情 | 风险 |
|------|------|------|
| **用户行为追踪** | 无分析/遥测代码 | 🟢 |
| **设备指纹** | 仅 `navigator.userAgent` 用于本地 platform class 设置 | 🟢 |
| **PII 收集** | 无 | 🟢 |
| **第三方资源加载** | 无 | 🟢 |
| **WebRTC / 本地网络** | 无 | 🟢 |

**结论**：扩展不收集、存储、传输任何用户数据。

---

## 8. 依赖安全分析

| 维度 | 详情 | 风险 |
|------|------|------|
| **JavaScript 依赖** | 零 NPM 依赖，零 CDN 脚本 | 🟢 |
| **NPAPI 插件** | `application/x-adbplugin` — 已停止支持 | 🟡 信息 — 不可用但不造成安全风险 |
| **Chrome API 依赖** | `chrome.tabs` / `chrome.extension` — 内建 API | 🟢 |
| **外部链接** | 三个硬编码 URL（均指向 Google/GitHub 官方域） | 🟢 |

**结论**：无第三方依赖供应链风险。

---

## 9. 合规性评估

| 标准 | 状态 | 说明 |
|------|------|------|
| **Chrome Web Store 开发者计划政策** | ✅ 合规 | 零权限、无隐蔽行为、用户主动操作触发导航 |
| **Manifest V2 弃用** | ⚠️ 信息 | 该扩展使用 MV2，Google Chrome 正在逐步淘汰 MV2 扩展 |
| **NPAPI 弃用** | ⚠️ 信息 | NPAPI 在 Chrome 45（2015年9月）中移除，扩展核心功能已失效 |
| **开源许可证** | ✅ BSD-3-Clause | 代码头部声明 BSD 许可证 |
| **CSP 最佳实践** | ✅ 合规 | 无外部脚本，无 eval，默认 CSP 已足够 |

---

## 10. 审计总结

### 风险矩阵

| 风险 ID | 类别 | 等级 | 发现 | 建议 |
|---------|------|------|------|------|
| SEC-01 | NPAPI 依赖 | 🟡 信息 | 遗留 NPAPI `object` 标签 | 无必要操作 — 扩展已废弃 |
| SEC-02 | MV2 淘汰 | 🟡 信息 | 使用 Manifest V2 | 如继续使用需迁移至 MV3 |
| SEC-03 | 权限 | 🟢 通过 | 零权限声明 | — |
| SEC-04 | 数据外传 | 🟢 通过 | 无网络请求 | — |
| SEC-05 | CSP | 🟢 通过 | 无内联脚本，无 eval | — |
| SEC-06 | XSS | 🟢 通过 | 无 DOM 写入操作 | — |
| SEC-07 | 通信 | 🟢 通过 | 仅内部同源调用 | — |
| SEC-08 | 存储 | 🟢 通过 | 无客户端存储 | — |
| SEC-09 | 隐私 | 🟢 通过 | 无数据收集 | — |
| SEC-10 | 依赖 | 🟢 通过 | 零外部依赖 | — |

### 最终评级：🟢 低风险

ADB v0.9.8 是一个安全设计良好的极简扩展。其 130 行代码中不存在任何已知的 Web 安全漏洞模式，零权限声明意味着即使被恶意利用也无法访问敏感 API，无任何网络请求意味着不存在数据外传路径。唯一的"问题"是它已因 NPAPI 和 MV2 的逐步淘汰而功能失效，但这属于演进性废弃，非安全漏洞。
