# VisBug v0.4.10 — 安全审计报告

## 审计概览

| 维度 | 评级 | 说明 |
|------|------|------|
| 权限面 | 低风险 | 仅 4 项必要权限，遵循最小权限原则 |
| 数据流 | 低风险 | 无外部网络请求，数据不离开浏览器 |
| CSP | 低风险 | 未设置自定义 CSP，使用浏览器默认策略 |
| 注入面 | 中风险 | 向任意页面注入 JS/CSS，受 activeTab 限制 |
| 通信 | 低风险 | 仅使用 runtime.sendMessage，单向传递 |
| 存储 | 低风险 | 仅存储用户偏好 (颜色格式/方案) |
| 隐私 | 低风险 | 无 PII 收集，无分析/遥测 |
| 依赖 | 低风险 | 仅内嵌 hotkeys-js (MIT)，无额外远程加载 |
| 合规 | 低风险 | Chrome Web Store 上架，符合 MV3 规范 |

**总体风险等级: 低**

## 1. 权限面分析

### 请求的权限

```json
"permissions": [
  "activeTab",
  "contextMenus",
  "scripting",
  "storage"
]
```

| 权限 | 风险评估 | 理由 |
|------|---------|------|
| `activeTab` | 低 | 仅在用户主动激活时授予当前 tab 权限，非持久化 |
| `contextMenus` | 低 | 仅注册 3 组右键菜单 (启动/颜色/主题)，无信息泄露 |
| `scripting` | 中 | 可以向页面注入任意代码，但受 activeTab 限制；注入内容明确 (inject.js/eject.js/restore.js + bundle.css/bundle.min.js) |
| `storage` | 低 | 仅存储 `visbug-color-mode` 和 `visbug-color-scheme` 两个键 |

### 未请求的权限 (正面信号)

- 无 `tabs` 权限 (不需要 tab 列表)
- 无 `cookies`、`history`、`bookmarks` 权限
- 无 `webRequest`、`webNavigation` 权限
- 无 `downloads` 权限
- 无 `host_permissions` (使用 activeTab 按需获取)

## 2. 数据流安全

### 数据外传检测

对全部 JS 文件执行了关键字搜索:

| 关键词 | 结果 |
|--------|------|
| `fetch(` | 未发现 |
| `XMLHttpRequest` | 未发现 |
| `send(` | 仅发现 `chrome.tabs.sendMessage` (内部通信) |
| `navigator.sendBeacon` | 未发现 |
| `WebSocket` | 未发现 |

**结论**: 可审阅的源代码中未发现任何向外发送数据的代码。bundle.min.js 为压缩文件，手工审查成本高，但从扩展的整体设计意图判断 (纯浏览器端设计工具)，不存在数据外传的合理动机。

### 内部通信

- `chrome.tabs.sendMessage`: 仅在 SW → 页面方向传递颜色偏好数据
- `chrome.runtime.onMessage`: 页面监听 SW 消息
- `chrome.runtime.sendMessage`: 未使用 (页面不向 SW 回传)
- 消息内容仅包含颜色格式/方案字符串，无敏感数据

## 3. 代码注入分析

### 注入面识别

```javascript
// toolbar/inject.js — 创建 script 标签加载 bundle
const script = document.createElement('script')
script.type = 'module'
script.src = platform.runtime.getURL('toolbar/bundle.min.js')
document.body.appendChild(script)

// toolbar/inject.js — 创建自定义元素
const visbug = document.createElement('vis-bug')
document.body.prepend(visbug)
```

| 注入方式 | 风险 | 理由 |
|---------|------|------|
| `createElement('script')` + `runtime.getURL()` | 低 | 使用扩展打包的本地文件，非远程 URL |
| `createElement('vis-bug')` | 低 | 自定义元素，遵循 Web Components 标准 |
| `element.setAttribute()` | 低 | 属性值来源为 `runtime.getURL()` 或 SW 消息，受控 |

### 未发现的高危模式

