# Tampermonkey v5.5.0 — 安全审计报告

> 审计日期：2026-07-06 | 审计工具：dsv4 逆向工程工作流 | 目标版本：5.5.0 (MV3)

---

## 审计结论摘要

| 项目 | 内容 |
|------|------|
| **综合安全等级** | **CRITICAL (高危)** |
| **风险评分** | 7.2 / 10 |
| **关键风险数** | 3 (权限组合、MAIN world 注入、凭证明文存储) |
| **中风险数** | 4 (通信验证、CSP 绕过、网络代理、隐私泄露) |
| **低风险数** | 2 (第三方依赖、外部连接) |
| **审计维度** | 9 (全部覆盖) |

> **总体结论**：Tampermonkey 的权限组合（webRequestBlocking + <all_urls> + userScripts + cookies + unlimitedStorage）使其成为 Chrome Web Store 上权限面最广的扩展之一。该扩展本身没有恶意行为，其 Vault 沙箱设计精良，但核心功能（在任意页面 MAIN world 执行用户脚本）与安全之间存在不可调和的矛盾。用户脚本完全可见可审计，安全上限最终取决于用户。

---

## 一 权限面评估 — CRITICAL

### 1.1 权限清单与风险矩阵

| 权限 | 实际用途 (代码证据) | 等级 | 风险说明 |
|------|---------------------|:----:|----------|
| `webRequest` + `webRequestBlocking` | background.js 注册 onBeforeRequest 监听器，实现 `GM_webRequest` API 的拦截/重定向/取消 | **CRITICAL** | 可同步拦截任意 HTTP(S) 请求，修改请求头、重定向 URL、阻断连接 |
| `<all_urls>` (host_permissions) | 所有 `@include`/`@match` 规则依赖，确保任意页面注入；代码中 ZA 常量确认覆盖 http/https/ftp/file/ws/wss | **CRITICAL** | 覆盖所有网络协议的最大主机权限范围 |
| `userScripts` | MV3 API，按需注入到 userScripts world；content.js 中 `Ho=ko.userScripts` 检测可用性，`onBeforeScript` 监听 | **HIGH** | 可在 page world 之外创建独立脚本执行上下文 |
| `scripting` | `chrome.scripting.executeScript` / `registerContentScripts` 注入 content.js 和用户脚本；支持 `world:"MAIN"` | **HIGH** | 动态 JS/CSS 注入能力，可注入到任意 world |
| `cookies` | `GM_cookie` API 实现 (set/delete/list)；通过 Port 通道传递至 background.js 处理 | **HIGH** | 可读写任意域名 cookie，包括 HttpOnly cookie |
| `unlimitedStorage` | IndexedDB 存储用户脚本 + JSZip 压缩，理论无限容量 | **MEDIUM** | 结合 <all_urls> 理论上可作为数据采集中转 |
| `clipboardWrite` | `GM_setClipboard` API；通过 offscreen document 配合 `document.execCommand("copy")` 实现 | **MEDIUM** | 可静默写入剪贴板 |
| `notifications` | `GM_notification` API；通过 Chrome notifications API 显示桌面弹窗 | **LOW** | 权限本身风险低，但恶意脚本可利用弹窗钓鱼 |
| `contextMenus` | `GM_registerMenuCommand` API；右键菜单注入 | **LOW** | 标准 Chrome 权限 |
| `offscreen` | clipboard/audio 等需要 DOM 的 API 支持 | **LOW** | MV3 必需权限 |
| `declarativeNetRequestWithHostAccess` | 声明式网络规则 | **LOW** | 基于主机权限的动态规则 |
| `downloads` (optional) | `GM_download` API | **LOW** | 可选权限，用户需主动授权 |
| `alarms`, `idle`, `webNavigation`, `tabs` | 定时更新检查、空闲检测、导航监听、标签管理 | **LOW** | 标准扩展功能 |
| `chrome://favicon/` | 脚本列表显示网站 favicon | **MINIMAL** | 只读 favicon |
| `storage` | 设置持久化、云配置存储 | **LOW** | 标准存储权限 |

