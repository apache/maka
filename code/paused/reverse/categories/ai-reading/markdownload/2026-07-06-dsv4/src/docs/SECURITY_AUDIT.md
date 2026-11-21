# MarkDownload v3.4.0 — 安全审计

## 审计概览

| 维度 | 评级 | 说明 |
|------|------|------|
| 权限面 | 中 | `<all_urls>` 可读取任意网页内容，但无网络请求外传 |
| 数据流 | 低风险 | 数据仅在本地处理，不向外部服务器发送 |
| CSP (内容安全策略) | 无 | manifest.json 未声明 `content_security_policy`，使用默认宽松策略 |
| 注入面 | 中 | 使用 `tabs.executeScript` + `innerHTML` 操作，但均有合理业务用途 |
| 通信安全 | 低风险 | 仅扩展内部 `runtime.sendMessage`，无外部通信 |
| 存储安全 | 低风险 | `storage.sync` 仅存配置项，无敏感数据 |
| 隐私合规 | 低风险 | 无用户标识收集，无分析/遥测 |
| 依赖安全 | 中 | 4 个第三方库，均为知名开源项目但版本固定不可自动更新 |
| CSP 合规 | 一般 | MV2 默认 CSP 允许 `eval` 和 inline script |

---

## 一、权限面分析

### 已声明权限

```json
"permissions": ["<all_urls>", "activeTab", "downloads", "storage", "contextMenus", "clipboardWrite"]
```

### 逐项分析

| 权限 | 实际使用点 | 风险评估 |
|------|-----------|----------|
| `<all_urls>` | Content script 注入 (`tabs.executeScript`) + 上下文菜单 (`contextMenus`) | **高权限** — 是扩展最敏感的权限，但本扩展仅在用户交互时注入脚本，且不向外部发送数据 |
| `activeTab` | 工具栏 Popup 触发时获取当前标签页 | 与 `<all_urls>` 重叠，提供额外的即时访问路径 |
| `downloads` | `downloadMarkdown()` 写入文件系统 | 仅写入用户指定的下载目录，不读取现有文件 |
| `storage` | 存储用户配置 (Markdown 样式、模板、路径) | 仅同步配置，不存储网页内容或用户数据 |
| `contextMenus` | 创建/管理右键菜单 | 纯 UI 权限，无数据访问 |
| `clipboardWrite` | 复制 Markdown 到剪贴板 | 仅在用户操作时触发 |

### 权限冗余分析

- `<all_urls>` 与 `activeTab` 存在功能性重叠，但 `<all_urls>` 是上下文菜单在任意页面生效的前提
- 无法在不损失功能的前提下显著缩减权限面

---

## 二、数据流安全

### 数据处理路径

```
网页 HTML (本地 DOM) → Readability 提取 → Turndown 转换 → 本地文件/剪贴板
```

### 关键发现

1. **无外部数据外传**: search 全部代码未发现 `fetch()` 非图片请求或向外部服务器 `XMLHttpRequest.send()` 的行为
2. **图片下载有外部请求**: `preDownloadImages()` 中的 XHR 请求仅针对文章内 `<img>` 标签的 `src` 地址，范围受页面内容限制
3. **模板变量不泄露**: `textReplace()` 替换仅在本地进行，替换结果写入本地文件
4. **Obsidian URI 调用**: `copyMarkdownFromContext()` 中 `copy-markdown-obsidian` 分支使用 `chrome.tabs.update({url: "obsidian://advanced-uri?...")` 跳转本地应用，非网络请求

### 网络请求审计

```bash
# 代码中唯一的网络请求模式:
XMLHttpRequest.open('GET', src)  # 仅在 preDownloadImages() 中，用于下载页面内图片
```

- `src` 来源于网页中的 `<img src="...">`，非硬编码 URL
- 仅在用户启用 `downloadImages` 选项时触发
- 这是功能必要性请求，非恶意外传

---

## 三、注入面分析

### detect: `tabs.executeScript` 使用

| 位置 | 调用方式 | 注入内容 | 风险 |
|------|---------|----------|------|
| `ensureScripts()` | `{file: "/contentScript/contentScript.js"}` | 固定扩展内文件 | **低** — 文件路径不可被外部控制 |
| `downloadMarkdown()` contentLink 模式 | `{code: "downloadMarkdown(...)"}` | 参数含用户可控的 title 和 base64 markdown | **中** — title 经过 `generateValidFileName` 清洗，markdown 经 `base64EncodeUnicode` 编码 |
| `copyMarkdownFromContext()` | `{code: "copyToClipboard(...)"}` | 参数含 `JSON.stringify(markdown)` | **低** — JSON 序列化自动转义特殊字符 |
| `copyTabAsMarkdownLink()` | `{code: "copyToClipboard(...)"}` | 参数含 title 和 baseURI (来自页面) | **中** — `JSON.stringify` 提供转义保护 |

### detect: `innerHTML` 操作

| 位置 | 代码 | 风险 |
|------|------|------|
| `getArticleFromDom()` | `node.innerHTML = node.innerHTML.replaceAll(...)` | **低** — 操作已解析的 DOM 树，非原始字符串拼接 |
| `contentScript.js:getHTMLOfSelection()` | `div.innerHTML = ...` | **低** — 仅用于临时 div 的 DOM 构建 |

### detect: `eval` / `Function` 构造器

- search 全部代码：未发现 `eval()` 或 `new Function()` 调用
- `browser-polyfill.min.js` 中无动态代码执行

---

## 四、通信安全

### 扩展内部通信

