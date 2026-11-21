# OneTab v2.18 — 架构文档 (ARCHITECTURE)

## 一、概述

OneTab 是一款 Chrome 标签页管理器，核心功能是将打开的标签页"收纳"为结构化列表，支持按窗口/标签组/文件夹整理、搜索、恢复、导入导出及云端分享。v2.18 基于 **Manifest V3**，Service Worker 驱动，无第三方 UI 框架。

## 二、技术栈

| 维度 | 选择 |
|------|------|
| Manifest 版本 | MV3 |
| Background | Service Worker（单文件） |
| 打包工具 | 无打包器，手工 minified concatenated sources |
| UI 框架 | 原生 DOM 操作（virtual DOM 风格辅助函数 `I()` / `T()`） |
| 模板语言 | 无，纯 JS 构造 DOM |
| 样式方案 | 原生 CSS + CSS 自定义属性（暗色模式通过 `prefers-color-scheme` 媒体查询驱动） |
| 字体 | Open Sans（本地 .woff） |
| 国际化 | Chrome i18n API（62 种语言） |
| 外部通信 | `https://www.one-tab.com/*`（分享与同步 API） |
| 代码状态 | 原始源码已 minify，无可读变量名，无 source map |

## 三、分层架构

```
┌─────────────────────────────────────────────────────────────────┐
│  UI Layer (HTML Pages)                                           │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌──────────────────┐ │
│  │ onetab.html│ │ popup.html│ │options.htm│ │import-export.html│ │
│  │ (主页面)    │ │ (弹出窗口) │ │ (设置页)   │ │ (导入导出页)      │ │
│  ├───────────┤ ├───────────┤ ├───────────┤ ├──────────────────┤ │
│  │ placeholder│ │shared-page│ │  safari-  │ │                  │ │
│  │   .html    │ │-permission│ │permissions│ │                  │ │
│  │ (文件tab页) │ │  .html    │ │  .html    │ │                  │ │
│  └───────────┘ └───────────┘ └───────────┘ └──────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  RPC Proxy Layer (localisation.js 共享代码)                       │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  h (Core Proxy) — 将 method 调用转为 chrome.runtime       │    │
│  │  sendMessage → {type, args, Hp:true}                     │    │
│  └──────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────┤
│  Background Service Worker (background.js)                       │
│  ┌──────────────┐ ┌────────────┐ ┌──────────────┐               │
│  │  ItemCache   │ │  Core API  │ │ Sync Manager │               │
│  │  (数据缓存)   │ │  (业务逻辑) │ │ (one-tab.com)│               │
│  └──────────────┘ └────────────┘ └──────────────┘               │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Storage Layer (chrome.storage.local + .session)         │    │
│  └──────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────┤
│  Chrome Extension APIs                                          │
│  tabs | storage | contextMenus | scripting | commands | omnibox │
│  tabGroups | readingList | bookmarks (optional)                  │
└─────────────────────────────────────────────────────────────────┘
```

## 四、模块职责表

### 4.1 JS 文件

| 文件 | 大小 (估算) | 加载页面 | 核心职责 |
|------|-----------|----------|---------|
| `ext-onetab-concatenated-sources-background.js` | ~250KB | Service Worker | Core API 实现、数据存储、同步、tab 操作 |
| `ext-onetab-concatenated-sources-localisation.js` | ~150KB | 所有页面（共享） | RPC 代理 `h`、i18n、UI 工具函数、DOM 构造器 |
| `ext-onetab-concatenated-sources-onetab.js` | ~350KB | onetab.html | 主页面 UI：列表渲染、拖拽、搜索、右键菜单 |
| `ext-onetab-concatenated-sources-popup.js` | ~300KB | popup.html | Action popup UI：标签页选择、发送选项 |
| `ext-onetab-concatenated-sources-options.js` | ~250KB | options.html | 设置页面 UI |
| `ext-onetab-concatenated-sources-import.js` | ~200KB | import-export.html | 导入导出功能 UI |
| `ext-onetab-concatenated-sources-contentscript.js` | ~10KB | 用户页面 | 监听快捷键、获取页面链接 |
| `ext-onetab-concatenated-sources-one-tab.com-contentscript.js` | ~10KB | one-tab.com | 分享页面与扩展通信 |
| `ext-onetab-concatenated-sources-placeholder.js` | ~70KB | placeholder.html | 处理 file:// 协议的标签页 |
| `ext-onetab-concatenated-sources-shared-page-permission.js` | ~30KB | shared-page-permission.html | 管理 one-tab.com host 权限授权 |

