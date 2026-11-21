# Redux DevTools v3.2.10 — 安全审计报告

## 审计概要

| 维度 | 评级 | 说明 |
|------|------|------|
| 权限面 | 中 | host_permissions 覆盖所有 URL + 文件系统 |
| 数据流 | 中 | 应用完整 state 在多个上下文间传递 |
| CSP | 中 | `style-src * unsafe-inline` 存在样式注入风险 |
| 注入面 | 中 | Content script 注入到所有页面 |
| 通信安全 | 低 | postMessage 使用 `"*"` 通配符源 |
| 存储安全 | 低 | 仅使用 chrome.storage.sync，无敏感数据 |
| 隐私 | 低 | 所有处理在本地，无外部网络请求 |
| 依赖 | 低 | 内嵌 React 18.3.1 + jsan，无运行时外部请求 |
| 合规 | 低 | 开源项目 (MIT)，行为透明 |

---

## 1. 权限面分析

### Manifest 声明的权限

| 权限 | 风险 | 评估 |
|------|------|------|
| `notifications` | 低 | 仅用于错误通知，不泄露信息 |
| `contextMenus` | 低 | 仅添加 "Open DevTools" / "Remote DevTools" 菜单项 |
| `storage` | 低 | 存储用户选项（过滤规则、maxAge、编辑器配置等） |
| `file:///*` | 中 | 允许调试本地文件系统页面 |
| `http://*/*` | 中 | 允许在任何 HTTP 页面运行 |
| `https://*/*` | 中 | 允许在任何 HTTPS 页面运行 |

### 隐式能力

- **externally_connectable**: `ids: ["*"]` 允许任何已安装扩展发送消息。这增加了跨扩展通信的攻击面，但 Redux DevTools 需要此能力以支持其他扩展集成。
- **双 Content Script**: 在 ISOLATED 和 MAIN world 各注入一段脚本，MAIN world 脚本可完全访问页面 JS 上下文。

---

## 2. 数据流安全

### 跨上下文消息流

```
Page State → jsan serialize → postMessage → Content Script → chrome.runtime.sendMessage → Background SW → DevTools Panel
```

- **数据量**: 应用的完整 Redux state 被序列化并在进程间传递
- **敏感数据风险**: 如果应用 state 中包含 token、密码、PII 等敏感字段，这些数据会经过 postMessage 和 Chrome runtime 通道，可能被其他扩展通过 `externally_connectable` 拦截
- **缓解措施**: 可通过 `stateSanitizer` 和 `actionSanitizer` 配置项清洗敏感数据

### URL 过滤

- 默认排除 `https://www.google*` (exclude_globs)
- 支持自定义 URL 过滤正则 (options.urls)
- 支持 per-domain 过滤规则

---

## 3. CSP (Content Security Policy)

```
script-src 'self'; object-src 'self'; style-src * 'unsafe-inline'; img-src 'self' data:;
```

| 指令 | 评估 |
|------|------|
| `script-src 'self'` | 安全: 禁止内联脚本和外部脚本 |
| `object-src 'self'` | 安全: 禁止 Flash/插件 |
| `style-src * 'unsafe-inline'` | 风险: 允许任意来源样式和内联样式，可能导致 CSS 注入 |
| `img-src 'self' data:` | 安全: 仅允许自身图片和 data URI |

**注意**: `style-src * 'unsafe-inline'` 是为 React 组件内联样式和 CodeMirror 主题动态样式所必需的折中。

---

## 4. 注入面分析

### Content Script 注入范围

- 匹配模式: `<all_urls>` (所有 HTTP/HTTPS + 文件页面)
- 排除: `https://www.google*`
- 所有 frames: `true`
- 运行时机: `document_start` (页面加载前)

### 注入到页面的 API

`page.bundle.js` 在 MAIN world 中注入以下全局对象:

```javascript
window.__REDUX_DEVTOOLS_EXTENSION__
window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__
```

这些 API 仅在页面主动调用时生效，不会自动修改页面行为。

### 动态代码执行

在 `page.bundle.js` 中找到以下动态代码执行:

```javascript
// 从字符串反序列化 action creator 函数
var Ge = e => new Function("return " + e)();

// 执行远程调用的 action
function He(e, t) {
  if (typeof e == "string") return new Function("return " + e)();
  let r = t[e.selected].func;
  let n = Ft(e.args, e.rest);
  return r(...n);
}
```

**风险**: 如果攻击者能向 DevTools Panel 发送恶意构造的 dispatch 消息，可能通过 `new Function()` 执行任意代码。但攻击前提是需要能接触到 DevTools Panel 的消息通道。

---

## 5. 通信安全

### postMessage 安全