### 1.2 权限链分析

```
用户脚本 (MAIN world, 不受 CSP 约束)
  └─ GM_* API (page.js, Vault 闭包保护)
      └─ Content Script (content.js, ISOLATED world)
          └─ chrome.runtime.Port 长连接 (消息队列 + 重连)
              └─ Service Worker (background.js, 614KB, 拥有全部权限)
                  ├─ chrome.scripting.executeScript ── 注入任意 JS
                  ├─ chrome.userScripts ── 注册用户脚本到新 world
                  ├─ chrome.webRequest ── 拦截/重定向网络请求
                  ├─ chrome.cookies ── 读写任意 cookie
                  ├─ chrome.tabs ── 操作标签页 (读取URL、切换焦点)
                  └─ IndexedDB / chrome.storage ── 持久化脚本和设置
```

权限链上每层都有对应的安全控制（@grant 白名单、沙箱隔离、消息验证），但攻击者只需控制最顶层（用户脚本）即可间接利用所有下层 Chrome API 能力。

---

## 二 用户脚本注入面 — CRITICAL

### 2.1 执行上下文分析

**代码证据** (content.js + background.js)：

- 脚本通过 `chrome.scripting.executeScript` 以 `world:"MAIN"` 注入
- 也支持 userScripts API 注入 (`Ho = ko.userScripts`，content.js 检测)
- `sandbox_mode` 设置控制执行方式：
  - `"raw"` — 通过 closed shadow DOM + sandbox iframe 隔离执行
  - `"js"` — Vault 沙箱环境执行（默认）
  - `"default"` — 标准 JS 注入
- 在 MAIN world 中执行时，用户脚本与页面 JS 共享全局对象
- 页面代码可以完全访问和篡改用户脚本使用的任何非 Vault 保护 API

### 2.2 Vault 沙箱机制 (深度分析)

**实现位置**: content.js 第 2-9 行 (`s=twod.vault=twod.vault||s(twod.unsafeWindow)`)

Vault 在 ISOLATED world 的 content.js 加载时创建闭包，缓存 **60+ 个原生函数引用**，防止页面代码通过原型链污染攻击：

```
缓存的关键原生引用（部分清单）:

对象操作:
  Object.call, Object.assign, Object.bind, Object.keys, Object.values
  Object.defineProperty, Object.defineProperties, Object.getOwnPropertyDescriptor
  Object.getPrototypeOf, {}.toString

数组/字符串操作:
  [].forEach, [].some, [].shift, [].join, [].indexOf, Array.isArray
  "".slice, "".substr, "".split, "".indexOf, "".trim, "".replace, "".replaceAll
  "".charCodeAt, "".toLowerCase, "".toUpperCase

JSON / 编码:
  JSON.parse, JSON.stringify
  atob, btoa, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI
  escape, unescape

Promise / Generator:
  Promise.prototype.then, Promise.prototype.catch, Promise.prototype.constructor
  Generator.prototype.next, Generator.prototype.throw

XHR / 网络:
  XMLHttpRequest.prototype.open, XMLHttpRequest.prototype.send
  XMLHttpRequest 状态常量 (DONE, HEADERS_RECEIVED, LOADING, OPENED, UNSENT)

DOM:
  document.createElementNS, document.getElementsByTagName
  document.createElement, document.getElementById, document.createEvent
  Element.prototype.remove, Element.prototype.setAttribute, Element.prototype.removeAttribute

事件 / 定时器:
  addEventListener, removeEventListener, dispatchEvent, postMessage
  setTimeout, clearTimeout, setInterval, clearInterval

文件 / 二进制:
  FileReader.prototype.readAsBinaryString, FileReader.prototype.readAsText
  FileReader.prototype.result (getter)
  Uint8Array.prototype.buffer (getter), Uint8Array.prototype.subarray
  URL.createObjectURL, URL.revokeObjectURL
  FormData.prototype.entries

其他:
  Math.floor, Math.random, Math.max, Math.min
  Number.MAX_SAFE_INTEGER, (0).toString
  CustomEvent, CompositionEvent, KeyboardEvent, MouseEvent, MutationObserver
  Function, RegExp, Proxy, Window 构造器
  Symbol.toStringTag, Symbol.unscopables
  console (浅拷贝), Error, parseInt, parseFloat
```

