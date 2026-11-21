# EditThisCookie V3 架构文档

> 反向工程版本: dsv4 | 源版本: v3.0.5 | 日期: 2026-07-06

---

## 一、概述

EditThisCookie (V3) 是一款基于 Chrome Manifest V3 的 Cookie 管理扩展。它允许用户查看、编辑、创建、删除、导入/导出 Cookie，并支持 Cookie 拦截过滤和只读保护等高级功能。

## 二、Manifest 配置分析

```json
{
  "manifest_version": 3,
  "version": "3.0.5",
  "default_locale": "en",
  "minimum_chrome_version": "88"
}
```

| 配置项 | 值 | 说明 |
|--------|-----|------|
| manifest_version | 3 | 使用 MV3 规范 |
| service_worker | /js/background.js (type: module) | 后台使用 ES Module Service Worker |
| devtools_page | /devtools/devtools-page.html | 注册 DevTools 面板 |
| options_page | options_main_page.html | 选项页面入口 (跳转路由) |
| action.default_popup | popup.html | 工具栏弹出窗口 |
| permissions | tabs, cookies, contextMenus, unlimitedStorage, storage, clipboardWrite | 核心权限 |
| host_permissions | \<all_urls\> | 所有网站均可操作 Cookie |

### 权限用途

| 权限 | 用途 |
|------|------|
| tabs | 获取当前标签页 URL，刷新页面 |
| cookies | 读取、创建、修改、删除 Cookie |
| contextMenus | 右键菜单入口 |
| unlimitedStorage | 大量 Cookie 数据存储不设限 |
| storage | chrome.storage.local 持久化偏好和数据 |
| clipboardWrite | 导出 Cookie 到剪贴板 |
| \<all_urls\> | 操作所有域名的 Cookie |

## 三、核心入口与模块结构

### 3.1 入口清单

| 入口点 | HTML 文件 | JS 入口 | 说明 |
|--------|-----------|---------|------|
| Service Worker | — | js/background.js | MV3 后台，常驻生命周期 |
| Popup | popup.html | js/popup.js | 工具栏弹窗 |
| DevTools Panel | devtools/panel.html | devtools/panel.js | DevTools Cookie 表格面板 |
| DevTools Page | devtools/devtools-page.html | devtools/devtools-page.js | 注册 DevTools 面板 |
| Options Router | options_main_page.html | js/options_main_page.js | 选项路由跳转 |
| Options — Preferences | options_pages/user_preferences.html | options_pages/user_preferences.js | 偏好设置 |
| Options — Block Rules | options_pages/block_rules.html | options_pages/block_rules.js | 拦截规则管理 |
| Options — ReadOnly Rules | options_pages/readonly_rules.html | options_pages/readonly_rules.js | 只读保护规则 |
| Options — Support | options_pages/support.html | options_pages/support.js | 支持页面 |

### 3.2 JS 模块依赖图

```
background.js  ─── common-utils.js (isChristmasPeriod, storage)
               ├── cookie_helpers.js (deleteCookie, cookieForCreationFromFullCookie, compareCookies)
               ├── data.js (startData)
               └── utils.js (filterMatchesCookie)

popup.js  ─── jquery-3.3.1
          ├── jquery-ui-1.12.1
          ├── jquery.uniform
          ├── data.js (startData)
          ├── cookie_helpers.js (buildUrl, deleteAll, deleteCookie, Filter, cookieForCreationFromFullCookie, cookiesToStringGenerator)
          ├── utils.js (getHost, addBlockRule, switchReadOnlyRule, _getMessage, filterMatchesCookie, getUrlVars, copyToClipboard, setLoaderVisible)
          ├── custom_i18n.js
          └── i18n_translator.js

devtools/panel.js  ─── jquery + jquery-ui + tablesorter + jeditable + uniform
                  ├── data.js
                  ├── utils.js (getUrlVars)
                  ├── custom_i18n.js
                  └── i18n_translator.js

devtools/devtools-page.js  ─── data.js (startData)
```

### 3.3 第三方库依赖

| 库 | 版本 | 路径 | 用途 |
|----|------|------|------|
| jQuery | 3.3.1 | lib/jquery-3.3.1.min.js | DOM 操作、动画 |
| jQuery UI | 1.12.1 | lib/jquery-ui-1.12.1.custom.min.js | Accordion、Button、Dialog |
| jQuery Uniform | — | lib/uniform/jquery.uniform.js | 表单样式统一 |
| jQuery jeditable | — | lib/jquery.jeditable.js | 内联编辑 |
| jQuery tablesorter | — | lib/tablesorter/ | DevTools 表格排序 |
| Font Awesome | 7.0.1 | css/font-awesome-7.0.1/ | 图标 |
| Open Sans | — | css/opensans/ | Web 字体 |

## 四、架构分层

```
┌────────────────────────────────────────────────┐
│                   UI 层                         │
│  popup.js  │  panel.js  │  options_pages/*.js  │
│  (jQuery UI Accordion, 表格, 表单)              │
├────────────────────────────────────────────────┤
│                 业务逻辑层                       │
│  cookie_helpers.js  │  utils.js                │
│  (Cookie CRUD, 过滤, 导入导出格式)              │
├────────────────────────────────────────────────┤
│                 数据层                           │
│  data.js  (startData, Object.watch, 持久化)     │
│  common-utils.js  (storage 封装, isChristmas)   │
├────────────────────────────────────────────────┤
│                 平台层                           │
│  chrome.cookies.*  │  chrome.storage.local      │
│  chrome.tabs.*     │  chrome.runtime.*          │
│  chrome.contextMenus  │  chrome.devtools.*      │
└────────────────────────────────────────────────┘
```

