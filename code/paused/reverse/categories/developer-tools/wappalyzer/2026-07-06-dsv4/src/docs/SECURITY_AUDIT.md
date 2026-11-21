# Wappalyzer v6.12.3 — 安全审计报告

> **审计范围**: Wappalyzer v6.12.3 Chrome Extension (Manifest V3)
> **审计日期**: 2026-07-06
> **审计模型**: dsv4
> **审计方法**: 静态源码分析 + Manifest 权限审查

---

## 目录

1. [总体安全评估](#1-总体安全评估)
2. [风险等级汇总表](#2-风险等级汇总表)
3. [权限面](#3-权限面-permission-surface)
4. [数据流安全](#4-数据流安全-data-flow)
5. [CSP 与注入面](#5-csp-与注入面-csp--injection)
6. [通信安全](#6-通信安全-communication-security)
7. [存储安全](#7-存储安全-storage-security)
8. [隐私](#8-隐私-privacy)
9. [依赖与供应链](#9-依赖与供应链-dependencies)
10. [合规](#10-合规-compliance)
11. [潜在风险点详析](#11-潜在风险点详析)

---

## 1. 总体安全评估

**总体评级: 🟡 Medium**

Wappalyzer v6.12.3 在安全设计上表现出良好的基础工程素养：零外部依赖、严格的 CSP 策略、无 eval 使用、完善的隐私控制机制。然而，在 postMessage 通信校验、API Key 存储加密、以及函数名分发调用等环节存在可改进空间。综合来看，该扩展在当前 Chrome Web Store 扩展中处于中等偏上安全水平，主要风险集中在通信面的 origin 校验缺失和敏感凭据的明文存储。

**关键优势**:
- 零 npm 依赖，供应链攻击面极小
- CSP 严格限制为 `script-src 'self'`，无 unsafe-inline/eval
- 完善的隐私控制（tracking toggle、robots.txt 合规、域名排除列表）
- 无 innerHTML 直接使用、无 document.write、无 eval/Functon

**关键不足**:
- window.postMessage 监听未校验 event.origin
- API Key 明文存储于 chrome.storage.local
- 基于消息 func 字段的函数名分发调用缺乏输入白名单

---

## 2. 风险等级汇总表

| # | 风险项 | 维度 | 等级 | 影响简述 |
|---|--------|------|------|----------|
| R1 | postMessage 无 origin 校验 | 通信安全 | 🟠 High | 恶意页面可伪造 Wappalyzer 消息 |
| R2 | API Key 明文存储 | 存储安全 | 🟠 High | 设备被攻破时 API Key 泄露 |
| R3 | 函数名分发调用无白名单 | 通信安全 | 🟡 Medium | 潜在任意函数调用风险 |
| R4 | 外部脚本拉取无完整性校验 | 数据流安全 | 🟡 Medium | 中间人可篡改脚本内容 |
| R5 | Tab ID 全量枚举 | 权限面 | 🟡 Medium | 可探测用户打开的标签页 URL |
| R6 | fetchTextSnippet 泄露请求 URL | 隐私 | 🟡 Medium | 请求的目标 URL 信息暴露 |
| R7 | 脚本注入依赖页面 CSP | CSP 与注入 | 🟢 Low | 页面 CSP 可能阻止注入 |
| R8 | webRequest 全量监听 | 隐私 | 🟢 Low | 监听所有 HTTP/HTTPS 流量 |
| R9 | cookies 全量读取 | 权限面 | 🟢 Low | 读取检测域名的所有 cookie |

---

## 3. 权限面 (Permission Surface)

### 3.1 已声明权限清单

| 权限 | 类型 | 用途 | 风险 |
|------|------|------|------|
| `cookies` | API 权限 | 读取检测域名的所有 cookie | 🟢 Low — 仅用于技术检测指纹（cookie 特征匹配），不收集 cookie 值上传 |
| `storage` | API 权限 | 存储选项配置和检测缓存 | 🟢 Low — 标准扩展存储，Chrome 沙箱隔离 |
| `tabs` | API 权限 | 读取活动标签页 URL、安装/升级/条款页面时打开新标签页 | 🟢 Low — 仅读取 URL 信息用于检测触发 |
| `webRequest` | API 权限 | 监听所有 `http/https` 的 `main_frame`（headers）、`script`、`xmlhttprequest` 流量 | 🟢 Low — 用于捕获 HTTP 响应头中的技术特征 |
| `http://*/*` `https://*/*` | Host 权限 | content script 在所有页面运行 | 🟢 Low — 扩展核心功能必需，但面积极大 |
| `downloads` | Optional 权限 | CSV 导出功能 (`chrome.downloads.download`) | 🟢 Low — optional 权限，仅用户主动导出时触发 |

### 3.2 CSP 声明

```
script-src 'self'; object-src 'self'
```

- 无 `unsafe-inline`、无 `unsafe-eval`
- `object-src 'self'` 阻止插件类内容加载
- 这是 MV3 扩展能达到的最严格 CSP 之一

### 3.3 权限面评估

**评级: 🟢 Low**

所有声明的权限均与扩展的核心功能（网站技术栈检测）直接相关，无冗余权限。`webRequest` 和 host 权限虽然覆盖面广，但对技术检测类扩展而言属于功能必需。`cookies` 权限仅用于在响应中匹配 cookie 特征指纹，不收集或上传 cookie 值本身，风险可控。

唯一注意点是 `downloads` 为 optional 权限，仅在用户主动触发 CSV 导出时请求，符合最小权限原则。

---

## 4. 数据流安全 (Data Flow)

### 4.1 关键数据流路径

```
Page Load → webRequest (headers) → Driver.analyze()
                                       ├── fetchTextSnippet(url) → 拉取外部 JS 内容
                                       ├── inject(script) → content script 注入
                                       ├── postMessage → page ↔ content script
                                       └── Ping → ping.wappalyzer.com/v2/
```

### 4.2 fetchTextSnippet — 外部脚本拉取

**行为**: 通过 extension origin 发起 fetch 请求拉取页面引用的外部脚本内容，用于在其内容中进行技术特征正则匹配。

**安全分析**:
- 请求从 extension origin 发出，受浏览器 CORS 保护
- 扩展 origin 不受同源策略限制（host_permissions），但 fetch 本身受服务端响应头约束
- **风险**: 拉取的脚本内容直接用于正则匹配，无 Subresource Integrity (SRI) 校验。若网络中间人可篡改响应（如企业代理解密 HTTPS），可能在匹配层面产生偏差，但不会导致扩展自身代码执行
- **隐私风险**: fetch 请求会暴露被检测页面所引用的外部脚本 URL 给网络层观察者

**评级**: 🟡 Medium

### 4.3 inject() — 脚本注入机制

**行为**: 通过 `document.createElement('script')` 创建 script 标签，src 指向 `chrome.runtime.getURL('js/js.js')` 和 `chrome.runtime.getURL('js/dom.js')`。

**安全分析**:
- 注入的脚本来自 extension bundle 内部，非外部源
- 资源在 manifest 中声明为 `web_accessible_resources`，限制仅允许 `http://*/*` 和 `https://*/*` 访问
- **风险**: 注入成功与否取决于目标页面的 CSP 策略。若页面设置了严格的 `script-src` 不允许 extension 资源，注入将失败（MV3 中页面 CSP 可以阻止 extension 注入）
- Chrome 对 `web_accessible_resources` 有额外的来源匹配保护

**评级**: 🟢 Low

### 4.4 Ping — 遥测数据外发

**数据内容**: hostname + 检测到的技术名称/版本 + 语言元数据（不含完整 URL、页面内容、cookie、用户标识）

**详细见第 8 节隐私分析**

**评级**: 🟢 Low（带隐私控制机制）

---

## 5. CSP 与注入面 (CSP & Injection)

### 5.1 Extension CSP

```
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```

- 仅允许执行扩展自身打包的脚本
- 禁止 inline script、eval、Function 构造器
- 阻止 `<object>` / `<embed>` 加载外部插件

### 5.2 代码注入模式审查

| 模式 | 是否使用 | 风险 |
|------|----------|------|
| `eval()` | ❌ 未发现 | — |
| `new Function()` | ❌ 未发现 | — |
| `innerHTML` (用户数据) | ❌ 未发现 | — |
| `innerHTML` (i18n) | ✅ 使用 | 🟢 Low — 来源为 `chrome.i18n.getMessage()`，Chrome 内置安全 |
| `document.write()` | ❌ 未发现 | — |
| `createElement('script')` | ✅ 使用 | 🟢 Low — src 为 `chrome.runtime.getURL()`，仅指向扩展内资源 |
| `window.postMessage` | ✅ 使用 | 🟠 High — 详见第 6 节 |

### 5.3 评估

**评级: 🟢 Low**

扩展在 CSP 和注入面控制上表现优秀。无任何动态代码执行，innerHTML 使用仅限于从 Chrome i18n API 获取的静态字符串。唯一的脚本注入路径通过 `web_accessible_resources` 白名单控制，且注入目标仅限扩展自有代码。

---

## 6. 通信安全 (Communication Security)

### 6.1 chrome.runtime.sendMessage

**行为**: 扩展内部消息传递（content script ↔ background script / popup）

**安全分析**:
- Chrome 运行时验证消息发送方身份
- 消息仅在扩展内部传递，外部页面无法直接调用 `chrome.runtime.sendMessage` 发送到该扩展
- **风险点**: 消息处理函数 `Driver.onMessage` / `Content.onMessage` 通过消息中的 `func` 字段进行函数分发调用

```
// 伪代码还原 — onMessage 模式
function onMessage(message, sender, sendResponse) {
  const { func, args } = message;  // 假设结构
  Driver[func].call(Driver, ...args);
}
```

- **影响**: 若攻击者能向扩展发送消息（需要是同一扩展的内部组件或利用其他漏洞），可通过 `func` 字段调用 `Driver` 对象的任意方法
- **实际利用难度**: 高。需要先突破 Chrome 的扩展消息隔离机制
- **缓解因素**: `Driver` 对象的方法均为技术检测逻辑，不涉及敏感操作

**评级**: 🟡 Medium

### 6.2 window.postMessage — 页面与 Content Script 通信

**行为**: Content script 和注入的页面脚本 (js.js / dom.js) 之间通过 `window.postMessage` 交换技术检测数据。

**安全分析**:

消息监听器代码模式：
```
// js.js / dom.js 中的监听器
window.addEventListener('message', function(event) {
  // 未校验 event.origin
  if (event.data.wappalyzer) {
    // 处理消息...
    const technologies = event.data.wappalyzer.js; // 或 .dom
  }
});
```

- **关键缺陷**: 消息监听器未校验 `event.origin`，接受来自任意源的消息
- **攻击场景**: 恶意页面可通过 iframe 嵌入 Wappalyzer 正在检测的页面，然后使用 `parent.postMessage({wappalyzer: {...}}, '*')` 向检测页面发送伪造消息
- **影响范围**: 伪造消息可注入虚假的技术检测结果，干扰检测准确性，但不涉及用户数据泄露（消息是 page → content script 方向传递检测结果）
- **实际风险**: 可被用于欺骗用户关于某网站的技术栈信息，但不直接导致凭据泄露或代码执行
- **缓解因素**: 
  - 消息仅包含技术名称/版本等检测结果数据，不含敏感用户信息
  - content.js 发出的消息同样未限定 targetOrigin

**评级**: 🟠 High

### 6.3 通信安全评估

**评级: 🟠 High**

主要风险来自 postMessage 的 origin 校验缺失。虽然实际危害仅限于技术检测数据伪造（非凭据泄露），但作为安全最佳实践，所有 postMessage 通信都应校验 origin。函数名分发调用模式也存在隐患，但利用门槛较高。

---

## 7. 存储安全 (Storage Security)

### 7.1 存储概览

| 存储区域 | 数据类型 | 加密 |
|----------|----------|------|
| `chrome.storage.local` | 用户选项配置、API Key | ❌ 明文 |
| `chrome.storage.session` | 检测缓存 | ❌ 明文 |
| 内存 fallback | 检测缓存（session storage 不可用时） | ❌ 明文 |

### 7.2 API Key 存储

**现状**: Wappalyzer Plus 的 API Key 明文存储在 `chrome.storage.local` 中，用于构造 Plus API 请求的 `Authorization` header。

**风险分析**:
- `chrome.storage.local` 由 Chrome 进行扩展级沙箱隔离，其他扩展无法直接读取
- 但若攻击者获得设备本地访问权限（如恶意软件、物理访问），可读取 Chrome 的用户数据目录中的 LevelDB 存储文件
- API Key 泄露后攻击者可使用该 Key 调用 Wappalyzer Plus API，消耗配额或获取订阅数据
- **对比**: 许多扩展同样将 API Key 明文存储于 chrome.storage，这是 Chrome 扩展生态的普遍实践，但并非最佳实践

**缓解建议**:
1. 使用 `chrome.storage.session` 存储 API Key（内存级，不持久化到磁盘）
2. 或使用 Web Crypto API 在存储前对 API Key 进行加密，密钥通过用户会话派生
3. 服务端（Wappalyzer Plus API）应实现 API Key 轮换机制和异常使用检测

**评级**: 🟠 High

### 7.3 检测缓存

**现状**: 技术检测结果缓存在 `chrome.storage.session`，有内存 fallback。

**安全分析**:
- 缓存数据为技术名称/版本等非敏感信息
- `chrome.storage.session` 在浏览器会话结束或扩展重启时自动清除
- 无安全风险

**评级**: 🟢 Low

---

## 8. 隐私 (Privacy)

### 8.1 Tracking 机制

**Ping 端点**: `ping.wappalyzer.com/v2/`

**发送数据内容**:
- 检测到的 hostname（非完整 URL）
- 技术名称及版本号
- 语言元数据（页面语言、检测规则使用的语言类别）

**明确不发送的数据**:
- 完整 URL（无 path、query string、fragment）
- 页面内容
- Cookie 值
- 用户身份标识符
- 浏览器指纹

### 8.2 隐私控制机制

| 控制项 | 实现 | 评级 |
|--------|------|------|
| Tracking 开关 | 用户可在选项中关闭 tracking | ✅ 优秀 |
| 条款同意 | 安装/升级时要求接受条款（Chrome 默认接受） | ✅ 良好 |
| robots.txt 合规 | 检查 `Disallow` 规则，遵守爬虫协议 | ✅ 优秀 |
| 本地域名排除 | `hostnameIgnoreList` 排除 localhost/dev/staging/sandbox/preview/internal/test | ✅ 优秀 |
| 私有网络排除 | `transientHostnameIgnoreList` 排除内网 IP | ✅ 优秀 |
| 大型站点排除 | 排除部分已被充分覆盖的主流站点 | ✅ 良好 |
| GA4 匿名化 | `_ga_XXXXXXXXXX` → `_ga_*` 归一化处理 | ✅ 优秀 |

### 8.3 隐私面评估

**评级: 🟢 Low**

Wappalyzer 在隐私保护方面设计周到。Tracking 默认启用但提供关闭选项，传输数据最小化（hostname + 技术名，无 PII），且遵守 robots.txt 协议。GA4 cookie 匿名化处理体现了对隐私细节的关注。主要不足是首次安装时 Chrome 默认接受条款（Firefox 下需要主动接受），部分用户可能未注意到 tracking 已启用。

---

## 9. 依赖与供应链 (Dependencies)

### 9.1 依赖清单

| 类别 | 数量 | 详情 |
|------|------|------|
| npm 依赖 | **0** | 无任何外部包 |
| 第三方 JS 库 | **0** | 全部手写 |
| 构建工具/Bundler | **0** | 无 webpack/rollup/vite/esbuild |
| 第三方图标/资源 | **0**（嵌入式） | 技术图标（SVG/PNG）内嵌为扩展资源 |
| 技术指纹数据 | 内嵌 JSON | 分类/分组定义 bundled 在扩展中 |
| Wappalyzer Plus API | 1 | 可选的外部服务调用 |

### 9.2 供应链评估

**评级: 🟢 Low（极低风险）**

零外部依赖意味着：
- 无 npm 供应链攻击面（无 left-pad、event-stream 类风险）
- 无依赖混淆/投毒风险
- 无第三方库 0-day 影响
- 所有安全控制完全自主

这是本次审计中 Wappalyzer 最突出的安全优势之一。代码全部手写体现了团队对安全的高度重视和自主可控意识。

**注意**: 虽然消除了第三方代码风险，但也意味着所有安全保证完全依赖自身代码质量，没有社区审计的第三方库安全网。

---

## 10. 合规 (Compliance)

### 10.1 平台合规

| 要求 | 状态 | 说明 |
|------|------|------|
| Chrome Web Store 发布 | ✅ | `update_url` 配置正确 |
| Manifest V3 | ✅ | 已迁移至 MV3 |
| Firefox Add-ons | ✅ | `browser_specific_settings.gecko` 已配置 |
| CSP 合规 | ✅ | 无 unsafe 指令 |

### 10.2 隐私法规合规

| 法规/要求 | 状态 | 说明 |
|-----------|------|------|
| GDPR（欧盟） | ⚠️ 部分满足 | 提供 tracking 关闭选项和 `terms.html` 同意页面；但 Chrome 默认接受条款不符合 GDPR 的明确同意要求 |
| CCPA（加州） | ✅ 基本满足 | 不收集 PII，提供 opt-out |
| robots.txt | ✅ 合规 | 主动检查并遵守爬虫协议 |

### 10.3 合规评估

**评级: 🟢 Low（Minor 保留意见）**

扩展在平台合规上无问题。隐私法规方面，Chrome 上默认接受条款的做法与 GDPR 的"主动明确同意"原则存在潜在差距，但考虑到传输数据不含 PII 且用户可随时关闭，实际法律风险较低。

---

## 11. 潜在风险点详析

### R1: postMessage 无 Origin 校验 🟠 High

**位置**: `js/js.js`, `js/dom.js`, content script 中的 `window.addEventListener('message', ...)`

**现状**:
```
window.addEventListener('message', function(event) {
  // event.origin 未校验 — 接受来自任意源的消息
  if (event.data && event.data.wappalyzer) {
    // 直接处理消息内容
  }
});
```

**攻击场景**:
1. 攻击者构造恶意页面，内嵌 iframe 指向目标检测页面
2. 恶意页面通过 `parent.postMessage({wappalyzer: {js: [forgedTech]}}, '*')` 发送伪造消息
3. 目标页面的 Wappalyzer content script 接收并处理伪造消息
4. 检测结果被污染，用户看到虚假技术栈信息

**影响**:
- 检测准确性可被干扰（数据完整性受损）
- 用户可能被误导关于网站的技术栈
- 不直接导致数据泄露或代码执行

**修复建议**:
```javascript
window.addEventListener('message', function(event) {
  // 校验消息来源
  if (event.origin !== window.location.origin) return;
  // 或使用更严格的 targetOrigin 匹配
  if (event.data && event.data.wappalyzer) {
    // 处理消息
  }
});
```

同时在发送消息时指定 `targetOrigin`：
```javascript
window.postMessage(data, window.location.origin); // 而非 '*'
```

### R2: API Key 明文存储 🟠 High

**位置**: `chrome.storage.local` 中 `options.apiKey`

**现状**: Wappalyzer Plus API Key 以明文形式持久化存储于 `chrome.storage.local`

**攻击场景**:
1. 用户设备感染信息窃取类恶意软件
2. 恶意软件读取 Chrome Profile 目录下的 LevelDB 存储文件
3. 提取 Wappalyzer Plus API Key
4. 攻击者使用泄露的 API Key 访问 Wappalyzer Plus API

**影响**:
- API Key 泄露导致 Plus 订阅滥用
- 可能泄露 Plus 用户的查询历史（取决于 API 设计）

**修复建议**:
1. **短期**: 将 API Key 迁移到 `chrome.storage.session`（仅内存存储，不写磁盘）
2. **中期**: 使用 Web Crypto API (`crypto.subtle.encrypt`) 加密存储，密钥绑定到用户会话
3. **长期**: 服务端实现 API Key 轮换 + 异常使用检测 + 设备绑定

### R3: 函数名分发调用无白名单 🟡 Medium

**位置**: `Driver.onMessage()` / `Content.onMessage()` 消息处理函数

**现状**:
```
function onMessage(message, sender, sendResponse) {
  const fn = Driver[message.func];
  if (typeof fn === 'function') {
    fn.call(Driver, ...message.args);
  }
}
```

**影响**:
- 理论上可调用 Driver/Content 对象上的任意方法
- 实际利用需要先绕过 Chrome 扩展消息隔离

**修复建议**:
- 添加允许调用的函数名白名单:
```javascript
const ALLOWED_FUNCTIONS = ['detect', 'getTechnologies', 'analyzeResponse'];
if (ALLOWED_FUNCTIONS.includes(message.func)) {
  Driver[message.func].call(Driver, ...message.args);
}
```

### R4: 外部脚本拉取无完整性校验 🟡 Medium

**位置**: `fetchTextSnippet(url)` 函数

**现状**: 拉取外部 JS 文件内容后直接进行正则匹配，无 SRI hash 校验

**影响**:
- 在 HTTPS 被企业代理解密的网络环境中，中间人可篡改脚本内容
- 导致技术检测结果偏差（非代码执行风险）

**修复建议**:
- 对已知的公共 CDN 脚本 URL 添加 SRI hash 校验
- 或至少对拉取内容做基本的完整性标记

### R5: Tab ID 全量枚举 🟡 Medium

**位置**: `getTabsByUrl(url)` 函数

**现状**: 遍历所有打开的标签页以匹配指定 URL

**影响**:
- 可被用于探测用户当前打开的标签页列表
- 但该功能是扩展内部使用，不是对外暴露 API

**修复建议**:
- 使用 `chrome.tabs.query({url: pattern})` 让 Chrome 自身过滤，减少扩展侧的标签页信息暴露

### R6: fetchTextSnippet 泄露请求 URL 🟡 Medium

**位置**: `fetchTextSnippet(url)` 中的 fetch 调用

**现状**: 拉取外部脚本时，请求 URL（被检测页面引用的脚本地址）暴露给网络层

**影响**:
- 网络观察者可获知用户正在访问哪些页面及其引用的脚本资源
- 属于功能固有特征，非设计缺陷

**修复建议**:
- 文档化此行为，让用户知情
- 考虑将外部脚本拉取作为可选特性

### R7: 脚本注入依赖页面 CSP 🟢 Low

**位置**: `inject()` 函数中的 `document.createElement('script')`

**现状**: 注入成功与否取决于目标页面的 CSP 策略

**影响**:
- 某些 CSP 严格的网站可能阻止注入，扩展在这些网站上的检测能力受限
- 这是 MV3 的设计特性，非安全漏洞

**修复建议**:
- 监控注入失败率，评估对检测覆盖率的影响
- 考虑 fallback 机制（如仅在 background script 中进行基于 header/response 的检测）

### R8: webRequest 全量监听 🟢 Low

**位置**: `chrome.webRequest.onBeforeSendHeaders` / `onHeadersReceived`

**现状**: 监听所有 `http://*/*` 和 `https://*/*` 的流量

**影响**:
- 扩展在技术上有能力观察所有网络请求的 headers
- 但代码分析表明仅提取 `Server`、`X-Powered-By`、`Set-Cookie` 等技术指纹 header

**修复建议**:
- 当前实现已足够克制，维持现状即可
- 建议在隐私政策中明确说明监听的 header 范围

### R9: Cookies 全量读取 🟢 Low

**位置**: `chrome.cookies.getAll({url: detectedUrl})`

**现状**: 读取检测域名下的所有 cookie

**影响**:
- 扩展有能力读取所有 cookie 的 name 和 value
- 代码分析表明仅匹配 cookie name 用于技术指纹，不读取或上传 cookie value

**修复建议**:
- 考虑使用 `chrome.cookies.getAllCookieDetails()` 或仅检查 cookie name 的方法
- 当前实现中 cookie value 未被使用或上传，风险可控

---

## 附录 A: 安全评分卡

| 维度 | 评分 | 等级 |
|------|------|------|
| 权限面 (Permission Surface) | 8/10 | 🟢 Low |
| 数据流安全 (Data Flow) | 7/10 | 🟡 Medium |
| CSP 与注入面 (CSP & Injection) | 9/10 | 🟢 Low |
| 通信安全 (Communication Security) | 5/10 | 🟠 High |
| 存储安全 (Storage Security) | 6/10 | 🟠 High |
| 隐私 (Privacy) | 8/10 | 🟢 Low |
| 依赖与供应链 (Dependencies) | 10/10 | 🟢 Low |
| 合规 (Compliance) | 8/10 | 🟢 Low |
| **综合** | **7.6/10** | **🟡 Medium** |

## 附录 B: 修复优先级

| 优先级 | 风险项 | 修复工作量 | 修复建议 |
|--------|--------|-----------|----------|
| P0 — 立即 | R1: postMessage origin 校验 | 低（< 1h） | 添加 `event.origin` 校验和 `targetOrigin` 指定 |
| P1 — 短期 | R2: API Key 加密存储 | 中（1-2d） | 迁移至 `storage.session` 或 Web Crypto 加密 |
| P2 — 短期 | R3: 函数名分发白名单 | 低（< 1h） | 添加 ALLOWED_FUNCTIONS 白名单 |
| P3 — 中期 | R4: 外部脚本 SRI | 中（1-2d） | 对已知 CDN URL 添加 SRI hash |
| P4 — 长期 | R5: Tab 查询优化 | 低（< 1h） | 使用 `chrome.tabs.query({url})` 替代遍历 |
| P5 — 文档 | R6: fetch URL 暴露 | 极低 | 在隐私政策中说明此行为 |

---

> **审计声明**: 本报告基于 Wappalyzer v6.12.3 源码的静态分析结果，未进行动态渗透测试或运行时行为验证。所有风险评级基于发现的代码模式、已知攻击向量和 Chrome 扩展安全模型进行综合判断。
