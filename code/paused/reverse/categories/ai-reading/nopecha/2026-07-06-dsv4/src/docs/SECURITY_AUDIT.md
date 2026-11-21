# NopeCHA: CAPTCHA Solver v0.6.1 — 安全审计报告

**审计日期**: 2026-07-06
**审计范围**: 完整源码 (12 JS 文件, 1 HTML, 1 CSS, ~725KB)
**威胁模型**: 恶意第三方利用扩展权限窃取用户数据 / API 提供商数据泄露 / 扩展自身被攻破

---

## 1. 权限面评估

| 权限 | 危险等级 | 说明 |
|------|---------|------|
| `debugger` | **严重** | 可完全控制浏览器标签页：读取/修改 DOM、拦截网络、执行任意 JS、捕获输入。仅用于鼠标模拟，但权限过大。 |
| `host_permissions: <all_urls>` | **高** | 可向任意网站注入脚本，读取任意页面的网络请求和 DOM。 |
| `scripting` | **高** | 动态注入脚本到所有 frame（配合 `<all_urls>`），可任意执行代码。 |
| `declarativeNetRequest` | **中** | 可修改任意 HTTP 请求参数，范围限定但影响网络通信。 |
| `storage` | **低** | 仅存用户设置和调度时间戳，无明文凭据（API Key 存在 storage 中是风险点）。 |

### 综合评估

该扩展成功取得了 Chrome 扩展中可能出现的最危险权限组合之一：`debugger` + `<all_urls>` + `scripting`。理论上，这个权限组合允许扩展：
- 读取用户所有网站的 DOM
- 拦截所有网络请求
- 模拟用户输入
- 窃取 cookie、localStorage、表单数据、密码
- 在任意页面执行任意 JavaScript

**当前代码中未发现恶意利用这些权限的证据**，但存在被供应链攻击或扩展更新注入恶意代码的结构性风险。

---

## 2. 数据外传分析

### 2.1 去向汇总

| 目标 | 传输数据 | 频率 | HTTP 方法 |
|------|---------|------|-----------|
| `api.nopecha.com/v1/status` | version, api_key (Basic Auth header) | 每 5 秒 | GET |
| `api.nopecha.com/v1/recognition` | CAPTCHA 图片 base64, sitekey, metadata (含域名) | 每次 CAPTCHA | POST |
| `api.nopecha.com/v1/observability` | 扩展运行遥测数据 (含 key) | ~7.2 小时 | POST |

### 2.2 传输内容的敏感度

| 数据项 | 敏感度 | 风险分析 |
|--------|--------|---------|
| **CAPTCHA 图片 base64** | **高** | 从用户访问的网站中截取，可能含有该网站 UI 元素的截图（背景图片、文本），产生元数据泄露 |
| **sitekey + 域名** | **高** | 暴露用户正在访问的具体网站，构成浏览历史追踪能力 |
| **API Key** | **中** | 通过 HTTP Basic Auth 明文传输（HTTPS 下加密），但在客户端 storage 中是明文存储 |
| **可观测性数据** | **中** | 包含扩展运行统计，meta 字段可能含 key |
| **鼠标行为数据** | **低** | 可视化的鼠标坐标，仅用于渲染 |

### 2.3 加密情况

- 所有 API 通信通过 HTTPS (`https://api.nopecha.com`)
- 消息完整性校验使用 CRC-32（非密码学哈希，仅防传输错误不防篡改）
- **未发现端到端加密**：CAPTCHA 图片以原始 base64 上传
- API Key 使用 HTTP Basic Auth（`Authorization: Basic <base64(key:)>`）

---

## 3. 内容安全策略 (CSP) 评估

- 扩展本身未声明 `content_security_policy` 字段（MV3 默认严格 CSP）
- Popup HTML 无内联 `<script>`，所有 JS 通过外部文件引用
- **无 eval() 调用**：代码中未发现 `eval()` 或 `new Function()`
- 无 `innerHTML` 直接拼接用户输入（Settings Setup 页面有 `innerHTML` 但来源是 URL hash，已做转义处理）