## 五、关键技术决策

### 5.1 Object.prototype.watch 特性

data.js 向 `Object.prototype` 注入了 `watch` / `unwatch` 方法。这在 MV3 的 module-type service worker 中是高风险操作——修改全局原型可能与其他扩展冲突。该 watch 机制用于在 `preferences` 和 `data` 对象的属性变化时自动触发 `chrome.storage.local` 的同步写入。

### 5.2 数据持久化策略

- `preferences` 对象: 键前缀 `options_` → chrome.storage.local
- `data` 对象: 键前缀 `data_` → chrome.storage.local
- 属性变更时通过 watch 回调触发异步写入 (debounce via `isSyncDataToStorageLook` 锁)
- 跨上下文同步通过 `chrome.storage.onChanged` 事件

### 5.3 i18n 机制

- 使用 Chrome 标准 `_locales/{code}/messages.json`
- 支持 32 种语言 (ar, zh_CN, zh_TW, cs, da, nl, en, et, fi, fr, de, el, he, hu, id, it, ja, ko, lt, ms, no, pl, pt_BR, pt_PT, ro, ru, sr, sk, es, sv, tr, uk, vi)
- `custom_i18n.js` 覆盖了 `chrome.i18n.getMessage()`，支持自定义语言优先级
- `i18n_translator.js` 提供 `localizePage()` 基于 `[i18n]` 属性的 DOM 翻译

### 5.4 Service Worker 键位

- `background.js` 为 module-type service worker
- 使用 `import` 语句而非 `importScripts()`
- 使用 `chrome.runtime.onConnect` 与 DevTools page 建立长连接
- 监听 `chrome.cookies.onChanged` 实现实时拦截和保护
- 监听 `chrome.contextMenus.onClicked` 实现右键菜单

### 5.5 DevTools 集成

- `devtools-page.html` 加载 `devtools-page.js`
- 向 background 建立 named port (`"devtools-page"`)
- 通过 `chrome.devtools.inspectedWindow.tabId` 获取当前调试标签页
- 发送 `"getall"` action 请求 Cookie 列表
- 修改 Cookie 后发送 `"submitCookie"` action

### 5.6 选项页面路由

- `options_main_page.html` 仅作为路由入口
- 从 `chrome.storage.local` 读取 `option_panel` 键决定目标页面
- 通过 `location.href` 跳转到 `/options_pages/{page}.html`
- 支持 URL 参数 `?page=xxx` 直接指定页面

## 六、文件目录结构 (~125 文件)

```
├── manifest.json                     # MV3 清单
├── popup.html                        # 弹出窗口
├── options_main_page.html            # 选项路由入口
├── js/
│   ├── background.js                 # Service Worker (module)
│   ├── popup.js                      # Popup 主逻辑
│   ├── common-utils.js               # 通用工具 (storage, isChristmas)
│   ├── cookie_helpers.js             # Cookie 操作辅助
│   ├── data.js                       # 数据层 (state + watch + persistence)
│   ├── utils.js                      # 工具函数 (过滤, 剪贴板, URL)
│   ├── data-popup-loader.js          # (空文件/占位)
│   └── options_main_page.js          # 选项路由逻辑
├── devtools/
│   ├── devtools-page.html            # DevTools 注册页
│   ├── devtools-page.js              # DevTools 面板创建
│   ├── panel.html                    # Panel UI
│   ├── panel.js                      # Panel 主逻辑 (tablesorter)
│   └── panel.css                     # Panel 样式
├── options_pages/
│   ├── options_page_chooser.js       # 侧边栏导航组件
│   ├── user_preferences.html/js/css  # 偏好设置
│   ├── block_rules.html/js/css       # 拦截规则
│   ├── readonly_rules.html/js/css    # 只读规则
│   └── support.html/js/css           # 支持页面
├── lib/
│   ├── custom_i18n.js                # 自定义 i18n
│   ├── i18n_translator.js            # DOM 翻译器
│   ├── jquery-3.3.1.min.js           # jQuery
│   ├── jquery-ui-1.12.1.custom.min.js# jQuery UI
│   ├── jquery.jeditable.js           # 内联编辑
│   ├── uniform/                      # 表单统一样式
│   └── tablesorter/                  # 表格排序
├── css/
│   ├── popup.css / popup-accordion.css / popup-tabs.css
│   ├── options.css / options_main_page.css
│   ├── font-awesome-7.0.1/           # Font Awesome 图标
│   ├── opensans/                     # Open Sans 字体
│   └── smoothness/                   # jQuery UI 主题
├── img/                              # 图标资源
├── _locales/                         # 多语言资源 (32 语言)
└── _metadata/                        # Chrome Web Store 元数据
```

## 七、设计模式与反模式

### 设计模式

- **Observer 模式**: `Object.prototype.watch` 实现数据变更自动同步
- **Pub-Sub 模式**: `chrome.storage.onChanged` 跨上下文数据同步
- **策略模式**: `cookiesToString` 对象封装多种导出格式 (json/netscape/semicolonPairs/lpw)
- **路由模式**: `options_main_page.js` 根据 storage 状态路由到不同选项页

### 反模式/技术债

- **全局原型污染**: `Object.prototype.watch` 修改原生原型
- **jQuery 重度依赖**: 整个 UI 层与 jQuery 紧密耦合
- **全局状态**: `data` 和 `preferences` 对象作为可变全局状态
- **类型安全缺失**: 纯 JavaScript，无 TypeScript 类型检查
- **错误处理不足**: 大量 try-catch 仅打印 console.error
