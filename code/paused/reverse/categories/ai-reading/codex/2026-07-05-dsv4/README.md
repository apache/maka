# Codex DSV4 — 逆向工程交付

Codex Chrome 扩展 (v1.1.5) 的逆向工程分析与类型定义项目。

## 项目概述

**Codex** 是 OpenAI 开发的 AI 驱动浏览器自动化代理扩展。通过 Native Messaging 与桌面端 AI 应用通信，利用 Chrome DevTools Protocol (CDP) 实现标签页管理、鼠标/键盘模拟、DOM 操作等浏览器自动化能力。

## 目录结构

```
codex-dsv4/
├── dist/                           # 原始源码 (完全复制)
│   ├── manifest.json               # MV3 清单
│   ├── background.js               # Service Worker (~145KB)
│   ├── popup.html                  # 弹出窗口入口
│   ├── chunks/popup-CTe__03-.js    # Popup SPA 逻辑 (Vite chunk)
│   ├── assets/popup-DzS88qVA.css   # Tailwind CSS v4 + OpenAI DS
│   ├── content-scripts/codex.js    # 内容脚本 (WXT 框架)
│   ├── images/                     # 图标 + 光标素材
│   └── _metadata/                  # Chrome Web Store 元数据
├── src/
│   ├── types/index.ts              # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md         # 架构分析文档 (中文)
│       ├── DATA_FLOW.md            # 数据流分析 + Mermaid 图 (中文)
│       └── SECURITY_AUDIT.md       # 安全审计报告 (中文)
├── package.json
├── tsconfig.json
└── README.md                       # 本文件
```

## 核心发现

- **Native Messaging Host**: `com.openai.codexextension` (系统级进程通信)
- **CDP 域**: Target, Emulation (已确认) / Page, Input, Runtime (推断)
- **通信通道**: Native Messaging + WebSocket/HTTP localhost (双通道)
- **权限**: 17 项权限 + `<all_urls>` (极高权限)
- **动画引擎**: 自研弹簧物理引擎 (60fps Bezier + Scoot 路径)
- **UI 框架**: OpenAI Design System + Tailwind CSS v4 + WXT
- **构建系统**: Vite

## 快速开始

```bash
npm install
npm run check    # 类型检查
```

## 安全警告

此项目包含对高权限 Chrome 扩展的逆向分析材料。`dist/` 中的源码为 OpenAI 版权所有，仅用于安全研究和教育目的。

详见 `src/docs/SECURITY_AUDIT.md`。

## 许可

原始源码 (dist/) 版权归 OpenAI 所有。逆向分析文档和类型定义 (src/) 仅限研究用途。
