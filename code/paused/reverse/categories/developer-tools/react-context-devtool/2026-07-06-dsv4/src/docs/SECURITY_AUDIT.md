# React Context DevTool v4.4 — 安全审计

## 审计概述

| 维度 | 评级 | 摘要 |
|------|------|------|
| 权限面 | 中 | `<all_urls>` 对所有站点有效，但工具用途合理 |
| 数据流 | 低 | 数据仅在本地扩展内部流转，无外传 |
| CSP | 低 | 严格 `script-src 'self'; object-src 'self'` |
| 注入面 | 中 | 向 MAIN world 注入代码，通过 postMessage 接收用户页面数据 |
| 通信安全 | 中 | `*` 通配符 targetOrigin，依赖 source 检查 |
| 存储安全 | 低 | 仅存储设置，无敏感数据 |
| 隐私 | 低 | 不收集 PII，不包含分析/遥测 |
| 依赖安全 | 中 | React 生产构建，CodeMirror/jsondiffpatch 内嵌 |
| 合规 | 低 | 纯本地工具，无 GDPR/CCPA 风险 |

---

## 1. 权限面分析

### 声明权限

```json
{
  "permissions": ["storage", "scripting"],
  "host_permissions": ["<all_urls>"]
}
```

| 权限 | 必要性 | 风险评估 |
|------|--------|----------|
| `storage` | 必要（保存用户设置） | 低 — 仅本地存储 |
| `scripting` | 必要（注入 mainContent.js 到 MAIN world） | 中 — 可在任意页面执行脚本 |
| `<all_urls>` | 必要（React 可能在任何站点运行） | 中 — 但符合 DevTools 类扩展的典型模式 |

### 分析结论

- `scripting` + `<all_urls>` 组合理论上允许扩展在任意页面注入任意脚本，但该扩展仅注入固定的 `mainContent.js`，无远程代码拉取行为。
- 未声明 `tabs`、`cookies`、`webRequest` 等高危权限。
- 未声明 `"matches": ["<all_urls>"]` 之外的受限权限。

---

## 2. 数据流安全

### 数据流向审计

| 来源 | 去向 | 数据类型 | 是否外传 |
|------|------|----------|----------|
| React Fiber 树 | mainContent.js | Context 值、useReducer state/action | 否 |
| mainContent.js | Content Script (ISOLATED) | 序列化后的 JSON 数据 | 否（同进程） |
| Content Script | Background SW | 同上（Chrome 内部消息） | 否 |
| Background SW | DevTools Panel / Popup | 同上（Chrome 内部端口） | 否 |

### 外传检查

- 代码中搜索 `fetch(`、`XMLHttpRequest`、`send(`、`WebSocket`、`navigator.sendBeacon`：**未发现任何外传代码**。
- 扩展不包含分析/遥测/错误上报端点。
- 无 `<img>` 或 `<script>` 标签引用外部 URL。

---

