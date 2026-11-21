# SimpleUndoClose v3.0.1 — 架构文档

## 概述

SimpleUndoClose 是一款轻量级 Chrome 扩展 (MV3)，通过弹出面板让用户查看和恢复最近关闭的标签页。它追踪所有打开的标签页，在关闭时将快照保存到 `chrome.storage.local`，并在 popup 中按时间倒序展示。

**技术栈**: Vanilla JS (无框架/无打包器), Chrome Extension Manifest V3, Service Worker 后台, i18n 国际化 (8 种语言)。

## 架构分层

```
┌──────────────────────────────────────────────────────┐
│                   UI Layer (HTML + JS)                │
│  ┌─────────────────┐ ┌──────────────┐ ┌───────────┐ │
│  │   popup.html      │ │ options.html │ │about.html │ │
│  │   + popup.js      │ │+ options.js  │ │credits.html│ │
│  │   + popup.css     │ │+ options.css │ │+ il8n.js  │ │
│  │   + popup-dark.css│ │+ common.js   │ │+ feedback.js│ │
│  │   + theme.js      │ │+ il8n.js     │ │+ theme.js │ │
│  └────────┬──────────┘ └──────┬───────┘ └───────────┘ │
│           │ runtime.sendMessage│                        │
│           └──────────┬────────┘                        │
│                      ▼                                 │
├──────────────────────────────────────────────────────┤
│            Background Layer (Service Worker)           │
│  ┌──────────────────────────────────────────────────┐ │
│  │              background.js (448 行)               │ │
│  │  ┌────────────┐ ┌──────────────┐ ┌────────────┐ │ │
│  │  │ 初始化/迁移  │ │ 标签页追踪系统 │ │ 消息路由    │ │ │
│  │  │initialize()│ │addNewTab()   │ │onMessage   │ │ │
│  │  ├────────────┤ ├──────────────┤ ├────────────┤ │ │
│  │  │ 设置管理    │ │ 关闭标签页存储 │ │ 图标/Badge  │ │ │
│  │  │settingsUpd│ │addClosedTab()│ │setBadge()  │ │ │
│  │  ├────────────┤ ├──────────────┤ ├────────────┤ │ │
│  │  │ 标签页恢复   │ │ 孤儿记录清理   │ │ 快捷键      │ │ │
│  │  │createTab() │ │cleanClosedTabs│ │onCommand   │ │ │
│  │  └────────────┘ └──────────────┘ └────────────┘ │ │
│  └──────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────┤
│            Shared Utilities                            │
│  ┌──────────────────────────────────────────────────┐ │
│  │  common.js     — 共享标签页操作 (popup + options) │ │
│  │  il8n.js       — DOM i18n 自动翻译引擎            │ │
│  │  theme.js      — 亮/暗模式主题切换 (popup+options)│ │
│  │  feedback.js   — 反馈链接供应商检测 (about.html)   │ │
│  └──────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────┤
│              External Surface                          │
│  ┌──────────────────────┐ ┌─────────────────────────┐│
│  │ chrome.storage.local │ │ Chrome Commands API     ││
│  │ (全部持久化数据)       │ │ (Alt+Z / MacCtrl+Z)    ││
│  └──────────────────────┘ └─────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

## 文件清单

| 文件 | 大小 | 职责 |
|------|------|------|
| `manifest.json` | 904 B | 扩展清单 (MV3, 3 权限, 1 命令) |
| `background.js` | 12.2 KB | Service Worker — 标签页追踪/存储/消息路由/初始化 |
| `popup.js` | 22.1 KB | 弹出面板 — 列表渲染/搜索/分页/键盘导航/长按批量操作 |
| `options.js` | 10.0 KB | 设置页面 — 19 个配置项的读写 |
| `common.js` | 5.9 KB | 共享工具 — createTab/removeClosedTab/setBadge/updateIcon 等 |
| `theme.js` | 523 B | 主题切换 — 亮/暗/跟随系统 (3 种模式) |
| `il8n.js` | 974 B | i18n 引擎 — `i18n` 属性自动翻译 + 顶部按钮提示词 |
| `feedback.js` | 885 B | 反馈链接 — 检测 Opera/Chrome 供应商选择对应 URL |
| `popup.html` | 1.4 KB | 弹出面板 HTML 骨架 |
| `popup.css` | 5.3 KB | 弹出面板样式 |
| `popup-dark.css` | 327 B | 弹出面板暗色模式 |
| `options.html` | 7.0 KB | 设置页面 HTML 骨架 |
| `options.css` | 6.6 KB | 设置页面样式 |
| `options-dark.css` | 712 B | 设置页面暗色模式 |
| `scrollbar.css` | 193 B | 共享滚动条样式 |
| `about.html` | 3.8 KB | 关于/使用技巧/权限说明页 |
| `credits.html` | 13.1 KB | 致谢/全版本更新日志 |
| `_locales/` | — | 8 种语言的 i18n 消息 (en/es/hu/ja/ru/sr/zh_CN/zh_TW) |
| `icon-*.png` | 7 个文件 | 多分辨率图标 (16/19/38/48/128) |
| `*.png` | 4 个 | 功能图标 (搜索/设置/关于/博客/清空) |

## 模块职责表

### Background (Service Worker - background.js)

| 模块 | 职责 | 依赖的 Chrome API |
|------|------|-------------------|
| **初始化引擎** | 安装时写入默认设置、初始化索引数组、注册现有标签页 | storage.local, runtime.onInstalled |
| **设置迁移器** | 版本升级时合并新旧设置键 (类型1: 添加新键, 类型2: 删除废弃键) | storage.local |
| **标签页追踪器** | 监听 `tabs.onUpdated` 和 `tabs.onCreated`，将当前标签页快照写入 `TabList-{tabId}` | tabs.onUpdated, tabs.onCreated |
| **关闭标签页记录器** | 监听 `tabs.onRemoved`，将标签页快照从 TabList 移到 ClosedTab | tabs.onRemoved, storage.local |
| **去重逻辑** | 同一 URL 重复关闭时删除旧记录，只保留最新一条 | storage.local |
| **溢出管理** | 当 `ClosedTabIndex.length > numLimit` 时，从头部删除最旧条目 | storage.local |
| **孤儿记录清理** | 启动时扫描 ClosedTab-* 键，删除不在索引中的孤立键 | storage.local |
| **标签页恢复** | 通过 `chrome.tabs.create({url, active})` 恢复关闭的标签页 | tabs.create |
| **Badge 更新** | 根据 `showBadge` 设置和闭标签页计数设置工具栏徽章 | action.setBadgeText, action.setBadgeBackgroundColor |
| **图标切换** | 根据 `altBut` 设置和系统暗色模式切换工具栏图标 | action.setIcon |
| **消息路由** | 响应 popup/options 的消息 (createTab/removeClosedTab/resetData/getSettings) | runtime.onMessage |
| **快捷键处理** | 响应 `undo-latest` 命令恢复最近关闭的标签页 | commands.onCommand |
| **启动/更新处理** | 监听 onInstalled (install/update) 和 onStartup 事件 | runtime.onInstalled, runtime.onStartup |

### Popup (popup.html + popup.js)

| 模块 | 职责 | 技术细节 |
|------|------|----------|
| **列表渲染器** | 从 ClosedTabIndex 倒序遍历，渲染每页 `numItems` 条记录 | DOM 操作, `chrome.storage.local.get()` 批量读取 |
| **条目创建器** | 为每条记录创建链接 DOM，绑定长按/点击/中键事件 | `addEventListener` (mousedown/touchstart/click/auxclick) |
| **搜索引擎** | 支持多关键词搜索 (AND 逻辑)，带元音变音字符规范化 | `String.prototype.multiFind`, 200ms debounce |
| **分页系统** | 上一页/下一页导航，键盘左右箭头翻页 | `pageNo` 变量, `numItems` 每页条目数 |
| **键盘导航** | 上下箭头遍历链接、回车选择、ESC 等 | `onkeydown` 事件, `selLink` 当前选择 |
| **长按批量模式** | 长按条目后进入 checkbox 模式，支持批量打开/删除/新建窗口 | `longpress` 变量, `chkArray` 选中集合 |
| **单条删除** | 根据 style 设置 (1/2/3) 渲染不同删除按钮样式 | 内联 click-shield (`event.stopPropagation`) |
| **时间显示** | 计算并格式化 "X 小时/分钟/秒 前" 字符串 | `getElapsedTime()` — 原生算术，无第三方库 |
| **按钮本地化** | DOMContentLoaded 时替换按钮文本为 i18n 消息 | `chrome.i18n.getMessage()` |
| **语言特定调整** | 俄语/塞尔维亚语下调整按钮宽度和字体大小 | `btnLangAdj()` — 硬编码语言特定样式 |

### Options (options.html + options.js)

| 模块 | 职责 | 技术细节 |
|------|------|----------|
| **设置绑定** | 19 个设置项的 checkbox/radio/range 值与 storage 双向绑定 | `addEventListener('click'/'input', save)` — 每次更改立即持久化 |
| **溢出修剪** | 当 numLimit 减少时，调用 trimTabs 删除多余的 ClosedTab 记录 | 按索引顺序从头删除 |
| **指数滑块映射** | numLimit (5-99994) 通过反指数函数映射到滑块 50-600 范围 | 5 + (sliderValue^5 / 600^5) * 99994 |
| **快捷键配置** | 打开 Chrome 系统快捷键设置页 | `chrome.tabs.create({url: 'chrome://extensions/configureCommands'})` |
| **数据清除** | 确认后通过 runtime.sendMessage 触发 resetData | `confirm()` → `{action: "resetData"}` |
| **主题重载** | theme 改变后调用 location.reload() 立即生效 | 避免动态切换 CSS 的复杂性 |

### 共享模块

| 模块 | 文件 | 被引用页面 | 职责 |
|------|------|-----------|------|
| **common.js** | 5.9 KB | options.html | createTab/createTabWindow/addNewTab/saveTabData/chkNewTab/removeClosedTab/setBadge/resetData/updateIcon/regExistingTabs/getLatestCTab (11 个函数, 与 background.js 功能重叠) |
| **il8n.js** | 974 B | about.html, credits.html, options.html | 自动翻译带有 `i18n` 属性的元素 + 设置顶部按钮工具提示 |
| **theme.js** | 523 B | popup.html, options.html, about.html, credits.html | 根据 settings.theme 移除暗色模式 CSS 的 `media` 属性或 `href` |
| **feedback.js** | 885 B | about.html | 检测 Opera vs Chrome 供应商，设置对应的反馈链接 URL |

## 技术决策

### 1. 为什么使用 `chrome.storage.local` 而非 `IndexedDB` 或 `localStorage`

- **chrome.storage.local** 是 Chrome 扩展的推荐持久化方案，Service Worker 和 UI 页面均可直接访问
- 异步 API (`chrome.storage.local.get/set`) 天然适配 Service Worker 的无阻塞要求
- 无需声明额外权限 (已包含在 `storage` 权限中)
- 数据量小 (最多几百条 ClosedTab 记录，每条 < 1KB)，localStorage 的无配额特性无需优先

### 2. 为什么使用 `"|!|"` 作为记录分隔符

- URL 中不会出现 `|!|` 组合，实现零冲突分割
- 比 JSON 序列化更简洁 (每条记录少约 40% 字节)
- 直接 `split("|!|")` 即可解析，无需 `JSON.parse`

### 3. 为什么 `common.js` 和 `background.js` 有函数重叠

- `common.js` 在 options.html 中被引用，用于直接在 storage 上操作 (不经过消息通信)
- `background.js` 中的同名函数服务于 Service Worker 的后台逻辑
- 这是一种代码重复，但避免了 Service Worker 模块导出与页面 `<script>` 导入的不兼容问题
- 实际上 `popup.js` 中的 `createTab`/`removeClosedTab` 也通过 `runtime.sendMessage` 调用了 background 版本

### 4. 为什么使用双索引 (TabListIndex + ClosedTabIndex)

- `TabListIndex[live]` 追踪当前打开的标签页，用于浏览器关闭时批量处理
- `ClosedTabIndex[closed]` 追踪已关闭的标签页，用于 popup 展示
- 索引数组 (非对象) 天然保持插入顺序
- 通过索引+前缀键名可以实现高效的范围查询和孤儿记录清理

### 5. 为什么使用随机 ID 而非 Chrome tabId 作为 ClosedTab 键名

- Chrome `tabId` 在标签页关闭后可能会被回收重用，导致键名冲突
- 6 字符随机 ID (`Math.random().toString(36).substring(2,8)`) 碰撞概率极低 (36^6 ≈ 2.1B)
- 去重逻辑通过 URL 匹配而非 ID 匹配，不受 ID 选择影响

### 6. 搜索的去元音变音规范化

- 实现 `stripVowelAccent()` 处理拉丁扩展字符 (A-Z 的变音版本)
- 使用 Latin-1 补充区字节级正则替换: `[\xC0-\xC2]` → `A`, `[\xE0-\xE2]` → `a` 等
- 搜索前对用户输入和存储数据均进行规范化，实现无变音搜索

## 权限清单与用途

| 权限 | 用途 | 风险等级 |
|------|------|----------|
| `tabs` | 监听标签页状态变化 (`onUpdated`/`onRemoved`)、创建标签页 (`tabs.create`)、查询现有标签页 (`tabs.query`) | 中 |
| `storage` | 持久化设置、标签页快照、索引数据到 `chrome.storage.local` | 低 |
| `favicon` | 获取标签页的网站图标 (在 popup 中通过 Google Favicon API 间接获取，本扩展未直接使用此权限) | 低 |
| `<all_urls>` (host) | 该扩展实际声明了此 host_permission 但未使用 content script 或跨域 fetch — 仅用于 `tabs.query({"url": "*://*/*"})` 的参数匹配 | **高** (但无实际远程访问风险) |

## 第三方依赖

| 库 | 来源 | 用途 | 许可证 |
|----|------|------|--------|
| 无 | — | — | — |

SimpleUndoClose 是一个**零依赖**的纯 Vanilla JS 项目，无任何 npm 包、CDN 脚本或第三方库。所有的 DOM 操作、存储访问、事件处理均使用原生浏览器 API。

## 代码可读性评估

- **打包方式**: 无打包器，原生 JS 文件直接部署
- **混淆程度**: 未混淆，变量名和函数名保持原始波兰语注释和英文函数名
- **代码质量**: 注释为波兰语，函数名和变量名为英文。代码风格为早期 ES5 风格 (var 声明、回调风格 Promise 包装)，但已部分适配 ES2017+ (async/await)
- **sourcemap**: 无 (不需要，因为未打包)