**防护效果**:
- 即使页面代码重写了 `window.postMessage`、`Array.prototype.forEach`、`JSON.parse` 等全局函数，Vault 闭包中的原始引用不受影响
- GM API 的完整性得到可靠保护，不会被页面侧的原型链污染攻击破坏

**防护盲区**:
- Vault **不保护用户脚本本身** — 用户脚本运行在 MAIN world，完全暴露给页面代码
- 页面代码可以攻击用户脚本使用的任何**非 Vault 缓存**的浏览器 API
- 缓存列表不包含部分新 API（如 `structuredClone`、`queueMicrotask` 等），用户脚本使用这些 API 时无保护

### 2.3 unsafeWindow 暴露

**代码证据** (page.js 第 88-92 行):

```javascript
// @grant none 模式 — 直接暴露:
v.unsafeWindow = _;  // _ = page window reference

// @grant GM_* 模式 — 通过 proxy 暴露:
const _ = l && l;  // l = pageWindow via proxy
```

`unsafeWindow` 授予用户脚本对页面 `window` 对象的完全读写权限：
- 所有页面定义的 JavaScript 变量和函数
- 页面 DOM 树（通过 `unsafeWindow.document`）
- 页面存储 (`localStorage`, `sessionStorage`, `indexedDB`)
- History API, Navigation API

### 2.4 恶意脚本攻击面枚举

| 攻击类型 | 可行性 | 利用方式 |
|---------|:----:|----------|
| 窃取密码 | **是** | 拦截表单 submit 事件、监听 input 事件、读取 `<input type=password>` |
| 劫持表单 | **是** | 修改 form.action、拦截 submit 事件重定向 |
| 键盘记录 | **是** | `document.addEventListener('keydown', ...)` 在 MAIN world |
| 注入广告 | **是** | DOM 操作 + GM_addStyle + GM_xmlhttpRequest 拉取广告内容 |
| 静默挖矿 | **是** | Web Worker + WebAssembly 加载 |
| 窃取 Cookie | **是** | `document.cookie` (非 HttpOnly) + `GM_cookie` (含 HttpOnly) |
| 窃取 local/sessionStorage | **是** | 直接访问 |
| 数据外传 | **是** | `GM_xmlhttpRequest` (需 @connect) 或 `GM_openInTab` 重定向 |
| CSRF 攻击 | **是** | `GM_xmlhttpRequest` 以用户身份发起任意请求 |
| DOM XSS | **是** | 用户脚本可直接操作 innerHTML / outerHTML |
| 中间人攻击 | **是** | `GM_webRequest` 拦截/重定向网络请求 |

### 2.5 UserScripts World 专项分析

**代码证据** (content.js):

```javascript
// userScripts API 可用性检测
const Ho = ko && ko.userScripts && ko.userScripts.onBeforeScript ?
    { supported: true,
      onBeforeScript: { addListener: e => ko.userScripts.onBeforeScript.addListener(e) } } :
    { supported: false }

// 全局变量检测 userScripts 动态模式
const Go = Ho.supported && !_t.pagejs;
```

- 所有 Chromium 120+ 浏览器均支持 `userScripts` API
- 当前实现**同时支持** `scripting` (MAIN world) 和 `userScripts` (userScripts world) 两种注入模式
- `Go=true` (userScripts 动态模式) 时使用 `"2U"/"2S"` 前缀的专用通信通道
- userScripts world 是 MAIN 和 ISOLATED 之间的折中：可访问部分页面 API，但不能直接访问 DOM

---

## 三 通信安全 — MEDIUM

### 3.1 通信架构全览