## 3. Content Security Policy

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```

- **script-src 'self'**：仅允许扩展自身打包的脚本执行，阻止 inline script 和远程脚本加载。
- **object-src 'self'**：阻止 Flash/ActiveX 等插件内容。
- 无 `unsafe-eval` 或 `unsafe-inline` 放宽。
- **评级：低风险** — CSP 配置符合最佳实践。

---

## 4. 注入面分析

### 4.1 Content Script 注入（injectGlobalHook.js）

- 通过 `manifest.json` 的 `content_scripts` 注册，在 `document_start` 注入 ISOLATED world。
- 无用户可控参数注入。
- 文件来源确定，不动态加载。

### 4.2 MAIN World 注入（mainContent.js）

- 通过 `chrome.scripting.executeScript({ world: 'MAIN' })` 动态注入。
- **风险点**：在 MAIN world 运行意味着可以访问用户页面的所有 JavaScript 对象（包括可能存在的恶意代码）。
- **缓解措施**：
  - 注入脚本是固定代码，内容不可被用户/远程修改
  - 不使用 `innerHTML`、`document.write`、`eval` 等 API
  - 数据序列化使用 `JSON.stringify` + 自定义 replacer（安全处理循环引用、React 节点、WeakMap/WeakSet）

### 4.3 postMessage 接收面

- `injectGlobalHook.js` 监听来自页面的 `window.postMessage`：
  ```javascript
  window.addEventListener("message", async (t) => {
    if (t.source === window) {
      // 处理 CONTEXT_DATA_UPDATED 事件
    }
  });
  ```
- **风险点**：任何页面脚本都可以向扩展发送消息，消息内容不可信。
- **缓解措施**：
  - `t.source === window` 检查确保消息来自同源窗口
  - 消息通过 `type` 字段鉴别来源
  - 处理函数内部有 try-catch 包裹
  - 消息数据仅作为 JSON 数据查看，不执行或插入 DOM
- **评级：中** — `*` 通配符 targetOrigin 降低了安全性，但 source 检查 + 数据不执行提供了有效防护。

---

## 5. 通信安全

### 5.1 扩展内部通信

- Content Script ↔ Background：使用 `chrome.runtime.connect` （端口消息），数据不经过网络。
- Background ↔ DevTools/Popup：同上，Chrome 内部 API。
- **评级：低风险** — Chrome 内部消息通道天然隔离。

### 5.2 window.postMessage 通信

- Content Script → 主页面：`window.postMessage(data, "*")`
- **风险点**：使用 `"*"` 作为 `targetOrigin` 意味着任何嵌入的 iframe 也能接收到消息，存在信息泄露可能。
- **实际影响**：发送的消息内容为调试状态控制指令（START_DEBUGGING / STOP_DEBUGGING / DISPATCH_USE_REDUCER_ACTION），不包含用户敏感数据。
- **评级：中** — 建议生产环境使用具体 origin。

---

## 6. 存储安全

### 6.1 chrome.storage.local

存储内容：
```json
{
  "startDebugWhenV2": "extensionLoad" | "pageLoad",
  "debugUseReducer": true | false,
  "debugContext": true | false
}
```

- 仅存储三个布尔/枚举设置项，无 PII（个人身份信息）。
- 无密码、token、API Key 等敏感凭据。

### 6.2 内存中的数据

- Background Service Worker 内存中缓存当前 Tab 的 Context/useReducer 状态。
- Service Worker 可能被浏览器回收（idle timeout），数据自动丢失。
- Tab 关闭时通过 `chrome.tabs.onRemoved` 清理对应数据。

**评级：低风险。**

---

## 7. 隐私评估

| 检查项 | 结果 |
|--------|------|
| 收集 PII？ | 否 — 仅调试用技术数据（React state/context 值） |
| 包含分析/遥测？ | 否 — 未发现任何 `fetch`、`XMLHttpRequest`、`Beacon` 调用 |
| 包含第三方 SDK？ | 否 — 仅开源库（React/CodeMirror/jsondiffpatch/classnames） |
| 数据持久化？ | 仅设置项（3 个键），无用户数据持久化 |
| 用户可清除？ | 是 — `chrome.storage.local.clear()` 或卸载扩展即可 |

---

## 8. 依赖安全

### 内嵌库

| 库 | 版本线索 | 风险 |
|----|---------|------|
| React | 18.x (production.min.js) | 标准生产构建 |
| react-dom | 18.x (production.min.js) | 标准生产构建 |
| classnames | (Jed Watson) | MIT 协议，仅字符串拼接 |
| CodeMirror | 内嵌 CSS (cm-s-material-ocean) | 代码编辑器组件 |
| jsondiffpatch | 内嵌 CSS | JSON diff 组件 |
| Montserrat | 字体文件 (18 变体, .ttf) | OFL 开源字体 |

- 均为知名开源库，无已知恶意依赖。
- 库文件在 webpack 构建时内嵌（非 CDN 远程加载），版本锁定在构建时。

---

## 9. 合规评估

- **GDPR**：不适用 — 不收集、不处理、不存储个人数据。
- **CCPA**：不适用 — 不涉及加州居民个人信息。
- **Chrome Web Store 政策**：符合 — DevTools 类扩展，权限与功能匹配，无隐藏行为。

---

## 10. 安全改进建议

| 优先级 | 建议 | 说明 |
|--------|------|------|
| 中 | postMessage targetOrigin 使用具体 origin | 替换 `"*"` 为 `location.origin`，防止 iframe 窃听 |
| 低 | CSP 添加 `default-src 'self'` | 作为 fallback 增加防御深度 |
| 低 | content script 的 postMessage 监听添加 event.data 结构校验 | 防御恶意页面发送畸形的消息数据 |
