# MarkDownload v3.4.0 — 架构文档

## 一、架构概览

MarkDownload 是一个 Chrome/Chromium 扩展（Manifest V2），将网页文章转换为 Markdown 格式并下载。核心流程为：**网页 DOM 采集 -> Readability 内容提取 -> Turndown HTML-to-Markdown 转换 -> 下载/剪贴板输出**。

### 分层架构图

```
┌─────────────────────────────────────────────────────┐
│                    User Interface                    │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │   Popup        │  │   Options    │  │ Context  │ │
│  │ (CodeMirror    │  │   Page       │  │  Menus   │ │
│  │  MD preview)   │  │ (settings)   │  │ (right-   │ │
│  │ popup.html/js  │  │ options.html │  │  click)   │ │
│  └───────┬───────┘  └──────┬───────┘  └────┬─────┘ │
└──────────┼──────────────────┼───────────────┼───────┘
           │                  │               │
           │  runtime.sendMessage / storage.sync
           ▼                  ▼               ▼
┌─────────────────────────────────────────────────────┐
│              Background Page (Orchestrator)          │
│                                                      │
│  background.js (主逻辑)                               │
│  ┌──────────────────────────────────────────────┐   │
│  │  notify()         消息路由中枢                 │   │
│  │  getArticleFromDom()   DOM -> Article        │   │
│  │  convertArticleToMarkdown()  Article -> MD   │   │
│  │  downloadMarkdown()   下载调度                │   │
│  │  copyMarkdownFromContext()  剪贴板            │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  依赖库 (按加载顺序):                                 │
│  ┌──────────────────────┐ ┌──────────────────────┐  │
│  │ browser-polyfill     │ │ apache-mime-types    │  │
│  │ (跨浏览器兼容)        │ │ (MIME 类型查询)      │  │
│  └──────────────────────┘ └──────────────────────┘  │
│  ┌──────────────────────┐ ┌──────────────────────┐  │
│  │ moment.min.js        │ │ Turndown.js          │  │
│  │ (日期格式化)          │ │ (HTML -> MD 核心)    │  │
│  └──────────────────────┘ └──────────────────────┘  │
│  ┌──────────────────────┐ ┌──────────────────────┐  │
│  │ turndown-plugin-gfm  │ │ Readability.js       │  │
│  │ (GFM 表格/删除线等)   │ │ (文章正文提取)       │  │
│  └──────────────────────┘ └──────────────────────┘  │
└──────────────────┬──────────────────────────────────┘
                   │
                   │ tabs.executeScript
                   ▼
┌─────────────────────────────────────────────────────┐
│           Content Script (页面注入层)                 │
│                                                      │
│  contentScript.js                                    │
│  ┌──────────────────────────────────────────────┐   │
│  │ getHTMLOfDocument()   获取页面完整 HTML       │   │
│  │ getHTMLOfSelection()  获取用户选中 HTML      │   │
│  │ getSelectionAndDom()  统一获取入口            │   │
│  │ removeHiddenNodes()   移除隐藏/不可见节点    │   │
│  │ copyToClipboard()     clipboardWrite         │   │
│  │ downloadMarkdown()     data: URI 下载 (降级) │   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  pageContext.js (页面上下文注入)                      │
│  ┌──────────────────────────────────────────────┐   │
│  │ addLatexToMathJax3()  MathJax v3 LaTeX 提取 │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

## 二、模块职责表

| 模块 | 文件 | 职责 | 依赖 |
|------|------|------|------|
| **Background 主逻辑** | `background/background.js` | 消息路由、Article 解析、MD 转换、下载调度、上下文菜单处理、快捷键响应 | Readability, Turndown, moment, mimedb |
| **内容脚本** | `contentScript/contentScript.js` | 页面 DOM 采集、选中文本采集、隐藏节点移除、页面内下载与剪贴板操作 | browser-polyfill |
| **页面上下文** | `contentScript/pageContext.js` | MathJax v3 LaTeX 公式注入标注 | MathJax (页面提供) |
| **Popup UI** | `popup/popup.js` | Markdown 预览编辑 (CodeMirror)、下载按钮、模板/图片选项切换 | CodeMirror, browser-polyfill |
| **选项页** | `options/options.js` | 全部配置项的可视化编辑、导入/导出、上下文菜单联动 | default-options, context-menus |
| **默认选项** | `shared/default-options.js` | 定义默认配置项，提供 `getOptions()` 从 storage.sync 读取 | browser-polyfill |
| **上下文菜单** | `shared/context-menus.js` | 右键菜单的创建、删除、重构 (受 `contextMenus` 选项控制) | browser-polyfill |
| **跨浏览器兼容** | `browser-polyfill.min.js` | Chrome/Firefox/Safari API 统一 (webextension-polyfill v0.8.0) | 无 |
| **HTML 转 Markdown** | `background/turndown.js` | Turndown 核心引擎，HTML DOM -> Markdown 文本 | 无 |
| **GFM 扩展** | `background/turndown-plugin-gfm.js` | GitHub Flavored Markdown (表格、删除线、任务列表) | Turndown |
| **正文提取** | `background/Readability.js` | Mozilla Readability，从完整 HTML 提取正文内容 | 无 |
| **日期格式化** | `background/moment.min.js` | Moment.js，模板中的 `{date:FORMAT}` 替换 | 无 |
| **MIME 类型** | `background/apache-mime-types.js` | MIME type -> 文件扩展名映射 (处理无扩展名图片) | 无 |
| **MD 编辑器** | `popup/lib/codemirror.js` | CodeMirror 编辑器，Popup 内 Markdown 高亮编辑 | 无 |

## 三、关键技术决策

### 1. Manifest V2 而非 V3

- 使用 Background Page（持久页面）而非 Service Worker
- 所有第三方库以独立 `<script>` 标签加载，不依赖模块打包器
- 优点：跨浏览器兼容性好 (Firefox 完整支持)
- 代价：无法上架 Chrome Web Store 新提交 (MV2 已于 2024 年弃用)

### 2. 无打包器架构

- 项目不使用 Webpack/Parcel/Vite 等打包器
- 所有 JS 文件以原始形式加载，全局作用域共享函数与变量
- `browser-polyfill` 挂载 `browser` 全局对象，其余脚本通过 `<script>` 标签链式加载
- 优点：代码透明可调试，无需 source map
- 代价：全局命名空间污染，依赖顺序敏感

### 3. 双下载模式

| 模式 | 原理 | 优势 | 限制 |
|------|------|------|------|
| `downloadsApi` | `browser.downloads.download()` | 完整功能：子文件夹、图片下载、Save As | 仅 Chromium/Firefox 支持 |
| `contentLink` | 页面内注入 `<a download>` 点击 | Safari 兼容 | 无子文件夹、无图片下载 |

自动降级策略：若 `browser.downloads` 不可用，自动切换至 `contentLink`。

### 4. 图片处理流水线

```
远程图片 URL
  → 过滤非图片节点
  → URL 规范化 (validateUri, 相对路径转绝对)
  → 文件名生成 (getImageFilename, 去重)
  → XHR Blob 下载 (preDownloadImages)
  → MIME 类型校正 (.idunno -> 正确扩展名)
  → 输出模式:
     ├── markdown: 替换为本地路径
     ├── base64:   reader.readAsDataURL 内联
     └── obsidian: ![[path]] 格式