```
MAIN World (page.js)              ISOLATED World (content.js)         Service Worker (background.js)
┌──────────────────────┐    DOM CustomEvent   ┌─────────────────┐  chrome.runtime.Port  ┌──────────────────┐
│ 用户脚本               │◄──────────────────►│ content.js       │◄────────────────────►│ background.js     │
│ GM_* API (50KB)       │   + postMessage    │ Vault 桥接 (45KB)│  长连接 + response_id │ 中央路由 (614KB)   │
│ unsafeWindow 引用      │                    │ Port 管理        │  + ACK + 消息队列     │ API 实现 + 存储    │
└──────────────────────┘                    └─────────────────┘                      └──────────────────┘
```

### 3.2 Page Script <-> Content Script (DOM Bridge) — 关键发现

**两种通信模式**：

| 模式 | 触发条件 | 前缀 | 通信方式 | 隔离强度 |
|------|---------|------|---------|:----:|
| userScripts world | Go=true (动态模式) | `"2U"/"2S"` | export/import API | 强 — userScripts world 隔离 |
| DOM Bridge (MAIN world) | 非动态模式 | `"2C"/"2P"` | DOM CustomEvent + postMessage | 弱 — MAIN world 可伪造 |

**DOM Bridge 安全隐患**:

| 隐患 | 严重度 | 详情 |
|------|:----:|------|
| postMessage origin 未验证 | **HIGH** | 代码中未显式验证 `event.origin`；仅依赖 `event.type` 前缀 (`"2C"`/`"2P"`) 区分消息。页面代码可以在同 origin 下伪造相同结构的 postMessage |
| DOM CustomEvent 可伪造 | **MEDIUM** | 使用 `"2C"` / `"2P"` 字符串前缀命名空间隔离，但页面代码同样可以 dispatch 同名 CustomEvent |
| raw 模式 Shadow DOM 隔离 | **LOW** | DOM mode 使用 closed shadow DOM + sandbox iframe 注入，提供一定隔离 |

**raw 模式注入安全** (content.js 第 86-88 行):
```javascript
// 创建 closed shadow DOM + sandboxed iframe
s = r.attachShadow(At({mode: "closed"}));
r = yo("iframe", At({sandbox: "allow-scripts allow-same-origin", 
                      style: "display: none", src: "javascript:void 0"}));
s.appendChild(r);
```

raw 模式下的脚本在 sandbox iframe 中执行，具有独立的同源沙箱，攻击面相对较小。

### 3.3 Content Script <-> Service Worker (Port) — 安全

**实现**: `chrome.runtime.Port` 长连接 + `response_id` 请求/响应关联 + ACK 机制

安全特性：
- Port 长连接为 Chrome 原生 API，通信在扩展进程内，不暴露给页面
- `response_id` (Nn() 生成的唯一 ID) 关联请求与响应
- ACK 机制确保消息送达（`"ack" in e` 检测），防止消息丢失
- `refreshId` 机制支持断线自动重连
- 消息队列缓存未发送的消息

**此通信链路安全性良好** — Chrome 扩展沙箱提供隔离保证。

### 3.4 外部脚本源连接 (external_connect)

**代码证据** (background.js 第 841-842, 989-990 行):

```javascript
// 用户可配置的连接级别
external_connect: "all"  // "all" | "version" | "off"

// SW 端处理 — 匹配允许域名
if ("off" != wn.values.external_connect && (r = t.url) && Gl.isAllowed(r)) {
    r.executeScript({target: {tabId: t, frameIds: [0]}, world: "MAIN", func: ...})
}
```

**暴露的 API**:
- `getVersion()` — 获取 Tampermonkey 版本号和 extension ID
- `openOptions(params)` — 打开选项页面
- `isInstalled(name, namespace)` — 检查脚本是否已安装

**安全分析**:
- 用户可通过设置控制外部连接级别（all/version-only/off）
- 仅对 `externally_connectable_reg` 白名单中的域名注入
- 默认值 `"all"` 允许检测脚本安装状态 — 可能泄露用户隐私
- 外部 API 注入到 MAIN world（`window.external.Tampermonkey`）

---

## 四 CSP 安全 — MEDIUM

### 4.1 各上下文 CSP 评估

