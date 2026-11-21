# Lumno - 安全审计报告

> 审计对象: Lumno v0.9.14 Chrome 扩展 (源码逆向分析)
> 审计日期: 2026-07-05
> 审计方式: 静态源码分析
> 风险等级: 低-中

## 一、资产清单

| 资产 | 存储位置 | 敏感度 |
|------|----------|--------|
| 浏览器历史记录 | 仅本地搜索，不向外发送 | 高 |
| 书签数据 | 仅本地使用 | 中 |
| 常用网站列表 | 仅本地使用 | 低 |
| 标签页 URL/标题 | 仅本地处理 | 中 |
| 标签页缩略图 (JPEG base64) | chrome.storage (session/local) | 中 |
| 用户设置 (主题/语言等) | chrome.storage.sync | 低 |
| 固定标签 URL 快照 | chrome.storage.local | 中 |
| 搜索选择统计 | chrome.storage.sync | 低 |
| AI Provider 配置 | 仅 `openAndSubmit` 中转，不存储凭据 | — |

## 二、权限风险矩阵

| 权限 | 风险等级 | 理由 |
|------|----------|------|
| `scripting` | 中 | 可在任意页面注入脚本，但仅用于覆盖层搜索和 PiP |
| `tabs` | 中 | 可读取标签 URL/标题，但不向外发送 |
| `history` | 中 | 可读取历史记录，但仅本地搜索使用 |
| `topSites` | 低 | 常用网站列表仅在本地使用 |
| `bookmarks` | 低 | 书签数据仅在本地使用 |
| `storage` | 低 | 无敏感数据外泄路径 |
| `search` | 低 | 仅用于搜索引擎建议查询 |
| `favicon` | 低 | 仅用于获取网站图标 |
| `host_permissions: <all_urls>` | 高 | 可访问所有网站 — 这是 Chrome Web Store 审核的重点关注项 |

### host_permissions 风险缓解

经审查，`<all_urls>` 权限的使用仅限于：

1. **全局键盘热键监听** (`hotkey-listener.js`) — 需要在所有页面捕获按键
2. **覆盖层注入** — 需要将搜索面板注入任意 HTTP/HTTPS 页面
3. **PiP 自动检测** — 需要在视频站点注入 PiP 脚本

代码中实现了严格的 URL 守卫 (`url-guards.js`)：

- `isRestrictedUrl()` — 阻止在 `chrome://`, `edge://`, `about:` 等浏览器内部页面操作
- `canOpenOverlayOnUrl()` — 覆盖层仅允许在 `http:`, `https:`, `file:` 协议页面打开
- 显式排除 Chrome Web Store 和扩展商店页面

## 三、外部通信分析

### 3.1 出站请求

| 目标 | 协议 | 用途 | 风险 |
|------|------|------|------|
| `fetch(localePath)` | HTTPS | 加载多语言消息 JSON | 低 — 仅读取扩展内置文件 |
| `fetch(site-search.json)` | HTTPS | 加载站点搜索配置 | 低 — 内置静态文件 |
| `https://t2.gstatic.cn/faviconV2` | HTTPS | Google Favicon 服务获取网站图标 | 低 — 仅 GET 请求 |
| 搜索引擎 URL (用户选择) | HTTPS | 执行搜索 | 低 — 用户主动触发 |
| AI 站点 (ChatGPT/Gemini/DeepSeek 等) | HTTPS | 交互式 AI 搜索提交 | 低 — 用户主动触发 |

### 3.2 入站请求

无外部入站请求点。扩展不监听任何外部连接。

### 3.3 数据外发风险

**未发现数据外发行为。** 搜索历史、书签、标签信息均在本地 chrome.storage 中存储和处理，未发现向任何遥测/统计/分析服务器发送数据的代码。

## 四、存储安全

| 存储项 | 安全评估 |
|--------|----------|
| 标签页切换统计 (`_x_extension_tab_switch_stats_*`) | 存储切换频次时间戳，不含 URL 明文 |
| 标签页缩略图 (`_x_extension_tab_switcher_state_*`) | JPEG base64 存储于 session/local storage，浏览器内访问 |
| 固定标签快照 (`_x_extension_pinned_tab_snapshot_*`) | 存储 URL 列表于 local storage，用于浏览器崩溃恢复 |
| 搜索选择统计 (`_x_extension_search_selection_stats_*`) | 存储搜索词→URL 映射，仅用于提升搜索相关性 |
| AI 密钥清理 | 代码中显式移除废弃的 AI 相关存储键（`_x_extension_ai_api_key_*` 等） |