| 通信方式 | 发送方 | 接收方 | 消息内容 | 风险 |
|----------|--------|--------|----------|------|
| `runtime.sendMessage` | Popup | Background | `{type: "clip", dom, selection}` | **低** — 扩展内部消息，不暴露给网页 |
| `runtime.sendMessage` | Background | Popup | `{type: "display.md", markdown, article}` | **低** — 同上 |
| `runtime.sendMessage` | Popup | Background | `{type: "download", markdown, title}` | **低** — 同上 |
| `tabs.executeScript` 返回值 | Content Script | Background | `{selection, dom}` | **低** — DOM 字符串可能很大但内容来自页面 |

### 外部通信面

- 无 `externally_connectable` 声明，不接受外部消息
- 无 `runtime.onMessageExternal` 监听器
- 与 Obsidian 的集成通过 `obsidian://advanced-uri` URI scheme 跳转，非网络通信

---

## 五、存储安全

### 存储内容

- **storage.sync**: 仅存储用户配置项 (Markdown 样式、模板、路径等)
- **不存储**: 网页内容、浏览历史、用户凭据、访问令牌

### 存储中的敏感度评估

| 存储字段 | 敏感度 | 说明 |
|---------|--------|------|
| `frontmatter` / `backmatter` | 低 | 用户自定义模板文本 |
| `title` | 低 | 文件名模板 |
| `mdClipsFolder` | 低 | 下载目录路径 |
| `obsidianVault` | 低 | Obsidian Vault 名称 (非路径) |
| 其他样式选项 | 无 | 纯 Markdown 渲染参数 |

---

## 六、隐私合规

### 数据收集评估

- **无遥测**: 未发现向任何服务器发送统计/分析数据
- **无用户标识**: 未生成或存储用户 ID、设备 ID
- **无第三方服务**: 未集成 Google Analytics、Firebase 或任何分析 SDK
- **无 cookie 访问**: 未声明 `cookies` 权限

### 页面数据生命周期

1. 用户触发 → Content Script 提取 DOM
2. DOM 传递给 Background Script → Readability 提取正文
3. 正文转换为 Markdown → 显示在 Popup / 写入文件 / 复制到剪贴板
4. DOM 字符串随 JS 垃圾回收释放

数据不在磁盘或 storage 中持久化。

---

## 七、依赖安全

### 第三方库清单

| 库 | 版本标识 | 用途 | 安全态势 |
|----|---------|------|---------|
| webextension-polyfill | v0.8.0 | 跨浏览器 API 兼容层 | Mozilla 官方维护，活跃项目 |
| Readability.js | (未标注版本) | 网页正文提取 | Mozilla 维护，Firefox Reader View 核心 |
| Turndown.js | (未标注版本) | HTML → Markdown 转换 | 开源项目 (domchristie/turndown)，稳定成熟 |
| turndown-plugin-gfm | (未标注版本) | GFM 扩展 (表格/删除线) | 同 Turndown 生态系统 |
| moment.js | (min.js, 未标注版本) | 日期格式化 | 已进入维护模式，作者推荐替代方案 |
| apache-mime-types | (未标注版本) | MIME type 查询 | 小型工具库，功能有限 |
| CodeMirror | (未标注版本) | Markdown 编辑器 | 成熟稳定的代码编辑器 |

### 依赖风险总结

- 所有依赖均为知名开源项目，无未知或可疑来源
- moment.js 已 deprecated (官方推荐 luxon/dayjs)，但仅用于日期格式化，风险面小
- 依赖以静态文件 (vendored) 方式引入，版本固定，不会自动拉取更新
- 无法通过 `npm audit` 进行自动漏洞检测
- **建议**: 若升级至 MV3 + 打包器架构，可引入依赖版本管理和 SCA 扫描

---

## 八、CSP 分析

### 当前状态

- `manifest.json` 中未声明 `content_security_policy`
- MV2 默认 CSP: `script-src 'self'; object-src 'self'`
- 实际运行中使用了 `tabs.executeScript` 注入代码，这不受页面 CSP 限制

### 风险

| 风险点 | 详情 |
|--------|------|
| 无 `connect-src` 限制 | 图片下载 XHR 可能向任意域名发起请求（但仅限于用户浏览的页面内图片） |
| 无 `img-src` 限制 | 同上 |
| 依赖以独立 script 标签加载 | 无 Subresource Integrity (SRI) 校验 |

---

## 九、合规建议

### 改进建议

1. **升级至 MV3**: 当前 MV2 已无法上架 Chrome Web Store 新版本，需迁移至 Service Worker + `chrome.scripting` API
2. **引入打包器**: 使用 webpack/vite 替代脚本链式加载，获得 tree-shaking、SRI、依赖审计能力
3. **替换 moment.js**: 使用 `dayjs` 或原生 `Intl.DateTimeFormat` 替代已弃用的 moment.js
4. **添加 CSP 声明**: 在 MV3 中通过 `content_security_policy` 字段明确限制资源加载源
5. **最小化 `<all_urls>`**: 评估是否可通过 `activeTab` + `host_permissions` 替代
6. **Content Script 注入安全**: `ensureScripts()` 当前仅检查函数是否存在，可增加文件哈希校验

### 整体评级

**安全等级: B+ (良好)**

MarkDownload 是一款以本地处理为核心的实用工具，无数据外传、无用户追踪、无第三方服务集成。主要风险来自 `<all_urls>` 权限和 `tabs.executeScript` 的动态代码执行——但这些均为实现核心功能所必需，且在合理的安全边界内使用。

与同类别剪藏工具相比，MarkDownload 的安全设计处于较优水平——它不上传网页内容到云端，也不依赖外部 API 进行内容处理。