### 4.2 HTML 页面

| 文件 | 用途 |
|------|------|
| `onetab.html` | 主界面，显示所有存储的标签页列表 |
| `popup.html` | 工具栏图标弹出窗口（min-width: 788px） |
| `options.html` | 设置页面（open_in_tab: true） |
| `import-export.html` | 导入/导出标签页数据 |
| `placeholder.html` | 处理 `file://` URL 的替代页面 |
| `shared-page-permission.html` | 请求 one-tab.com host 权限 |
| `safari-permissions.html` | Safari 权限说明（遗留页面） |

## 五、数据模型

### 5.1 实体类型

```
Item (抽象)
├── Tab (type="tab") — 单个标签页快照
└── Group (type="group")
    ├── Folder (groupType="folder") — 文件夹
    ├── TabGroup (groupType="tabGroup") — Chrome 标签组
    ├── Window (groupType="window") — 原始窗口
    └── QuickList (groupType="quickList") — 快速列表
```

### 5.2 特殊节点

- **root** (id="root") — 虚拟根节点，所有顶层组为其子节点
- **trash** (id="trash") — 虚拟回收站节点

### 5.3 树形结构

所有数据以扁平 map 存储（`items: Record<ItemId, ListItem>`），树结构通过 `childIds`/`parentIds` 数组维护。

### 5.4 存储键

| 存储位置 | 键 | 用途 |
|---------|------|------|
| chrome.storage.local | `items` | 所有 tab/group 条目 |
| chrome.storage.local | `root` | 根节点 |
| chrome.storage.local | `trash` | 回收站节点 |
| chrome.storage.local | `options` | 用户配置 |
| chrome.storage.local | `uncommittedChangesStore` | 离线暂存变更 |
| chrome.storage.local | `excludedDomains` | 排除域名列表 |
| chrome.storage.session | 多个临时键 | UI 状态、选中项等 |

## 六、通信模式

### 6.1 RPC 代理机制

所有 HTML 页面通过一个 Proxy 对象 `h`（定义在 localisation.js 中）调用 background 的 Core API：

```
UI Page ──chrome.runtime.sendMessage({type, args, Hp:true})──> Service Worker
UI Page <──response.result─────────────────────────────────── Service Worker
```

消息 `type` 对应 Core API 的方法名，`Hp` 是内部协议标记（hard-protocol）。

### 6.2 State Change 广播

当数据变更时，Service Worker 向所有打开的页面广播 `{type: "stateChange", s0: diff}` 消息，各页面监听此消息更新 UI。

### 6.3 与 one-tab.com 通信

通过 `fetch()` 向 `https://www.one-tab.com/*` 发送 POST/GET 请求（JSON 格式），用于标签页列表的分享与云端同步功能。需要用户先授权 `optional_host_permissions`。

## 七、权限清单

| 权限 | 类型 | 用途 |
|------|------|------|
| `tabs` | required | 查询、创建、更新、关闭标签页 |
| `storage` | required | chrome.storage.local 持久化数据 |
| `unlimitedStorage` | required | 无限制存储空间 |
| `favicon` | required | 获取网站 favicon |
| `activeTab` | required | 访问当前活跃标签页 |
| `scripting` | required | 动态注册 content script |
| `contextMenus` | required | 右键菜单 "发送到 OneTab" |
| `tabGroups` | optional | 标签组折叠/展开/颜色管理 |
| `readingList` | optional | 导入 Chrome 阅读列表 |
| `bookmarks` | optional | 导入 Chrome 书签 |
| `https://www.one-tab.com/*` | optional_host | 分享与同步功能 |

## 八、技术决策

1. **无框架纯 DOM**：减少依赖体积，提升加载速度；自行实现了轻量 virtual DOM 风格的 `I()` / `T()` 构造器
2. **扁平化存储**：用 `childIds`/`parentIds` 数组而非嵌套对象，便于增量更新和 diff
3. **离线优先 + 在线同步**：主数据存储在 chrome.storage.local，one-tab.com 仅作为可选的云端同步层
4. **Proxy 代理模式**：所有 UI 页面对 background 的调用通过 Proxy 对象透明转发，简化调用代码
5. **未提交变更暂存机制**：离线时变更暂存到 `uncommittedChangesStore`，联网后自动同步
6. **60+ 语言支持**：通过 Chrome i18n API 实现，`_locales/` 目录包含 62 个语言包
