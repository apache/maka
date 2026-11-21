# i微信读书 (WeRead Helper) 架构文档

## 概述

**i微信读书** (v0.9.22) 是一款基于 Chrome Manifest V2 的微信读书网页版增强扩展。提供划线摘抄、生成分享书签图片、导出读书笔记(Markdown)、同步到 Flomo/Readwise/Notion、切换字体/皮肤/纸张纹理、代码高亮等功能。使用 Webpack 5 打包，含 Source Map。

- **扩展名称**: i微信读书
- **版本**: 0.9.22
- **Manifest 版本**: MV2 (Manifest V2)
- **打包工具**: Webpack 5 + Hot Module Replacement (HMR)
- **UI 框架**: React 17 (Class Component + Function Component 混用)
- **可读性**: 打包但有完整 source map，部分代码保留注释和变量名

---

## 项目结构

```
weread-helper-source-code/
├── manifest.json                  # MV2 扩展声明
├── background.js                  # 后台脚本 (Persistent)
├── contentScript.js               # Content Script (document_start)
├── i.js                           # 注入到页面的预加载脚本 (Inject Script)
├── m.js                           # 腾讯云/阿里云 CPS 脚本 (Inject Script)
├── popup.html                     # 弹出窗口 HTML
├── popup.js                       # 弹出窗口脚本
├── plugin.js                      # 主应用 Webpack Bundle (~4.3MB)
├── plugin.js.map                  # Source Map (~4.8MB)
├── plugin.js.LICENSE.txt          # 第三方库许可证
├── plugin.*.hot-update.js(x4)     # Webpack HMR 热更新模块
├── fonts/                         # 字体文件 (5 个 ttf, ~23MB)
│   ├── kaiti.ttf                  # 楷体
│   ├── xingkai.ttf                # 行楷
│   ├── zuiyou.ttf                 # 最右
│   ├── xingshu.ttf                # 手写/行书
│   └── FZYouSK_509R.ttf           # 宋体
├── images/                        # 图标 (16/32/48/128 + QR)
└── _metadata/                     # Chrome Web Store 元数据
```

---

## 系统架构

i微信读书采用**三层注入架构**：Background Script -> Content Script -> Inject Script，这是 MV2 下实现 DOM 深层集成的典型模式。

```
┌─────────────────────────────────────────────────────────────┐
│                  Chrome Extension Runtime (MV2)              │
├─────────────────────────────────────────────────────────────┤
│  Background Script (background.js) — Persistent             │
│  ├── webRequest 拦截 — CSP 移除 / CORS 头注入               │
│  ├── 飞书 API 集成 — tenant_access_token / 文档创建          │
│  ├── Message Listener — chrome.runtime.onMessage            │
│  └── 硬编码 API 凭据 (飞书 App ID/Secret)                     │
├─────────────────────────────────────────────────────────────┤
│  Content Script (contentScript.js) — document_start          │
│  ├── Inject Script 加载器 — plugin.js + i.js 动态注入        │
│  ├── 自定义字体 CSS @font-face 注入                           │
│  ├── window.load 事件 Hook — 字体注册                        │
│  └── DOMContentLoaded 事件 Hook — 脚本注入                   │
├─────────────────────────────────────────────────────────────┤
│  Inject Scripts (i.js + plugin.js) — 页面主世界              │
│  ├── i.js: Function.prototype 劫持 → 文本选中事件拦截        │
│  ├── i.js: 百度统计初始化                                    │
│  └── plugin.js (Webpack Bundle) ← 核心应用逻辑              │
│      ├── src/main.jsx → ReactDOM.render                     │
│      ├── src/App.jsx → 根组件                               │
│      ├── src/components/ToolButton/index.jsx → 设置面板      │
│      ├── src/components/ToolBarItem/index.jsx → 划线工具栏   │
│      ├── src/components/BookCard/index.jsx → 书签卡片        │
│      ├── src/components/Dialog/index.jsx → 模态对话框        │
│      ├── src/components/Toast/index.jsx → 消息提示           │
│      ├── src/components/Switch/index.jsx → 开关组件          │
│      ├── src/components/PreloadFonts/index.jsx → 字体预加载  │
│      ├── src/utils/store.js → window.r Proxy (微信读书Store) │
│      ├── src/utils/db.js → store2 本地持久化 (namespace:iwr) │
│      ├── src/utils/index.js → 核心业务函数                   │
│      ├── src/utils/config.js → 字体列表配置                  │
│      ├── src/utils/listener.js → 事件监听注册                │
│      ├── src/utils/sentry.js → Sentry 错误监控               │
│      ├── src/utils/doc.js → 飞书文档 API (与 background 重复) │
│      ├── src/utils/Image.js → Unsplash 随机图片缓存          │
│      └── src/utils/hash.js → MD5 + bookId 哈希               │
└─────────────────────────────────────────────────────────────┘
```

### 额外 Content Script

