# OneTab v2.18 — 安全审计报告 (SECURITY_AUDIT)

## 审计摘要

| 维度 | 评级 | 说明 |
|------|:----:|------|
| 权限面 (Permissions) | 🟡 中 | 7 个 required + 4 个 optional，组合权力较大 |
| 数据流 (Data Flow) | 🟢 低 | 数据仅流向 one-tab.com（需用户授权），无其他外部端点 |
| CSP (Content Security Policy) | 🟢 低 | 严格限制 script-src/object-src |
| 注入面 (Injection Surface) | 🟡 中 | 使用 innerHTML 渲染用户提供的 title/URL 内容 |
| 通信安全 (Communication) | 🟢 低 | 仅使用 chrome.runtime API 内部通信 |
| 存储安全 (Storage) | 🟢 低 | chrome.storage.local，沙箱隔离 |
| 隐私 (Privacy) | 🟡 中 | 分享功能将标签页数据上传至 one-tab.com |
| 依赖安全 (Dependencies) | 🟢 低 | 无第三方 npm/JS 依赖 |
| 合规 (Compliance) | 🟢 低 | MV3 合规，使用 Service Worker |

**综合安全等级：🟡 中风险**

---

## 一、权限面分析 (Permissions Surface)

### 1.1 Required Permissions

| 权限 | 风险 | 分析 |
|------|:----:|------|
| `tabs` | 中 | 可读取所有标签页 URL/标题，可创建/关闭/更新标签页。核心功能必须，风险可控 |
| `storage` | 低 | chrome.storage.local，沙箱隔离，不可被其他扩展读取 |
| `unlimitedStorage` | 低 | 仅影响配额上限，不扩大访问范围 |
| `favicon` | 低 | 仅读取 favicon 图片 |
| `activeTab` | 低 | 仅在用户主动点击时激活，临时权限 |
| `scripting` | 中 | 可向任意页面注入脚本。本扩展仅用于注册 content script（监听快捷键、提取链接），无恶意用途 |
| `contextMenus` | 低 | 仅添加右键菜单项，无数据收集能力 |

### 1.2 Optional Permissions

| 权限 | 风险 | 分析 |
|------|:----:|------|
| `tabGroups` | 低 | 管理 Chrome Tab Group 折叠/展开/颜色，按需请求 |
| `readingList` | 低 | 读取 Chrome 阅读列表，仅导入功能使用 |
| `bookmarks` | 中 | 可读取全部书签树。导入书签功能需要，需用户主动触发授权 |
| `https://www.one-tab.com/*` | 中 | 允许跨域 fetch 到 one-tab.com。仅在分享/同步功能触发时请求 |

### 1.3 权限组合风险

`tabs` + `scripting` + `activeTab` 组合理论上可读取和修改任意页面内容，但本扩展的业务逻辑限定在标签页 URL 提取，未发现通用数据采集或注入行为。

---

## 二、数据流分析 (Data Flow)

### 2.1 数据流向图

```
用户标签页数据
    │
    ├──> chrome.storage.local (本地持久化)
    │       │
    │       └──> 各 UI 页面通过 RPC 读取
    │
    └──> [需用户授权] one-tab.com (分享/同步)
            │
            └──> 生成分享链接，30 天后过期
```

### 2.2 外部通信

| 端点 | 方法 | 数据 | 触发条件 |
|------|------|------|---------|
| `https://www.one-tab.com/*` | POST | 序列化的标签页列表 JSON | 用户点击分享 |
| `https://www.one-tab.com/*` | GET | 分享页面数据 | 用户访问分享链接 |

**结论**：数据外传仅发生在用户明确触发分享操作时，且需先授权 one-tab.com host 权限。未发现后台静默上传行为。

### 2.3 fetch 调用审计

所有 fetch 调用集中在 `it()` 辅助函数中，目标 URL 由 `oneTabUrl` 常量（编译时固定为 `https://www.one-tab.com`）+ 路径构成：
- 无动态拼接用户输入到 URL 的情况
- 请求体为 `JSON.stringify()` 序列化，Content-Type 设置为 `text/json`
- 响应检查 `response.status === 200`

---

## 三、CSP 分析 (Content Security Policy)

### 3.1 当前策略

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; img-src 'self' data: https://t2.gstatic.com;"
}
```

### 3.2 逐项评估

| 指令 | 值 | 评估 |
|------|------|------|
| `script-src` | `'self'` | 仅允许扩展自身 JS，禁止 inline script 和 eval。安全 |
| `object-src` | `'self'` | 禁止加载外部插件。安全 |
| `img-src` | `'self' data: https://t2.gstatic.com` | 允许 `data:` URI（用于 base64 favicon 内联）和 Google favicon 服务。低风险 |

### 3.3 缺失指令

- 无 `connect-src`：由于 MV3 的 CSP 对 `connect-src` 默认为 `*`，扩展的 fetch 到 one-tab.com 不受限制。这是 MV3 的已知设计。
- 无 `style-src`：内联样式被允许（HTML 中使用了 `<style>` 块），这在 MV3 extension_pages 中是允许的。

---

## 四、注入面分析 (Injection Surface)

### 4.1 innerHTML 使用

发现在多处使用 `innerHTML`（通过 Grep 检测），主要集中在：
- 从文本内容构造 DOM（如 HTML 格式的剪贴板粘贴）
- 渲染标签页标题和 URL 到 DOM
- 处理导入数据时的 HTML 解析

