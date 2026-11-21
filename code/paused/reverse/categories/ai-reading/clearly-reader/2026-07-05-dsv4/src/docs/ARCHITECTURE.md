# Clearly Reader 架构文档

## 概述

Clearly Reader 是一款基于 Chrome Manifest V3 的阅读模式扩展，提供 AI 辅助阅读、语音朗读、翻译、高亮标注、PDF/Markdown 导出等功能。版本 4.7.0，使用 rspack 1.7.11 进行 Webpack 打包，部分包提供 source maps。

---

## 项目结构

```
clearly-reader-source-code/
├── manifest.json                  # MV3 扩展声明
├── background.bundle.js           # Service Worker (无 source map)
├── content.bundle.js              # Content Script (~1.7MB, 有 source map)
├── content.bundle.js.map          # Content Script source map
├── content.css                    # Content Script 样式
├── content.css.map                # Content CSS source map
├── contentStyles.css              # 空白占位
├── app.bundle.js                  # 阅读器 UI 应用 (~1.6MB, 有 source map)
├── app.bundle.js.map              # App source map
├── skim.bundle.js                 # Skim 速览面板 (极简)
├── onboarding.bundle.js           # 引导页逻辑
├── onboarding.html                # 引导页 HTML
├── _locales/                      # 多语言支持 (13 种语言)
│   ├── en/messages.json           # 英语 (default_locale)
│   ├── zh_CN/messages.json        # 简体中文
│   ├── zh_TW/messages.json        # 繁体中文
│   ├── ja/messages.json           # 日语
│   ├── ko/messages.json           # 韩语
│   ├── ar/messages.json           # 阿拉伯语
│   ├── de/messages.json           # 德语
│   ├── es/messages.json           # 西班牙语
│   ├── fr/messages.json           # 法语
│   ├── hi/messages.json           # 印地语
│   ├── in/messages.json           # 印尼语
│   └── ru/messages.json           # 俄语
├── _metadata/                     # Chrome Web Store 元数据
├── assets/
│   ├── fonts/                     # 字体文件
│   │   ├── CrimsonText-*.ttf      # Crimson Text (衬线)
│   │   ├── Lora-*.ttf             # Lora (衬线)
│   │   ├── NotoSerif-*.ttf        # Noto Serif (衬线)
│   │   ├── Roboto-*.ttf           # Roboto (无衬线)
│   │   └── remixicon/             # Remix Icon 图标库
│   ├── icons/                     # 扩展图标
│   │   ├── default/               # 默认图标 (未激活)
│   │   ├── active/                # 激活状态图标
│   │   ├── disable/               # 禁用状态图标
│   │   └── readable/              # 可读页面图标
│   ├── img/                       # 背景图片
│   ├── styles/                    # CSS 样式
│   ├── theme/                     # 主题资源
│   └── *.svg / *.png              # UI 图标
├── 7202509e591effb6.ttf           # Web 字体 (hash 命名)
├── 819143a0a2e5844a.ttf           # Web 字体 (hash 命名)
├── ac7d4c9b4701205e.ttf           # Web 字体 (hash 命名)
└── e8a145e6e713ac6d.ttf           # Web 字体 (hash 命名)
```

---

## 系统架构

