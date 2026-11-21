# Clearly Reader 逆向工程分析

## 项目概述

本项目是对 **Clearly Reader** (v4.7.0) Chrome 浏览器扩展的逆向工程分析。

**原扩展简介**: Clearly Reader 是一款 AI 驱动的阅读模式 Chrome 扩展，提供沉浸式阅读体验，支持主题切换、字体定制、语音朗读、多语言翻译、AI 摘要、PDF/Markdown 导出、文本高亮标注等功能。

**逆向目标**: 分析其架构设计、数据流、安全审计，产出文档化的技术分析报告。

---

## 项目结构

```
clearly-reader-dsv4/
├── README.md                         # 本文件
├── README.archive.md                 # 归档说明
├── package.json                      # Node.js 项目配置
├── dist/                             # 原始扩展文件 (完整副本)
│   ├── manifest.json                 # MV3 扩展清单
│   ├── background.bundle.js          # Service Worker
│   ├── content.bundle.js             # Content Script
│   ├── content.bundle.js.map         # Content Script source map
│   ├── content.css / content.css.map # Content 样式
│   ├── app.bundle.js / .map          # 阅读器 UI (iframe)
│   ├── skim.bundle.js                # Skim 速览面板
│   ├── onboarding.bundle.js / .html  # 引导页
│   ├── _locales/                     # 多语言资源 (13 种语言)
│   ├── _metadata/                    # Chrome Web Store 元数据
│   └── assets/                       # 字体/图标/图片/样式/主题
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

- **打包工具**: rspack 1.7.11 (类 Webpack 的 Rust 打包器)
- **Bundle 数量**: 5 个独立 bundle (background / content / app / skim / onboarding)
- **Source Map**: 仅 content.bundle.js 和 app.bundle.js 提供，background 无 source map

### 架构模式

- **三层架构**: Service Worker (后台) -> Content Script (注入脚本) -> App iframe (阅读器 UI)
- **通信模式**: 自研 Message Bus (MBus)，基于消息类型的发布-订阅模式
- **消息命名**: `clearly:<context>:<action>` (background/content/app/_relay)
- **UI 框架**: React (JSX)，从 source map 确认

### 功能矩阵

| 功能 | 实现方式 |
|------|---------|
| 阅读模式 | Content Script 隐藏原始页面 + iframe 渲染文章 |
| 主题系统 | 5 种预设 (light/dark/sepia/night/custom) |
| 字体系统 | 5 种字体 (System/Roboto/Georgia/Crimson Text/Lora/Noto Serif) |
| 语音朗读 | Web Speech API (SpeechSynthesis) |
| 翻译 | Google Translate API 封装 |
| AI 功能 | Clearly Reader 自有 API (需要登录) |
| 导出 | PDF (window.print) / Markdown (marked 库) / HTML / Text |
| 速览 (Skim) | 独立 iframe 浮动面板，AI 摘要 + 关键要点 |
| 高亮标注 | DOM Range + `<mark>` 元素注入 |
| 快捷键 | Alt+R (激活阅读器) / Alt+S (切换 Skim) |

### 外部依赖

| 服务 | 用途 | URL |
|------|------|-----|
| Clearly Reader API | 用户认证、AI 功能 | `https://api.clearlyreader.com` |
| Google Translate | 翻译 | `https://translate.googleapis.com/translate_a/single` |
| 卸载统计 | 卸载追踪 | `https://clearlyreader.com/r/uninstall` |

### 第三方库

- **marked** (Markdown 解析与渲染)
- **browser-or-node** (运行环境检测)
- React (JSX 组件 UI)
- Remix Icon (图标)

---

## 安全要点

详细的审计报告见 [SECURITY_AUDIT.md](src/docs/SECURITY_AUDIT.md)。关键发现：

1. `web_accessible_resources: ["*"]` -- 所有扩展文件可被任意网页访问
2. JWT 令牌明文存储在 `chrome.storage.local`，可能被其他扩展读取
3. Content Script 的 `postMessage` 监听未验证 `event.origin`
4. AI 功能将文章全文发送到外部 API
5. Content Script 注入所有 HTTP/HTTPS 页面

---

## 使用说明

### 安装依赖

```bash
cd clearly-reader-dsv4
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
| `content.bundle.js` | ~1.76 MB | Content Script (含 marked 库) |
| `app.bundle.js` | ~1.66 MB | 阅读器 UI 应用 (React) |
| `onboarding.bundle.js` | ~338 KB | 引导页逻辑 |
| `background.bundle.js` | ~180 KB | Service Worker |
| `skim.bundle.js` | ~203 B | Skim 面板引导 |

---

## 免责声明

本项目仅用于技术研究和学习目的。原始扩展 Clearly Reader 的版权归其原作者所有。请勿将本项目用于任何商业或非法用途。
