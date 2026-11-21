# Codex 扩展架构分析文档

> 基于 Codex v1.1.5 (Manifest V3) Chrome 扩展源码逆向工程
> 输出目录: `dsv4` | 分析日期: 2026-07-06

---

## 一、项目概述

Codex 是 OpenAI 开发的 Chrome 浏览器扩展，实现 **AI 驱动的浏览器自动化代理 (Agent)**。它允许 AI 模型通过原生消息通信 (Native Messaging) 与浏览器深度交互，能够操控标签页、模拟鼠标输入、注入内容脚本、执行 CDP 命令、获取页面 DOM 快照等。视觉上通过覆盖层渲染 Agent 光标的平滑动画，并通过 Favicon 徽章反馈代理状态。

- **名称**: Codex
- **版本**: 1.1.5
- **扩展 ID**: (动态生成，每实例唯一)
- **平台**: Chrome MV3
- **构建工具**: Vite (单文件打包)
- **UI 框架**: 原生 + Tailwind CSS v4 + OpenAI Design System (CDN 字体)
- **原生消息主机**: `com.openai.codexextension`

---

## 二、文件清单

```
dist/
├── manifest.json                  # MV3 清单
├── background.js                  # Service Worker (主逻辑 ~145KB minified)
├── popup.html                     # 弹出窗口入口
├── chunks/
│   └── popup-CTe__03-.js          # Vite chunk: popup SPA 逻辑
├── assets/
│   └── popup-DzS88qVA.css         # Tailwind CSS v4 + OpenAI Design System
├── content-scripts/
│   └── codex.js                   # 内容脚本 (WXT 框架构建)
├── images/
│   ├── icon16.png / icon32.png / icon48.png / icon128.png
│   └── cursor-chat.png            # Agent 光标素材
└── _metadata/
    └── verified_contents.json     # Chrome Web Store 验证数据
```

---

## 三、权限模型

### 3.1 清单权限

```
permissions: [
  alarms,          bookmarks,      debugger,
  downloads,       downloads.ui,   favicon,
  history,         nativeMessaging, notifications,
  readingList,     scripting,      sessions,
  storage,         tabGroups,      tabs,
  topSites
]
```

### 3.2 主机权限

```
host_permissions: ["<all_urls>"]
```

### 3.3 CSP (内容安全策略)

```
script-src  'self'
object-src  'none'
connect-src 'self'
            http://127.0.0.1:*
            http://localhost:*
            ws://127.0.0.1:*
            ws://localhost:*
font-src    'self' https://cdn.openai.com
```

**关键发现**: CSP 允许与本地主机的 HTTP 和 WebSocket 连接，这是原生消息通信之外的第二条通信通道。

### 3.4 动态权限

代码中引用了 `sidePanel` 权限（通过 `chrome.sidePanel.*` API），但未在清单中显式声明——可能通过 Chrome 的权限 API 动态请求。

---

## 四、核心架构

### 4.1 架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                         Native App (AI)                          │
│                     (桌面端 AI 助手/CLI)                          │
└──────────────────────┬───────────────────────────────────────────┘
                       │ Standard I/O
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                 Native Messaging Host                            │
│            (com.openai.codexextension)                           │
│          Windows: 注册表 JSON manifest                           │
│          macOS:    ~/Library/Application Support/...             │
└──────────────────────┬───────────────────────────────────────────┘
                       │ chrome.runtime.connectNative()
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Background Service Worker                     │
│                      (background.js)                             │
│                                                                  │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │ NativeTransport  │  │  CDP Executor    │  │ Tab Manager    │  │
│  │                  │  │                  │  │                │  │
│  │ - connectNative  │  │ - debugger.attach│  │ - tabs.query   │  │
│  │ - auto-reconnect │  │ - debugger.detach│  │ - tabs.create  │  │
│  │ - heartbeat/ping │  │ - sendCommand()  │  │ - tabs.group   │  │
│  │ - request/notify │  │ - Page domain    │  │ - tabGroups.*  │  │
│  │                  │  │ - Target domain  │  │ - windows.*    │  │
│  │ + localhost WS    │  │ - Emulation dom. │  │ - sessions.*   │  │
│  └────────┬─────────┘  └────────┬─────────┘  └───────┬────────┘  │
│           │                     │                     │           │
│  ┌────────┴─────────────────────┴─────────────────────┴────────┐ │
│  │                      Message Router                         │ │
│  │  AGENT_CURSOR_STATE / CONTENT_PING / TAB_FAVICON_BADGE     │ │
│  │  GET_AGENT_CURSOR_STATE / GET_NATIVE_HOST_STATUS            │ │
│  └─────────────────────────────────────────────────────────────┘ │
└───────────────────┬───────────────────┬──────────────────────────┘
                    │                   │
        chrome.tabs.sendMessage  chrome.scripting.executeScript
                    │                   │
                    ▼                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Content Script (每页面)                        │
