# VisBug v0.4.10 — 架构文档

## 1. 概述

VisBug 是一款开源浏览器端可视化设计工具，以 Chrome 扩展形式提供。用户可在任意网页上激活一个类 Firebug 风格的设计工具栏，直接拖拽、移动、调整页面元素，实时预览 CSS 变更。本版本为 Manifest V3 实现。

## 2. 分层架构

```
┌──────────────────────────────────────────────────────┐
│                    用户交互层                          │
│  工具栏图标  │  快捷键 (Alt+Shift+D)  │  右键菜单      │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│               后台 Service Worker 层                   │
│  visbug.js (入口)                                     │
│  ├── contextmenu/launcher.js  — 点击/快捷键/右键调度   │
│  ├── contextmenu/colormode.js — 颜色格式偏好管理       │
│  └── contextmenu/colorscheme.js — 主题偏好管理         │
│                                                       │
│  职责: 状态管理 (loaded/injected per tab)              │
│       注入/切换/移除 VisBug UI                         │
│       用户偏好持久化 (chrome.storage.sync)             │
│       跨上下文消息转发                                  │
└─────────────────────┬────────────────────────────────┘
                      │ chrome.scripting.executeScript
                      │ chrome.scripting.insertCSS
                      │ chrome.tabs.sendMessage
                      ▼
┌──────────────────────────────────────────────────────┐
│                 内容脚本注入层                          │
│  toolbar/inject.js   — 初次注入 (创建自定义元素)       │
│  toolbar/eject.js    — 隐藏 (动画淡出 + 移除 DOM)      │
│  toolbar/restore.js  — 恢复 (重新创建自定义元素)        │
│  toolbar/bundle.css  — 注入的样式 (~36 行)             │
│                                                       │
│  职责: DOM 操作 (插入/移除 <vis-bug>)                  │
│       监听 COLOR_MODE / COLOR_SCHEME 消息              │
│       加载核心 bundle 脚本                              │
└─────────────────────┬────────────────────────────────┘
                      │ <script type="module">
                      ▼
┌──────────────────────────────────────────────────────┐
│              核心应用层 (页面内运行)                     │
│  toolbar/bundle.min.js (~318KB, 单文件打包)            │
│  ├── hotkeys-js v3.13.7 (第三方键盘快捷键库)           │
│  └── VisBug 应用主体 (自定义元素 <vis-bug> 逻辑)       │
│                                                       │
│  职责: 完整的设计工具 UI 与交互逻辑                     │
│       元素选择、拖拽、尺寸调整、间距可视化              │
│       CSS 属性编辑、颜色拾取、引导教程                  │
│       键盘快捷键处理                                    │
└──────────────────────────────────────────────────────┘
```

## 3. 模块职责表

| 模块 | 文件 | 运行上下文 | 代码规模 | 职责 |
|------|------|-----------|---------|------|
| 入口调度 | `visbug.js` | Service Worker | ~59 行 | 管理 tab 状态、协调注入/移除 |
| 启动器 | `contextmenu/launcher.js` | Service Worker | ~22 行 | 右键菜单 + action.onClicked 事件 |
| 颜色格式 | `contextmenu/colormode.js` | Service Worker | ~101 行 | hex/rgb/hsl 偏好管理、迁移旧值 |
| 主题模式 | `contextmenu/colorscheme.js` | Service Worker | ~80 行 | auto/light/dark 偏好管理 |
| 注入 | `toolbar/inject.js` | Content Script | ~23 行 | 插入 `<vis-bug>` + 加载模块 bundle |
| 弹出 | `toolbar/eject.js` | Content Script | ~10 行 | 动画隐藏并移除 `<vis-bug>` |
| 恢复 | `toolbar/restore.js` | Content Script | ~14 行 | 重新创建 `<vis-bug>` |
| 样式 | `toolbar/bundle.css` | 页面 CSS | ~36 行 | 选中态/拖拽/测量等基础样式 |
| 核心应用 | `toolbar/bundle.min.js` | 页面 Module | ~318KB | VisBug 主程序 (打包闭源) |

## 4. 技术决策

### 4.1 Manifest V3 + Service Worker
- 使用 MV3 的 `service_worker` (type: "module")，支持 ES module import
- Service Worker 不持久运行，每次事件触发时唤醒，完成后可能被终止
- 因此状态 (`state.loaded`/`state.injected`) 存在内存中，浏览器重启或 SW 回收后丢失

### 4.2 Custom Element (`<vis-bug>`) 架构
- VisBug 以自定义 HTML 元素 `<vis-bug>` 挂载到页面上
- 主应用打包为 ES module (`toolbar/bundle.min.js`)，由 inject.js 动态创建 `<script type="module">` 加载
- eject.js 使用 Web Animations API (`element.animate()`) 实现平滑退出动画
- restore.js 在原 `<vis-bug>` 被移除后重新创建

### 4.3 颜色偏好系统
- 通过 `chrome.storage.sync` 持久化用户偏好
- 支持旧版本迁移 (`hsla` -> `hsl`, `rgba` -> `rgb`)
- 通过 `chrome.tabs.sendMessage` 传递偏好到内容脚本
- 内容脚本收到消息后设置 `<vis-bug>` 元素的 HTML attribute

### 4.4 打包方式
- `toolbar/bundle.min.js` 为手工打包/压缩产物，非标准 bundler
- 内含 `hotkeys-js v3.13.7` (MIT License)
- 12 行高度压缩代码 (~318KB)，变量名混淆但结构可辨
- 未使用 sourcemap

### 4.5 跨浏览器兼容
- 使用 `typeof browser === 'undefined' ? chrome : browser` 模式兼容 Chrome/Firefox
- 实际仅使用 `chrome.*` 命名空间的 API

## 5. 权限清单

| 权限 | 用途 | 风险等级 |
|------|------|---------|
| `activeTab` | 仅在用户激活时访问当前页面 DOM | 低 — 最小权限原则 |
| `contextMenus` | 注册右键菜单项 (启动/颜色/主题) | 低 — 标准扩展功能 |
| `scripting` | 动态注入 CSS 和 JS 到页面 | 中 — 可执行任意脚本 |
| `storage` | 跨设备同步颜色偏好设置 | 低 — 仅存储用户设置 |

## 6. 运行时资源

| 资源 | 暴露范围 | 内容 |
|------|---------|------|
| `tuts/*.gif` | `<all_urls>` 的 web_accessible_resources | 13 个教程动画 GIF |
| `toolbar/*` | `<all_urls>` 的 web_accessible_resources | bundle.js/css + inject/eject/restore 脚本 |

## 7. 关键发现

1. **bundle.min.js 不可还原**: 主应用代码被压缩为 12 行，虽未混淆但变量名已被缩短，完整还原需要手动反压缩
2. **代码规模不对称**: 26 个文件中，bundle.min.js 占总大小的 ~99% (318KB)，其余文件仅 ~10KB
3. **无构建配置**: 源代码中没有 webpack/rollup/esbuild 配置文件，打包方式不明
4. **热键库**: 内嵌 hotkeys-js v3.13.7，用于快捷键绑定
