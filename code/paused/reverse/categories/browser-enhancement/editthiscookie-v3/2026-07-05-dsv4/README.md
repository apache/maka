# EditThisCookie V3 — 反向工程 (dsv4)

> 源版本: v3.0.5 | 目标: Chrome Manifest V3 | 日期: 2026-07-06

---

## 项目说明

本项目是对 **EditThisCookie (V3)** Chrome 扩展的**安全反向工程分析**。

### 目标

- 理解 Manifest V3 扩展的架构模式
- 分析 Cookie 管理扩展的数据流和安全边界
- 产出可读的 TypeScript 类型定义和中文技术文档

### 非目标

- 不是商业/恶意用途
- 不修改/重新分发原扩展代码
- 不绕过任何安全机制

---

## 目录结构

```
editthiscookie-v3-dsv4/
├── dist/                          # 原始源代码 (完整复制)
│   ├── manifest.json              # MV3 清单
│   ├── js/                        # JS 模块
│   │   ├── background.js          # Service Worker (module)
│   │   ├── popup.js               # Popup 主逻辑
│   │   ├── common-utils.js        # 通用工具
│   │   ├── cookie_helpers.js      # Cookie CRUD
│   │   ├── data.js                # 数据层
│   │   └── utils.js               # 工具函数
│   ├── devtools/                  # DevTools 面板
│   ├── options_pages/             # 选项页面
│   ├── lib/                       # 第三方库
│   ├── css/                       # 样式
│   ├── img/                       # 图标
│   ├── _locales/                  # 多语言 (32 语言)
│   └── popup.html                 # Popup UI
├── src/
│   ├── types/
│   │   └── index.ts               # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md         # 架构文档 (中文)
│       ├── DATA_FLOW.md            # 数据流文档 (中文, 含 Mermaid 图)
│       └── SECURITY_AUDIT.md       # 安全审计报告 (中文)
├── package.json                   # 项目配置
└── README.md                      # 本文件
```

---

## 关键技术特征

| 特征 | 详情 |
|------|------|
| Manifest | V3 |
| Service Worker | Module 类型 (`"type": "module"`) |
| UI 框架 | jQuery 3.3.1 + jQuery UI 1.12.1 |
| 数据持久化 | chrome.storage.local + Object.prototype.watch |
| i18n | 32 语言自定义 i18n 系统 |
| DevTools | DevTools Page + Panel (tablesorter + jeditable) |
| Cookie 操作 | chrome.cookies API (CRUD + onChanged 监听) |
| 高级功能 | Block Filters, ReadOnly Protection, Max Age Enforcement |

---

## 快速开始

```bash
# 安装依赖 (仅类型检查)
npm install

# TypeScript 类型检查
npm run check

# 在 Chrome 中加载 (开发者模式)
# 1. 打开 chrome://extensions/
# 2. 启用"开发者模式"
# 3. 加载已解压的扩展 → 选择 dist/ 目录
```

---

## 文档索引

- [架构文档](src/docs/ARCHITECTURE.md) — 模块结构、依赖关系、设计模式
- [数据流文档](src/docs/DATA_FLOW.md) — 存储同步、通信流程、状态管理 (含 Mermaid 图)
- [安全审计](src/docs/SECURITY_AUDIT.md) — 权限风险、数据安全、代码审计、依赖评估

---

## 许可

原始扩展版权归原作者所有。本项目仅用于安全研究和教育目的。

反向工程文档 (`src/`) 以 UNLICENSED 发布。