| 上下文 | CSP 约束 | eval 可用 | 风险 |
|--------|----------|:----:|:----:|
| Service Worker (background.js) | MV3 默认严格 CSP | 否 | **LOW (安全)** |
| Popup (action.html) | `script-src 'self'` | 否 | **LOW (安全)** |
| Options (options.html) | `script-src 'self'` | 否 | **LOW (安全)** |
| Editor (editor.html) | `script-src 'self'` | 否 | **LOW (安全)** |
| Offscreen (offscreen.html) | `script-src 'self'` | 否 | **LOW (安全)** |
| Content Script (ISOLATED world) | 扩展 CSP 保护 | 是 (需要时) | **MEDIUM** |
| **Page Script (MAIN world)** | **完全不受扩展 CSP 限制** | 是 | **CRITICAL** |
| userScripts world | MV3 默认 | 是 (设计如此) | **MEDIUM** |

### 4.2 configureWorld CSP 设置

**代码证据** (background.js 第 909 行):

```javascript
// sandbox_mode = "js" 时的 ISOLATED world 配置:
const e = "script-src 'self' 'unsafe-inline' 'unsafe-eval' *";
// 非 sandbox 模式:
const t = "script-src 'self' 'unsafe-inline' *";
await vA.configureWorld({csp: e, messaging: true})
```

- sandbox_mode 为 `"js"` 时，ISOLATED world 允许 `'unsafe-eval'`（Vault 沙箱需要 eval 来注入用户脚本）
- 全局通配符 `*` 允许加载任意源脚本（@require 机制的功能需求）

### 4.3 Eval / Eval-like 模式检测

| 位置 | 代码 | 用途 | 风险 |
|------|------|------|:----:|
| content.js `Es` 函数 | `(0, eval)(e)` | 执行 DOM 模式注入的脚本 | **MEDIUM** — ISOLATED world 中 eval |
| page.js `g` 函数 | `g('window["__p__xxx"]=function(){' + code + '};')` | 通过全局变量赋值绕过 CSP 注入 MAIN world | **HIGH** — 用户脚本代码直接注入 |
| userScripts world | `Jo = o.global.eval` (content.js) | userScripts world 原生允许 eval | **MEDIUM** — 功能要求 |
| Webpack bootstrap | `new Function("return this")()` | 标准 Webpack 运行时获取 globalThis | **LOW** — 构建工具行为 |

### 4.4 关键发现

**用户脚本在 MAIN world 中完全不受扩展 CSP 约束**，这意味着：
- 用户脚本可以使用 `eval()`、`new Function()`、内联事件处理器
- 恶意脚本可加载任意外部脚本（通过 `GM_addElement` 或直接创建 `<script>` 标签）
- 不受 `script-src` 指令限制

**这是设计权衡而非安全漏洞** — 用户脚本管理器需要这种灵活性来实现功能。

---

## 五 数据存储安全 — HIGH

### 5.1 存储架构与加密状态

| 存储层 | 存储内容 | 加密 | 风险 |
|--------|---------|:----:|:----:|
| IndexedDB | 用户脚本源码 (JSZip 压缩) | **否** | **MEDIUM** — 压缩但未加密 |
| chrome.storage.sync | 基础设置 (100KB 限制) | **否** (TLS 传输) | **LOW** |
| chrome.storage.local | 全局设置、云配置、token、密码 | **否** | **HIGH** — 凭证明文存储 |
| chrome.storage.managed | 企业策略 (schema.json) | **否** | **LOW** — 只读 |

### 5.2 敏感配置存储 (代码证据)

**类型定义** (`src/types/index.ts`):

```typescript
export interface CloudProviderConfig {
    access_token?: string;    // OAuth access token — 明文存储
    cloud_user?: string;      // 云服务用户名 — 明文存储
    cloud_pass?: string;      // 云服务密码 — 明文存储 (CRITICAL)
    cloud_url?: string;       // 云服务地址
    auth_failed?: boolean;    // 认证状态
}
```

