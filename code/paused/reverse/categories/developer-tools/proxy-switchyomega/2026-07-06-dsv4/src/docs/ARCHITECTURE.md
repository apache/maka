# Proxy SwitchyOmega (V3) v3.0.5 — 架构文档

## 概述

Proxy SwitchyOmega (V3) 是一款 Chrome 浏览器代理管理和自动切换扩展。它允许用户轻松管理和切换多个代理配置，并基于 URL 规则自动选择代理。V3 版本是原 SwitchyOmega 的 Manifest V3 迁移分支，针对 Chrome MV3 的 Service Worker 架构进行了适配。

- **扩展 ID**: `padekgcemlokbadohgkifijomclgjgif` (Chrome Web Store)
- **仓库**: <https://github.com/mrfanii/SwitchyOmega-V3>
- **Manifest 版本**: 3
- **最低 Chrome 版本**: 111

---

## 架构分层图

```mermaid
graph TB
    subgraph "UI 层 (User Interface)"
        POPUP[Popup 面板<br/>popup/index.html<br/>AngularJS App]
        OPTIONS[选项页面<br/>options.html<br/>AngularJS App + UI-Router]
    end

    subgraph "通信层 (Communication)"
        MSG[chrome.runtime.sendMessage<br/>请求-响应模式]
        CONNECT[chrome.runtime.connect<br/>长连接端口]
    end

    subgraph "Service Worker 层 (Background)"
        SW[x-background.js<br/>ES Module Service Worker]
        BG[js/background.js<br/>核心业务逻辑编排]
        TARGET[js/omega_target_chromium_extension.min.js<br/>Chrome 平台适配层]
        PAC[js/omega_pac.min.js<br/>PAC 生成 + 配置匹配引擎]
    end

    subgraph "代理决策层 (Proxy Decision)"
        CONDITION[OmegaPac.Conditions<br/>条件匹配 (host/url/regex/ip/time)]
        PROFILES[OmegaPac.Profiles<br/>配置管理 (CRUD/查找/校验)]
        RULES[OmegaPac.RuleList<br/>规则列表解析与组合]
    end

    subgraph "存储层 (Storage)"
        LOCAL[chrome.storage.local<br/>配置持久化]
        SYNC[chrome.storage.sync<br/>跨设备同步]
        LS[localStorage<br/>运行时状态<br/>omega.local.*]
        IDB[idb-keyval / IndexedDB<br/>localStorage polyfill 后端]
    end

    subgraph "平台层 (Platform)"
        PROXY_API[chrome.proxy API<br/>代理设置与控制]
        WEBREQ[chrome.webRequest<br/>网络请求监控]
        TABS_API[chrome.tabs API<br/>标签页管理]
        MENUS[chrome.contextMenus<br/>右键菜单]
    end

    subgraph "外部 (External)"
        ANALYTICS[analytics.editcookie.com<br/>页面访问统计]
        GITHUB[GitHub Issues<br/>问题报告]
        EXT_API[ExternalApi<br/>其他扩展远程控制]
    end

    POPUP --> MSG
    OPTIONS --> MSG
    POPUP --> CONNECT
    MSG --> SW
    CONNECT --> SW
    SW --> BG
    BG --> TARGET
    BG --> PAC
    PAC --> CONDITION
    PAC --> PROFILES
    PAC --> RULES
    BG --> LOCAL
    BG --> SYNC
    BG --> LS
    LS -.-> IDB
    BG --> PROXY_API
    BG --> WEBREQ
    BG --> TABS_API
    BG --> MENUS
    BG --> ANALYTICS
    BG --> GITHUB
    BG --> EXT_API
    OPTIONS --> EXT_API

    style POPUP fill:#e1f5fe
    style OPTIONS fill:#e1f5fe
    style BG fill:#fff3e0
    style TARGET fill:#fff3e0
    style PAC fill:#fff3e0
    style LOCAL fill:#e8f5e9
    style LS fill:#e8f5e9
    style PROXY_API fill:#fce4ec
    style ANALYTICS fill:#ffcdd2
```

---

## 模块职责表

