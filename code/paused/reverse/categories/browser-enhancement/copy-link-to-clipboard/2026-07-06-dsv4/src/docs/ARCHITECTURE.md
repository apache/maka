# ARCHITECTURE.md -- 复制链接到剪贴板 v15.1.3

## 1. 扩展概述

**复制链接到剪贴板** (url2clipboard) 是一个 Chrome Manifest V3 扩展，用于将当前页面/链接/标签页的 URL 以多种标记格式复制到剪贴板。支持 16 种输出格式，通过右键菜单、键盘快捷键、弹出窗口三种方式触发。

- 扩展 ID: `url2clipboard@asamuzak.jp`
- 仓库: https://github.com/asamuzaK/url2clipboard
- 许可: MPL-2.0
- MV3 Service Worker, ES Module

## 2. 分层架构图

```
+------------------------------------------------------------------+
|                         UI 层                                     |
|  +------------------+  +------------------+  +---------------+   |
|  | popup.html       |  | options.html     |  | offscreen.html|   |
|  | (弹出菜单)        |  | (设置页面)        |  | (隐形文档)     |   |
|  +--------+---------+  +--------+---------+  +-------+-------+   |
|           |                      |                    |           |
+-----------+----------------------+--------------------+-----------+
            |                      |                    |
+-----------v----------------------v--------------------v-----------+
|                      通信层 (Message Bus)                         |
|  +--------------------------------------------------------------+ |
|  | chrome.runtime.sendMessage / onMessage                       | |
|  | 消息类型: executeCopy / contextInfo / notifyOnCopy /         | |
|  |           promptContent / sanitizeAttributes / sanitizeURL   | |
|  +--------------------------------------------------------------+ |
+------------------------------------------------------------------+
            |
+-----------v------------------------------------------------------+
|                    核心业务层 (Service Worker)                     |
|  +-------------------+  +-------------------+                    |
|  | background.js     |  | main.js           |                    |
|  | (事件绑定/路由)    |  | (核心逻辑/状态管理) |                    |
|  +-------------------+  +-------------------+                    |
|  +-------------------+  +-------------------+                    |
|  | menu.js           |  | format.js          |                   |
|  | (右键菜单管理)     |  | (格式定义与渲染)    |                   |
|  +-------------------+  +-------------------+                    |
+------------------------------------------------------------------+
            |
+-----------v------------------------------------------------------+
|                    浏览器 API 抽象层                               |
|  +--------------------------------------------------------------+ |
|  | browser.js (30+ API wrappers)                                | |
|  | - tabs / windows / storage / runtime / sessions              | |
|  | - permissions / scripting / notifications / bookmarks       | |
|  | - management / theme / search / contextualIdentities         | |
|  +--------------------------------------------------------------+ |
+------------------------------------------------------------------+
            |
+-----------v------------------------------------------------------+
|                    工具/安全层                                     |
|  +------------------+  +------------------+  +---------------+   |
|  | common.js        |  | clipboard.js     |  | sanitize*.js  |   |
|  | (字符串/URL工具)  |  | (Clip 类)        |  | (XSS 防护)    |   |
|  +------------------+  +------------------+  +---------------+   |
|  +------------------+  +------------------+  +---------------+   |
|  | dom-util.js      |  | ns-uri.js        |  | edit-content  |   |
|  | (DOM 序列化)      |  | (命名空间 URI)    |  | (prompt 编辑) |   |
|  +------------------+  +------------------+  +---------------+   |
+------------------------------------------------------------------+
            |
+-----------v------------------------------------------------------+
|                    第三方库                                       |
|  +------------------+  +------------------+  +---------------+   |
|  | webext-polyfill  |  | DOMPurify        |  | url-sanitizer  |   |
|  | (跨浏览器兼容)    |  | (HTML 净化)      |  | (URL 净化)     |   |
|  +------------------+  +------------------+  +---------------+   |
+------------------------------------------------------------------+
```

## 3. 模块职责表