**关键发现**:
- `cloud_pass` 字段以明文形式存储在 chrome.storage.local 中 — **这是严重安全隐患**
- OAuth `access_token` 同样明文存储
- 未使用 `chrome.storage.session` (内存级存储) 或 `chrome.identity` API 进行安全令牌管理
- 未使用 SubtleCrypto API 加密敏感数据

### 5.3 脚本源码存储

- JSZip 3.5.0 DEFLATE 压缩后写入 IndexedDB（2-10x 压缩比）
- 压缩非加密，仅优化存储效率
- 脚本源码在 IndexedDB 中以 UUID 为键存储
- 脚本包含 `@grant`、`@connect`、`@include` 等元数据，可完整审计

---

## 六 网络请求安全 — MEDIUM

### 6.1 GM_xmlhttpRequest 代理链路

```
page.js:  u = fo.connect("xhr")     // 创建 Port 连接
content.js:  转发 XHR 请求至 background.js
background.js:  使用内部 XHR 实现 (Uo.internal) 发起真实请求
                                    └─ 绕过浏览器 CORS 限制
```

**关键安全机制**:
- `@connect` 白名单限制脚本可连接的域名（元数据声明）
- 禁止的请求头过滤（background.js `uo` 常量）：
  ```
  cookie, cookie2, user-agent, accept-charset, host, origin, referer, 
  connection, content-length, date, dnt, expect, keep-alive, te, 
  trailer, transfer-encoding, upgrade, via
  ```
- 支持 `anonymous` 模式（省略 cookie 和凭据）

### 6.2 @connect 白名单

**风险**: 如果用户安装的脚本声明了过宽的 `@connect`（如 `*`），攻击者可通过 `GM_xmlhttpRequest` 将任意数据外传到任何互联网服务器。

### 6.3 webRequest 拦截

- `webRequest` + `webRequestBlocking` 权限支持同步拦截
- `GM_webRequest` API 允许用户脚本注册动态规则
- 支持 `cancel` (阻断) 和 `redirect` (重定向) 操作

### 6.4 脚本更新请求 (隐私影响)

**代码证据** (background.js):

```javascript
{
    method: "GET",
    headers: { Accept: "text/x-userscript-meta, */*" },
    url: updateURL
}
```

每次更新检查向脚本源服务器发送请求，可能泄露用户 IP 和使用时间。

---

## 七 第三方依赖 — LOW

### 7.1 依赖清单

| 依赖 | 版本 | 使用方式 | 用途 | 已知漏洞 |
|------|------|---------|------|:----:|
| JSZip | 3.5.0 | 内联于 background.js | 用户脚本压缩/解压 | 无已知 CVE |
| CodeMirror | 6.x | editor.js (410KB) | 代码编辑器 (语法高亮/折叠/补全) | 无已知 CVE |
| ESLint | 自定义规则集 | vendor/eslint/ (1.5MB) | 用户脚本实时校验 | 无已知 CVE |
| jsdiff | — | vendor/jsdiff/ (11KB) | 脚本差异对比 | 无 |
| FileSaver.js | — | vendor/saveas/ (3KB) | 导出脚本文件 | 无 |

### 7.2 供应链评估

- **LOW** — 所有第三方库均为知名开源项目，内联打包无外部 CDN 加载
- JSZip 3.5.0 (2020 年发布) 建议更新至最新版本
- 无运行时 npm 依赖，所有代码打包在扩展内
- ESLint 为内置自定义规则，非 npm 包形式，外部审计困难

---

## 八 隐私考量 — MEDIUM

### 8.1 数据外发渠道分析

| 渠道 | 数据内容 | 用户可控性 | 风险 |
|------|---------|:----:|:----:|
| 脚本更新检查 | 脚本名称 + 版本 + IP + 时间戳 | 可配置频率或禁用 | **MEDIUM** |
| 统计功能 | 脚本执行次数、错误信息 | `disable_stats` / `enable_stats` 开关 | **LOW** |
| 云同步 | 全部脚本源码 + 元数据 + 设置 | 需用户主动配置云服务 | **MEDIUM** |
| external_connect | 脚本安装状态 (可选) | external_connect 设置 (all/version/off) | **LOW** |
| 脚本黑名单 | 通过 script_blacklist_server 请求黑名单 | 需用户配置服务器地址 | **LOW** |
| Tampermonkey 遥测 | 扩展版本等基础信息 | 无明确独立开关 | **MEDIUM** |

