# React Context DevTool v4.4 — 架构文档

## 1. 概述

React Context DevTool 是一款 Chrome DevTools 扩展（MV3），用于实时调试 React 应用中的 **Context API** 和 **useReducer** hook。它通过 Hook React 内部的 Fiber 调和器来追踪 Context 值变化与 useReducer 的 action/state 历史记录，并在 DevTools Panel 和 Popup 中提供可视化的 JSON 查看器与时间旅行调试能力。

## 2. 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                       UI 层                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ DevTools Panel│  │   Popup     │  │  Options Page    │   │
│  │ (devpanel.js) │  │ (popup.js)  │  │  (options.js)    │   │
│  │  React SPA    │  │  React SPA  │  │  React SPA       │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                    │             │
├─────────┼─────────────────┼────────────────────┼─────────────┤
│         │     chrome.runtime.connect (port)     │             │
│         │      命名的长连接端口通信              │             │
├─────────┼─────────────────┼────────────────────┼─────────────┤
│         │                 │                                 │
│  ┌──────┴─────────────────┴──────────────────────────┐     │
│  │              Background Service Worker             │     │
│  │              (background.js)                       │     │
│  │  ┌──────────────┐  ┌──────────────┐               │     │
│  │  │ 端口管理器    │  │ Tab 状态缓存  │               │     │
│  │  │ (portManager) │  │ (tabDataMap) │               │     │
│  │  └──────────────┘  └──────────────┘               │     │
│  │  ┌──────────────┐  ┌──────────────┐               │     │
│  │  │ 设置管理      │  │ 图标/Popup   │               │     │
│  │  │ (settings)   │  │ 切换管理     │               │     │
│  │  └──────────────┘  └──────────────┘               │     │
│  └──────┬────────────────────────────────────────────┘     │
│         │  chrome.runtime.connect (port)                   │
│         │  chrome.tabs.sendMessage                         │
├─────────┼───────────────────────────────────────────────────┤
│         │                                                   │
│  ┌──────┴──────────────────────────────────────────────┐   │
│  │           Content Script (ISOLATED world)            │   │
│  │           (injectGlobalHook.js)                      │   │
│  │  ┌────────────────┐  ┌────────────────┐             │   │
│  │  │ React 检测器    │  │ 消息桥接       │             │   │
│  │  │ (hook sniffer) │  │ (port ↔ PM)    │             │   │
│  │  └────────────────┘  └────────────────┘             │   │
│  └──────┬──────────────────────────────────────────────┘   │
│         │  window.postMessage                               │
├─────────┼───────────────────────────────────────────────────┤
│         │                                                   │
│  ┌──────┴──────────────────────────────────────────────┐   │
│  │        Main Content Script (MAIN world)              │   │
│  │        (mainContent.js)                              │   │
│  │  ┌────────────────┐  ┌────────────────┐             │   │
│  │  │ Fiber 树遍历器  │  │ Hook 注入器     │             │   │
│  │  │ (fiberWalker)  │  │ (hookPatcher)  │             │   │
│  │  └────────────────┘  └────────────────┘             │   │
│  │  ┌────────────────┐  ┌────────────────┐             │   │
│  │  │ 数据序列化器    │  │ Action 转发器   │             │   │
│  │  │ (serializer)   │  │ (dispatcher)   │             │   │
│  │  └────────────────┘  └────────────────┘             │   │
│  └─────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────┤
│                   用户页面 (MAIN world)                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  React App + __REACT_DEVTOOLS_GLOBAL_HOOK__          │   │
│  │  + Fiber Tree + Context Providers + useReducer hooks │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 3. 模块职责表

| 模块 | 文件 | 运行环境 | 核心职责 |
|------|------|----------|----------|
| **Content Script** | `injectGlobalHook.js` | ISOLATED world (content script) | React 检测、双向消息桥接、端口生命周期管理 |
| **Main Content** | `mainContent.js` | MAIN world (动态注入) | Fiber 树遍历、Hook 拦截/注入、数据序列化、Action 转发 |
| **Background** | `background.js` | Service Worker | 中央消息路由、Tab 状态存储、设置管理、图标切换、调试生命周期编排 |
| **DevTools Entry** | `devtool/devtool.js` | DevTools Page | 注册 DevTools Panel |
| **DevTools Panel** | `devtool/devpanel.js` | DevTools Panel (iframe) | React SPA 界面：Context/useReducer 可视化、JSON diff 对比 |
| **Popup** | `popup/popup.js` | Action Popup | React SPA 轻量界面（与 Panel 共享组件） |
| **Options** | `options/options.js` | Options Page | 设置表单界面（debugContext/debugUseReducer/startDebugWhenV2） |

