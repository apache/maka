# ARCHITECTURE.md — yuque-helper v1.6.0

## 概述

yuque-helper (语雀助手) 是一个针对语雀（Yuque）知识库平台的 Chrome 扩展，提供内容增强编辑、图片搜索、文本格式化、思维导图、日记生成等辅助功能。

**版本**: 1.6.0 | **Manifest**: V2 | **构建工具**: Webpack | **UI 框架**: Vue.js 2.6.12 + Element UI

---

## 架构分层图

```
┌──────────────────────────────────────────────────────┐
│                     Chrome Extension                  │
│                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │ popup/       │  │ options/     │  │ editor/     │  │
│  │ (Vue+Element)│  │ (Vue+Element)│  │ (Vue+Codemir│  │
│  │ 1025KB JS   │  │ 775KB JS     │  │ ror) 1.5MB  │  │
│  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘  │
│         │                │                  │         │
│         └────────────────┼──────────────────┘         │
│                          │                            │
│              ┌───────────▼────────────┐               │
│              │    background.js       │               │
│              │   (Vue.js 2.6.12)      │               │
│              │    81KB — Webpack      │               │
│              │   Entry module: 288    │               │
│              └───────────┬────────────┘               │
│                          │                            │
│         chrome.runtime.sendMessage / onMessage        │
│                          │                            │
│  ┌───────────────────────▼──────────────────────────┐ │
│  │          content_scripts/test.js                  │ │
│  │   (jQuery + Turndown + Readability + polyfills)   │ │
│  │         176KB — Webpack, Entry: 318               │ │
│  │         run_at: document_start                    │ │
│  │         matches: <all_urls>                       │ │
│  └───────────────────────────────────────────────────┘ │
│                          │                             │
│              ┌───────────▼────────────┐                │
│              │     Yuque Pages        │                │
│              │   (www.yuque.com)      │                │
│              └────────────────────────┘                │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │   markmap/   (独立页面，非 Webpack)              │  │
│  │   - d3.js 6.3.0                                  │  │
│  │   - markmap-lib 0.11.1 + markmap-view 0.2.1      │  │
│  │   - Prism.js + KaTeX                             │  │
│  └─────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

---

## 模块职责表

| 模块 | 文件 | 大小 | 构建方式 | 职责 |
|------|------|------|----------|------|
| Background | `background.js` | 81KB | Webpack (entry 288) + Vue 2.6.12 | 生命周期管理、消息路由、存储管理、通知 |
| Content Script | `content_scripts/test.js` | 176KB | Webpack (entry 318) + jQuery | DOM 注入、文本格式化、目录提取、图片插入、日记生成、页面转存 |
| Popup | `popup/popup.js` | ~1MB | Webpack (entry 342) + Vue 2 + Element UI | 快捷工具栏、图片搜索(Pexels)、剪贴板、表情选择、日期时间选择 |
| Options | `options/options.js` | 775KB | Webpack (entry 344) + Vue 2 + Element UI | 用户设置：字数统计、文本格式化、彩色标题头、知识库路径、字体 |
| Editor | `editor/editor.js` | 1.5MB | Webpack (entry 343) + Vue 2 + Element UI + CodeMirror | 全功能 Markdown 编辑器：全屏、分屏、代码块、导入/导出 |
| Markmap | `markmap/markmap.js` | 70KB | 独立脚本 | 思维导图独立页面，渲染 Markmap |
| HTML 页面 | 4 个 `.html` | <1KB each | 静态 | 各页面的 HTML 容器 |

---

## 技术决策

| 决策 | 方案 | 原因分析 |
|------|------|----------|
| 打包工具 | Webpack 4 | 使用 `n(n.s=N)` 引导模式，Vue 2.6.12 内联在 bundle 中 |
| UI 框架 | Vue 2.6.12 | popup/options/editor/background 均在 Webpack 模块 0 中内联 Vue 源码 |
| UI 组件库 | Element UI | 从 `fonts/_/node_modules/element-ui/` 路径和 `el-*` 组件前缀确认 |
| 内容脚本 | jQuery + Turndown + Readability | 非 Vue，直接操作 Yuque 页面 DOM；用 Turndown 转 HTML→Markdown；Readability 提取正文 |
| Markdown 编辑 | CodeMirror | editor.js 中的 `CodeMirror-wrap` 和 `cm-force-border` CSS 类 |
| 思维导图 | markmap-lib + d3.js | 独立 markmap 页面，非 Webpack 打包 |
| 代码高亮 | Prism.js | 在 editor 和 markmap 中引用 |
| 数学公式 | KaTeX | markmap 中渲染数学公式 |
| 图标 | 自定义 SVG + PNG | 5 种图标：danger/info/success/tip/warn.svg |
| API 图片 | Pexels API | https://api.pexels.com/v1/ 提供免费图片搜索 |
| 表情资源 | 语雀 CDN | 16 张表情 PNG 托管在 cdn.nlark.com |

---

## 第三方依赖清单

| 库 | 版本 | 来源 | 用途 |
|----|------|------|------|
| Vue.js | 2.6.12 | 内联于 Webpack bundle | UI 框架 |
| Element UI | unknown | 内联 + 字体文件 | UI 组件库 |
| Vue Router | unknown | 内联 (`$route`/`$router`) | 路由 |
| jQuery | unknown | 内联于 test.js | content script DOM 操作 |
| Turndown | unknown | 内联于 test.js | HTML 转 Markdown |
| Mozilla Readability | unknown | 内联于 test.js | 网页正文提取 |
| CodeMirror | unknown | 内联于 editor.js | 代码/文本编辑器 |
| marked | unknown | 内联于 editor.js | Markdown 解析 |
| Prism.js | unknown | markmap/ | 代码语法高亮 |
| d3.js | 6.3.0 | markmap/ | SVG 可视化 |
| markmap-lib | 0.11.1 | markmap/ | 思维导图核心 |
| markmap-view | 0.2.1 | markmap/ | 思维导图渲染 |
| KaTeX | unknown | markmap/ | 数学公式渲染 |
| WebFont Loader | unknown | markmap/ | 字体加载 |
| core-js | unknown | 内联于 test.js | ES6+ polyfills |

---

## 权限清单

| 权限 | 用途 | 风险 |
|------|------|------|
| `<all_urls>` | content script 注入所有页面 | 高 — 可读取任意网页内容 |
| `*://*/*` | 资源访问 | 高 — 支持 HTTP/HTTPS 所有主机 |
| `storage` | 用户设置持久化 | 低 — 标准 Chrome 存储 API |
| `notifications` | 复制成功/失败等桌面通知 | 低 — 仅 UI 通知 |

