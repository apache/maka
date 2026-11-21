# React Developer Tools v7.0.1 — 架构文档

## 概述

React Developer Tools 是 Chrome DevTools 的官方扩展，用于调试 React 应用。它注入到页面的主世界（MAIN world）和隔离世界（ISOLATED world），通过多层次的通信架构连接页面 React 实例、Chrome 扩展后台和 DevTools 面板。

**版本**：7.0.1（修订版 `3cde211b0c`，构建日期 2025-10-20）
**Manifest 版本**：MV3
**打包工具**：Webpack 5（识别特征：`__webpack_require__` 模块系统）
**代码可读性**：打包 + 压缩，部分文件有 source map

---

## 分层架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DevTools 前端层                              │
│                                                                     │
│  ┌──────────────────┐    ┌──────────────────┐                       │
│  │   main.html      │    │   panel.html     │                       │
│  │  (DevTools 入口)  │    │  (面板容器)       │                       │
│  │  → main.js (1.2M)│    │  → panel.js (169B)│                      │
│  └──────────────────┘    └──────────────────┘                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ chrome.runtime.connect()
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      扩展后台层 (Service Worker)                     │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  background.js (5.5K)                                        │   │
│  │  - 动态注册/注销 content scripts (4 个)                        │   │
│  │  - Tab 状态管理 (port bridging: proxy ↔ extension)            │   │
│  │  - 图标/弹窗切换 (7 种状态)                                    │   │
│  │  - 消息路由 (devtools-page ↔ content ↔ backend)               │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ chrome.scripting.executeScript()
                               │ window.postMessage()
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      内容脚本层 (Content Scripts)                    │
│                                                                     │
│  ┌──────────────────────────┐  ┌──────────────────────────────────┐ │
│  │ ISOLATED World            │  │ MAIN World                       │ │
│  │                           │  │                                  │ │
│  │ prepareInjection.js (334B)│  │ installHook.js (175K)            │ │
│  │ → 消息中继 (hook→bg)     │  │ → __REACT_DEVTOOLS_GLOBAL_HOOK__ │ │
│  │                           │  │                                  │ │
│  │ proxy.js (1.4K)           │  │ backendManager.js (14K)          │ │
│  │ → port 连接管理           │  │ → 后端管理器 + LRU Cache         │ │
│  │ → 桥接 devtools↔page     │  │ → semver 版本比较                │ │
│  │                           │  │ → 渲染器注册与激活               │ │
│  │ fileFetcher.js (671B)     │  │                                  │ │
│  │ → fetch 资源（带缓存）    │  │ react_devtools_backend_compact   │ │
│  │                           │  │ .js (50K)                        │ │
│  │ hookSettingsInjector      │  │ → Agent + Bridge + initBackend   │ │
│  │ .js (755B)                │  │ → 元素高亮 overlay              │ │
│  │ → Hook 设置注入           │  │ → 性能追踪 traceUpdates          │ │
│  └──────────────────────────┘  └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      页面层 (Page Context)                          │
│                                                                     │
│  React 应用页面                                                     │
│  └→ __REACT_DEVTOOLS_GLOBAL_HOOK__ (由 installHook.js 挂载)        │
│     └→ backends Map<version, RendererBackend>                      │
│     └→ renderers Map<id, RendererInterface>                        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 模块职责表

### 扩展后台

| 文件 | 大小 | 职责 |
|------|------|------|
| `background.js` | 5.5K | 后台服务 worker。负责：(1) 动态注册 4 个 content scripts；(2) Tab 级别端口桥接（proxy ↔ extension）；(3) 图标/弹窗状态管理（7 种状态）；(4) 消息路由中继 |

### 内容脚本（ISOLATED World）

| 文件 | 大小 | 职责 |
|------|------|------|
| `prepareInjection.js` | 334B | 静态 content script，在 `document_start` 注入。监听 `react-devtools-hook` 消息并中继到后台 |
| `proxy.js` | 1.4K | 动态 content script，在 `document_start` 注入。建立到后台的 `chrome.runtime.connect` 长连接，转发 devtools ↔ page 之间的消息 |
| `fileFetcher.js` | 671B | 动态 content script，在 `document_end` 注入。使用 `fetch` + `cache: force-cache` 获取页面资源文件内容 |
| `hookSettingsInjector.js` | 755B | 动态 content script，在 `document_start` 注入。从 `chrome.storage.local` 读取 Hook 设置并注入到主世界 |

### 主世界脚本（MAIN World）