```

### 5. 模板变量系统

Frontmatter/Backmatter/Title 支持三种变量替换：

- **Article 字段**: `{title}`, `{pageTitle}`, `{baseURI}`, `{keywords}`, `{byline}` 等
- **日期格式化**: `{date:YYYY-MM-DD}`, `{date:Z}` (通过 moment.js)
- **命名转换**: `{variable:kebab}`, `{variable:snake}`, `{variable:camel}`, `{variable:pascal}`
- **动态 Meta 标签**: `<meta name/property>` 标签自动映射为变量

## 四、权限清单

| 权限 | 用途 | 风险等级 |
|------|------|----------|
| `<all_urls>` | 内容脚本注入任意网页以提取 DOM | **高** - 可读取所有网页内容 |
| `activeTab` | 通过工具栏点击获取当前标签页访问权 | 中 - 仅在用户交互时生效 |
| `downloads` | 下载 Markdown 文件和图片 | 中 - 文件系统写入 |
| `storage` | 保存用户配置 (storage.sync 同步) | 低 - 本地存储 |
| `contextMenus` | 右键菜单集成 | 低 - UI 交互 |
| `clipboardWrite` | 复制 Markdown 到剪贴板 | 低 - 用户操作触发 |

## 五、通信机制

扩展使用三类通信方式：

1. **browser.runtime.sendMessage / onMessage**: Background <-> Popup 通信 (JSON 消息)
2. **browser.tabs.executeScript**: Background -> Content Script 注入与执行，通过返回值传递数据
3. **browser.storage.sync**: 配置项跨组件共享 (Popup、Options、Background 均读写同一存储)

消息流示意图：

```
Content Script ──(return value)──> Background ──(sendMessage)──> Popup
                                       ▲
Popup ────(sendMessage)───────────────┘
```

## 六、扩展点

- **Turndown 自定义规则**: `turndownService.addRule()` 支持自定义 HTML 元素转换
- **模板系统**: 通过 frontmatter/backmatter 注入任意前后文，支持全文变量替换
- **Obsidian URI 集成**: 通过 `obsidian://advanced-uri` 协议直接创建笔记