## 五、注入安全

### 5.1 Content Script 注入

- `hotkey-listener.js` — `run_at: document_start`，`<all_urls>` — 仅监听键盘事件
- `site-auto-pip.js` — `run_at: document_idle`，限定域名匹配列表 — 仅操作视频元素
- `youtube-auto-pip.js` — `run_at: document_idle`，限定 `youtube.com` — 仅操作 YouTube 播放器

### 5.2 覆盖层注入 (scripting.executeScript)

覆盖层使用 `chrome.scripting.executeScript` 注入。注入前经过严格的 URL 检查：

1. `isRestrictedUrl()` 检查 → 阻止内部页面
2. `canOpenOverlayOnUrl()` 检查 → 仅 HTTP/HTTPS/file 协议
3. 排除 Chrome Web Store / Edge Add-ons / Opera Addons

### 5.3 页面内脚本 (MAIN world)

`pip-main-world.js` 在 MAIN world 下执行，用于调用 `video.requestPictureInPicture()`。该脚本仅操作视频元素，不执行任意代码。

### 5.4 Shadow DOM 隔离

覆盖层 UI 通过 Shadow DOM 注入，与宿主页面 DOM 隔离，防止样式污染和事件冲突。

## 六、消息通信安全

| 通信方式 | 安全评估 |
|----------|----------|
| `runtime.sendMessage` | 内部消息路由，基于 action 字符串分发 |
| `tabs.sendMessage` | 向特定标签内容脚本发送消息 |
| port (`lumno-tab-switcher-extension-page`) | 扩展页面内标签切换器专用通道 |

消息路由使用 `message-router.js` 的 action 白名单机制。未注册的 action 返回 `{ ok: false }`。

## 七、依赖与供应链

| 依赖 | 来源 | 风险 |
|------|------|------|
| pinyin-pro.js | 内联 vendor (`assets/vendor/pinyin-pro.js`) | 低 — 本地内联，纯拼音转换库 |
| Remix Icon | 内联字体+CSS (`assets/remixicon/`) | 低 — 本地内联，图标字体 |
| Open Sans | 内联字体 (`assets/fonts/open-sans/`) | 低 — 本地内联，字体文件 |

无外部 CDN 依赖，无 npm 包依赖，所有依赖均内联包含在扩展包中。

## 八、发现的问题

### 8.1 低风险

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| 1 | IIFE 全局命名空间无冲突保护 | 所有 shared/background 模块 | 考虑使用模块系统或更严格的命名空间隔离 |
| 2 | 标签页缩略图存于 storage，可能包含敏感页面截图 | `background.js` line ~1091 | 考虑对缩略图设置更短的 TTL (当前 2 小时) |
| 3 | `document.execCommand('copy')` 回退方案 | `hotkey-listener.js` | 已正确优先使用 Clipboard API，execCommand 仅为回退 |

### 8.2 信息提示

| # | 观察 | 说明 |
|---|------|------|
| 1 | 扩展使用 `chrome.storage.sync` 为主存储 | sync 存储有 100KB 配额限制，当前合理使用 |
| 2 | Service Worker 使用 `importScripts` 而非 ES Modules | 符合 Manifest V3 规范，但无法 tree-shaking |
| 3 | 部分 CSS 使用 `corner-shape: superellipse()` | 这是 CSS Houdini 新特性，部分浏览器不支持 |
| 4 | `_favicon/*` web_accessible_resource | 使用了 Chrome 内置 favicon API |

## 九、总结

**整体安全等级: 低风险**

该扩展设计合理，无明显恶意行为：

- 所有数据在本地处理，未发现向外部服务器发送用户数据
- 权限使用有合理的 URL 守卫和限制
- 用户数据的存储和访问均有边界
- AI 搜索功能仅作为 URL 中转，不存储任何凭据
- 无外部 CDN 依赖
- 已清理废弃的 AI 密钥存储键

主要关注点是 `<all_urls>` 的 `host_permissions` 权限（Chrome Web Store 审核的重点），代码中已有完善的 URL 守卫来缓解此风险。