```
m.js — "matches": ["https://cloud.tencent.com/*","*://*.aliyun.com/*"]
├── 腾讯云: 注入 cps_key 推广参数
└── 阿里云: 注入 userCode 推广参数
```

---

## 模块职责表

| 文件/模块 | 运行上下文 | 职责 |
|-----------|-----------|------|
| `manifest.json` | Extension | MV2 声明, permissions, content_scripts, web_accessible_resources |
| `background.js` | Background | CSP 移除, CORS 注入, 飞书 API, 消息监听 |
| `contentScript.js` | Content Script | 脚本注入器, 字体注册 |
| `i.js` | Page Main World | Function.prototype 劫持, 百度统计 |
| `m.js` | Page Main World (云站) | 腾讯云/阿里云 CPS 推广参数注入 |
| `plugin.js` (bundle) | Page Main World | React UI 完整应用 |
| `plugin.js.map` | — | Source Map (开发调试用) |
| `popup.html` | Popup | 使用说明 + 推广链接 |
| `popup.js` | Popup | 占位代码 (chrome.storage 示例) |
| `fonts/*.ttf` | Content Script | 自定义阅读字体 (3.7~11.2MB each) |

---

## 技术决策

### 1. MV2 + Persistent Background

采用 MV2 (而非 MV3)，因为需要 `webRequestBlocking` 来修改 CSP/CORS 头。MV3 的 `declarativeNetRequest` 不支持动态修改响应头。

### 2. Inject Script 模式

通过 `contentScript.js` 在 `document_start` 阶段注入 `<script>` 标签到页面主世界：
- 绕过 Content Script 隔离沙箱限制
- 直接访问微信读书的 `window.r` 全局 Store 对象
- 通过 Proxy 代理保持对微信读书 Store 的热引用

### 3. Function.prototype 劫持 (i.js)

劫持 `Function.prototype.apply` 来拦截微信读书内部的 `showSelectionToolBar` 调用，从中提取选中文本对象并派发自定义 `textselect` 事件。

### 4. Webpack HMR 热更新残留

dist 中包含 4 组 `*.hot-update.js` 文件，说明开发构建时开启了 HMR 但未在生产构建中清理。这些文件是冗余的。

### 5. Proxy Store 模式

`src/utils/store.js` 使用 `new Proxy({}, handler)` 代理 `window.r`：
- 每次读取都从 `window.r` 实时获取最新值
- 解决了微信读书 SPA 路由切换时 Store 引用失效的问题

---

## 权限清单

| 权限 | 用途 | 风险 |
|------|------|------|
| `webRequest` | 拦截 HTTP 请求 | 中 |
| `webRequestBlocking` | 修改 CSP/CORS 响应头 | 高 |
| `*://weread.qq.com/*` | 微信读书主站 | 低 |
| `*://flomoapp.com/*` | Flomo API 划线同步 | 中 |
| `*://api.notion.com/*` | Notion API 笔记同步 | 中 |
| `*://open.feishu.cn/*` | 飞书 API 文档创建 | 中 |
| `*://*.tencent.com/*` | 腾讯系站点 (含云服务 CPS) | 中 |

---

## 第三方依赖

| 依赖 | 版本推测 | 用途 |
|------|---------|------|
| React + ReactDOM | 17.x | UI 框架 |
| @sentry/react + @sentry/tracing | 6.x | 错误监控和性能追踪 |
| html2canvas | 1.x | 书签卡片截图导出 |
| turndown | 7.x | HTML 转 Markdown |
| store2 | 2.x | localStorage 封装 (namespace: iwr) |
| highlight.js | 11.x | 代码块语法高亮 |
| dom-event-types | — | 事件类型列表 (用于 stopPropagation 全部事件) |
| @babel/runtime | 7.x | Polyfill helpers |
| regenerator-runtime | — | async/await polyfill |

---

## 外部服务依赖

| 服务 | URL | 用途 | 认证方式 |
|------|-----|------|---------|
| Sentry | `o1228425.ingest.sentry.io` | 前端错误追踪 | 硬编码 DSN |
| 百度统计 | `hm.baidu.com` | 用户行为分析 | 硬编码统计ID |
| Unsplash | `source.unsplash.com` | 书签卡片随机背景图 | 无认证 |
| transparenttextures.com | `transparenttextures.com` | 纸张纹理图片 | 无认证 |
| Flomo | `flomoapp.com` (用户输入 API URL) | 划线摘抄同步 | 用户 API URL |
| Readwise | `readwise.io/api/v2/highlights/` | 笔记批量同步 | 用户 Token |
| Notion (代理) | `wx.redream.cn/weixin/ireader/notion/upsert/` | 笔记同步到 Notion | 用户 Token (中转) |
| 飞书开放平台 | `open.feishu.cn` | 文档创建 | 硬编码 App ID/Secret |
| Markdown 预览 | `md.redream.cn` | 导出笔记在线预览 | 无认证 |
| 腾讯云推广 | `cloud.tencent.com` | CPS 推广链接 | 硬编码 CPS Key |