---

## 4. 注入面评估

### 4.1 Content Script 注入

所有 content script 通过 manifest 声明式注册：

| 脚本 | 匹配模式 | 风险 |
|------|---------|------|
| `9jm743.js` | `<all_urls>` | **高** — 注入到每个页面，是攻击面最大的脚本 |
| `vk3s1y.js` | `*.hcaptcha.com/captcha/*` | 中 — 仅限于 hCaptcha 域 |
| `kathhh.js` | `*.google.com/recaptcha/*` | 中 — 仅限于 Google reCAPTCHA |
| `t9kg5l.js` | `*.arkoselabs.com/fc/*` | 中 — 仅限于 Arkose Labs |
| `x2ra3j.js` | `challenges.cloudflare.com/*` | 中 — 仅限于 Cloudflare |
| `t7658k.js` | `*.hcaptcha.com/captcha/*` (MAIN world) | **高** — 在 MAIN 世界运行，绕过隔离 |

### 4.2 `world: "MAIN"` 注入

`t7658k.js` 使用 `"world":"MAIN"` 属性注入 hCaptcha 页面。这意味着：
- 该脚本可以访问页面的 JavaScript 全局变量
- 它可以被页面的其他脚本检测到
- 它修改了 XMLHttpRequest 的原型链（`setRequestHeader` 中修改 Accept 头）
- 它代理了 `XMLHttpRequest.prototype.open`，可拦截所有 XHR 请求

**这是该扩展最主要的攻击面**：如果 hCaptcha.com 的页面被 XSS 攻破，攻击者可以操纵 MAIN world 脚本截获的响应数据。

---

## 5. 通信安全

### 5.1 扩展内部通信

| 通道 | 协议 | 安全性 |
|------|------|--------|
| Content Script → SW | `chrome.runtime.sendMessage` | 内置隔离 (Chrome 进程内) |
| Content Script → SW (stream) | `chrome.runtime.connect` (长连接) | 内置隔离 |
| Popup → SW | `chrome.runtime.connect("popup-stream")` | 内置隔离 |
| ISOLATED → MAIN world | `window.postMessage` | **弱隔离** — 任何同源脚本可监听 |
| CDP 命令 | `chrome.debugger.sendCommand` | 内置隔离 |

### 5.2 postMessage 风险

Content Script (ISOLATED) 和 MAIN world 脚本之间通过 `window.postMessage` 通信。消息格式：
```javascript
{source: "3149371273", payload: {k: "xhr", url: "...", body: "..."}}
```

**风险**：
- `source` 字段是硬编码的 magic number (`3149371273`)，仅凭此做来源验证
- 页面中任何脚本都能发送格式相同的 `postMessage` 来伪造数据
- hCaptcha 的响应数据（包含验证 token）通过 postMessage 以明文传输，页面内任何脚本都能读取

---

## 6. 存储安全

| 存储位置 | 数据 | 加密 |
|---------|------|------|
| `chrome.storage.local` | `settings` (含 API Key) | 无客户端加密 |
| `chrome.storage.local` | `observability:*` (时间戳) | 无 |
| 内存 (Map) | CaptchaJob (含 sitekey, host) | 无 |
| 内存 (Map) | PointerSession (鼠标模拟 profile) | 无 |

**风险**：
- API Key 在 `chrome.storage.local` 中明文存储，任何获得扩展存储访问权限的恶意扩展都可读取
- Settings 中 `disabled_hosts` 列表可能泄露用户访问过哪些站点（用户手动禁用过）

---

## 7. 隐私分析

### 7.1 浏览历史追踪能力

通过以下组合，NopeCHA 具备精确追踪用户浏览历史的技术能力：

1. `<all_urls>` + `9jm743.js` 注入所有页面
2. 每个 CAPTCHA 识别请求附带 `sitekey` 和域名
3. `host_permissions` 可访问任意网站

**实际代码中**：识别请求包含识别所需的必要信息（CAPTCHA 类型、图片、sitekey），域名信息隐含在 sitekey 中。可观测性上报数据也包含 meta 字段。

