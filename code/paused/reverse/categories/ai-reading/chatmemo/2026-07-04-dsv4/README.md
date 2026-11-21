# Chat Memo v1.3.3 — 逆向工程项目 (dsv4)

**逆向日期**: 2026-07-04
**AI 助手**: Claude (DeepSeek-V4-Pro)
**原始扩展**: Chat Memo — 自动保存 ChatGPT、Gemini、Claude 等 AI 平台聊天记录
**原作者**: 一泽Eze
**版本**: 1.3.3

---

## 🚀 快速开始

### 加载到 Chrome

1. 打开 `chrome://extensions/`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `dist/` 目录

### 编译 TypeScript（可选）

```bash
cd chatmemo-dsv4
npm install
npm run build
```

---

## 📁 项目结构

```
chatmemo-dsv4/
├── dist/                     # ✅ 可加载的扩展（复制自源代码）
│   ├── manifest.json         # MV3 清单
│   ├── js/
│   │   ├── background.js     # Service Worker
│   │   ├── content_common.js # 通用 Content Script
│   │   ├── popup.js          # Popup UI
│   │   ├── core/             # 核心模块
│   │   └── adapters/         # 8 个 AI 平台适配器
│   ├── css/ icons/ html/ lib/
│   └── _locales/
│
├── src/                      # TypeScript 源代码（还原）
│   ├── types/
│   │   ├── index.ts          # 核心类型定义
│   │   ├── messages.ts       # 消息类型与工具
│   │   └── storage.ts        # 存储类型定义
│   ├── background/
│   │   └── index.ts          # Service Worker 逻辑
│   ├── core/
│   │   └── base.ts           # 平台适配器基类
│   ├── adapters/
│   │   └── chatgpt.ts        # ChatGPT 适配器（示例）
│   └── docs/
│       ├── ARCHITECTURE.md   # 架构文档
│       ├── DATA_FLOW.md      # 数据流图
│       └── SECURITY_AUDIT.md # 安全审计
│
├── package.json
├── tsconfig.json
└── README.md
```

---

## 📊 项目统计

| 指标 | 数值 |
|------|------|
| 原始文件数 | 40 |
| JS 总大小 | ~397 KB |
| 最大文件 | popup.js (112 KB) |
| 代码行数 | ~4,000+ |
| 支持平台 | 8 个 AI 平台 |
| 混淆程度 | 无（手写原生 JS，注释详尽） |
| 打包工具 | 无 |
| 框架 | 原生 JavaScript |

---

## 🏗️ 架构

```
Content Scripts ──► Background Service Worker ──► IndexedDB
    (8 adapters)        (CRUD + Export +         (KeepAIMemoryDB)
     + common           Analytics)
     + sidebar
```

### 核心设计
- **适配器模式**: 8 个 AI 平台的差异封装在独立的适配器中
- **观察者模式**: MutationObserver 监听 DOM 变化实现自动保存
- **消息总线**: 三组件通过 `chrome.runtime.sendMessage` 通信

---

## ✅ 逆向完成清单

| 阶段 | 状态 | 输出 |
|------|------|------|
| Phase 1: 提取与扫描 | ✅ | `chatmemo-source-code/` (40 文件) |
| Phase 2: 代码结构分析 | ✅ | 架构识别 + 适配器模式分析 |
| Phase 3: 类型定义 | ✅ | `src/types/` (3 文件) |
| Phase 4: 代码还原 | ✅ | `src/` (background, core, adapters) |
| Phase 5: 数据流分析 | ✅ | `src/docs/DATA_FLOW.md` |
| Phase 6: 安全审计 | ✅ | `src/docs/SECURITY_AUDIT.md` |
| Phase 7: 文档生成 | ✅ | `src/docs/ARCHITECTURE.md` |
| Phase 8: 项目打包 | ✅ | `dist/` (可运行) |

---

## 🔍 关键发现

1. **无构建工具**: 纯手写 JS，代码极其清晰，是逆向的"教科书级"目标
2. **适配器模式**: 8 个平台的适配器结构高度统一，仅需实现 3 个方法
3. **智能增量保存**: StorageManager 实现懒加载感知的增量更新
4. **注入式侧边栏**: 通过 iframe 注入 `html/popup.html`，而非 Chrome Side Panel API
5. **匿名分析**: 通过 Cloudflare Worker 批量上报，支持客户端去重

---

## 📚 文档导航

| 文档 | 说明 |
|------|------|
| [ARCHITECTURE.md](src/docs/ARCHITECTURE.md) | 架构详细文档 |
| [DATA_FLOW.md](src/docs/DATA_FLOW.md) | 数据流与消息流 |
| [SECURITY_AUDIT.md](src/docs/SECURITY_AUDIT.md) | 安全审计报告 |
