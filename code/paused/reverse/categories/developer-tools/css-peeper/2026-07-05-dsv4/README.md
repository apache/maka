# CSS Peeper dsV4 — Chrome 扩展反向工程

## 项目概述

本项目是 **CSS Peeper** Chrome 扩展 (v1.2.2) 的反向工程分析产物。CSS Peeper 是一款网站 CSS 样式检查工具，允许用户快速查看网页元素的颜色、排版和 CSS 属性。

### 源信息

| 属性 | 值 |
|------|-----|
| 扩展名称 | CSS Peeper |
| 版本 | 1.2.2 |
| 作者 | Sparkglare Sp. z o.o. |
| 构建框架 | Plasmo + Parcel |
| 清单版本 | Manifest V3 |
| 许可证 | 专有 / UNLICENSED |

## 目录结构

```
css-peeper-dsv4/
├── dist/                          # 原始扩展产物 (完整副本)
│   ├── manifest.json              # MV3 扩展清单
│   ├── sidepanel.html             # Side Panel 入口 HTML
│   ├── static/background/
│   │   └── index.js               # Service Worker
│   ├── sidebar-element-locator.*.js  # Content Script: 元素定位
│   ├── csspeeper-inspector-tools.*.js # Content Script: 检查工具
│   ├── inspector.*.js             # Content Script: 主检查器
│   ├── sidepanel.*.js             # Side Panel React 应用
│   ├── sidepanel.*.css            # Tailwind CSS + 自定义 token
│   ├── *.png / *.svg              # 静态资源 (13 个)
│   └── _metadata/                 # Chrome Web Store 元数据
├── src/
│   ├── types/
│   │   └── index.ts               # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md        # 架构文档 (中文)
│       ├── DATA_FLOW.md           # 数据流文档 (中文, 含 Mermaid 图)
│       └── SECURITY_AUDIT.md      # 安全审计报告 (中文)
├── package.json
├── README.md                      # 本文件
└── archive.md                     # 归档说明
```

## 快速开始

### 安装依赖

```bash
npm install
```

### TypeScript 类型检查

```bash
npm run check
```

### 在 Chrome 中加载扩展

1. 打开 `chrome://extensions/`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `dist/` 目录

## 关键发现

### 架构亮点

- **Plasmo 框架**: 使用 Plasmo 扩展框架构建，简化 MV3 开发
- **Side Panel**: MV3 的 Side Panel API，不再使用 popup
- **三个 Content Script**: 分别负责元素定位、样式提取、检查交互
- **Tailwind CSS**: 完整的 Utility-first CSS 方案，含自定义 `peeper-*` 颜色 token
- **Z-Index 隔离**: 扩展元素使用 `z-index: 2147483647` 确保始终在最顶层

### 安全关注

参见 `src/docs/SECURITY_AUDIT.md`，主要关注点：
- `webRequest` 权限可拦截所有 HTTP/HTTPS 请求
- `externally_connectable` 连接 googletagmanager.com 和 csspeeper.com
- 三个 content script 注入到 `<all_urls>`，拥有完整 DOM 访问权限

### 技术栈

| 层面 | 技术 |
|------|------|
| 扩展框架 | Plasmo |
| 打包器 | Parcel |
| UI | React + Tailwind CSS |
| 字体 | Google Fonts (Inter, Roboto, Roboto Mono) |
| 清单版本 | Manifest V3 |

## 限制说明

- **源码不可恢复**: 所有 JS 经 Parcel 高度打包，无 source map，无法还原原始 TypeScript/React 源码
- **静态分析为主**: 分析基于 manifest 声明、代码片段和功能行为推断
- **仅供学习研究**: 本项目为技术分析和学习目的，版权归原作者所有

## 分析文件

| 文档 | 内容 |
|------|------|
| `src/docs/ARCHITECTURE.md` | 完整架构分析、组件关系图、设计 token 表 |
| `src/docs/DATA_FLOW.md` | 数据流图 (Mermaid)、消息类型、状态机 |
| `src/docs/SECURITY_AUDIT.md` | 权限审计、CSP 分析、隐私评估、改善建议 |
| `src/types/index.ts` | TypeScript 类型定义（InspectResult, ColorPalette, TypographyInfo 等） |