### 7.2 用户行为分析

鼠标模拟引擎需要知道页面布局和元素位置，通过 CDP 的 `Page.getLayoutMetrics` 和 `DOM.getBoxModel` 获取。这些数据仅用于鼠标路径计算，**未发现被外传的证据**。

---

## 8. 依赖与供应链

| 组件 | 来源 | 版本 | 风险 |
|------|------|------|------|
| Valibot | 内联裁剪版 | 未知 (推断 v0.x) | **中** — 手动内联，无法追踪上游安全修复 |
| CRC-32 | 内联 | N/A | 低 — 仅用校验和 |
| Mersenne Twister | 内联 | N/A | 低 — 仅用随机数 |

**未使用外部 CDN 或 npm 包**。所有第三方库均以裁剪形式内联到打包产物中。

### 供应链风险评估

- 依赖项较少（仅 Valibot 一个主要第三方库）
- Valibot 内联版本难以验证与上游的一致性
- 如果 Rspack 打包工具链被攻破，恶意代码将直接注入扩展

---

## 9. 合规性

| 维度 | 状态 | 说明 |
|------|------|------|
| MV3 规范 | 合规 | 使用 MV3 manifest、Service Worker、declarativeNetRequest |
| CSP | 合规 | 无违反 MV3 默认 CSP 的行为 |
| 隐私声明 | 不明确 | 扩展描述未充分说明数据收集范围（CAPTCHA 图片 + 浏览域名） |
| 最小权限原则 | **违反** | `debugger` + `<all_urls>` 远超 CAPTCHA 识别所需的最小权限 |
| CWS 政策 | 技术上合规 | Chrome Web Store 允许 debugger 权限用于辅助功能 |

---

## 10. 发现总结

### 高风险发现

| ID | 发现 | 严重度 |
|----|------|--------|
| SEC-01 | `debugger` 权限 + `<all_urls>` 组合可完全控制浏览器 | **严重** |
| SEC-02 | `world:"MAIN"` 注入 + XHR 原型劫持，页面 XSS 可劫持通信 | **高** |
| SEC-03 | CAPTCHA 图片 base64 上传至第三方 API，可能含网页 UI 截图 | **高** |
| SEC-04 | postMessage 通信仅用 magic number 做来源验证 | **高** |
| SEC-05 | API Key 明文存储在 chrome.storage.local | **高** |
| SEC-06 | sitekey+域名通过识别请求泄露浏览历史 | **中** |
| SEC-07 | CRC-32 校验无法防止消息篡改 | **中** |
| SEC-08 | Valibot 内联版本无法追踪安全修复 | **中** |

### 缓解建议

1. **SEC-01**: 将 `debugger` 权限限制为 `activeTab` 或在需要时使用 `chrome.debugger.attach` + 用户确认
2. **SEC-02**: 考虑将 MAIN world 脚本所需功能移至 ISOLATED，或增加 postMessage origin 验证
3. **SEC-03**: 服务端应执行图片裁剪/脱敏，仅保留 CAPTCHA 核心区域
4. **SEC-04**: 增加 `event.origin` 验证 + 一次性 token/challenge 机制
5. **SEC-05**: 使用 `chrome.storage.session` 或加密存储，或使用 OAuth token 代替 API Key
6. **SEC-06**: 识别请求中去除域名信息，仅保留 CAPTCHA 类型和图片
7. **SEC-07**: 升级为 HMAC 或非对称签名机制
8. **SEC-08**: 迁移到 npm 依赖 + 构建时 tree-shaking，确保可追踪版本

---

## 11. 审计结论

NopeCHA v0.6.1 是一个工程复杂度较高的 Chrome 扩展，其核心功能（AI CAPTCHA 解决）通过 CDP 鼠标模拟和内容脚本注入实现。**代码中未发现恶意或间谍行为**，但权限组合（debugger + all_urls）构成**结构性过度授权**。建议用户仅在信任的开发者和明确需要时使用，并定期检查扩展更新是否有权限变更。
