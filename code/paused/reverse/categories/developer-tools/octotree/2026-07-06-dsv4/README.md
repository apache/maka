# Octotree v8.3.0 — 逆向工程 (dsv4)

基于 Chrome 扩展 **Octotree - GitHub code tree v8.3.0** (Manifest V3) 的完整源码逆向工程分析。

---

## 目录结构

```
2026-07-06-dsv4/
├── package.json               # TypeScript 项目配置
├── README.md                  # 本文件
├── dist/                      # 原始扩展文件（未修改，可直接加载到 Chrome）
│   ├── manifest.json          # 扩展清单（MV3）
│   ├── background.js          # Service Worker（Webpack 打包）
│   ├── content.js             # 内容脚本（Webpack 打包，~565KB）
│   ├── content.css            # 侧边栏样式表（~1.2MB）
│   ├── browser-polyfill.js    # Mozilla WebExtension Polyfill
│   ├── NOTICE.txt             # 第三方库许可声明
│   ├── fonts/                 # 字体文件（17 个 .woff2）
│   ├── icons/                 # 扩展图标 + VSCode 文件图标主题
│   │   ├── vscode/            # VSCode 风格图标（250+ SVG）
│   │   └── vscodemat/         # VSCode Material 风格图标
│   ├── images/                # 扩展内嵌图片
│   └── _metadata/             # Chrome Web Store 元数据
└── src/
    ├── types/
    │   └── index.ts           # TypeScript 类型定义
    └── docs/
        ├── ARCHITECTURE.md    # 架构文档
        ├── DATA_FLOW.md       # 数据流文档（含 Mermaid 图）
        └── SECURITY_AUDIT.md  # 安全审计报告
```

---

## 功能概述

Octotree 为 GitHub 仓库页面提供 IDE 风格的侧边栏文件浏览器：

- **树形文件视图**: 使用 jsTree 渲染可折叠的目录树
- **快速文件导航**: 点击文件节点直接预览代码内容
- **语法高亮**: 对代码文件进行语法着色显示
- **文件搜索**: 在仓库中按文件名搜索
- **VSCode 图标**: 支持 250+ 种文件类型的专用图标
- **多主题**: 深色/浅色/跟随系统三种主题
- **多字体**: 内置 11 种等宽代码字体可选
- **PR 文件树**: 支持在 Pull Request 页面显示变更文件树
- **GitHub Enterprise**: 通过右键菜单授权支持私有部署
- **pjax 兼容**: 兼容 GitHub 的单页导航机制

---

## 技术栈

| 技术 | 版本/说明 |
|------|----------|
| Chrome Extension | Manifest V3 |
| 打包工具 | Webpack 5 |
| UI 框架 | jQuery + jQuery UI |
| 树形组件 | jsTree |
| 快捷键 | keymaster |
| 图标映射 | file-icons-js |
| 兼容层 | webextension-polyfill (Mozilla) |
| 扩展库 | webext-patterns / webext-permission-toggle / webext-dynamic-content-scripts (fregante) |

---

## 快速开始

```bash
# 安装 TypeScript 类型依赖（仅用于类型检查）
npm install

# 类型检查（无需 build，dist 已包含完整原始文件）
npm run check
```

---

## 文档

- [架构文档](src/docs/ARCHITECTURE.md) — 扩展分层架构、模块职责、技术栈识别、权限清单、入口点分析
- [数据流文档](src/docs/DATA_FLOW.md) — 页面加载渲染、文件预览、API 代理、权限切换、pjax 兼容等核心流程
- [安全审计报告](src/docs/SECURITY_AUDIT.md) — 9 维度安全评估（权限面/数据外传/CSP/注入面/通信/存储/隐私/依赖/合规）

---

## 许可

本项目仅用于逆向工程学习与研究目的。原始扩展版权归 Team Octotree 所有。

`dist/` 目录中的文件为原始扩展的未修改副本。
