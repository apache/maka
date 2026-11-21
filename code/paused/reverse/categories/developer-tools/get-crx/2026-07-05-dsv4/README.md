# Get CRX — 逆向工程文档 (dsv4)

## 项目简介

本项目是对 **Get CRX** Chrome 扩展（v1.51）的完整逆向工程文档。

**Get CRX** 是一个极简的 MV3 扩展，允许用户从 Chrome Web Store 下载任意扩展的 `.crx` 安装包文件。它在 Web Store 页面添加右键菜单项 "Get CRX of this extension"，点击后通过 Google CRX 更新 API 下载对应扩展的 CRX 文件。

## 项目结构

```
get-crx-dsv4/
├── package.json              # TypeScript 类型检查配置
├── README.md                 # 本文件
├── dist/                     # 原始源码副本（零改动）
│   ├── manifest.json
│   ├── bg.js
│   ├── icon_48.png
│   └── icon_128.png
└── src/
    ├── types/
    │   └── index.ts          # TypeScript 类型定义
    └── docs/
        ├── ARCHITECTURE.md   # 架构文档（中文）
        ├── DATA_FLOW.md      # 数据流文档（含 Mermaid 图，中文）
        └── SECURITY_AUDIT.md # 安全审计报告（中文）
```

## 技术摘要

| 项目 | 细节 |
|------|------|
| 平台 | Chrome Extension Manifest V3 |
| 运行环境 | Service Worker |
| 代码量 | ~60 行 JS（唯一业务文件） |
| 权限 | `contextMenus`, `downloads` |
| 外部 API | `clients2.google.com/service/update2/crx` |

## 快速开始

```bash
# 安装依赖（仅用于类型检查，非运行时依赖）
npm install

# TypeScript 类型检查
npm run check
```

## 文档索引

- [架构文档](./src/docs/ARCHITECTURE.md) — 组件架构、权限分析、全局状态说明
- [数据流文档](./src/docs/DATA_FLOW.md) — 完整数据流序列图（Mermaid）、数据转换细节、时序风险
- [安全审计报告](./src/docs/SECURITY_AUDIT.md) — 6 项安全发现、风险矩阵、总体评估

## 许可证

原始扩展版权归原作者所有。本项目仅为教育目的的逆向工程文档，不包含原扩展的可执行代码分发。