│                   (content-scripts/codex.js)                     │
│                                                                  │
│  ┌──────────────────────┐  ┌─────────────────────────────────┐  │
│  │   Agent Cursor 覆盖层 │  │    Favicon Badge Manager        │  │
│  │                      │  │                                 │  │
│  │  - Shadow DOM 隔离   │  │  - active/deliverable/handoff    │  │
│  │  - 弹簧物理动画      │  │  - SVG 合成图标注入             │  │
│  │  - Bezier 路径光标   │  │  - 状态清理与恢复              │  │
│  │  - z-index: 2147483646│ │  - data-codex-favicon-badge 标记 │
│  │  - 光标素材: cursor-  │  │                                 │  │
│  │    chat.png + 发光    │  │                                 │  │
│  └──────────────────────┘  └─────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 模块划分

| 模块 | 位置 | 职责 |
|------|------|------|
| **NativeTransport** | background.js | 原生消息通道：连接/重连/心跳/请求-响应 |
| **CDP Executor** | background.js | Chrome DevTools Protocol 执行器：attach/detach/sendCommand |
| **Tab Manager** | background.js | 标签页生命周期管理：创建/关闭/分组/租约 |
| **Window Manager** | background.js | 窗口管理：创建/焦点/关闭 |
| **Session Manager** | background.js | AI 会话与轮次管理 |
| **Favicon Badge Manager** | content-scripts/codex.js | 标签图标状态徽章 |
| **Agent Cursor Overlay** | content-scripts/codex.js | Agent 光标动画覆盖层 |
| **Popup UI** | popup.html + chunks/ | 弹出窗口界面 (SPA) |
| **Side Panel** | background.js (chrome.sidePanel) | 侧边栏管理 |

---

## 五、核心通信协议

### 5.1 原生消息通信 (Native Messaging)

**通道标识**: `com.openai.codexextension`

NativeTransport 类实现了一个完整的单向异步 RPC 通道：

- **连接**: `chrome.runtime.connectNative("com.openai.codexextension")`
- **请求模式**: `sendRequest(type, params)` → 返回 Promise
- **通知模式**: `sendNotification(type, params)` → 无返回
- **心跳**: `ping()` → `"pong"`
- **自动重连**: 断连后自动重连，使用 `chrome.alarms` 调度
- **状态广播**: 连接状态通过 `chrome.runtime.onMessage` 向外广播

### 5.2 扩展内部消息

| 消息类型 | 方向 | 用途 |
|---------|------|------|
| `AGENT_CURSOR_STATE` | BG → CS | 更新 Agent 光标状态 |
| `AGENT_CURSOR_ARRIVED` | CS → BG | 光标抵达动画完成通知 |
| `GET_AGENT_CURSOR_STATE` | CS → BG | 内容脚本查询光标状态 |
| `CONTENT_PING` | BG → CS | 检测内容脚本存活 |
| `TAB_FAVICON_BADGE` | BG → CS | 更新单个标签 Favicon 徽章 |
| `TAB_FAVICON_BADGES` | BG → CS | 批量更新 Favicon 徽章 |
| `TAB_LEASES` | 内部 | 标签租约管理 |
| `TAB_GROUPS` | 内部 | 标签组管理 |
| `USER_CANCELED` | 内部 | 用户取消操作 |
| `GET_NATIVE_HOST_STATUS` | 内部 | 查询原生主机连接状态 |

### 5.3 WebSocket/HTTP localhost 通道

CSP 声明了 `connect-src` 对 `localhost` / `127.0.0.1` 的 HTTP 和 WebSocket 访问。这表明扩展还有第二条通信通道——可能用于大文件传输、流式响应或实时事件推送，绕过原生消息的字节限制。

---

## 六、CDP 集成

### 6.1 使用的 CDP 域

| 域 | 用途 |
|----|------|
| **Target** | `getTargets` — 获取可调试目标列表 |
| **Emulation** | `setDeviceMetricsOverride` — 控制视口尺寸 |
| **Page** | (推测) 页面导航、截图 |
| **Input** | (推测) 鼠标/键盘事件注入 |
| **Runtime** | (推测) JavaScript 执行 |

