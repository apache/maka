# Redux DevTools v3.2.10 — 架构文档

## 概述

Redux DevTools 是一个 Chrome 扩展 (Manifest V3)，用于调试 Web 应用中 Redux 的状态变更。它提供了时间旅行调试、action 日志查看、状态快照对比、导入/导出等功能。

## 技术栈

| 层级 | 技术 | 版本/说明 |
|------|------|----------|
| 浏览器平台 | Chrome Extension API (MV3) | Manifest V3 |
| UI 框架 | React | v18.3.1 |
| UI 编辑器 | CodeMirror | (内嵌于 bundle) |
| 状态管理 | Redux | (内嵌于 page.bundle.js 的增强器逻辑) |
| 序列化 | jsan | 支持循环引用、函数、Symbol 等 |
| 打包工具 | Webpack 5 | 单一 bundle 输出 |
| 字体 | Roboto / Roboto Mono / Source Code Pro / Source Sans Pro | woff2 格式 |

## 模块架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        Chrome 扩展进程                            │
│                                                                  │
│  ┌─────────────────┐  ┌──────────────────────┐                  │
│  │  background.bundle.js  │  │  options.bundle.js    │               │
│  │  (Service Worker)      │  │  (Options Page)       │               │
│  │                        │  │                       │               │
│  │  - 消息路由/桥接       │  │  - 设置 UI (React)     │               │
│  │  - 右键菜单            │  │  - chrome.storage.sync │               │
│  │  - 通知管理            │  │  - 过滤规则配置        │               │
│  │  - 窗口管理(remote)    │  │                       │               │
│  │  - 选项存储            │  │                       │               │
│  └────────┬───────────────┘  └──────────────────────┘               │
│           │ chrome.runtime.connect / onConnect                       │
│           ▼                                                        │
│  ┌──────────────────────┐  ┌──────────────────────┐               │
│  │  devtools.bundle.js  │  │  devpanel.bundle.js   │               │
│  │  (DevTools Page)     │  │  (DevTools Panel)     │               │
│  │                      │  │                       │               │
│  │  - 创建面板          │  │  - 主 UI (React)      │               │
│  │  - chrome.devtools   │  │  - Action 列表        │               │
│  │    .panels.create()  │  │  - State 树查看器     │               │
│  └──────────────────────┘  │  - Diff 对比          │               │
│                             │  - 时间旅行控制       │               │
│                             │  - 导入/导出          │               │
│                             └──────────────────────┘               │
│  ┌──────────────────────┐                                          │
│  │  remote.bundle.js    │                                          │
│  │  (Remote DevTools)   │                                          │
│  │                      │                                          │
│  │  - 远程调试 UI       │                                          │
│  │  - 独立窗口模式      │                                          │
│  │  - 与 RN/远程实例连接 │                                          │
│  └──────────────────────┘                                          │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                      目标页面 (Web Page)                          │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  page.bundle.js (MAIN world)                                │  │
│  │                                                             │  │
│  │  - __REDUX_DEVTOOLS_EXTENSION__ (全局 API)                  │  │
│  │  - Store 增强器 (instrument)                                │  │
│  │  - Lifted Store (时间旅行)                                  │  │
│  │  - Action 过滤 + 序列化                                    │  │
│  │  - 与 content script 通过 window.postMessage 通信          │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ▲ postMessage                       │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  content.bundle.js (Isolated world)                         │  │
│  │                                                             │  │
│  │  - 桥接 page <-> background                                │  │
│  │  - chrome.runtime.connect() 连接后台                       │  │
│  │  - 大消息拆分 (32MB chunk)                                  │  │
│  │  - URL 过滤和注入判断                                      │  │
│  └───────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## 模块职责表

| 模块 | 文件 | 大小 | 运行上下文 | 核心职责 |
|------|------|------|-----------|---------|
| Service Worker | `background.bundle.js` | 23KB | Extension Service Worker | 消息路由、右键菜单、通知、窗口管理、选项持久化 |
| Content Script (Isolated) | `content.bundle.js` | 3.8KB | Page Isolated World | 跨上下文桥接、消息拆分、URL 过滤 |
| Content Script (MAIN) | `page.bundle.js` | 34KB | Page MAIN World | Store 增强器、Lifted Store、Redux API 暴露 |
| DevTools Page | `devtools.bundle.js` | 111B | DevTools Page | 创建 DevTools 面板 |
| DevTools Panel | `devpanel.bundle.js` | 1633KB | DevTools Panel | 主调试 UI (React) |
| Remote DevTools | `remote.bundle.js` | 1634KB | 独立 Tab/Window | 远程调试 UI (React) |
| Options Page | `options.bundle.js` | 153KB | Extension Page | 设置 UI (React) |

## 权限与能力清单

### Manifest Permissions

| 权限 | 用途 |
|------|------|
| `notifications` | 错误通知弹出 |
| `contextMenus` | 右键菜单 (打开 DevTools / Remote) |
| `storage` | 存储选项和最近调试会话 |
| `file:///*` | 支持本地文件调试 |
| `http://*/*` | 支持所有 HTTP 页面 |
| `https://*/*` | 支持所有 HTTPS 页面 |

### Content Scripts

| 脚本 | World | 匹配 | 运行时机 |
|------|-------|------|---------|
| content.bundle.js | ISOLATED | `<all_urls>` (除 google.com) | document_start |
| page.bundle.js | MAIN | `<all_urls>` (除 google.com) | document_start |

### 特殊能力

- **externally_connectable**: 允许所有 Chrome 扩展连接 (`ids: ["*"]`)
- **commands**: 注册 DevTools 窗口和 Remote 快捷键
- **action popup**: 工具栏弹出面板
- **devtools_page**: 自动创建 DevTools 面板
- **options_ui**: 扩展选项页面

## CSP 策略

```
script-src 'self'; object-src 'self'; style-src * 'unsafe-inline'; img-src 'self' data:;
```

- 仅允许自身打包脚本
- 允许任意来源样式和内联样式
- 允许 data: 协议的图片

## 关键设计决策

1. **双 Content Script 架构**：ISOLATED world 提供 Chrome API 访问，MAIN world 注入 Redux 增强器到页面 JS 上下文。两者通过 `window.postMessage` 通信。
2. **jsan 序列化**：使用 jsan (JSON + Circular) 库处理循环引用、函数、Symbol、Map/Set 等 JSON 无法表示的类型。
3. **Lifted Store 模式**：在原始 Redux store 之上包装了一层 "Lifted Store"，维护完整的 action 历史和计算状态链，支持时间旅行调试。
4. **消息拆分**：对于超大状态对象 (>32MB)，自动拆分为 chunk 分片传输，避免 Chrome 消息大小限制。
5. **实例标识**：支持同一页面多个 Redux store 实例，通过 `instanceId` 区分。
6. **Electron/Firefox 兼容**：Content script 中包含 Electron 和 Firefox 的兼容性补丁。
