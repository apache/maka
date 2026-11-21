# OneTab v2.18 — 逆向工程报告 (dsv4)

> **批次**: 2026-07-06-dsv4 | **模型**: DeepSeek V4 Pro | **分类**: browser-enhancement

## 功能概述

OneTab 是 Chrome 浏览器标签页管理器，将打开的标签页收纳为结构化列表，支持按窗口/标签组/文件夹整理，提供搜索、恢复、拖拽重组、导入导出及云端分享功能。号称"节省 95% 内存"。

## 技术概要

| 维度 | 详情 |
|------|------|
| Manifest 版本 | 3 (MV3) |
| Background | Service Worker |
| 打包方式 | 无打包器 — 手工 minified concatenated sources |
| UI 技术 | 原生 DOM + 自定义 virtual-DOM 风格构造器 |
| 语言 | JavaScript (minified, 无可读变量名) |
| 样式 | 原生 CSS + CSS 自定义属性 (暗色模式) |
| 字体 | Open Sans (本地 .woff) |
| 国际化 | 62 种语言 (Chrome i18n API) |
| 第三方依赖 | **无** |
| 外部通信 | `https://www.one-tab.com/*` (分享/同步，需用户授权) |
| 文件总数 | 250 (JS 10 + HTML 7 + CSS 1 + images ~100 + fonts 5 + locales 62 + metadata) |

## 文件清单

```
2026-07-06-dsv4/
├── dist/                          # 可加载到 Chrome 的原始扩展
├── src/
│   ├── types/index.ts             # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md        # 架构文档
│       ├── DATA_FLOW.md           # 数据流文档
│       └── SECURITY_AUDIT.md      # 安全审计报告
├── package.json
└── README.md                      # 本文件
```

## 安全评级

**综合：🟡 中风险**

主要关注点：
- `tabs` + `scripting` + `activeTab` 权限组合
- innerHTML 用于渲染用户提供的标题/URL 内容（有基本清洗但面大）
- 分享功能将标签页数据上传至 one-tab.com（需用户主动触发 + 授权）
- 无第三方依赖、无 eval、无遥测、MV3 合规

详见 [SECURITY_AUDIT.md](src/docs/SECURITY_AUDIT.md)。

## 代码可读性

代码为 **minified** 状态（变量名缩短为 1-2 字符，无注释），但保留了函数边界和模块结构。虽然无 source map，但以下几个特征使逆向分析可行：

- 文件命名清晰（`ext-onetab-concatenated-sources-{模块}.js`）
- RPC 代理机制使用了 Proxy 模式，调用路径可追踪
- `_locales/en/messages.json` 提供了所有功能的英文描述
- 数据模型通过类型判别器（`type`, `groupType`）可推断

## 已知限制

1. **Minified 代码**：变量名无意义，需要大量推导
2. **无 source map**：无法还原原始源码结构
3. **代码体量大**：主文件超过 350KB（onetab.js），分析耗时
4. **共享业务逻辑**：localisation.js 同时用于所有页面，耦合度高

## 快速开始

```bash
# 安装类型检查依赖
npm install

# 类型检查
npm run check

# 在 Chrome 中加载
# 1. 打开 chrome://extensions/
# 2. 启用"开发者模式"
# 3. 点击"加载已解压的扩展程序"
# 4. 选择 dist/ 目录
```