Clearly Reader 采用三层架构：**Background (Service Worker)** -> **Content Script** -> **App (iframe)**

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Extension 运行时                    │
├─────────────────────────────────────────────────────────────┤
│  Service Worker (background.bundle.js)                      │
│  ├── Message Bus (MBus) - 跨上下文通信中枢                    │
│  ├── Settings Manager - 配置的增删改查                         │
│  ├── Auth Manager - 用户认证与令牌管理                         │
│  ├── API Client - 向 api.clearlyreader.com 发请求             │
│  ├── Translation Service - Google Translate API 封装          │
│  ├── Context Menu Manager - 右键菜单管理                      │
│  ├── Command Handler - 快捷键处理 (Alt+R, Alt+S)              │
│  └── Icon Manager - 工具栏图标状态更新                         │
├─────────────────────────────────────────────────────────────┤
│  Content Script (content.bundle.js + content.css)            │
│  ├── Page Parser - 页面内容提取与可读性判断                      │
│  ├── iframe Manager - 阅读器容器的创建与生命周期管理               │
│  ├── Skim Panel Manager - 速览面板注入与控制                     │
│  ├── Page Highlighter - 文本高亮与标注                          │
│  ├── Message Relay - 与 Background/App 双向通信                 │
│  └── Content Tip UI - 页面浮动工具栏 (打开/设置/关闭)              │
├─────────────────────────────────────────────────────────────┤
│  App iframe (app.bundle.js) - 阅读器主界面                     │
│  ├── React 渲染引擎 (从 source map 可见 JSX)                    │
│  ├── Article Renderer - 文章内容渲染                            │
│  ├── Theme Manager - 主题切换 (light/dark/sepia/night/custom)   │
│  ├── Font Manager - 字体切换                                    │
│  ├── Settings Panel - 阅读设置面板 (字号/行高/宽度/对齐)           │
│  ├── Speech Controller - TTS 语音朗读控制                        │
│  ├── Translation Panel - 翻译面板                                │
│  ├── Export Handler - PDF/Markdown/HTML/Text 导出                │
│  ├── Outline Panel - 文档大纲导航                                │
│  ├── Print Handler - 打印功能                                    │
│  └── AI Assistant Panel - AI 助手对话界面                         │
├─────────────────────────────────────────────────────────────┤
│  Skim iframe (skim.bundle.js) - 速览面板                       │
│  ├── AI Summary Display                                        │
│  ├── Key Points List                                           │
│  └── Quick Actions                                              │
├─────────────────────────────────────────────────────────────┤
│  Onboarding (onboarding.bundle.js + onboarding.html)           │
│  └── 首次安装引导页                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心技术细节

### 1. 打包方式

| 文件 | 打包工具 | 大小 | Source Map |
|------|---------|------|------------|
| `background.bundle.js` | rspack 1.7.11 | ~180 KB | 无 |
| `content.bundle.js` | rspack 1.7.11 | ~1.76 MB | 有 (7 个源文件) |
| `app.bundle.js` | rspack 1.7.11 | ~1.66 MB | 有 (5 个源文件) |
| `skim.bundle.js` | rspack 1.7.11 | ~203 B | 无 |
| `onboarding.bundle.js` | rspack 1.7.11 | ~338 KB | 无 |

### 2. Source Map 揭示的源文件

**content.bundle.js.map** 包含 7 个源文件：

| 源文件 | 用途 |
|--------|------|
| `./lib/config.js` | 共享配置常量 |
| `./lib/print.js` | 打印功能逻辑 |
| `./pages/app/Settings/Clip.jsx` | 剪藏设置组件 (React) |
| `../../../node_modules/marked/lib/marked.esm.js` | Markdown 解析库 (marked) |
| `./pages/app/index.jsx` | App 入口组件 |
| `./pages/content/page-highlighter.js` | 页面高亮功能 |
| `../../../node_modules/browser-or-node/lib/index.js` | 环境检测工具 |

**app.bundle.js.map** 包含 5 个源文件：

| 源文件 | 用途 |
|--------|------|
| `./lib/config.js` | 共享配置常量 |
| `./lib/print.js` | 打印功能逻辑 |
| `./pages/app/Settings/Clip.jsx` | 剪藏设置组件 |
| `../../../node_modules/marked/lib/marked.esm.js` | Markdown 解析库 |
| `./pages/app/index.jsx` | App 入口组件 |

### 3. 消息总线 (MBus) 设计

扩展使用自研的消息总线进行各上下文间的通信：

```
Background (Service Worker)
    ↕ chrome.runtime.sendMessage / onMessage
Content Script (注入页面)
    ↕ postMessage / window.addEventListener('message')
App/Skim iframe (页面内 iframe)
    ↕ chrome.runtime.sendMessage / tabs.sendMessage
Background → Content Script
```

