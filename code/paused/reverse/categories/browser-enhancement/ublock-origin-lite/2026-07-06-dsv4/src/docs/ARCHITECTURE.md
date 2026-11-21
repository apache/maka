# uBlock Origin Lite — 架构文档

> **版本:** 2026.628.2035 | **Manifest:** V3 | **作者:** Raymond Hill  
> **逆向日期:** 2026-07-06 | **模型:** DeepSeek V4 Pro (dsv4)

---

## 一、扩展概述

uBlock Origin Lite (uBOL) 是 uBlock Origin 的 MV3 合规版本。它放弃了 MV2 的 `webRequest` 阻塞能力，转而完全依赖 Chrome 的 `declarativeNetRequest` (DNR) API 实现网络请求过滤，从而在 Manifest V3 架构约束下继续提供内容拦截功能。

**核心差异 (vs uBlock Origin MV2):**
- 不再使用 `webRequest` API (MV3 中仅支持观察模式, 无法拦截)
- 所有网络过滤预先编译为 DNR 静态/动态规则集
- Cosmetic 过滤通过 `scripting` API 注入内容脚本实现
- Scriptlet 注入通过 `userScripts` API 实现
- 过滤模式与 host 权限绑定 (basic/optimal/complete 三级)

---

## 二、分层架构

```
┌──────────────────────────────────────────────────────┐
│                    UI 层                              │
│  popup.html    dashboard.html    matched-rules.html  │
│  report.html   strictblock.html  zapper-ui.html      │
│  picker-ui.html  unpicker-ui.html                     │
│       ↕ BroadcastChannel / runtime.sendMessage        │
├──────────────────────────────────────────────────────┤
│                Service Worker 层 (单线程)             │
│  background.js (主入口, 消息路由)                      │
│    ├── mode-manager.js     (过滤模式管理)             │
│    ├── ruleset-manager.js  (规则集管理 + DNR 操作)    │
│    ├── filter-manager.js   (自定义过滤器管理)         │
│    ├── scripting-manager.js(content script 注册)      │
│    ├── compiled-filters.js (scriptlet 编译)           │
│    ├── config.js           (配置持久化)               │
│    ├── admin.js            (托管策略)                 │
│    ├── alarms.js           (定时任务调度)             │
│    ├── prevent-popup.js    (弹窗拦截)                 │
│    ├── action.js           (工具栏图标)               │
│    ├── imported-lists.js   (导入列表管理)             │
│    ├── ext.js              (Chrome API 封装)          │
│    ├── ext-compat.js       (跨浏览器兼容)             │
│    ├── ext-utils.js        (扩展工具函数)              │
│    ├── ext-offscreen.js    (Offscreen 文档管理)       │
│    ├── fetch.js            (网络请求封装)              │
│    ├── utils.js            (通用工具函数)              │
│    ├── debug.js            (调试/日志)                │
│    ├── urlskip.js          (URL 参数剥离)             │
│    └── deep-compare.js     (深度比较)                 │
│       ↕ chrome.runtime.sendMessage                    │
├──────────────────────────────────────────────────────┤
│              Offscreen Document 层                    │
│  js/offscreen/compile-filters.js (过滤器编译)          │
│  js/offscreen/fetch-list.js       (远程列表拉取)       │
│  js/offscreen/regex-analyzer.js   (正则分析)          │
├──────────────────────────────────────────────────────┤
│              内容脚本层 (注入到页面)                    │
│  js/scripting/                    (cosmetic 过滤)     │
│    css-api.js, css-generic.js, css-specific.js        │
│    css-procedural-api.js, css-user.js                 │
│    isolated-api.js                                     │
│  js/scripting/                    (交互工具)           │
│    tool-overlay.js, zapper.js, picker.js, unpicker.js │
│    toolbar-icon.js                                     │
│  js/scripting/                    (弹窗拦截)           │
│    prevent-popup.js, prevent-popup-target.js          │
├──────────────────────────────────────────────────────┤
│              Scriptlet 层 (userScripts)               │
│  js/resources/scriptlets.js       (77KB, 核心脚本集)   │
│  js/resources/*.js                (30+ 专用脚本)       │
├──────────────────────────────────────────────────────┤
│              数据层                                    │
│  ┌─────────────────┐  ┌────────────────────┐         │
│  │ storage.local    │  │ storage.session     │         │
│  │ (持久化配置)      │  │ (CSS 缓存/会话状态)  │         │
│  ├─────────────────┤  ├────────────────────┤         │
│  │ rulesetConfig    │  │ rulesetConfig (副本) │         │
│  │ filteringMode    │  │ filteringModeDetails │         │
│  │   Details        │  │ cache.css.*          │         │
│  │ customFilters    │  │                      │         │
│  │ importedLists    │  │                      │         │
│  │ permissions.*    │  │                      │         │
│  └─────────────────┘  └────────────────────┘         │
│  ┌──────────────────────────────────────────┐        │
│  │ rulesets/ (静态规则文件, 打包在扩展内)      │        │
│  │  main/   (60+ DNR ruleset JSON 文件)      │        │
│  │  regex/  (正则分析数据)                    │        │
│  │  scripting/ (cosmetic 过滤清单)           │        │
│  │  strictblock/ (严格拦截重定向模板)         │        │
│  │  urlskip/ (URL 跟踪参数剥离规则)          │        │
│  │  ruleset-details.json                    │        │
│  │  scriptlet-details.json                  │        │
│  │  generic-details.json                    │        │
│  └──────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────┘
```