| 模块 / 文件 | 层级 | 职责 | 技术栈 |
|---|---|---|---|
| `popup/index.html` + `popup/js/` | UI | 弹出面板: 快速切换代理、临时规则、页面信息 | AngularJS, iframeResizer |
| `options.html` + `js/options.js` | UI | 选项页面: 所有配置的增删改查、导入导出、主题切换 | AngularJS, UI-Router, UI-Bootstrap, jsondiffpatch |
| `x-background.js` | Service Worker | ES Module 入口, 导入所有后台依赖 | ES Modules (import) |
| `background.html` | 遗留兼容 | 原 MV2 event page 入口 (MV3 中不再使用, 保留兼容) | HTML |
| `js/background.js` | 核心编排 | 初始化存储/状态/代理/标签监控, 处理所有 chrome.runtime.onMessage | OmegaTargetCurrent API |
| `js/omega_target_chromium_extension.min.js` | 平台适配 | Chrome 扩展平台专用实现: proxy 设置、webRequest 监控、badge 管理 | Chrome Extension API |
| `js/omega_target.min.js` | 核心引擎 | 平台无关的核心逻辑: 配置存储、同步、外部 API、页面匹配 | 通用 JS (跨浏览器) |
| `js/omega_pac.min.js` | 代理引擎 | PAC 脚本生成、配置条件匹配、规则列表解析 | PAC 规范 |
| `js/omega.js` | UI 控制器 | AngularJS 模块定义、路由配置、所有 UI 控制器和过滤器 | AngularJS 1.x |
| `js/omega_decoration.js` | UI 装饰器 | AngularJS 指令: 配置图标、内联显示、下拉选择 | AngularJS Directives |
| `js/omega_target_web.js` | UI 通信 | Options/Popup 页到 background 的通信桥接 (omegaTarget 服务) | AngularJS $q Promise |
| `js/omega_target_popup.js` | Popup 通信 | Popup 页面专用的 background 通信桥接 (简化版) | chrome.runtime.sendMessage |
| `page_statistics.js` | 分析统计 | 页面访问统计上报到 analytics.editcookie.com | chrome.tabs, fetch |
| `content_scripts.js` | 内容脚本 | 监听页面 URL 变更 (popstate), 通知 background | chrome.runtime.sendMessage |
| `js/log_error.js` | 日志 | 全局 window.onerror 捕获, 写入 localStorage['log'] | Error handling |
| `js/omega_debug.js` | 调试 | 调试工具: 下载日志、重置配置、报告问题 | chrome.runtime |
| `idb-keyval.js` | 存储适配 | IndexedDB 键值存储封装 (localStorage 的后备实现) | IndexedDB |
| `localstorage-polyfill.js` | 存储适配 | Service Worker 环境下的 localStorage polyfill (基于 IndexedDB) | Proxy |
| `csso.js` | 样式处理 | CSS 缩减/优化工具 | 自研 CSS 引擎 |

---

## 技术栈识别

| 类别 | 技术 | 版本/说明 |
|---|---|---|
| **UI 框架** | AngularJS (1.x) | angular.min.js, 验证了 `angular.module('omega', [...])` |
| **路由** | UI-Router | `$stateProvider.state(...)`, 嵌套路由 |
| **UI 组件** | UI-Bootstrap | 模态框、下拉、tab 等 |
| **样式** | Bootstrap 3 + 自定义主题 | bootstrap.min.css, 70+ base16 主题 |
| **依赖加载** | $script.js (script.js) | 异步脚本加载器, 链式依赖管理 |
| **差异对比** | jsondiffpatch | 配置变更增量对比 |
| **颜色选择** | Spectrum | lib/spectrum/spectrum.js |
| **排序拖拽** | jQuery UI Sortable | Angular UI Sortable 封装 |
| **加载动画** | Ladda + Spin.js | 按钮加载效果 |
| **文件保存** | FileSaver.js | Blob 文件下载 |
| **iframe 适配** | iframeResizer | Popup 自适应高度 |
| **新手引导** | Shepherd.js | 分步引导教程 |
| **Promise** | 自研 (OmegaTargetCurrent.Promise) | 带 longStackTraces 的 Promise polyfill |
| **代理引擎** | 自研 OmegaPac | PAC 生成、条件匹配、配置管理 |
| **存储** | chrome.storage.local/sync + localStorage + IndexedDB | 多层存储体系 |

---

## 配置类型体系

Proxy SwitchyOmega 支持 8 种配置类型, 构成层级代理决策系统:

```
DirectProfile      — 直接连接 (绕过代理)
SystemProfile      — 使用系统代理设置
AutoDetectProfile  — 自动检测代理 (WPAD)
FixedProfile       — 固定代理服务器 (HTTP/HTTPS/SOCKS4/SOCKS5)
PacProfile         — PAC 脚本代理 (本地/远程 URL)
VirtualProfile     — 虚拟配置 (指向另一个配置)
SwitchProfile      — 条件切换配置 (条件 → 配置)
RuleListProfile    — 规则列表配置 (附加到 SwitchProfile)
```

