# BewlyBewly 安全审计报告

> **审计范围**: v0.41.2 生产构建产物 (manifest.json + dist/* + assets/*)
> **审计方法**: 静态分析 (无 source map, JS 为 minified 产物)
> **审计级别**: 架构审计 + 权限风险 + 数据流追踪

---

## 一、总体风险评级

| 维度 | 等级 | 说明 |
|------|------|------|
| 权限使用 | 中 | 2 个权限 + 2 个 host_permissions, 用途明确但覆盖面广 |
| 数据外泄风险 | 低 | 所有 API 调用均指向 Bilibili 官方域名, 未发现第三方数据发送 |
| 请求伪造 | 中 | DNR 规则修改 Origin/Referer 头伪装同源请求 |
| CSP 安全 | 中 | extension_pages 有 CSP 配置, 但 content script 不受限制 |
| MAIN world 注入 | 中 | inject 脚本直接操作 window.history, 但仅限于 hook |
| 供应链风险 | 低-中 | 使用已知的 npm 包 (Vue 3, vue-i18n, qrcode.vue, webextension-polyfill), 但无 source map 验证版本一致性 |

---

## 二、权限清单审核

### 2.1 `storage`

**用途**: 保存用户 UI 偏好配置

**风险**: 低
- 存储内容为用户配置 (主题、布局等), 不含敏感凭据
- 没有 `unlimitedStorage` 权限, 数据量受限
- 注意: 如果未来版本加入访问令牌 (access_key) 存储, 风险将显著升高

### 2.2 `declarativeNetRequest`

**用途**: 修改向 Bilibili API 发出的 POST 请求头

**风险**: 中
- 修改 Origin 和 Referer 为目标域名, 本质上是在请求层面伪装来源
- 虽然仅针对 `api.bilibili.com` 和 `passport.bilibili.com`, 但如果 Bilibili 服务端依赖这些头做 CSRF 防护, 规则会削弱防护
- 规则仅作用于 POST + xmlhttprequest + 第三方域, 范围控制良好

### 2.3 `host_permissions`

**范围**: `*.bilibili.com` 和 `*.hdslb.com`

**风险**: 中
- 覆盖 Bilibili 全站, content script 在所有匹配页面运行
- Content script 的 ISOLATED world 无法直接读取页面 JavaScript 变量, 但可以读取和操作 DOM
- MAIN world 的 inject 脚本可以访问页面的所有 JavaScript 上下文

---

## 三、Content Script 安全分析

### 3.1 注入范围

Content script 注入到 **10 个子域名** 的所有页面 (包括 iframe):

| 域名 | 敏感操作 | 风险评估 |
|------|---------|---------|
| `passport.bilibili.com` | 登录/注册/密码 | 可观察登录表单 DOM |
| `account.bilibili.com` | 账号管理 | 可观察账号设置界面 |
| `message.bilibili.com` | 私信 | 可观察私信内容 DOM |
| `www.bilibili.com` | 全功能 | 可观察所有页面内容 |

**注意**: ISOLATED world 的 content script 无法直接读取页面 JS 密码, 但可以通过 DOM 观察用户交互。

### 3.2 MAIN World Inject 脚本

`dist/inject/index.js` 在 MAIN world 执行, 拥有与页面同等的权限:

**已确认操作**:
1. Hook `window.history.pushState` — 低风险, 保留原始函数
2. Hook `window.history.replaceState` — 低风险
3. Hook `window.history.forward` — 低风险
4. 设置 `window.___inject = true` — 无风险 (暴露注入标记)

**未发现操作**:
- 未发现 cookie 读取代码 (无 `document.cookie` 引用)
- 未发现 localStorage/sessionStorage 操作
- 未发现 fetch/XHR 拦截
- 未发现键盘/鼠标事件记录

**验证局限性**: inject/index.js 仅约 50 行 (解构后), 代码量小, 静态分析可信度较高。

### 3.3 Vue 应用 (ISOLATED World)

`dist/contentScripts/index.global.js` 约 7MB (minified), 完整 Vue 3 包含:

- 模板编译 → DOM 创建
- `chrome.runtime.sendMessage` → API 调用
- `window.addEventListener('historyChange', ...)` → 跨 world 通信
- `window.postMessage` → 可能的额外跨 world 通信 (需动态分析确认)

**静态分析局限性**: 7MB minified 代码无法完整人工审计, 以下为基于模式匹配的风险评估:

- 未发现 `eval()` 调用
- 未发现 `document.write()` 调用
- 未发现 `innerHTML` 不当使用 (Vue 使用虚拟 DOM)
- 未发现第三方追踪/分析脚本
- 未发现向非 Bilibili 域名的网络请求

---

## 四、API 代理层安全

### 4.1 请求转发机制

Background Service Worker 充当 API 代理, 将 content script 的请求转发到 Bilibili API:

```
content script → sendMessage → background → fetch → Bilibili API
```

**安全评估**:
- **正面**: 所有 API 域名硬编码在 background 中, 无法被注入脚本篡改
- **正面**: 使用声明式 API 映射表 (`FullAPI`), 不存在动态 URL 构造风险
- **风险**: 如果 Bilibili API 返回的内容包含恶意脚本, Vue 渲染时可能触发 XSS (取决于 Vue 模板是否使用 `v-html`)

### 4.2 Cookie / 认证令牌流

**access_key 参数**: 在 `getAppRecommendVideos` 等 API 中传递 `access_key` 参数。该参数来自 content script 通过 `sendMessage` 发送, 来源可能是:
- 从 Bilibili 页面 DOM 中提取 (Bilibili 自身暴露的)
- 从 `chrome.storage` 读取 (用户之前保存的)
- 从 Bilibili 自身的 `window.__INITIAL_STATE__` 中读取 (MAIN world inject 可获取)

**风险**: 如果 access_key 在 content script 和 background 之间通过消息传递, 理论上其他扩展也可以通过 `chrome.runtime.onMessageExternal` 拦截 (需要验证此扩展是否注册了 external 消息监听)。

**验证结果**: background 使用 `chrome.runtime.onMessage` (非 external), 不响应外部扩展消息。

---

## 五、CSP 分析

### 5.1 Extension Pages CSP

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```

- **范围**: 仅适用于 options page (`dist/options/index.html`) 和 popup (`dist/popup/index.html`)
- **script-src 'self'**: 禁止内联脚本和远程脚本加载
- **object-src 'self'**: 禁止 `<object>` / `<embed>` 加载外部插件

### 5.2 Content Script CSP

Content script 不受 `extension_pages` CSP 限制, 其有效安全边界是:
1. **ISOLATED world**: JavaScript 执行环境与页面隔离
2. **但**: Content script 创建的 DOM 元素可能与页面 DOM 交互

### 5.3 Web Accessible Resources

```json
"web_accessible_resources": [
  {
    "resources": ["dist/contentScripts/style.css", "assets/*"],
    "matches": ["<all_urls>"]
  }
]
```

- `assets/*` 对所有 URL 可访问 — 包括字体文件、图标等
- 风险: 低, 这些是静态资源, 不含可执行代码
- 注意: 任何网站都可以在 `<link>` 中引用扩展的 CSS 文件, 但 CSS 本身不含敏感信息

---

## 六、威胁模型

### 6.1 攻击面

| 攻击向量 | 可行性 | 影响 |
|---------|--------|------|
| 恶意 Bilibili 页面利用 content script 漏洞 | 低 | 中 (可影响渲染 UI) |
| 其他 Chrome 扩展利用消息通信 | 极低 | 低 (仅使用 onMessage, 不暴露 external) |
| XSS 通过 API 返回内容 | 低 | 中 (取决于 Vue 模板安全性) |
| Supply chain: 恶意 npm 包注入 | 中 | 高 (完整扩展权限) |
| 浏览器漏洞利用 (sandbox escape) | 极低 | 极高 |

### 6.2 信任边界

```
┌─ 不信任区域 ─────────────────────────┐
│ Bilibili 页面 JavaScript (MAIN world) │
│ Bilibili API 响应内容                  │
│ 用户输入的 URL/data                    │
└───────────────────────────────────────┘
                │
        ┌───────┴───────┐
        │  inject 脚本   │ ← 仅 hook history, 无数据流入
        └───────┬───────┘
                │ CustomEvent('historyChange')
        ┌───────┴───────┐
        │ Content Script │ ← Vue 渲染, 信任边界在此
        └───────┬───────┘
                │ chrome.runtime.sendMessage
        ┌───────┴───────┐
        │   Background   │ ← API 代理, 仅转发到 Bilibili
        └───────────────┘
```

---

## 七、改进建议

### 7.1 高优先级
1. **access_key 保护**: 避免在 content script 与 background 之间明文传递 access_key, 考虑仅在 background 中读取 cookie
2. **API 响应消毒**: 在 Vue 渲染 API 返回的 HTML/文本前进行 HTML 实体编码, 避免 `v-html` 造成的 XSS
3. **DNR 规则收紧**: 将 `urlFilter` 精确到具体 API 路径, 而非整个域名

### 7.2 中优先级
4. **host_permissions 最小化**: 考虑使用 `activeTab` 或更精确的 match 替代 `*://*.bilibili.com/*`
5. **WAR 收紧**: `assets/*` 下的 `<all_urls>` 改为具体的 Bilibili 域名匹配
6. **Source map 发布**: 发布 source map 以便用户和审核者验证构建产物与源码一致

### 7.3 低优先级
7. **Content script 注入时机**: 考虑将非必需页面从内容脚本 match 中移除 (如 `passport.bilibili.com`)
8. **依赖版本锁定**: 在构建产物中包含 lockfile, 以便验证依赖完整性