---

## 三、模块职责详表

### 3.1 Service Worker 核心模块

| 模块 | 文件 | 大小 | 核心职责 |
|------|------|------|----------|
| **主入口** | `background.js` | 29KB | Service Worker 入口, 消息路由 (80+ 消息类型), 生命周期管理, 权限变更处理 |
| **过滤模式管理** | `mode-manager.js` | 15KB | 4 级过滤模式 (none/basic/optimal/complete) 的读/写/查询, 按 hostname 精细化控制 |
| **规则集管理** | `ruleset-manager.js` | 27KB | DNR 静态规则集的启用/禁用/更新, 动态规则和会话规则的增删 |
| **过滤器管理器** | `filter-manager.js` | 10KB | Element picker 创建的自定义过滤器 (CSS selector + scriptlet) 的 CRUD |
| **脚本管理器** | `scripting-manager.js` | 13KB | 根据过滤模式注册/注销 content scripts, 管理 CSS 注入规则 |
| **编译过滤器** | `compiled-filters.js` | 10KB | 通过 Offscreen Document 编译 scriptlet 过滤器, 注册 userScripts |
| **配置管理** | `config.js` | 3KB | `rulesetConfig` 对象的加载/持久化, 首次运行检测, 服务唤醒检测 |
| **托管策略** | `admin.js` | 8KB | 读取 `managed_storage.json` 企业策略, 合并管理员配置 |

### 3.2 平台抽象层

| 模块 | 文件 | 核心职责 |
|------|------|----------|
| **浏览器 API** | `ext.js` | 封装 `chrome.*` / `browser.*` API, 提供 local/session storage 读写, userScripts 检测, 平台检测 (chromium/firefox/safari) |
| **跨浏览器兼容** | `ext-compat.js` | monkey-patch `dnr.setAllowAllRules`, 正则规则验证, 浏览器引擎差异处理 |
| **扩展工具** | `ext-utils.js` | `gotoURL` (标签页导航), `hasBroadHostPermissions` (host 权限检查) |
| **Offscreen** | `ext-offscreen.js` | Offscreen Document 的创建/关闭管理 |

### 3.3 过滤引擎