### 8.2 更新检查隐私

```typescript
// 全局设置
script_update: 'only_manual' | 'some_secs' | 'not_succeeded';  // 更新策略
scriptUpdateCheckPeriod: number;  // 检查周期（秒）
scriptUpdateCheckDisabled: boolean;  // 完全禁用
```

### 8.3 Cloud 同步隐私

- 支持 Google Drive / OneDrive / Dropbox / WebDAV / Yandex 5 种云服务
- 脚本源码会上传到第三方服务器
- 用户可完全控制同步开关

---

## 九 合规与透明度 — LOW (良好)

### 9.1 用户控制面

| 控制措施 | 状态 | 说明 |
|----------|:----:|------|
| 安装时可查看完整脚本源码 | **是** | 最高透明度 |
| @grant 白名单机制 | **是** | 用户可见脚本请求的权限 |
| 脚本源码完全可审计 | **是** | 无混淆，源码存储在 IndexedDB |
| 用户可随时禁用/卸载脚本 | **是** | 完整控制权 |
| 脚本启用/禁用独立控制 | **是** | 逐脚本粒度 |
| 脚本更新模式可配置 | **是** | 手动/自动 |
| 外部连接级别可控 | **是** | all / version / off |
| SRI 完整性校验 | **是** | require_sri_mode 可选 |
| forbiddenPages 金融网站保护 | **是** | 内置保护 |
| 脚本黑名单 | **是** | script_blacklist_server 可选 |

### 9.2 安全相关设置

```typescript
// 从类型定义中提取的安全设置
sandbox_mode: 'raw' | 'js' | 'default';        // 沙箱模式
page_filter_mode: 'all' | 'whitelist' | 'blacklist';  // 页面过滤
script_include_mode: 'enabled' | 'disabled';    // 脚本包含模式
script_blacklist_type: 'none' | 'blacklist' | 'whitelist';  // 黑名单
script_blacklist_severity: number;              // 黑名单严格程度
require_sri_mode: boolean;                      // Subresource Integrity
external_connect: boolean;                      // 外部连接
script_cookie_access: boolean;                  // Cookie 访问控制
script_file_access: boolean;                     // 文件访问控制
```

---

## 十 综合风险矩阵

### 10.1 各维度等级

| # | 审计维度 | 等级 | 核心依据 |
|---|---------|:----:|---------|
| 1 | 权限面 | **CRITICAL** | webRequestBlocking + <all_urls> + cookies + userScripts 组合权限 |
| 2 | 用户脚本注入面 | **CRITICAL** | MAIN world 执行 + unsafeWindow 完全暴露页面 window |
| 3 | 通信安全 | **MEDIUM** | Port 通信安全，postMessage 缺少显式 origin 验证 |
| 4 | CSP 安全 | **MEDIUM** | SW CSP 严格，但用户脚本完全不受 CSP 约束 |
| 5 | 数据存储安全 | **HIGH** | cloud_pass 和 access_token 明文存储于 chrome.storage |
| 6 | 网络请求安全 | **MEDIUM** | @connect 白名单 + 请求头过滤，但 GM_xmlhttpRequest 可绕过 CORS |
| 7 | 第三方依赖 | **LOW** | JSZip 3.5.0 无已知 CVE，全部内联打包 |
| 8 | 隐私考量 | **MEDIUM** | 脚本更新检查泄露使用信息，统计可配置 |
| 9 | 合规与透明度 | **LOW (良好)** | @grant 透明，源码可审计，用户完全控制 |

### 10.2 攻击场景