## 4. 技术决策

### 4.1 双层 Content Script 架构

- **injectGlobalHook.js**（ISOLATED world）：通过 `manifest.json` 的 `content_scripts` 注册，在 `document_start` 注入。负责检测 `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` 的存在性，以及桥接 ISOLATED world ↔ MAIN world 通信。
- **mainContent.js**（MAIN world）：通过 `chrome.scripting.executeScript({ world: 'MAIN' })` 动态注入。需要在 MAIN world 运行才能访问用户页面的 React Fiber 树和 `__REACT_DEVTOOLS_GLOBAL_HOOK__` 实例。

### 4.2 端口消息总线

不使用 `chrome.runtime.sendMessage` 的请求-响应模式，而是自建了一套基于 `chrome.runtime.connect` **长连接端口** 的消息总线：

- 每个端口有唯一名称（如 `content:123`、`devtool:123`、`popup`、`background`）
- 支持 `to`/`from` 路由字段，模拟多播
- 内置 `::RESPONSE` / `::RESPONSE_ERROR` 后缀的请求-响应机制
- 30 秒超时保护
- 自动重连机制（端口断开时，content script 监听 `chrome.runtime.onMessage` 的 `RECONNECT_CONTENT_MESSAGING_PORT` 事件自动重建端口）

### 4.3 Hook 注入技术

`mainContent.js` 通过 Monkey-patching `useReducer` hook 的 `queue.lastRenderedReducer` 和 `queue.dispatch` 来拦截 action 和 state：

- 替换 `lastRenderedReducer`，在每次 reducer 调用时捕获 action
- 替换 `dispatch`，标记 `useDispatch: true` 并捕获 action
- 为每个 hook 分配唯一的 `__reactContextDevtoolDebugId`

对于 Context（Fiber tag === 10），拦截点在 Fiber 节点处理时读取 `memoizedProps.value` 和 `memoizedProps.displayName`。

### 4.4 防抖渲染

Fiber 树遍历通过 `onCommitFiberRoot` 钩子触发，但实际数据提取使用了 **100ms 防抖**（`setTimeout` debounce），避免高频渲染造成性能问题。

## 5. 技术栈

| 技术 | 用途 |
|------|------|
| React 18.x | UI 框架（DevTools Panel / Popup / Options 三个独立 SPA） |
| classnames | CSS 类名条件组合 |
| CodeMirror | JSON 代码编辑/展示（`cm-s-material-ocean` 主题） |
| jsondiffpatch | 新旧值 JSON diff 可视化 |
| Montserrat | UI 字体（18 个变体，Thin ~ Black + Italic） |
| Babel / Webpack | 构建工具（regenerator runtime 内联，webpack license 插件） |

## 6. 权限清单

| 权限 | 类型 | 用途 |
|------|------|------|
| `storage` | permission | 保存用户设置（`chrome.storage.local`） |
| `scripting` | permission | 动态注入 `mainContent.js` 到 MAIN world |
| `<all_urls>` | host_permission | 所有页面均可激活调试 |
| `web_accessible_resources` | manifest | 暴露 `mainContent.js` 供页面访问 |

## 7. 入口点总览

| HTML 入口 | JS 文件 | 渲染根节点 | 何时激活 |
|-----------|---------|-----------|---------|
| `devtool/devtool.html` | `devtool.js` | — | DevTools 打开时（仅注册 Panel） |
| `devtool/devpanel.html` | `devpanel.js` | `#devPanelRoot` | Panel 可见时 |
| `popup/disabled.html` | — | — | React 未检测到（默认） |
| `popup/popup.html` | `popup.js` | `#popupRoot` | React 检测到后动态切换 |
| `options/options.html` | `options.js` | `#optionsRoot` | 用户打开选项页 |