---

## 文件清单 (36 files)

```
_source-code/
├── manifest.json                         # 扩展清单
├── background.js                         # 后台脚本 (81KB)
├── _metadata/                            # Chrome Web Store 元数据
│   └── verified_contents.json
├── content_scripts/
│   └── test.js                           # 内容脚本 (176KB)
├── popup/
│   ├── popup.html                        # 弹出窗口
│   ├── popup.css                         # 弹出窗口样式
│   └── popup.js                          # 弹出窗口逻辑 (~1MB)
├── options/
│   ├── options.html                      # 设置页
│   ├── options.css                       # 设置页样式
│   └── options.js                        # 设置页逻辑 (775KB)
├── editor/
│   ├── editor.html                       # 编辑器页
│   ├── editor.css                        # 编辑器样式
│   └── editor.js                         # 编辑器逻辑 (1.5MB)
├── markmap/
│   ├── markmap.html                      # 思维导图页
│   ├── markmap.js                        # 思维导图逻辑 (70KB)
│   ├── d3@6.3.0.js                       # D3.js
│   ├── markmap-lib@0.11.1.js             # markmap 核心
│   ├── markmap-view@0.2.1.js             # markmap 视图
│   ├── markmap-autoloader.js             # 自动加载
│   ├── katex.min.js / katex.min.css      # KaTeX 数学
│   ├── prism-core.min.js                 # Prism 核心
│   ├── prism-autoloader.min.js           # Prism 自动加载
│   ├── prism.css                         # Prism 样式
│   └── webfontloader.js                  # 字体加载
├── icons/
│   ├── icon_36.png / icon_48.png / icon_128.png
│   ├── empty.png
│   ├── danger.svg / info.svg / success.svg / tip.svg / warn.svg
└── fonts/
    └── _/node_modules/element-ui/lib/theme-chalk/fonts/
        ├── element-icons.ttf
        └── element-icons.woff
```