| 模块 | 文件 | 大小 | 核心职责 |
|------|------|------|----------|
| **静态过滤解析器** | `static-filtering-parser.js` | 169KB | 完整的 uBlock 过滤语法解析器, 将文本规则转为 AST, 再编译为 DNR 规则或 CSS selector |
| **DNR 解析器** | `dnr-parser.js` | 19KB | 将过滤规则文本转换为 DNR API 兼容的 JSON 规则 |
| **DNR 编辑器** | `dnr-editor.js` | 6KB | DNR 规则的增删改查接口 |
| **只读编辑器** | `ro-dnr-editor.js` | 3KB | 只读模式下的 DNR 规则操作 |
| **读写编辑器** | `rw-dnr-editor.js` | 16KB | 读写模式下的 DNR 规则操作 |
| **URL 跳过** | `urlskip.js` | 6KB | 基于 rulesets/urlskip 规则移除 URL 中的跟踪参数 |

### 3.4 UI 层

| 模块 | 文件 | 核心职责 |
|------|------|----------|
| **弹窗** | `popup.js` + `popup.html` | 工具栏弹窗 UI, 显示当前站点过滤级别, 滑块切换, 规则集开关 |
| **仪表盘** | `dashboard.js` + `dashboard.html` | 设置页面 (options_page), 规则集管理, 过滤器编辑器, 备份/恢复, 故障排查 |
| **设置** | `settings.js` | 仪表盘设置面板逻辑 (11KB) |
| **过滤器编辑器** | `filter-editor.js` | 自定义过滤规则编辑界面 |
| **规则集 UI** | `filter-manager-ui.js` | 规则集管理界面 |
| **主题** | `theme.js` | 亮/暗主题切换 |
| **国际化** | `i18n.js` | 动态加载 i18n 消息, 支持 80+ 语言 |
| **DOM 工具** | `dom.js` | DOM 操作辅助函数 |
| **Font Awesome** | `fa-icons.js` | Font Awesome 图标集 (48KB) |

### 3.5 内容脚本与 Scriptlet

| 目录 | 核心职责 |
|------|----------|
| **`js/scripting/`** | 注入到页面的内容脚本: cosmetic 过滤 (CSS 注入/移除), element picker, zapper, 弹窗拦截, 工具栏图标控制 |
| **`js/resources/`** | Scriptlet 库 (30+ 个脚本): cookie 操作, JSON 修剪, localStorage 清理, fetch/XHR 拦截, setTimeout 防滥用, 事件监听器阻止等 |

### 3.6 第三方库

| 库 | 位置 | 用途 |
|----|------|------|
| **CodeMirror** | `lib/codemirror/` | 过滤器编辑器的代码编辑器 |
| **CSS Tree** | `lib/csstree/` | CSS selector 解析 (用于 `static-filtering-parser`) |
| **Regex Analyzer** | `lib/regexanalyzer/` | 正则表达式分析优化 |
| **S14E Serializer** | `lib/s14e-serializer.js` | 结构化数据序列化 |

---

## 四、关键技术决策

### 4.1 为什么使用三层过滤模式

| 模式 | 权限需求 | 能力 | 适用场景 |
|------|----------|------|----------|
| **none** | 无需 | 不进行任何过滤 | 用户信任的站点 |
| **basic** | 无需 host 权限 | 仅 DNR 网络请求过滤 (无 cosmetic) | 隐私敏感用户, 不授予 host 权限 |
| **optimal** | 特定站点 host 权限 | DNR + 特定站点 cosmetic 过滤 | **默认模式**, 平衡隐私与效果 |
| **complete** | `<all_urls>` host 权限 | DNR + 特定 + 通用 cosmetic 过滤 | 最大防护, 等同原版 uBlock |

**设计理由:** MV3 中 host 权限是敏感权限, Chrome Web Store 审查严格. 分层模式允许用户在 basic 模式下无需授予任何 host 权限即可获得网络层的广告/跟踪拦截, 而 cosmetic 过滤 (隐藏页面元素) 需要的 host 权限可按需授予.

### 4.2 DNR 静态规则集策略