| 文件 | 大小 | 职责 |
|------|------|------|
| `installHook.js` | 175K | 核心 Hook 注入脚本。挂载 `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`，提供 renderer 注册、事件系统、React Symbol 定义 |
| `backendManager.js` | 14K | 后端管理器。内嵌 lru-cache + semver，管理渲染器版本匹配与后端激活 |
| `react_devtools_backend_compact.js` | 50K | Compact 后端实现。包含 Bridge / Agent / initBackend / 高亮 overlay / 追踪更新 traceUpdates 等核心后端逻辑 |

### DevTools 页面

| 文件 | 大小 | 职责 |
|------|------|------|
| `main.html` | 156B | DevTools 入口页面，加载 main.js |
| `main.js` | 1.2M | DevTools 前端 UI（React 组件树面板、Profiler 面板等），Webpack 打包的应用 |
| `panel.html` | 1.6K | DevTools 面板页面，提供 React 挂载容器 |
| `panel.js` | 169B | 面板初始化，提供 `injectStyles` 函数 |

### Worker 线程

| 文件 | 大小 | 职责 |
|------|------|------|
| `importFile.worker.worker.js` | 219K | Web Worker：处理导入的 Profiling 数据文件 |
| `parseSourceAndMetadata.worker.worker.js` | 839K | Web Worker：解析源代码和元数据（source map 解析、组件元数据提取） |

### 弹窗页面

| 文件 | 大小 | 职责 |
|------|------|------|
| `popups/disabled.html` | 439B | React DevTools 禁用状态弹窗 |
| `popups/development.html` | 610B | 开发构建检测弹窗 |
| `popups/production.html` | 365B | 生产构建弹窗 |
| `popups/outdated.html` | 603B | 过期版本弹窗 |
| `popups/deadcode.html` | 785B | Dead code 检测弹窗 |
| `popups/unminified.html` | 682B | 未压缩代码弹窗 |
| `popups/restricted.html` | 263B | 受限页面弹窗 |
| `popups/shared.js` | 686B | 弹窗共用逻辑（链接点击处理、淡入动画） |
| `popups/shared.css` | 261B | 弹窗共用样式（暗色模式支持） |

---

## 关键技术决策

### 1. 动态 Content Script 注册

与早期版本在 manifest.json 中静态声明不同，v7.0.1 使用 `chrome.scripting.registerContentScripts()` 在 Service Worker 启动时动态注册 4 个 content scripts。这允许：
- 动态控制注入时机（`document_start` vs `document_end`）
- 指定执行世界（MAIN vs ISOLATED）
- `persistAcrossSessions: true` 确保持久化

### 2. Port 桥接模式

后台维护一个 `Tab → { extension, proxy }` 的映射表，通过 `chrome.runtime.connect` 建立长连接。当 devtools 面板通过 named port 连接后台时，后台将其与 proxy content script 的端口桥接，实现消息双向转发。

### 3. 多 Backend 版本支持

`backendManager.js` 支持多个 React 版本共存。它使用 semver 比较检测页面注册的 renderer 版本，匹配对应的 backend 实现。`compact` backend 作为兜底（fallback）用于无法精确匹配的情况。

### 4. Web Worker 密集型计算

两个开销较大的任务运行在 Web Worker 中：
- **importFile.worker**: 处理 Profiling 数据导入
- **parseSourceAndMetadata.worker**: 解析 source map 和提取组件元数据

---

## 权限清单

| 权限 | 类型 | 用途 |
|------|------|------|
| `scripting` | 必需 | 动态注册 content scripts 和向主世界注入脚本 |
| `storage` | 必需 | 持久化 Hook 设置（appendComponentStack 等） |
| `tabs` | 必需 | 查询所有标签页、监听 Tab 创建/更新/激活事件 |
| `clipboardWrite` | 可选 | 复制组件路径到剪贴板 |
| `<all_urls>` | 主机权限 | 注入 content scripts 到所有页面 |

### CSP

```
script-src 'self'; object-src 'self'
```

严格限制脚本只能来自扩展自身，禁止 inline script 和 eval。

### Web Accessible Resources

```
main.html, panel.html, build/*.js
```

这些资源对 `<all_urls>` 可访问，允许 DevTools 页面和 content scripts 正常加载。

---

## 技术栈

| 技术 | 用途 |
|------|------|
| Webpack 5 | JS 打包（`__webpack_require__` 模块系统） |
| TypeScript | 原始开发语言（编译为 JS） |
| React | DevTools 前端 UI（main.js 面板） |
| Chrome Extension MV3 | 扩展运行时 |
| lru-cache | LRU 缓存（内嵌在 backendManager.js 中） |