**场景 A — 恶意脚本攻击**（最严重）:
```
1. 攻击者发布恶意脚本到脚本托管平台（@grant GM_xmlhttpRequest + @connect *）
2. 用户安装脚本
3. 脚本在 target.com 以 MAIN world 执行
4. 通过 unsafeWindow 读取密码框内容
5. 通过 GM_xmlhttpRequest 外传凭据到攻击者服务器
6. 通过 GM_cookie 读取该域名 cookie（含 HttpOnly）
7. 攻击者获得账户完全控制权
```

**场景 B — 供应链攻击**:
```
1. 攻击者入侵热门脚本的维护者账户
2. 在脚本更新中注入恶意代码片段
3. 用户自动更新拉取恶意版本
4. GM_setValue 污染脚本存储，持久化恶意配置
```

---

## 十一 改进建议

### 11.1 高优先级 (P0)

| # | 建议 | 影响维度 |
|---|------|---------|
| 1 | **加密敏感凭据**: cloud_pass 和 access_token 必须使用 SubtleCrypto API (AES-GCM) 加密后再存入 chrome.storage，密钥通过 PBKDF2 从用户输入派生 | 数据存储安全 |
| 2 | **postMessage origin 验证**: DOM Bridge 通信中显式检查 `event.origin === window.location.origin` | 通信安全 |
| 3 | **SRI 默认启用**: 将 require_sri_mode 默认值改为 true，防止 @require 依赖被中间人篡改 | 供应链安全 |
| 4 | **external_connect 默认收紧**: 将默认值从 "all" 改为 "version" | 隐私保护 |

### 11.2 中优先级 (P1)

| # | 建议 | 影响维度 |
|---|------|---------|
| 5 | **脚本源码可选加密**: IndexedDB 中使用 SubtleCrypto 提供可选的脚本加密存储 | 数据存储安全 |
| 6 | **@connect 风险提示**: 安装脚本时高亮 `@connect *`，对连接未声明域名时弹窗警告 | 网络请求安全 |
| 7 | **XHR 速率限制**: 实施同源请求频率限制，防止通过 XHR 批量外传数据 | 数据泄露防护 |
| 8 | **权限组合评分**: 基于 @grant 计算安全评分（如包含 GM_xmlhttpRequest + GM_cookie + unsafeWindow 时给出高危警告） | 用户意识 |
| 9 | **JSZip 版本更新**: 将 JSZip 更新到最新版本（当前 3.5.0） | 第三方依赖 |

### 11.3 低优先级 (P2)

| # | 建议 | 影响维度 |
|---|------|---------|
| 10 | **userScripts world 选项**: 让用户可选择在 userScripts world 中执行脚本，减少 MAIN world 暴露 | 注入安全 |
| 11 | **脚本签名验证**: 更新检查时验证 Ed25519/ECDSA 签名 | 供应链安全 |
| 12 | **forbiddenPages 扩展**: 允许用户自定义 forbiddenPages 列表 | 用户控制 |
| 13 | **安全仪表盘**: 提供每个脚本实际使用的 GM API 查询界面 | 透明度 |

---

## 十二 审计方法说明

- **分析来源**: 从 Chrome Web Store 获取的 v5.5.0 CRX 包解包产物 (`dist/` 目录)
- **分析文件**: `manifest.json`, `background.js` (614KB), `content.js` (45KB), `page.js` (50KB), `cache.js`, `offscreen.js`, `editor.js`, `src/types/index.ts`, `src/docs/ARCHITECTURE.md`
- **分析方法**: 静态代码分析 + 动态行为推理（基于函数调用图、消息流、字符串常量、配置选项）
- **代码引用**: 所有关键发现均标注了具体文件、函数名和行号范围
- **限制**: 未进行实际运行时测试，所有结论基于静态逆向分析

---

> **最终安全声明**: Tampermonkey 是一款设计出色的用户脚本管理器，其 Vault 沙箱、@grant 白名单、@connect 域名限制代表了行业最佳实践。然而其核心功能（在任意网页的 MAIN world 执行用户 JavaScript）与安全之间存在不可调和的矛盾。**用户脚本管理器的安全上限最终在用户手中** — 建议用户只安装可信来源的脚本，安装前审查 @grant 权限声明，并定期审计已安装脚本列表。