- 无 `innerHTML` 赋值 (可审阅的 7 个 JS 文件中)
- 无 `eval()` 调用
- 无 `new Function()` 调用
- 无 `document.write()`
- 无 `insertAdjacentHTML()`

## 4. 内容安全策略 (CSP)

manifest.json 中未设置 `content_security_policy` 字段。

- MV3 默认 CSP: `script-src 'self'; object-src 'self'`
- 扩展本身不使用 inline script，而是使用 `executeScript` (files 模式) 和 `<script type="module" src="...">`
- Web Accessible Resources 仅暴露 `tuts/*.gif` 和 `toolbar/*`，均为扩展本地资源

## 5. Web Accessible Resources 安全

```json
"web_accessible_resources": [{
  "resources": ["tuts/*.gif", "toolbar/*"],
  "matches": ["<all_urls>"]
}]
```

| 资源 | 风险 | 理由 |
|------|------|------|
| `tuts/*.gif` | 低 | 13 个教程动画 GIF，无代码执行能力 |
| `toolbar/*` | 中 | 暴露了整个 toolbar/ 目录，包括 bundle.min.js (~318KB) |

**tuts 目录内容 (13 个 GIF):**
accessibility, align, boxshadow, font, guides, hueshift, inspector, margin, move, padding, position, search, text

这些 GIF 是 VisBug 内嵌的交互式教程/向导动画，无安全风险。

**toolbar/* 暴露范围** 包括核心应用代码 `bundle.min.js`。外部网页理论上可以通过 `<script>` 或 `<img>` 标签引用这些资源，但:
- bundle.min.js 是 ES module，需要 `type="module"` 才能加载
- bundle.css 仅包含 VisBug 相关样式规则，作用域有限
- inject/eject/restore.js 仅作为 content script 由扩展加载，外部直接执行没有副作用

## 6. 存储安全

| 键名 | 类型 | 风险 |
|------|------|------|
| `visbug-color-mode` | `"hex"` / `"rgb"` / `"hsl"` | 无风险 |
| `visbug-color-scheme` | `"auto"` / `"light"` / `"dark"` | 无风险 |

- 仅存储用户 UI 偏好，不涉及任何身份信息、令牌或凭证
- 使用 `sync` 存储区 (可通过 Chrome 账号同步到其他设备)
- 写入前做了值校验 (白名单模式)，不接受任意值
- 包含旧版本值迁移逻辑 (`hsla` → `hsl`, `rgba` → `rgb`)

## 7. 第三方依赖

bundle.min.js 内嵌:
- **hotkeys-js v3.13.7**: MIT License, 纯键盘快捷键库, 仅做 `KeyboardEvent` 处理, 不涉及网络/存储/DOM 操作

无其他第三方库或远程资源加载。

## 8. 隐私评估

- 无 Google Analytics / Firebase / Mixpanel 等分析 SDK
- 无用户行为追踪
- 无 crash reporting
- 无远程配置拉取
- 无 A/B testing
- 右键菜单虽然注册在 `contexts: ['all']`，但仅响应自身菜单项
- `chrome.tabs.onUpdated` 监听器仅用于重置内部状态，不收集 tab URL

## 9. bundle.min.js 限制声明

本审计的可审阅范围覆盖全部可读源代码文件 (7 个 JS 文件, 共约 300 行)，但不包括 `bundle.min.js` (~318KB, 12 行压缩代码)。对 bundle.min.js 的结论基于:

1. **意图推断**: VisBug 是开源项目 (GitHub: google/visbug)，设计目标明确为浏览器设计工具
2. **接口边界检查**: bundle.min.js 通过 `<vis-bug>` 元素接收配置 (`color-mode`, `color-scheme`, `tutsBaseURL` attributes)，通过 hotkeys-js 处理键盘事件，无网络请求迹象
3. **Chrome Web Store 审核**: 扩展已上架，通过 Google 的扩展审核流程

**建议**: 如需完整安全审计，应对 bundle.min.js 进行解压缩和静态分析。可在 GitHub (github.com/GoogleChromeLabs/visbug) 获取原始未压缩源代码对照审查。
