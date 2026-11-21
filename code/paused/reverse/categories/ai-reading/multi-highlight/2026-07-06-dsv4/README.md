# Multi Highlight 逆向工程分析

## 项目概述

本项目是对 **Multi Highlight** (v2.11.1) Chrome 浏览器扩展的逆向工程分析。

**原扩展简介**: Multi Highlight 是一款高效灵活的网页阅读高亮工具，支持多关键词彩色高亮、实时搜索、右键菜单添加/删除关键词、全词匹配和大小写敏感搜索。代码简洁（原生 JavaScript，无框架/无打包器），仅依赖 jQuery 生态。

**逆向目标**: 分析其架构设计、数据流、安全审计，产出文档化的技术分析报告。

---

## 项目结构

```
multi-highlight-dsv4/
├── README.md                         # 本文件
├── package.json                      # Node.js 项目配置
├── dist/                             # 原始扩展文件 (完整副本)
│   ├── manifest.json                 # MV3 扩展清单
│   ├── background.js                 # Service Worker
│   ├── content-action.js             # Content Script
│   ├── getPagesSource.js             # 页面文本提取脚本
│   ├── highlight.css                 # 20 种高亮颜色样式
│   ├── popup.html                    # 弹出窗口 HTML
│   ├── popup.js                      # 弹出窗口逻辑
│   ├── jquery/                       # jQuery 依赖
│   │   ├── jquery.js                 # jQuery v3.x
│   │   ├── jquery.highlight.js       # 高亮插件 (修改版)
│   │   └── jquery.inactivity.min.js  # 空闲检测插件
│   ├── options/                      # 选项页
│   │   ├── options.html
│   │   ├── options.js
│   │   └── options.css
│   ├── img/                          # 图标资源
│   └── _metadata/                    # Chrome Web Store 元数据
└── src/
    ├── types/
    │   └── index.ts                  # TypeScript 类型定义
    └── docs/
        ├── ARCHITECTURE.md           # 架构分析文档
        ├── DATA_FLOW.md              # 数据流文档 (含 Mermaid 图)
        └── SECURITY_AUDIT.md         # 安全审计报告
```

---

## 核心技术发现

### 打包方式

- **打包工具**: 无（原生 JavaScript）
- **代码可读性**: 极高 -- 所有 JS 源文件均为无压缩、无混淆的可读源码
- **模块系统**: 无（全局命名空间 + jQuery 插件扩展）

### 架构模式

- **标准 MV3 三层架构**: Service Worker (background.js) -> Content Script (content-action.js) -> Popup UI (popup.js)
- **通信方式**: Chrome Extension Message API (`chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`)
- **DOM 操作**: jQuery v3.x + 自定义 jQuery Highlight 插件
- **标签页隔离**: 每个标签页独立的关键词状态，通过 `chrome.storage.local` 的 `multi-highlight_{tabId}` key 存储

### 功能矩阵

| 功能 | 实现方式 |
|------|---------|
| 关键词高亮 | jQuery Highlight 插件（DOM 文本节点扫描 + `<span>` 注入） |
| 多颜色轮转 | 20 种 CSS 预设颜色 (highlight.css)，按 `kwGrp % 20` 分配 |
| 实时搜索 | `isInstant` 模式 + jquery.inactivity 300ms 延迟刷新 |
| DOM 自动重高亮 | MutationObserver (childList + subtree + characterData) |
| 右键添/删关键词 | chrome.contextMenus + background.js 事件处理 |
| 全词匹配 | jQuery Highlight 插件的 `wordsOnly` 选项 + `\b` 边界 |
| 大小写敏感 | jQuery Highlight 插件的 `caseSensitive` 选项 |
| 换行切换颜色 | `isNewlineNewColor` -- 同行关键词同色，换行切换 |
| 关键词可用性检查 | chrome.scripting.executeScript 注入 getPagesSource.js 获取页面文本 |
| 标签页记忆 | `isSaveKws` -- 新标签页保留最近关键词列表 |
| 选项持久化 | chrome.storage.local |

### 第三方库

| 库 | 用途 | 文件大小 |
|----|------|---------|
| jQuery v3.x | DOM 操作基础库 | ~87 KB |
| jQuery Highlight (修改版) | 文本高亮核心引擎 | ~8 KB |
| jQuery Inactivity v1.3.2 | Popup 输入空闲检测 | ~1 KB |

### 扩展 ID

`ghinpogongmlphfkmnjfapdaoaaainejn`

---

## 安全要点

详细的审计报告见 [SECURITY_AUDIT.md](src/docs/SECURITY_AUDIT.md)。关键发现：

1. **安全优势明显**: 无任何外部网络请求（零数据外传）、无用户数据收集、代码可审计（无打包混淆）
2. `file://*/*` 匹配使 Content Script 可注入本地文件 -- 建议移除
3. 关键词标签 HTML 构建未转义 -- 潜在扩展内 XSS（影响有限）
4. Content Script 的 jQuery 注入可能污染页面全局变量
5. 多处 `console.log` 调试日志残留

---

## 使用说明

### 安装依赖

```bash
cd multi-highlight-dsv4
npm install
```

### 类型检查

```bash
npm run typecheck
```

### 安装原扩展 (测试用)

1. 打开 Chrome，进入 `chrome://extensions/`
2. 启用「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `dist/` 目录

---

## 文件清单

| 文件 | 大小 | 说明 |
|------|------|------|
| `background.js` | ~9.3 KB | Service Worker (标签页生命周期、右键菜单、消息路由) |
| `content-action.js` | ~6.4 KB | Content Script (高亮引擎、MutationObserver) |
| `popup.js` | ~11.2 KB | Popup UI 逻辑 (关键词管理、设置控制) |
| `popup.html` | ~9.3 KB | Popup UI 模板 (含内联 CSS) |
| `jquery/jquery.js` | ~87 KB | jQuery v3.x 压缩版 |
| `jquery/jquery.highlight.js` | ~7.3 KB | 高亮插件 (修改版) |
| `jquery/jquery.inactivity.min.js` | ~1.3 KB | 空闲检测插件 |
| `highlight.css` | ~1.8 KB | 20 种高亮颜色样式 |
| `getPagesSource.js` | ~1.3 KB | 页面可见文本提取脚本 |
| `options/options.js` | ~2.3 KB | 选项页逻辑 |
| `options/options.html` | ~2.6 KB | 选项页 UI |

---

## 免责声明

本项目仅用于技术研究和学习目的。原始扩展 Multi Highlight 的版权归其原作者 ([vinc96](https://github.com/vinc96/Multi-Highlight)) 所有。请勿将本项目用于任何商业或非法用途。