| 文件 | 角色 | 依赖 |
|------|------|------|
| `mjs/background.js` | Service Worker 入口, 注册所有事件监听器 | main.js, menu.js, common.js, webext-polyfill |
| `mjs/main.js` | 核心业务逻辑: 复制执行/存储管理/命令处理/启动初始化 | browser.js, format.js, exec-copy.js, menu.js, sanitize.js, prompt.js, notify.js |
| `mjs/browser.js` | 浏览器 API 抽象层, 30+ 封装函数, 统一权限检查 | common.js |
| `mjs/menu.js` | 右键菜单创建/更新/移除, 动态子菜单生成 | browser.js, format.js, constant.js |
| `mjs/format.js` | 16 种格式定义 (`formatData`), 模板渲染 (`createLinkText`), 转义处理 | common.js, sanitize.js, constant.js |
| `mjs/clipboard.js` | `Clip` 类: 剪贴板写入 (navigator.clipboard.write / execCommand fallback) | dom-util.js, constant.js |
| `mjs/exec-copy.js` | 触发 offscreen 文档创建 + 发送复制消息 | constant.js |
| `mjs/offscreen-main.js` | offscreen 文档消息处理器: 执行复制/prompt/净化 | clipboard.js, sanitize-attr.js, url-sanitizer, edit-content.js |
| `mjs/offscreen.js` | offscreen 文档入口, 注册 onMessage 监听 | offscreen-main.js |
| `mjs/popup-main.js` | 弹出窗口逻辑: 菜单渲染/事件绑定/上下文信息获取 | browser.js, format.js, localize.js |
| `mjs/popup.js` | 弹出窗口入口 | popup-main.js |
| `mjs/options-main.js` | 设置页面逻辑: 存储读写/权限管理/UI 同步 | browser.js, constant.js |
| `mjs/options.js` | 设置页面入口 | options-main.js, localize.js, compat.js |
| `mjs/sanitize.js` | URL 净化调度 (直接调用/offscreen 委托) | url-sanitizer, constant.js |
| `mjs/sanitize-attr.js` | HTML 属性净化 (DOMPurify hook) | lib/purify/purify.min.js |
| `mjs/dom-util.js` | DOM 序列化: 安全重建 HTML/XML/SVG 文档片段 | ns-uri.js, common.js |
| `mjs/ns-uri.js` | 90+ XML 命名空间 URI 映射表 | -- |
| `mjs/prompt.js` | 内容编辑提示 (通过 offscreen document 调用 window.prompt) | constant.js |
| `mjs/edit-content.js` | 在 offscreen 上下文中调用 `window.prompt()` | -- |
| `mjs/notify.js` | 复制成功通知 (chrome.notifications) | browser.js, constant.js |
| `mjs/icon.js` | 工具栏图标切换 (action.setIcon) | common.js |
| `mjs/common.js` | 通用工具函数: 类型检查/错误处理/字符串处理/URL 编码 | -- |
| `mjs/constant.js` | 全局常量: 格式 ID/存储键名/消息类型/MIME 类型/扩展 ID | -- |
| `mjs/localize.js` | i18n HTML 本地化: data-i18n 属性扫描 | constant.js |
| `mjs/compat.js` | 浏览器兼容: 非 Firefox 时显示工具栏图标选项 | constant.js |
| `js/context-info.js` | 内容脚本 (注入页面): 提取选中文本/链接/canonical URL | -- |

## 4. 关键技术决策

### 4.1 Offscreen Document 用于剪贴板写入

MV3 Service Worker 中无 DOM, `navigator.clipboard.write()` 不可用。扩展通过 `chrome.offscreen.createDocument()` 创建隐形 HTML 页面 (`html/offscreen.html`), 在其中执行剪贴板写入, 写入完成后自关闭。

使用场景:
- **CLIPBOARD** 理由: 写入富文本 (text/html) 到剪贴板
- **DOM_PARSER** 理由: HTML 属性净化 (DOMPurify)、URL 净化 (data: 协议)、内容编辑 (window.prompt)

### 4.2 内容脚本按需注入

不使用 manifest 声明 content_scripts, 而是通过 `chrome.scripting.executeScript()` 动态注入 `js/context-info.js` 到活动标签页。该脚本读取页面中的选中文本、光标所在链接信息、canonical URL 后自返回结果。

### 4.3 双通道剪贴板写入

`Clip` 类实现分级剪贴板写入策略:
1. 优先: `navigator.clipboard.writeText()` (纯文本) 或 `navigator.clipboard.write()` (富文本, 通过 `ClipboardItem`)
2. 降级: `document.execCommand('copy')` (同步 fallback, 适用于旧环境)

### 4.4 格式模板系统

16 种格式通过 `formatData` 字典定义 (id / template / templateAlt / enabled), 模板变量为 `%content%` / `%url%` / `%title%` / `%attr%`。`createLinkText()` 函数根据格式 ID 对内容执行特定转义 (如 LaTeX 转义反斜杠, Markdown 转义方括号), 然后替换模板变量。

### 4.5 跨浏览器兼容

- `lib/mozilla/browser-polyfill.min.js` 提供 `browser.*` Promise API (兼容 Chrome 的 `chrome.*` 回调 API)
- `browser.menus ?? browser.contextMenus` 兼容 Firefox/Chrome 右键菜单 API 差异
- `menus.onShown` 可选链调用 (Firefox 特有 API, Chrome 不存在)
- 浏览器判断通过 `runtime.id === WEBEXT_ID` 区分 Firefox/Chrome 行为差异

### 4.6 右键菜单布局

7 类场景各自生成子菜单:
- `copyPageURL` -- contexts: page, selection
- `copyLinkURL` -- contexts: link
- `copyTabURL` (当前标签页) -- contexts: tab
- `copyTabsURL` (选中标签页) -- contexts: tab
- `copyOtherTabsURL` (其他标签页) -- contexts: tab
- `copyAllTabsURL` (所有标签页) -- contexts: tab
- `openOptions` -- contexts: action

每个场景下, 根据用户启用的格式动态生成子菜单项。多标签页场景 (All/Other/Selected), 每个标签页的链接文本用换行符 (或 `<br>`) 拼接。

## 5. 权限清单

| 权限 | 类型 | 用途 |
|------|------|------|
| `activeTab` | 必需 | 访问当前活动标签页的 URL 和标题 |
| `clipboardWrite` | 必需 | 写入剪贴板 |
| `contextMenus` | 必需 | 创建右键菜单 |
| `offscreen` | 必需 | 创建隐形文档执行剪贴板写入/净化 |
| `scripting` | 必需 | 动态注入内容脚本获取页面上下文 |
| `storage` | 必需 | 保存用户设置和格式启用状态 |
| `tabs` | 必需 | 获取标签页信息 |
| `notifications` | 可选 | 复制成功后显示通知 |