配置键名约定: 存储中以 `+` 前缀, 隐藏/内置以 `_` 前缀 (如 `__ruleListOf_`).

---

## 权限清单与分析

| 权限 | 用途 | 风险等级 |
|---|---|---|
| `proxy` | 设置和读取 Chrome 代理配置 | 高 — 可控制所有网络流量路由 |
| `tabs` | 读取标签页 URL、更新/刷新标签页 | 中 — 可访问所有标签页信息 |
| `alarms` | 定时任务 (如定期更新远程 PAC/规则列表) | 低 |
| `storage` | 持久化配置到 chrome.storage | 低 — 本地数据 |
| `webRequest` | 监控网络请求以进行规则匹配 | 高 — 可观察所有网络流量 |
| `webRequestAuthProvider` | 为代理连接提供认证凭据 | 极高 — 可拦截代理认证凭据 |
| `contextMenus` | 添加右键菜单项 | 低 |
| `<all_urls>` (host) | 内容脚本和 webRequest 访问所有网站 | 高 — 全局访问 |

**特殊权限说明:**
- `webRequestAuthProvider`: 此权限允许扩展在代理认证期间提供凭据。由于此扩展管理代理配置, 用户可以配置带认证的 SOCKS5/HTTP 代理, 凭据通过此权限注入。
- `<all_urls>` + `webRequest`: 组合使用以匹配所有 URL 并应用代理规则, 但同时也赋予扩展观察所有网络流量的能力。

---

## 第三方库清单

| 库 | 文件 | 用途 | 体积 (approx) |
|---|---|---|---|
| AngularJS 1.x | lib/angular/angular.min.js | MVVM 框架 | 145 KB |
| jQuery | lib/jquery/jquery.min.js | DOM 操作 | 87 KB |
| UI-Router | lib/angular-ui-router/angular-ui-router.min.js | SPA 路由 | 37 KB |
| UI-Bootstrap | lib/angular-bootstrap/ui-bootstrap-tpls.min.js | UI 组件 | 117 KB |
| jsondiffpatch | lib/jsondiffpatch/jsondiffpatch.min.js | 增量差异 | 37 KB |
| FileSaver | lib/FileSaver/FileSaver.min.js | 文件保存 | 4 KB |
| Spectrum | lib/spectrum/spectrum.js | 颜色选择器 | 51 KB |
| iframeResizer | lib/iframeResizer/ | iframe 自适应 | 13 KB |
| Shepherd | lib/shepherd.js/ | 引导教程 | 24 KB |
| Ladda + Spin | lib/ladda/, lib/spin.js/ | 加载动画 | 19 KB |
| idb-keyval | idb-keyval.js | IndexedDB KV | 5 KB |
| Bootstrap 3 | lib/bootstrap/ | CSS 框架 | 146 KB |
| base16 主题 | lib/themes/ (70+ 文件) | 代码高亮主题 | ~100 KB |

---

## 关键架构决策

### 1. MV3 Service Worker 适配

原 SwitchyOmega 是 MV2 扩展, 使用持久化 background page。V3 版本通过 `localstorage-polyfill.js` 在 Service Worker 环境下模拟 localStorage (基于 IndexedDB), 并确保所有异步操作正确保持 Service Worker 生命周期。

### 2. Promise 自研实现

`omega_target.min.js` 包含一个完整的 Promise polyfill (`OmegaTargetCurrent.Promise`), 带有 `longStackTraces()` 调试功能, 而非使用浏览器原生 Promise — 这是为了兼容旧版浏览器。

### 3. jsondiffpatch 增量同步

配置保存采用 jsondiffpatch 增量 diff 策略: 计算新旧配置差异, 只将变更的 patch 发送到存储层, 减少了存储写入量并支持更细粒度的同步。

### 4. Popup Iframe 架构

Popup 面板使用 iframe 嵌套架构: `popup-iframe.html` 加载 `popup/index.html`, 通过 iframeResizer 实现自适应宽度。这种设计避免了 Chrome popup 窗口的尺寸限制。

### 5. 外部 API (ExternalApi)

`options.externalApi` 允许其他扩展通过 `chrome.runtime.sendMessage` 远程控制 SwitchyOmega 的代理切换 — 这是一个重要的 extensibility 设计, 但也带来了安全考量。
