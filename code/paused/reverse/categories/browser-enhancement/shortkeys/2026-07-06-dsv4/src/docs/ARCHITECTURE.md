# Shortkeys v5.0.1 — 架构文档

## 概述

Shortkeys 是一款 Chrome 扩展，允许用户自定义浏览器键盘快捷键。用户可以为 80+ 内建操作绑定任意键盘组合，在不同网站上激活不同的快捷键配置。

**技术栈**: Vite + Vanilla JS (无框架), WXT 内容脚本生命周期, Mousetrap.js 键盘绑定

## 架构分层

```
┌─────────────────────────────────────────────────────┐
│                   UI Layer (HTML)                    │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │  popup.html   │  │       options.html           │ │
│  │  (快速面板)    │  │  (完整设置页, open_in_tab)   │ │
│  └──────┬───────┘  └──────────────┬───────────────┘ │
│         │ Vite chunk               │ Vite chunk       │
│         ▼                          ▼                  │
│  popup-B1yKYaqZ.js          options-D7Jpik--.js      │
│         │                          │                  │
│         └──────────┬───────────────┘                  │
│                    ▼                                  │
│           storage-DL2X4Nnb.js (共享存储模块)          │
├─────────────────────────────────────────────────────┤
│              Background Layer (Service Worker)        │
│  ┌─────────────────────────────────────────────────┐ │
│  │              background.js (单文件)              │ │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────────┐  │ │
│  │  │ 命令分发  │ │ 存储管理  │ │ 外部通信/导入   │  │ │
│  │  │ (80+操作) │ │(sync+loc)│ │                 │  │ │
│  │  ├──────────┤ ├──────────┤ ├────────────────┤  │ │
│  │  │ 截图引擎  │ │ 使用统计  │ │ 标签页历史跟踪   │  │ │
│  │  │(debugger)│ │          │ │                 │  │ │
│  │  ├──────────┤ ├──────────┤ ├────────────────┤  │ │
│  │  │ 宏执行器  │ │ 迁移逻辑  │ │ userScripts注入 │  │ │
│  │  └──────────┘ └──────────┘ └────────────────┘  │ │
│  └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│            Content Script Layer (页面注入)            │
│  ┌─────────────────────────────────────────────────┐ │
│  │         content-scripts/content.js               │ │
│  │  ┌──────────┐ ┌──────────────┐ ┌─────────────┐ │ │
│  │  │Mousetrap │ │ 链接提示系统  │ │ 页面覆盖层   │ │ │
│  │  │ 键盘绑定  │ │ (Link Hints) │ │(暗色/cheat) │ │ │
│  │  ├──────────┤ ├──────────────┤ ├─────────────┤ │ │
│  │  │ JS 执行   │ │ URL 编辑栏   │ │ WXT 生命周期 │ │ │
│  │  └──────────┘ └──────────────┘ └─────────────┘ │ │
│  └─────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────┤
│                  External Surface                     │
│  ┌──────────────────────┐ ┌────────────────────────┐│
│  │ shortkeys.app (导入)  │ │ Chrome Commands API    ││
│  │ localhost (开发)      │ │ (92 个注册命令)        ││
│  └──────────────────────┘ └────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

## 文件清单

| 文件 | 大小 | 职责 |
|------|------|------|
| `manifest.json` | 7.3 KB | 扩展清单 (MV3, 13 权限, 92 commands) |
| `background.js` | 43 KB | Service Worker — 命令分发/存储/截图/宏/USS/统计 |
| `content-scripts/content.js` | 38 KB | 内容脚本 — 键盘绑定/链接提示/页面覆盖层 |
| `chunks/options-D7Jpik--.js` | ~350 KB | 设置页面 (Vue-like 响应式, 快捷键编辑器) |
| `chunks/popup-B1yKYaqZ.js` | ~15 KB | 弹出面板 (快速操作) |
| `chunks/storage-DL2X4Nnb.js` | ~45 KB | 共享存储模块 (内建脚本定义) |
| `assets/options-XVCwSCwF.css` | ~30 KB | 设置页面样式 |
| `assets/popup-DWRgwik3.css` | ~5 KB | 弹出面板样式 |
| `assets/storage-RkGT7EPn.css` | ~2 KB | 存储模块样式 |
| `options.html` | 758 B | 设置页入口 |
| `popup.html` | 651 B | 弹出页入口 |
| `_locales/en/messages.json` | 358 B | 国际化 (en) |
| `images/` | — | 图标和截图素材 |

## 模块职责表

### Background (Service Worker)

| 模块 | 职责 | 依赖的 Chrome API |
|------|------|-------------------|
| **命令分发器 (Action Dispatcher)** | 将操作名称映射到处理函数, 对 80+ 操作进行路由 | tabs, windows, sessions, bookmarks |
| **存储管理器 (Storage Manager)** | 双区存储 (sync + local), 序列化/反序列化, 配额管理 | storage.sync, storage.local |
| **截图引擎 (Screenshot Engine)** | 通过 CDP 截取页面完整截图 | debugger (Page.captureScreenshot, Emulation.setDeviceMetricsOverride) |
| **宏执行器 (Macro Executor)** | 顺序执行多步骤操作链, 支持延迟和条件执行 | tabs, scripting |
| **使用统计 (Usage Tracker)** | 记录快捷键使用频率, 保留 90 天每日统计 | storage.local |
| **迁移逻辑 (Migration)** | 从 local-only 迁移到 sync+local 双存储 | storage.sync, storage.local |
| **标签页历史跟踪 (Tab History)** | 维护最后两个活动标签页引用, 支持 "切换到上次使用的标签" | tabs.onActivated, windows.onFocusChanged |
| **userScripts 注入** | 将 JavaScript 快捷键注册为 `chrome.userScripts` 以在 MAIN world 执行 | userScripts |
| **外部消息处理** | 从 shortkeys.app 接收快捷键导入 | runtime.onMessageExternal |
| **通知管理** | 升级通知 (带按钮, 指向设置页) | notifications |

### Content Script

| 模块 | 职责 | 技术细节 |
|------|------|----------|
| **键盘绑定引擎** | 基于 Mousetrap.js 的自定义键盘处理, 支持序列/组合键 | stopCallback 覆盖 (支持 activeInInputs) |
| **链接提示系统 (Link Hints)** | 为页面可点击元素生成字母标签, 键盘选择后点击 | SADFJKLEWCMPGH 字符集, 可见性检测 |
| **Cheat Sheet 覆盖层** | 显示当前页面激活的所有快捷键 | 动态构建, Esc 关闭 |
| **暗色模式切换** | CSS filter 页面反色 | invert(1) hue-rotate(180deg) |
| **URL 编辑栏** | 页面内 URL 编辑输入框覆盖层 | 固定定位, 输入验证 |
| **JavaScript 执行** | 转发用户脚本到页面上下文 (通过 CustomEvent) | document.dispatchEvent + userScripts |
| **WXT 生命周期** | 内容脚本的注册/失效检测/重新加载 | ContentScriptContext, LocationChangeWatcher |

### UI 页面

| 页面 | 框架 | 功能 |
|------|------|------|
| **options.html** | 自研响应式 (类 Vue 数据绑定) | 快捷键 CRUD, 键盘录制, 导入/导出, 分组管理, 使用统计图表 |
| **popup.html** | 自研响应式 | 快速启用/禁用快捷键, 打开设置页链接 |

## 技术决策

### 1. 为什么使用 chrome.storage.sync + local 双存储

- **sync**: 支持跨设备同步, 但有 100KB 配额限制
- **local**: 无配额限制, 作为 sync 超限时的降级方案
- 策略: 数据 < ~99KB 时写 sync, 否则仅写 local; 读取时比较两者数据完整性择优选

### 2. 为什么使用 chrome.debugger 而非 chrome.tabs.captureVisibleTab

- `captureVisibleTab` 只能截取可视区域
- `debugger` + `Page.captureScreenshot` 配合 `Emulation.setDeviceMetricsOverride` 可截取完整页面 (最高 16348px)
- 截完后立即 `detach`, 不会持续占用 debugger

### 3. 为什么使用 chrome.userScripts

- MV3 中内容脚本运行在隔离世界 (ISOLATED world)
- 用户的自定义 JavaScript (`action=javascript`) 需要在 MAIN world 中执行以访问页面变量
- `userScripts` API 允许在 MAIN world 注入脚本, 通过 CustomEvent 桥接通信

### 4. 为什么使用 Mousetrap.js

- 成熟的开源键盘绑定库, 支持组合键、序列键
- 在内容脚本中通过覆盖 `stopCallback` 实现对输入框的自定义处理 (支持 `activeInInputs` 配置)

### 5. Vite 打包策略

- `background.js` — IIFE 格式, 单文件 (Service Worker 不支持 ES Module import)
- `chunks/*.js` — ES Module, 代码分割 (options 和 popup 共享 storage chunk)
- CSS 作为独立文件提取 (非 JS 注入)

## 权限清单与用途

| 权限 | 用途 | 风险等级 |
|------|------|----------|
| `storage` | 存储快捷键配置和使用统计 | 低 |
| `tabs` | 标签页操作 (切换/关闭/移动等) | 中 |
| `activeTab` | 获取当前标签页信息 | 低 |
| `scripting` | 在页面中执行脚本 (内容脚本通信) | 中 |
| `clipboardWrite` | 复制 URL/标题/选中文本到剪贴板 | 低 |
| `clipboardRead` (optional) | 从剪贴板读取 URL 并打开 | 中 |
| `bookmarks` | 搜索/创建/删除书签 | 中 |
| `downloads` | 清除下载历史, 显示最近下载 | 低 |
| `sessions` | 恢复最近关闭的标签页 | 中 |
| `browsingData` | 清除下载历史数据 | 中 |
| `management` | 启动已安装的 Chrome App | 低 |
| `debugger` | 完整页面截图 (CDP) | **高** |
| `notifications` | 升级通知 | 低 |
| `userScripts` | 在 MAIN world 执行用户自定义 JavaScript | **高** |
| `tabGroups` (optional) | 标签页分组管理 | 中 |
| `*://*/*` (host) | 内容脚本注入 + userScripts | **高** |

## 第三方依赖

| 库 | 版本/来源 | 用途 | 许可证 |
|----|----------|------|--------|
| Mousetrap.js | 内联 (修改版) | 键盘绑定库 | Apache 2.0 |
| Material Design Icons | CDN (cdn.materialdesignicons.com, cdn.jsdelivr.net) | 设置页图标 | MIT / SIL OFL 1.1 |

注: 代码中未发现其他 npm 依赖, UI 为自研框架, 无 React/Vue/Angular 等第三方 UI 库。