### 4.2 XSS 风险分析

**高风险场景**：
- 导入功能：用户粘贴的 HTML 内容通过 `DOMParser` 解析，`<a>` 标签的 `href` 和 `textContent` 被提取后用于构造 DOM
- 潜在风险：恶意页面的 `<title>` 可能包含 HTML/script 标签，被读取后若直接放入 innerHTML 则可能触发 XSS

**已实施的防护**：
- `Kt()` 函数：`textContent` → `innerHTML` 转换（基本 XSS 防护）
- `Zt()` 函数：Unicode 规范化、去除控制字符
- `mt()` 函数：去除 `\x00-\x1F`、`\x7F-\x9F` 控制字符
- `Ji()` 函数：HTML 实体编码（`&<>"'`）
- `hr()` 函数：综合清理（控制字符 + Unicode 规范化）
- DOMParser 解析处理（利用浏览器原生安全解析）

**残余风险**：代码规模大（~350KB minified），存在边缘场景中字符串处理不完整的可能性。

### 4.3 eval 检查

未发现 `eval()` 或 `new Function()` 调用。

---

## 五、通信安全分析 (Communication Security)

### 5.1 扩展内部通信

- 全部使用 `chrome.runtime.sendMessage` 和 `chrome.runtime.onMessage`
- 消息格式：`{type, args, Hp: true}`，其中 `Hp` 是内部协议标记
- Background 返回 `{result}` 或 `{zp: "error message"}`
- 版本不匹配检测：通过 `corePing()` 返回 `{pong: currentVersion}` 校验

### 5.2 与网页通信

- Content script 通过 `chrome.runtime.onMessage` 与 Service Worker 通信
- 无 `window.postMessage` 使用
- 无 `externally_connectable` 声明，外部网页无法与扩展通信

### 5.3 评价

内部通信设计保守，未暴露危险的 IPC 通道。Hp 标记可能用于防止来自其他扩展或网页的伪造消息。

---

## 六、存储安全分析 (Storage Security)

### 6.1 存储位置

| 存储 | 内容 | 风险 |
|------|------|:----:|
| chrome.storage.local | 所有标签页数据、选项 | 低 |
| chrome.storage.session | 临时 UI 状态 | 低 |

### 6.2 敏感数据

- 标签页 URL 和标题存储在 chrome.storage.local 中
- 无密码、token、API key 的硬编码
- 分享功能可能暴露用户浏览历史（需用户主动触发）
- 未发现将敏感数据写入非安全存储的行为

### 6.3 数据加密

- 未使用自定义加密。chrome.storage.local 由 Chrome 自动加密存储
- 分享数据通过 HTTPS 传输（fetch → one-tab.com）
- 使用 `crypto.subtle.digest("SHA-256")` 对 URL 生成短哈希 ID（用于重复检测，非安全目的）

---

## 七、隐私分析 (Privacy)

### 7.1 数据收集

- OneTab 核心功能完全离线工作，不需要网络
- 分享功能需用户主动触发，数据传输前需授权 one-tab.com host 权限
- 无遥测、无分析追踪、无广告 SDK

### 7.2 one-tab.com 数据留存

- 分享页面默认 30 天后过期（`shareExpiryPeriod: "30d"`）
- 用户可随时取消分享（通过扩展删除）
- 离线时取消分享的操作会排队到联网后执行

### 7.3 URL 哈希

使用 SHA-256 对 URL 生成 22 字符的短标识符（`st()` 函数 → 132 位二进制 → 22 字符 base64url）。这不是安全哈希（位宽不够），仅用于 URL 重复检测和索引。

---

## 八、依赖安全分析 (Dependencies)

### 8.1 第三方代码

本扩展**无任何第三方 JS 库或 npm 依赖**。所有 JS 代码为自研。

### 8.2 本地资源

| 资源 | 来源 | 风险 |
|------|------|:----:|
| `fonts/OpenSans-*.woff` | 本地文件 | 低 |
| `images/*.png` | 本地文件（~100+ UI 图标） | 低 |
| `_locales/*/messages.json` | 62 种语言的翻译文件 | 低 |

---

## 九、MV3 合规性检查

| 检查项 | 状态 | 说明 |
|--------|:----:|------|
| Service Worker (非 Event Page) | 通过 | `background.service_worker` |
| 无远程代码执行 | 通过 | CSP `script-src 'self'` |
| 使用 declarativeNetRequest | N/A | 无网络请求拦截功能 |
| 使用 Promise-based API | 通过 | 全 async/await 风格 |
| 无 `unsafe-eval` | 通过 | 无 eval/Function |

---

## 十、安全建议

1. **innerHTML 硬ening**：建议将导入和渲染路径中的 innerHTML 替换为 `textContent` 或 `createTextNode`，仅对受信任的 HTML 片段使用 innerHTML
2. **connect-src CSP**：建议显式添加 `connect-src 'self' https://www.one-tab.com` 限制 fetch 目标
3. **host 权限最小化**：one-tab.com 的 optional_host_permissions 可缩小到具体路径（如 `https://www.one-tab.com/page/*`）
4. **URL 哈希增强**：用于去重的 URL 短哈希（132bit）可考虑使用完整 SHA-256 以增强抗碰撞性