消息命名约定：`clearly:<context>:<action>`
- `clearly:background:*` - 发往 Service Worker
- `clearly:content:*` - 发往 Content Script
- `clearly:app:*` - 发往阅读器 UI
- `clearly:_relay:*` - 内部中继 (跨 iframe 转发)

关键消息类型：
- `clearly:background:get-settings` / `update-settings` - 配置读写
- `clearly:background:get-user` / `save-user` - 用户信息管理
- `clearly:background:translate-text` - 翻译请求
- `clearly:background:call-api` - 通用 API 调用代理
- `clearly:background:refresh-token` - 令牌刷新
- `clearly:content:parse-content` - 页面内容解析
- `clearly:content:open-frame` / `close-frame` - 阅读器开关
- `clearly:content:toggle-frame` - 切换阅读器状态
- `clearly:app:speak-text` - TTS 语音指令
- `clearly:app:update-content` - 更新阅读器内容
- `clearly:app:print` - 打印指令

### 4. 阅读器注入机制

1. Content Script 在 `document_end` 阶段注入所有页面
2. 注入 CSS (`content.css`) 定义 iframe 容器样式
3. 当触发阅读模式时：
   - 添加 `clearly-enabled` 类到 `<body>`，隐藏原始页面内容
   - 创建 `#clearly-root` 容器
   - 在其中注入 `<iframe id="clearly-container">` (z-index: 2147483647)
   - iframe 加载 `app.bundle.js`，渲染阅读器 UI
   - 通过 Message Bus 发送解析后的文章内容到 iframe

### 5. Skim 速览面板

- 独立的 `<iframe id="clearly-skim-root">`
- 以浮动面板形式出现在页面右上角
- 通过 `Alt+S` 快捷键切换
- 加载 `skim.bundle.js` (仅 203 bytes 的引导代码，实际内容可能内联)
- 提供 AI 摘要和关键要点

### 6. 存储设计 (chrome.storage.local)

扩展使用 `chrome.storage.local` 存储以下数据：
- 扩展配置 (阅读器设置、主题、字体等)
- 用户令牌与刷新令牌
- 自动打开域名列表
- 高亮数据
- 使用统计 (skimUsedCount)
- API 模式与自定义端点

### 7. API 集成

| API | 用途 | URL |
|-----|------|-----|
| Clearly Reader API | 用户认证、AI 功能、同步 | `https://api.clearlyreader.com` |
| Google Translate | 文本翻译 | `https://translate.googleapis.com/translate_a/single` |
| Chrome Web Store | 版本更新检查 | Chrome Runtime API |

### 8. 权限分析

| 权限 | 用途 |
|------|------|
| `activeTab` | 获取当前标签页信息 |
| `storage` | 保存用户配置和偏好 |
| `contextMenus` | 右键菜单集成 ("用 Clearly 打开") |
| `commands` | 键盘快捷键 (Alt+R, Alt+S) |
| `http://*/*` / `https://*/*` | 在所有页面注入 content script |

### 9. 依赖库

从 source map 中识别到的第三方依赖：

| 库名 | 用途 | 来源 |
|------|------|------|
| `marked` (marked.esm.js) | Markdown 渲染 | npm |
| `browser-or-node` | 环境检测 | npm |
| React (JSX) | UI 框架 (app 组件) | 推断 |
| Remix Icon | 图标库 | `assets/fonts/remixicon/` |

---

## 构建信息

- **打包工具**: rspack 1.7.11
- **运行时标识**: `bundler=rspack@1.7.11`
- **模块系统**: CommonJS-style 模块注册 (`__webpack_require__` 风格)
- **Source Map**: 仅 content 和 app bundle 提供

---

## 版本信息

- **扩展版本**: 4.7.0
- **Manifest 版本**: 3
- **默认语言**: en (英语)
- **更新 URL**: Chrome Web Store 自动更新
