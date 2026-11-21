# 安全审计报告 — 陪读蛙 (Read Frog) v1.37.2

> 审计日期: 2026-07-06 | 分析模型: dsv4 | 扩展版本: 1.37.2 | 清单版本: Manifest V3
> 
> 范围: Chrome 扩展程序静态逆向分析，基于解包后的 dist/ 目录和源码审查

---

## 目录

1. [权限面分析](#1-权限面分析)
2. [数据流评估](#2-数据流评估)
3. [CSP 安全](#3-csp-安全)
4. [注入面分析](#4-注入面分析)
5. [通信安全](#5-通信安全)
6. [存储安全](#6-存储安全)
7. [隐私评估](#7-隐私评估)
8. [依赖安全](#8-依赖安全)
9. [合规评估](#9-合规评估)
10. [综合评分与整改路线图](#10-综合评分与整改路线图)

---

## 1. 权限面分析

### 风险等级: **Critical**

### 清单

| 权限 | 用途声明 | 实际用途 | 风险 |
|------|----------|----------|------|
| `storage` | 配置/翻译缓存/备份存储 | 存储所有配置、翻译缓存、OAuth Token、API Key、备份 | Low |
| `tabs` | 获取标签页信息 | 站点控制、URL 翻译规则 | Low |
| `alarms` | 定时备份、定时任务 | 每小时配置备份（最多 8 份）、定期清理 | Low |
| `cookies` | 与 readfrog.app 会话保持 | **未在可读代码中找到直接 chrome.cookies API 调用** | **High** |
| `contextMenus` | 右键菜单 | 右键翻译/朗读 | Low |
| `identity` | Google OAuth2 登录 | chrome.identity.launchWebAuthFlow → Google Drive 同步 | Medium |
| `scripting` | 动态注入翻译脚本 | 翻译样式注入、动态 CSS | Medium |
| `webNavigation` | 监听页面导航 | 自动翻译触发 | Low |
| `offscreen` | 音频播放 (TTS) | Edge TTS 音频播放 | Low |
| `sidePanel` | 侧边栏 UI | 侧边翻译面板 | Low |
| `host_permissions: *://*/*` | 全站点内容脚本 | host.js / selection.js / side.js 注入**所有**网页 | **Critical** |

### 关键发现

**F-1.1: cookies 权限必要性存疑**

扩展声明了 `cookies` 权限，官方解释为"与 readfrog.app 的会话保持"。但在 dist/ 目录中：
- 后台脚本 (background.js) 中未发现 `chrome.cookies` 相关 API 调用
- better-auth 客户端库使用 `credentials: 'include'` 的 Fetch 代理方案管理会话，无需 cookies 权限
- Google OAuth 流程使用 `chrome.identity.launchWebAuthFlow`，不需要直接读取 cookie

如果确实使用了 cookies 权限而代码被混淆隐藏，那么该权限结合 `*://*/*` 的 host_permissions 构成全域 cookie 窃取能力。即便仅用于 readfrog.app 会话保持，`cookies` 权限仍然过度——MV3 中 WXT fetch proxy 的 `credentials: 'include'` 即可管理跨域 cookie。

**风险**: 若恶意代码注入或供应链攻击发生，cookies 权限 + `*://*/*` host_permissions 可实现针对**任意域名**的全量 cookie 读取。

**F-1.2: host_permissions: `*://*/*` 覆盖范围极大**

内容脚本 (host.js, selection.js, side.js) 注入**所有 HTTP/HTTPS 页面**。input-injector.js 和 interceptor.js 在 MAIN world 执行，可直接访问页面 JavaScript 上下文。这等同于：
- 可以读取任何网页的 DOM 内容（包括敏感的登录表单、银行页面、内部系统）
- 可以拦截和修改任何网页的网络请求（interceptor.js 拦截 YouTube XHR/fetch）
- 可以通过 postMessage 实现页面与扩展的通信

**F-1.3: 权限组合风险**

`cookies` + `*://*/*` + `scripting` + `webNavigation` 的组合构成一个完整的**数据收集管道**：
1. `webNavigation` 监控所有浏览行为
2. `*://*/*` 注入所有页面
3. `scripting` 动态执行任意脚本
4. `cookies` 理论上可读取任意域 cookie
5. 20+ 外部 API endpoint 提供了数据外传通道

### 建议

- **立即整改**: 移除 `cookies` 权限，改用 WXT 内建的 `credentials: 'include'` 机制
- **强烈建议**: 将 `host_permissions` 从 `*://*/*` 收窄为 `<all_urls>` 的 `activeTab` 风格模式，或至少排除敏感域名（如 `*://*.banking.*` 等）——尽管 Chrome Web Store 实际不支持排除规则
- **建议**: 向用户说明每项必要权限的具体使用场景和限制

---

## 2. 数据流评估

### 风险等级: **Critical**

### 敏感数据类型

| 数据 | 存储位置 | 传输目标 | 加密状态 | 风险 |
|------|----------|----------|----------|------|
| 用户 API Key (OpenAI/DeepSeek/Claude 等) | chrome.storage.local | 各 LLM 提供商 API | 明文存储 + HTTPS 传输 | **Critical** |
| Google OAuth Access Token | chrome.storage.local | Google APIs (Drive/UserInfo) | 明文存储 + HTTPS 传输 | **High** |
| 翻译缓存 | chrome.storage.local | 无（本地使用） | 明文存储 | Low |
| 用户翻译文本 | 内存中 | 20+ LLM API endpoint | HTTPS 传输 | **High** |
| 浏览页面内容 | 内容脚本 DOM 访问 | LLM 提供商 | HTTPS 传输 | **High** |
| 分析数据 (PostHog) | 无本地存储 | us.i.posthog.com | HTTPS 传输，匿名化处理 | Medium |
| 错误报告 (Sentry) | 无本地存储 | Sentry | HTTPS 传输 | Low |
| Google Drive 配置同步 | googleapis.com | Google Drive appDataFolder | OAuth Bearer Token | Medium |

### 关键发现

**F-2.1: 用户 API Key 明文存储**

所有用户输入的 LLM 提供商 API Key 以**明文**形式存储在 `chrome.storage.local` 中。导出配置时虽有"排除 API Key"选项，但默认情况下 API Key 在存储和导出中均为明文。

```javascript
// 从 api-DRcQvSQe.js — API Key sanitiser 仅用于日志，不用于存储
// redacts apiKey before logging, but NOT before storage
// 从 config-DEeWDsJY.js — 配置导出提供 include/exclude API Keys 的选择
```

sanitize 函数仅在**日志输出**前移除 apiKey 字段，存储本身无加密保护。

**F-2.2: API Key 流向 20+ 外部端点**

用户 API Key 被发送到的端点包括：
- OpenAI: `https://api.openai.com/v1`
- DeepSeek: `https://api.deepseek.com/v1`
- Anthropic: `https://api.anthropic.com`
- Google Gemini: `https://generativelanguage.googleapis.com/v1beta`
- Groq: `https://api.groq.com/openai/v1`
- xAI: `https://api.x.ai/v1`
- DeepInfra: `https://api.deepinfra.com/v1`
- Mistral: `https://api.mistral.ai/v1`
- TogetherAI: `https://api.together.xyz/v1/`
- Cohere: `https://api.cohere.com/v2`
- Fireworks: `https://api.fireworks.ai/inference/v1`
- Cerebras: `https://api.cerebras.ai/v1`
- Replicate: `https://api.replicate.com/v1`
- Perplexity: `https://api.perplexity.ai`
- OpenRouter: `https://openrouter.ai/api/v1`
- Ollama: `http://127.0.0.1:11434/v1`（本地）
- Vercel AI Gateway: `https://ai-gateway.vercel.sh/v4/ai`
- SiliconFlow, Volcengine, MiniMax, 302.ai 等中国厂商 API
- AWS Bedrock: `https://bedrock-runtime.*.amazonaws.com`

**F-2.3: 翻译内容的数据主权风险**

用户翻译的文本内容（可能包含敏感商业信息、个人隐私）在 HTTPS 传输层保护下发送到用户自行配置的 LLM 提供商。但扩展本身不提供端到端加密、不限制数据留存策略、不提供数据分类标记功能。用户无法区分哪些内容应该/不应该发送到第三方 API。

**F-2.4: Edge TTS 硬编码凭据泄漏**

在 `chunk-CDXTSg0a.js` 中发现：
```javascript
// 硬编码的 Microsoft/Edge TTS 信任客户端 Token
WXT_EDGE_TTS_TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
// 硬编码的签名密钥 Base64
WXT_EDGE_TTS_SIGNATURE_SECRET_BASE64 = "oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw=="
// 硬编码的应用 ID
WXT_EDGE_TTS_SIGNATURE_APP_ID = "MSTranslatorAndroidApp"
```

这些凭据硬编码在扩展包中，属于 Microsoft 的服务凭据。虽然是公开客户端凭据（类似移动端应用），但仍存在被滥用的风险。

### 建议

- **核心整改**: chrome.storage.local 中存储的 API Key 应至少使用 WebCrypto API 的 `SubtleCrypto.encrypt()` 进行加密存储，密钥派生自用户身份或设备指纹
- **整改**: 翻译内容发送前增加"敏感内容检测"选项，或提供本地翻译模式（Ollama 已支持）
- **建议**: Edge TTS 凭据应移至服务端代理，或至少通过构建时注入而非硬编码
- **建议**: 增加数据流可视化面板，让用户了解哪些数据发送到了哪些端点

---

## 3. CSP 安全

### 风险等级: **Low**

### 现状

扩展未声明 `content_security_policy` 字段，使用 Manifest V3 默认 CSP：
- `script-src 'self'`
- `object-src 'self'`

### 关键发现

**F-3.1: 默认 CSP 符合 MV3 标准**

默认 CSP 限制了脚本加载来源为扩展自身，有效防范了大多数 XSS 攻击链。扩展不依赖内联脚本或 eval（MV3 默认禁止）。

**F-3.2: 缺少额外加固**

扩展未显式声明更严格的 CSP。例如：
- 未限制 `connect-src` 可限制扩展的网络请求目标
- 未限制 `style-src` 的样式来源

但由于扩展需要连接 20+ 外部 API 端点，`connect-src` 在实际中难以显著收窄。

**F-3.3: React 渲染的 XSS 面**

扩展使用 React (shadcn/ui)，React 内置了 JSX 转义机制，正常情况下不会产生 XSS。但若存在 `dangerouslySetInnerHTML` 使用点，则可能成为攻击面。从可读代码中未发现明显的 `dangerouslySetInnerHTML` 使用。

### 建议

- **保持现状**: 默认 MV3 CSP 已足够
- **可选加固**: 显式声明 `connect-src` 限制网络请求目标至已知 API 端点列表

---

## 4. 注入面分析

### 风险等级: **Critical**

### 内容脚本清单

| 脚本 | 匹配 | World | 执行时机 | 功能 | 风险 |
|------|------|-------|----------|------|------|
| host.js | `*://*/*`, `file:///*` | ISOLATED | document_idle | 页面翻译宿主 | **High** |
| selection.js | `*://*/*`, `file:///*` | ISOLATED | document_idle | 划词翻译 | **High** |
| side.js | `*://*/*`, `file:///*` | ISOLATED | document_idle | 侧边面板 | **High** |
| input-injector.js | `*://*/*` | **MAIN** | document_start | 输入框翻译注入 | **Critical** |
| interceptor.js | YouTube | **MAIN** | document_start | XHR/fetch 拦截 | **Critical** |
| subtitles.js | YouTube | ISOLATED | (默认) | 字幕翻译 | Medium |
| guide.js | readfrog.app | ISOLATED | (默认) | 引导页面 | Low |

### 关键发现

**F-4.1: MAIN world 注入 — input-injector.js**

`input-injector.js` 注入到**所有网页** (`*://*/*`) 的 MAIN world，在 `document_start` 阶段执行。这意味着它可以：
- 访问页面所有 JavaScript 对象和变量
- 读取和修改 React/Draft.js/Slate.js 编辑器的内部状态
- 拦截和修改任何页面函数

**恶意页面风险**: 恶意网站可以通过检测扩展注入的 MAIN world 脚本，反向利用 postMessage 通道或全局变量（`window.__READ_FROG_INPUT_INJECTOR__`）与扩展通信。

```javascript
// input-injector.js 监听页面 postMessage，无来源验证
window.addEventListener("message", e => {
  e.origin === window.location.origin && 
  e.data?.type === "READ_FROG_INPUT_REPLACE" && 
  f(e.data.text)
})
```

虽然有 `e.origin === window.location.origin` 检查，但攻击者控制的页面可以伪造此消息。

**F-4.2: MAIN world 注入 — interceptor.js**

`interceptor.js` 钩入 YouTube 的 `XMLHttpRequest.prototype.open/send`，拦截所有 XHR 请求以获取字幕数据。然后通过 postMessage 与 ISOLATED world 的内容脚本通信：

```javascript
// interceptor.js 将捕获的数据发送回 ISOLATED world
window.postMessage({
  type: "READ_FROG_PLAYER_DATA",
  requestId: n,
  success: !0,
  data: { videoId, captionTracks, ... }
}, window.location.origin)
```

此方法虽然没有直接泄露给外部，但篡改了 YouTube 页面的网络请求行为。若 YouTube 页面存在 XSS，攻击者可以伪造 `READ_FROG_PLAYER_DATA` 消息注入虚假字幕数据。

**F-4.3: ISOLATED world 内容脚本的高风险行为**

host.js (1.9MB)、selection.js (大量代码)、side.js 都注入到 `*://*/*`。虽然运行在 ISOLATED world，但：
- 通过 DOM 操作与页面交互，可能被恶意页面利用 DOM clobbering 攻击
- 大量 DOM 操作可能触发 CSP 违规或页面性能问题
- 注入的 CSS 可能影响页面原有布局

**F-4.4: Web Accessible Resources 泄露**

```json
"web_accessible_resources": [
  {"resources": ["assets/*.png","assets/*.svg","assets/*.webp"], "matches": ["*://*/*","file:///*"]},
  {"resources": ["content-scripts/selection.css"], "use_dynamic_url": true, "matches": ["*://*/*","file:///*"]},
  {"resources": ["content-scripts/side.css"], "use_dynamic_url": true, "matches": ["*://*/*","file:///*"]}
]
```

所有 PNG/SVG/WEBP 资源对任意页面可见。攻击页面可以通过 `fetch(chrome.runtime.getURL('assets/icon.png'))` 检测扩展是否已安装（扩展指纹识别），这是一种已知的隐私攻击手法。

### 建议

- **关键整改**: input-injector.js 的 postMessage 监听应增加消息来源验证，例如使用 `chrome.runtime.connect()` 替代 `window.postMessage`
- **整改**: 缩减 input-injector.js 的 matches 模式，限制为仅支持输入翻译的特定站点
- **建议**: 使用 `externally_connectable` 限制哪些页面可与扩展通信
- **建议**: 考虑使用 `optional_host_permissions` 替代 `host_permissions: *://*/*`，让用户按需授权

---

## 5. 通信安全

### 风险等级: **Medium**

### 外部通信端点汇总

| 类别 | 端点 | 协议 | 认证方式 |
|------|------|------|----------|
| OAuth 认证 | `accounts.google.com/o/oauth2/v2/auth` | HTTPS | OAuth2 PKCE (部分) |
| Google APIs | `www.googleapis.com/oauth2/v2/userinfo` | HTTPS | Bearer Token |
| Google Drive | `www.googleapis.com/drive/v3` | HTTPS | Bearer Token |
| Google Drive Upload | `www.googleapis.com/upload/drive/v3` | HTTPS | Bearer Token |
| 20+ LLM Providers | 各厂商 API 端点 | HTTPS | API Key / Bearer Token |
| Microsoft Translator | `api-edge.cognitive.microsofttranslator.com` | HTTPS | API Key |
| Google Translate | Google Translate API | HTTPS | (内置) |
| DeepLX | `https://deeplx.vercel.app`, `https://api.deeplx.org` | HTTPS | API Key (路径参数) |
| Edge TTS | `speech.platform.bing.com`, `dev.microsofttranslator.com` | HTTPS | Hardcoded Token |
| PostHog Analytics | `us.i.posthog.com`, `us.posthog.com` | HTTPS | API Key |
| Sentry | Sentry endpoint | HTTPS | DSN |
| Discord | Discord invite link (UI 链接) | HTTPS | N/A (仅链接) |
| ReadFrog 后端 | `readfrog.app` (better-auth base URL) | HTTPS | Session Cookie |
| Ollama (本地) | `http://127.0.0.1:11434/v1` | **HTTP (明文)** | 无 |

### 关键发现

**F-5.1: Ollama 本地通信使用 HTTP 明文**

Ollama 提供商默认使用 `http://127.0.0.1:11434/v1`（HTTP 明文）。虽然连接本地 localhost，但：
- 若系统被安装了中间人代理，localhost 通信可能被监听
- 没有 TLS 意味着数据完整性无法保证

**F-5.2: Google OAuth 缺少 PKCE 验证**

OAuth 流程使用 `response_type=token`（隐式授权），在 chrome.identity redirect URL 中提取 access_token。代码中未发现 PKCE (Proof Key for Code Exchange) 验证逻辑。虽然 chrome.identity.launchWebAuthFlow 在一定程度上提供了流程完整性保护，但隐式授权协议本身已不再推荐使用（Google 自 2023 年起推荐使用 `response_type=code` + PKCE）。

**F-5.3: DeepLX API Key 作为 URL 路径参数**

```javascript
// translate-BaKnb6wb.js — DeepLX URL 模板
"https://api.deeplx.org/{{apiKey}}/translate"
```

API Key 出现在 URL 路径中（而非 Header 或请求体），在服务器日志、代理日志和浏览器历史中可能泄露。

**F-5.4: WXT fetch proxy 的 credentials 设置**

```javascript
// auth-client-DbamIzFe.js
fetchOptions: { credentials: "include", customFetchImpl: z({...}) }
```

better-auth 客户端使用 `credentials: 'include'` 发送请求到 `readfrog.app`。这意味着所有对 readfrog.app 的请求都会自动附带该域的 cookie。如果 readfrog.app 存在 CSRF 漏洞，攻击者可能利用此配置发起跨站请求。

**F-5.5: PostHog 分析数据收集**

扩展硬编码了 PostHog API Key (`phc_wfOOFubvGIVFUlsQ6oVHdlHp6VuJvNw0gz6grcNgwWp`)。收集的数据包括：
- `feature_used` 事件（页面翻译、划词翻译、AI 操作等）
- 操作来源（popup、右键菜单、自动翻译等）
- 操作延迟 (latency_ms)

代码中存在 `analyticsEnabled` 配置项，用户可以在选项页中关闭分析。PostHog 的 `phc_` 前缀 key 是 public key，只能写入数据不能读取，符合 PostHog 设计。

### 建议

- **整改**: Ollama 默认 endpoint 建议使用 `https://`（如果用户 Ollama 实例配置了 TLS），或至少增加 localhost TLS 使用提示
- **建议**: DeepLX API Key 从 URL 路径移至 HTTP Header (`Authorization` 或自定义 Header)
- **建议**: 增加 network_error 的统一处理，避免敏感数据泄露到错误日志
- **建议**: 在 PostHog 配置中启用 IP 匿名化和数据最小化

---

## 6. 存储安全

### 风险等级: **High**

### 存储内容

| 数据类别 | 存储键 | 敏感度 | 加密 | 生命周期 |
|----------|--------|--------|------|----------|
| 扩展配置 | nanostores persisted atoms | Medium | 明文 | 永久 |
| Google OAuth Token | `local:${p}` (better-auth) | **High** | 明文 | 到过期 (1h) |
| 上次同步配置 | `local:${g}` (Google Drive sync) | Medium | 明文 | 永久 |
| 配置备份 (最多 8 份) | `local:backup_ids`, `local:${backup_id}` | **High** | 明文 | 保留最新 8 份 |
| 分析偏好 | nanostores atom | Low | 明文 | 永久 |
| LLM API Keys | 配置对象的 providersConfig 字段 | **Critical** | 明文 | 永久 |
| 翻译缓存 | translate cache | Low-Medium | 明文 | 至缓存清理 |
| 批处理请求记录 | batch request records | Low | 明文 | 滚动 |

### 关键发现

**F-6.1: API Key 和 OAuth Token 无加密保护**

`chrome.storage.local` 的数据在磁盘上以明文存储。具有文件系统访问权限的恶意软件可以直接读取这些凭据：

```
%LOCALAPPDATA%\Google\Chrome\User Data\Default\Local Extension Settings\{extension_id}\
```

OAuth access_token 过期时间为 1 小时，但结合 refresh_token（如果存在），可以持续访问用户 Google 账号。

**F-6.2: 配置备份含 API Key**

配置备份功能每小时自动创建一份快照（最多保留 8 份），存储在 `chrome.storage.local` 中。备份中包含完整的配置对象——包括所有 API Key。虽然备份也有 schema 版本控制和迁移逻辑，但 API Key 以明文形式存在于每份备份中。

**F-6.3: 配置导出含 API Key 选项**

配置导出功能提供两个选项：
- 包含 API Key 导出（完整配置）
- 排除 API Key 导出

这是良好的 UX 设计，但"包含 API Key"选项的导出文件如果被共享或泄露，将直接暴露所有 API Key。

**F-6.4: chrome.storage.local 的隔离性限制**

MV3 中 `chrome.storage.local` 是扩展隔离的，其他扩展无法读取。但：
- 具有 `storage` 权限的其他扩展不能跨扩展读取
- 磁盘上的文件可通过 `chrome.storage.local` 以外的攻击面访问（如恶意软件、物理访问）

### 建议

- **核心整改**: 对 API Key 和 OAuth Token 使用 WebCrypto API 加密存储，密钥使用 `chrome.storage.session` 或 `sessionStorage` 管理
- **整改**: 备份在存储前剥离 API Key，恢复时提示用户重新输入
- **建议**: 配置导出默认排除 API Key，需要时额外确认
- **建议**: 增加"主密码"功能，用户设置后用于派生加密密钥

---

## 7. 隐私评估

### 风险等级: **Medium**

### 数据收集现状

| 数据 | 收集方 | 用途 | 用户控制 | 风险 |
|------|--------|------|----------|------|
| 使用统计 (PostHog) | PostHog Inc. | 功能使用分析 | 可关闭 (settings) | Medium |
| 错误报告 (Sentry) | Sentry (Functional Software Inc.) | 错误追踪 | 未知 | Low |
| 翻译内容 | 用户配置的 LLM 提供商 | 翻译 | 用户选择提供商 | **High** |
| 浏览历史 (间接) | webNavigation 事件 | 自动翻译触发 | 不可关闭（权限始终有效） | Medium |
| 页面内容 | 内容脚本 DOM 访问 | 翻译源文本提取 | 站点控制 (siteControl) | **High** |
| Google 账号信息 | Google APIs (userinfo) | Drive 同步认证 | 仅登录时 | Medium |
| 邮箱地址 | Google OAuth | Drive 同步身份关联 | 仅登录时 | Low |

### 关键发现

**F-7.1: PostHog 匿名化状态不明确**

扩展使用 PostHog SDK 进行分析。在代码中发现了以下 PostHog 相关配置：
- API Key: `phc_wfOOFubvGIVFUlsQ6oVHdlHp6VuJvNw0gz6grcNgwWp`
- Host: `https://us.i.posthog.com`
- 文档引用中发现了 redaction 相关 URL (`https://posthog.com/tutorials/web-redact-properties`)

但**未在可读代码中明确找到 web redaction 配置**。PostHog 的匿名化依赖配置，不确定翻译内容、API Key、URL 等是否被发送到 PostHog。如果未配置 redaction，翻译文本可能被泄露到分析平台。

**F-7.2: Function-level analytics 追踪**

扩展追踪详细的功能使用事件：
```javascript
// analytics-CcW7E_VC.js — 追踪事件类型
feature: page_translation, selection_translation, custom_ai_action, 
         input_translation, translation_hub, video_subtitles, text_to_speech
surface: popup, floating_button, context_menu, page_auto, shortcut, 
         touch_gesture, selection_toolbar, input_translation, translation_hub, 
         video_subtitles, tts_settings
```

每个事件包含：feature 类型、触发 surface、outcome (success/failure)、延迟时间 (latency_ms)。虽然不包含翻译内容本身，但可以推断用户的浏览和翻译行为模式。

**F-7.3: 翻译内容隐私取决于 LLM 提供商**

用户翻译的文本直接发送到第三方 LLM API：
- OpenAI、DeepSeek、Anthropic 等有各自的隐私政策
- 一些中国厂商 API（SiliconFlow、Volcengine 等）受中国数据法规管辖
- 用户可能不知道数据被发送到哪个国家/区域

扩展内置了免费 AI 提供商（Read Frog Free AI / AtlasCloud），用户可能在不知情的情况下将翻译内容发送到此服务。

**F-7.4: 站点控制功能**

扩展提供了 siteControl 配置（黑名单/白名单模式），用户可以控制哪些站点不触发翻译。这是良好的隐私设计。但内容脚本仍然注入所有页面（仅翻译功能被抑制）。

**F-7.5: Discord 社区链接**

Pop-up 页面包含 Discord 邀请链接，引导用户加入社区。这不涉及数据收集，但属于推广行为，用户应知晓。

### 建议

- **整改**: 在 PostHog 配置中明确启用属性 redaction，确保 URL、翻译内容、API Key 不被发送
- **整改**: 在选项页增加"数据透明度"面板，列出所有数据收据端点和用途
- **建议**: 为不同 LLM 提供商标注数据存储区域/国家信息
- **建议**: 更新隐私政策链接并确保在 Chrome Web Store 列表页可访问

---

## 8. 依赖安全

### 风险等级: **Medium**

### 关键依赖

| 依赖 | 版本推测 | 类型 | 风险 |
|------|----------|------|------|
| React | 18.x | 运行时 | Low |
| WXT | (unknown version) | 构建框架 | Low |
| better-auth | (unknown version) | 认证库 | Medium |
| nanostores | (unknown version) | 状态管理 | Low |
| Jotai | (unknown version) | 状态管理 | Low |
| shadcn/ui | (unknown version) | UI 组件库 | Low |
| Tailwind CSS | 3.x | CSS 框架 | Low |
| PostHog | (SDK) | 分析 | Low |
| zod | 4.4.3 (确认) | Schema 验证 | Low |
| @codemirror | (unknown version) | 代码编辑器 | Low |
| FileSaver.js | (unknown version) | 文件下载 | Low |
| Lezer (CodeMirror parser) | (unknown version) | 语法解析 | Low |
| Radix UI | (unknown version) | 无障碍原语 | Low |

### 关键发现

**F-8.1: WXT 版本不可知**

WXT 是构建 Chrome 扩展的现代框架。dist/ 目录不包含 `package.json`，无法确定 WXT 版本。WXT 使用的 Vite/Rollup 构建链可能存在已知漏洞，但无版本信息则无法验证。

**F-8.2: better-auth 客户端库安全审查不足**

better-auth 是一个相对较新的认证库（GitHub: better-auth/better-auth）。代码使用了其客户端部分：
- Session 管理（get-session API）
- 广播频道（BroadcastChannel）
- 焦点管理（FocusManager）
- 在线状态管理（OnlineManager）
- localStorage session 同步

better-auth 的 `better-json` 自定义 JSON 解析器在 `auth-client-DbamIzFe.js` 中有 prototype pollution 防护：

```javascript
// better-json 的 prototype pollution 防护
const protoPatterns = {
  proto: /"(?:_|\\u0{2}5[Ff]){2}.../,
  constructor: /"(?:c|\\u0063).../,
  protoShort: /"__proto__"\s*:/,
  constructorShort: /"constructor"\s*:/
}
```

这表明开发团队关注了安全细节，但更好的做法是使用标准的 `JSON.parse` 配合 `reviver` 参数或 `Object.freeze` 而非自定义解析器。

**F-8.3: Debug 日志保留在生产版本中**

所有内容脚本都包含 debug logging 模块：
```javascript
// 生产构建中 debug 函数保留但被抑制
{debug: (...e) => ([...e], void 0), log: (...e) => ([...e], void 0)}
```

虽然日志输出被抑制（NOP），但函数签名仍保留在 bundle 中。如果未来通过配置或运行时代码修改恢复了日志输出，可能会泄露敏感信息。

**F-8.4: 未发现已知的漏洞依赖**

基于静态分析，未在可读代码中识别出已知的 CVE 相关代码模式。但无法做出完整保证，因为没有 package.json 和 lockfile 来审计具体版本。

### 建议

- **整改**: 在构建时使用 terser `drop_console` 或 `pure_funcs` 移除 debug 日志函数
- **建议**: 提供 SBOM (Software Bill of Materials) 或 package.json 以便进行依赖审计
- **建议**: 监控 better-auth 的安全公告，特别是其自定义 JSON 解析器的安全性

---

## 9. 合规评估

### 风险等级: **Low-Medium**

### Chrome Web Store 合规检查

| 政策要求 | 状态 | 说明 |
|----------|------|------|
| 最小权限原则 | **FAIL** | cookies 权限必要性未充分证明；host_permissions 过度 |
| 明确隐私披露 | **OK** | README.md 列出了权限用途 |
| 用户数据使用透明 | **PARTIAL** | 分析开关存在但不详细 |
| 禁止秘密数据收集 | **LIKELY OK** | PostHog 分析可关闭，未发现隐藏的数据收集 |
| 单一用途 | **OK** | 翻译与语言学习 |
| 远程代码执行禁止 | **OK** | 未发现远程代码加载 |
| 无混淆代码 | **OK*** | 代码 minified 但未 maliciously obfuscate |

### 关键发现

**F-9.1: 最小权限原则违规**

`cookies` 权限和 `host_permissions: *://*/*` 超出了翻译扩展的必要范围。Chrome Web Store 审核可能要求对此做出解释。

**F-9.2: Google OAuth 的受限范围使用**

使用 `https://www.googleapis.com/auth/drive.appdata` 和 `https://www.googleapis.com/auth/userinfo.email` 两个 scope。这两个 scope 不需要 Google 的安全审核（非受限 scope），合规性良好。

**F-9.3: Google API Client ID 硬编码**

OAuth Client ID (`115446439841-gc9op5ulp0uh9v34ib9sej8kb914epff.apps.googleusercontent.com`) 硬编码在扩展中。这属于常规做法（Chrome 扩展通常将 Client ID 内置），但值得注意：
- 任何人可以提取此 Client ID
- redirect URI 绑定到 `chrome-extension://{extension_id}/`，防止了标准的 OAuth token 劫持

**F-9.4: GDPR/隐私法规考量**

扩展面向全球用户（支持 9 种语言：中、英、日、韩、俄、西、土、越）。数据可能跨越多个司法管辖区域（美国 LLM 提供商、中国 LLM 提供商、微软 Azure 区域、PostHog US 区域）。应关注：
- 用户是否有数据删除权（翻译缓存的删除机制）
- 用户是否有数据导出权（配置导出功能部分满足）
- 分析数据匿名化的充分性

### 建议

- **整改**: 移除 `cookies` 权限或提供充分的技术必要性说明
- **建议**: 在选项页增加 GDPR 数据主体权利入口（删除所有缓存、导出所有数据）
- **建议**: 增加"数据的区域"说明，告知用户数据将被发送到哪个区域的 API

---

## 10. 综合评分与整改路线图

### 总体评分

| 维度 | 风险等级 | 分数 (1-10) |
|------|----------|-------------|
| 1. 权限面 | **Critical** | 2/10 |
| 2. 数据流 | **Critical** | 3/10 |
| 3. CSP | Low | 8/10 |
| 4. 注入面 | **Critical** | 2/10 |
| 5. 通信安全 | Medium | 6/10 |
| 6. 存储安全 | **High** | 3/10 |
| 7. 隐私 | Medium | 5/10 |
| 8. 依赖安全 | Medium | 6/10 |
| 9. 合规 | Low-Medium | 6/10 |

**加权综合评分: 4.3/10** (低安全水平)

### 整改优先级

#### P0 — 立即整改 (Critical, 影响用户凭据安全)

| # | 整改项 | 影响范围 | 工作量 |
|---|--------|----------|--------|
| 1 | **移除 `cookies` 权限**，改用 WXT fetch proxy 的 `credentials: 'include'` | 权限声明 | 小 |
| 2 | **API Key 加密存储**，使用 WebCrypto API 加密后存入 storage.local | storage 读写层 | 中 |
| 3 | **input-injector.js 安全加固**: postMessage 验证 + 收窄 matches 模式 | 内容脚本 | 中 |

#### P1 — 近期整改 (High, 影响用户数据安全)

| # | 整改项 | 影响范围 | 工作量 |
|---|--------|----------|--------|
| 4 | **OAuth Token 加密存储**，或移至 chrome.storage.session (MV3) | 认证模块 | 中 |
| 5 | **配置备份剥离 API Key**，恢复时提示重新输入 | 备份/恢复模块 | 中 |
| 6 | **PostHog 属性 redaction 配置**，确保 URL 和翻译内容不被发送 | 分析模块 | 小 |

#### P2 — 建议改进 (Medium, 最佳实践)

| # | 整改项 | 影响范围 | 工作量 |
|---|--------|----------|--------|
| 7 | 收窄 `host_permissions` 或使用 `optional_host_permissions` | 权限声明 | 大 |
| 8 | DeepLX API Key 从 URL 路径移至 HTTP Header | 翻译 API 层 | 小 |
| 9 | 增加数据透明度面板，列出所有数据端点 | 选项页 UI | 中 |
| 10 | Google OAuth 升级为 `response_type=code` + PKCE | 认证流程 | 中 |
| 11 | 增加"数据区域"标注，说明各 API 的数据存储区域 | 选项页 UI | 小 |

### 正面发现

尽管存在上述安全问题，以下方面值得肯定：

1. **分析可关闭**: PostHog 分析有明确的用户开关
2. **API Key 日志脱敏**: api-DRcQvSQe.js 中的 sanitize 函数在日志输出前脱敏 API Key
3. **配置导出可选**: 导出功能允许用户选择是否包含 API Key
4. **站点控制**: siteControl 功能允许用户限制翻译范围
5. **Prototype Pollution 防护**: better-json 自定义 JSON 解析器内置了原型污染检测
6. **OAuth Scope 最小化**: 仅使用 `drive.appdata` 和 `userinfo.email`，未请求过度的 Google 权限
7. **翻译提供商多样化**: 用户可自由选择 LLM 提供商，包括本地 Ollama 选项
8. **开源项目**: 扩展在 GitHub 开源 (github.com/mengxi-ream/read-frog)，代码可接受公众审查

### 免责声明

本审计基于静态逆向分析，未进行动态测试或渗透测试。部分代码经过 minify/uglify 处理，可能影响分析的完整性。审计结论基于可观察到的代码行为，不构成对扩展运行时行为或开发者意图的完整保证。

---

> 审计完成: 2026-07-06 | 分析工具: dsv4 | 文档版本: 1.0