### 6.2 调试器管理

- `chrome.debugger.attach()` — 附加调试器到标签页
- `chrome.debugger.detach()` — 分离调试器
- `chrome.debugger.sendCommand()` — 发送 CDP 命令
- `chrome.debugger.onEvent` — 接收 CDP 事件
- `chrome.debugger.onDetach` — 监听分离事件
- `chrome.debugger.getTargets()` — 获取调试目标

---

## 七、Agent 光标动画系统

### 7.1 动画物理引擎

内容脚本 `content-scripts/codex.js` 包含一个完整的 **弹簧物理动画系统**：

- **状态变量**: positionX/Y, rotation, stretch, scootAxis, scootRotation, visibility
- **弹簧参数**: dampingFraction + response (标准二阶段弹簧模型)
- **路径类型**:
  - **Bezier 路径**: 长距离移动时，通过多次候选采样选择最优三次贝塞尔路径，包含 arc 弧线参数
  - **Scoot 路径**: 短距离微调，带旋转目标
- **渲染**: 60fps requestAnimationFrame 循环
- **光标材质**: `images/cursor-chat.png` + CSS drop-shadow 蓝光效果

### 7.2 覆盖层技术

- **Shadow DOM**: `attachShadow({mode: "closed"})` 隔离样式
- **Z-index**: `2147483646` (最高层级)
- **定位**: `position: fixed; inset: 0; pointer-events: none`
- **MutationObserver**: 检测 DOM 变化，防止覆盖层被移除
- **VisualViewport API**: 自适应移动端视口变化

---

## 八、Favicon 徽章系统

### 8.1 状态类型

| 徽章 | 视觉 | 含义 |
|------|------|------|
| `active` | 黑色光标图标 + 白色背景降低透明度 | AI 正在当前标签页操作 |
| `deliverable` | 绿色圆点 | AI 已完成操作/有交付物 |
| `handoff` | 黄色圆点 | AI 等待用户交互/交接 |

### 8.2 实现技术

- 使用 `data:image/svg+xml` 编码合成 SVG 替换原有 favicon
- 通过 `data-codex-favicon-badge="true"` 标记管理
- 存储 `data-codex-original-favicon-href` 用于恢复
- 清理逻辑: 内容脚本销毁时恢复原始 favicon

---

## 九、标签管理高级特性

### 9.1 标签租约 (Tab Leases)

Codex 实现了标签租约机制，防止多个 AI 会话同时操作同一个标签。租约包含 `sessionId` 和获取时间戳。

### 9.2 标签组

- 通过 `chrome.tabs.group()` / `chrome.tabGroups.*` 管理
- 支持在 AI 操作期间将相关标签自动分组

### 9.3 窗口管理

- `chrome.windows.create()` — 创建窗口
- `chrome.windows.getCurrent()` — 获取当前窗口
- `codexSidePanelOpenWindowIds` — 跟踪 Side Panel 打开的窗口
- Debugger 会话按窗口组织

---

## 十、存储

| 存储区 | 用途 |
|--------|------|
| `chrome.storage.local` | 持久化数据：标签租约、配置、JWT、更新版本号 (`codexPendingUpdateVersion`) |
| `chrome.storage.session` | 会话数据：会话状态、原生主机连接状态缓存 |

---

## 十一、非活跃功能推断

以下清单权限在当前源码中 **未发现直接调用**（可能在未加载的代码分支或计划功能中）:

- `notifications` — 未发现 `chrome.notifications.*` 调用
- `readingList` — 未发现 `chrome.readingList.*` 调用  
- `topSites` — 未发现 `chrome.topSites.*` 调用
- `favicon` — 未发现 `chrome.favicon` 调用（使用自定义 SVG favicon 系统替代）

---

## 十二、技术栈总结

| 层级 | 技术 |
|------|------|
| 构建 | Vite (Chrome Extension 专用配置) |
| 框架 | WXT (内容脚本模块注册) |
| UI | Tailwind CSS v4 + OpenAI Design System |
| 动画 | 自研弹簧物理引擎 (Spring + Bezier) |
| 通信 | Chrome Native Messaging + WebSocket (localhost) |
| 协议 | Chrome DevTools Protocol (CDP) |
| 字体 | OpenAI Sans (cdn.openai.com) |
| 存储 | chrome.storage (local + session) |