`content.bundle.js` 和 `page.bundle.js` 使用 `window.postMessage(data, "*")` 进行通信:

```javascript
// page.bundle.js (MAIN world)
window.postMessage(e, "*");

// content.bundle.js (Isolated world)
window.postMessage(e, "*");
```

**风险**: `"*"` 通配符允许任何窗口接收消息。虽然消息有 `source` 字段 (`@devtools-extension` / `@devtools-page`) 用于校验来源，但恶意页面可以伪造这些字段。

**消息源校验** (content.bundle.js):
```javascript
function b(e) {
  if (!x() || !e || e.source !== window || typeof e.data !== "object") return;
  let t = e.data;
  if (t.source === I) { // "@devtools-page"
    // 处理消息
  }
}
```

- 检查 `e.source !== window` 防止跨源消息
- 检查 `t.source === "@devtools-page"` 过滤消息类型
- 该实现基本安全，因为 `e.source` 仅在同源 window 之间匹配

### chrome.runtime 通信

扩展内部通信使用 `chrome.runtime.connect()` 创建长连接 port，这是 Chrome 扩展的安全 IPC 机制，通信局限于扩展自身进程。

---

## 6. 存储安全

### chrome.storage.sync 中存储的数据

| 键名 | 内容 | 敏感度 |
|------|------|--------|
| `useEditor` | 编辑器类型 (0-3) | 无 |
| `editor` | 编辑器路径 | 低 |
| `projectPath` | 项目路径 | 低 |
| `maxAge` | 最大 action 数 | 无 |
| `filter` | 过滤模式 | 无 |
| `allowlist` | 允许列表正则 | 无 |
| `denylist` | 拦截列表正则 | 无 |
| `shouldCatchErrors` | 错误捕获开关 | 无 |
| `inject` | 注入开关 | 无 |
| `urls` | URL 过滤正则 | 无 |
| `showContextMenus` | 右键菜单开关 | 无 |

所有存储数据均为用户配置，不包含应用 state 或用户身份信息。

### localStorage (仅 Electron 降级模式)

当检测到 Electron 环境时，使用 localStorage 作为 chrome.storage.local 的降级方案。调试会话 (`redux-dev-session-{id}`) 可能被写入 localStorage，包含应用 state 快照。

---

## 7. 隐私分析

- **无外部网络请求**: 所有代码在本地运行，不向任何远程服务器发送数据
- **无分析/追踪**: 不包含 Google Analytics 或类似追踪代码
- **State 数据**: 应用 state 数据仅在本地进程间传递，不会离开浏览器
- **Remote DevTools**: 远程连接功能需要用户主动配置，默认不启用

---

## 8. 依赖审计

所有依赖内嵌于 webpack bundle 中，无运行时外部加载:

| 依赖 | 版本 | 许可证 | 审计 |
|------|------|--------|------|
| React | 18.3.1 | MIT | 生产版本，无已知漏洞 |
| react-dom | 18.3.1 (推测) | MIT | 生产版本 |
| jsan | 内嵌 | MIT | 序列化库，无 eval |
| Lodash (debounce) | 内嵌 | MIT | 仅使用 debounce 函数 |
| CodeMirror | 内嵌 | MIT | 代码编辑器，用于 JSON 查看 |

---

## 9. 合规性

- **许可证**: MIT (https://github.com/reduxjs/redux-devtools)
- **源代码公开**: 是，GitHub 托管
- **第三方库声明**: webpack bundle 末尾有 lodash 许可证声明
- **行为透明**: 功能与其声明一致，无隐藏行为

---

## 风险总结与建议

### 高风险项

1. **`new Function()` 动态代码执行**: `page.bundle.js` 中 `ACTIONS` dispatch 路径使用 `new Function()` 执行远程传来的函数体字符串。这是最大的潜在风险点。建议在生产环境中通过 `features.dispatch: false` 禁用。

### 中风险项

2. **`postMessage` 使用 `"*"` targetOrigin**: 虽然做了来源校验，但最佳实践应限定 target origin。
3. **`externally_connectable: ids: ["*"]`**: 允许任何扩展通信，可能被恶意扩展利用。
4. **`style-src * 'unsafe-inline'`**: 过于宽松的样式 CSP。

### 低风险项

5. **host_permissions 覆盖所有 URL**: 调试工具的性质决定了这一点不可避免。
6. **页面全局 API 注入**: 仅在页面显式调用时激活，不影响不使用 Redux DevTools 的页面。

### 总体评级: 中低风险

作为开发者工具，Redux DevTools 的安全设计合理：功能所需的最小权限集、本地处理、无外部通信。主要风险来自动态代码执行路径和宽松的跨扩展通信策略，这些可通过配置项缓解。