扩展打包了 60+ DNR 静态规则集 JSON 文件, 分为:
- **默认启用 (6 个):** ublock-filters, easylist, easyprivacy, pgl, ublock-badware, urlhaus-full
- **可选 (50+ 个):** 地区语言规则集 (ara/cze/deu/fra/jpn/kor/rus/spa/...), 骚扰过滤 (annoyances-cookies/overlays/social/...), 实验性规则
- **最大启用数:** Chrome 限制 50 个静态规则集同时启用

### 4.3 Content Script 动态注册

不同于传统扩展在 manifest.json 中声明 `content_scripts`, uBOL 使用 `chrome.scripting.registerContentScripts()` API 在运行时根据过滤模式动态注册 — 这允许根据 `filteringModeDetails` 中的 hostname 集合动态调整哪些站点注入 content scripts, 最小化不必要的脚本注入.

### 4.4 BroadcastChannel 通信

对于同一扩展的多个上下文 (popup, dashboard, service worker, offscreen) 之间的广播通知 (如配置变更), 使用 `BroadcastChannel('uBOL')` 而非逐个 `sendMessage`, 减少消息路由复杂度.

---

## 五、权限清单与分析

| 权限 | 类型 | 用途 | 风险 |
|------|------|------|:--:|
| `activeTab` | 权限 | Element picker/zapper 在当前标签页注入脚本 | 低 |
| `alarms` | 权限 | 调度周期性任务 (规则集更新, 过滤器列表拉取) | 低 |
| `declarativeNetRequest` | 权限 | 核心过滤能力 — 阻止/重定向/修改网络请求 | 低 |
| `offscreen` | 权限 | 创建离屏文档编译过滤器 (避开 Service Worker DOM 限制) | 低 |
| `scripting` | 权限 | 动态注入 cosmetic 过滤内容脚本和工具脚本 | 中 |
| `storage` | 权限 | 持久化用户配置/过滤模式/自定义规则 | 低 |
| `unlimitedStorage` | 权限 | 存储较大规则集和过滤器数据 | 低 |
| `userScripts` | 权限 | 注入 scriptlet 到页面主世界 (MAIN world) | **高** |
| `<all_urls>` | host 权限 | complete 模式下的通用 cosmetic 过滤 | **高** |

**重点关注:** `userScripts` 权限允许脚本访问页面的 JavaScript 全局作用域 (MAIN world), 可用于拦截和修改页面脚本行为 (如防止广告脚本加载). 这也是 scriptlet 注入的核心依赖, 但具有相当的能力范围.

---

## 六、文件统计

| 类别 | 数量 | 说明 |
|------|:----:|------|
| JS 模块 (Service Worker) | 20+ | ES Module, 无打包器, 原生 import/export |
| JS 模块 (内容脚本) | 14 | 注入到页面的独立脚本 |
| JS 模块 (Scriptlet) | 30+ | userScripts 注入的页面级脚本 |
| JS 模块 (Offscreen) | 10 | 离屏文档中运行的脚本 |
| HTML 页面 | 7 | popup, dashboard, matched-rules, report, strictblock, zapper-ui, picker-ui, unpicker-ui |
| CSS 文件 | 20+ | 各页面对应样式表 |
| DNR 规则集 | 60+ | 静态 JSON 规则文件 |
| 第三方库 | 4 | CodeMirror, CSS Tree, Regex Analyzer, S14E Serializer |
| 本地化 | 80+ | _locales/ 下 80+ 语言目录 |
| 图片资源 | 300+ | 国旗图标, 扩展图标, UI 图标 |
| Web 可访问资源 | 35 | noop 脚本/图片/媒体, 广告脚本替代 |

---

## 七、编码特征

- **模块系统:** 100% 原生 ES Module (`import`/`export`), 无打包器 (webpack/rollup/vite)
- **代码风格:** GPL-3.0 开源项目, 高质量手写 JavaScript, 无混淆
- **注释质量:** 每个模块文件开头有完整的许可证声明和项目描述
- **Source Map:** 无 (原生 ES Module 无需 source map)
- **最小 Chrome 版本:** 122.0
