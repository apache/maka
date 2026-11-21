# 2026-07-05 Chrome 扩展批量逆向工程 — 汇总报告

**执行日期**: 2026-07-05 ~ 2026-07-06
**逆向模型**: DeepSeek V4 Pro (dsv4)
**总扩展数**: 15
**状态**: ✅ 100% 完成

---

## 总览

| # | 扩展名 | 版本 | MV | Bundler | 代码可读性 | 文件数 | 复杂度 |
|---|--------|------|-----|---------|-----------|--------|--------|
| 1 | **Get CRX** | 1.51 | 3 | None | 纯净原生 JS | 4 | 简单 |
| 2 | **Chrome Font Super Enhancer** | 2.25 | 3 | None | 纯净原生 JS | 18 | 简单 |
| 3 | **JSON Viewer Pro** | 1.0.6 | 3 | React (main.js) | 混合 | 22 | 简单 |
| 4 | **EditThisCookie (V3)** | 3.0.5 | 3 | None (jQuery) | 可读 ES Module | 125 | 简单 |
| 5 | **Material Icons for GitHub** | 1.16.2 | 3 | 打包 (main.js) | 打包 | 1265 | 简单 |
| 6 | **Header Editor Lite** | 5.2.12 | 3 | Webpack | 打包无 sourcemap | 24 | 中等 |
| 7 | **IDM Integration Module** | 6.43.1 | 3 | 手工混淆 | ROT13 混淆 | 37 | 中等 |
| 8 | **ContextSearch web-ext** | 1.48.4.13 | 3 | None | 可读原生 JS | 188 | 中等 |
| 9 | **Clearly Reader** | 4.7.0 | 3 | rspack | 打包+sourcemap | 80 | 中等 |
| 10 | **Lumno 新标签页** | 0.9.14 | 3 | None (IIFE) | 可读模块化 | 140 | 中高 |
| 11 | **BewlyBewly** | 0.41.2 | 3 | Vite + Vue 3 | 混淆无 sourcemap | 54 | 中高 |
| 12 | **Codex** | 1.1.5 | 3 | Vite | 打包 | 12 | 中高 |
| 13 | **CSS Peeper** | 1.2.2 | 3 | Plasmo (Parcel) | 重度打包 | 28 | 高 |
| 14 | **FeHelper** | 2026.7.3 | 3 | None (ES Module) | 可读，代码量巨大 | 263 | 高 |
| 15 | **crxMouse 手势** | 7.0.5 | 3 | Webpack + jQuery | 打包核心 | 403 | 最高 |

---

## 产出规范

每个项目包含统一结构：

```
{name}-dsv4/
├── dist/                  ← 原始源码逐字节副本（可直接加载）
├── src/
│   ├── types/
│   │   └── index.ts       ← 完整 TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md   ← 架构文档（中文）
│       ├── DATA_FLOW.md      ← 数据流文档（含 Mermaid 图）
│       └── SECURITY_AUDIT.md ← 安全审计报告
├── package.json           ← TypeScript + @types/chrome 配置
├── tsconfig.json          ← TypeScript 编译器配置
└── README.md              ← 项目自述文件（中文）
```

---

## 关键发现汇总

### 框架分布
- **无框架/原生**: 8 个 (Get CRX, Chrome Font, EditThisCookie, ContextSearch, IDM, Lumno, FeHelper, Material Icons)
- **React**: 3 个 (JSON Viewer Pro, Header Editor Lite, Clearly Reader)
- **Vue 3**: 1 个 (BewlyBewly)
- **Plasmo**: 1 个 (CSS Peeper)
- **仅打包无框架**: 2 个 (Codex/Vite, crxMouse/Webpack)

### 混淆程度
- **无混淆**: Get CRX, Chrome Font, EditThisCookie, ContextSearch, Lumno, FeHelper
- **打包混淆**: CSS Peeper, BewlyBewly, Codex, Clearly Reader, Header Editor Lite, Material Icons
- **手工混淆**: IDM (ROT13), crxMouse (proconstantinator_key)

### Source Map 可用性
- **有 Source Map**: Clearly Reader (content.bundle.js.map, app.bundle.js.map)
- **无 Source Map**: 其余 14 个

### 安全热点
| 风险等级 | 扩展 | 关键问题 |
|----------|------|---------|
| 🔴 高 | crxMouse | webRequest + clipboard + bookmarks + all_urls，数据采集分享给关联公司 |
| 🔴 高 | Codex | chrome.debugger 完全浏览器控制，localhost 任意端口连接 |
| 🟡 中 | IDM | proxy 权限，externally_connectable 开放 |
| 🟡 中 | CSS Peeper | webRequest 权限，externally_connectable (googletagmanager/csspeeper) |
| 🟡 中 | FeHelper | 沙箱 unsafe-eval，evalCore 全局注入，热修复 new Function() |
| 🟡 中 | EditThisCookie | cookies + all_urls 权限组合 |
| 🟡 中 | Clearly Reader | web_accessible_resources `["*"]`，令牌明文存储 |
| 🟢 低 | 其余 8 个 | 最小权限或无网络通信 |

---

## 技术亮点

### 最有趣的架构
1. **Lumno** — Shadow DOM 覆盖层注入 (z-index: 2147483647)，六维搜索评分算法，零外部依赖
2. **ContextSearch web-ext** — 1887 行消息中枢 `notify()` 分发 100+ 消息类型，7 种节点树类型
3. **BewlyBewly** — MAIN world History API hook → CustomEvent → Vue SPA 跨 world 通信，`--bew-*` CSS Design Token
4. **Header Editor Lite** — 双引擎架构 (DNR + CDP Fetch)，IndexedDB 4 表规则存储
5. **Codex** — CDP Target.getTargets + Emulation.setDeviceMetricsOverride 远程浏览器控制，自研弹簧物理光标动画

---

## 统计

| 指标 | 数值 |
|------|------|
| 总扩展数 | 15 |
| 总原始文件数 (dist/) | 2,662 |
| 总生成 TypeScript 类型文件 | 15 |
| 总生成架构文档 | 15 |
| 总生成数据流文档 | 15 |
| 总生成安全审计报告 | 15 |
| 总 Mermaid 图表 | ~100+ 张 |
| Manifest V3 覆盖率 | 100% (15/15) |

---

## 文件大小分布

```
get-crx-dsv4                   10 files  (最小)
codex-dsv4                     20 files
chrome-font-super-enhancer-dsv4  25 files
json-viewer-pro-dsv4           28 files
header-editor-lite-dsv4        30 files
css-peeper-dsv4                35 files
idm-integration-module-dsv4    44 files
bewlybewly-dsv4                60 files
clearly-reader-dsv4            87 files
editthiscookie-v3-dsv4        131 files
lumno-dsv4                    147 files
contextsearch-web-ext-dsv4    195 files
fehelper-dsv4                 270 files
crxmouse-dsv4                 411 files
material-icons-for-github-dsv4 1273 files (最大，1251 SVG)
```

---

## 与早期分析对比

本次 dsv4 批次较 2026-02 批次的关键改进：

| 改进点 | 旧方法 | dsv4 方法 |
|--------|--------|----------|
| Bundler 识别 | 手动 grep 关键字 | 自动化特征扫描 + Plasmo/file-manifest.json 检测 |
| 类型推断 | 人工枚举 | 系统性从 API 使用模式逆向接口 |
| 安全审计 | 基础权限检查 | 9 维度评估矩阵 |
| 混淆对抗 | 跳过 | 系统性识别模式 (ROT13/proconstantinator/Webpack chunk ID) |
| 文档标准 | 无 | 统一三段式 (ARCHITECTURE/DATA_FLOW/SECURITY_AUDIT)，含 Mermaid 图 |

---

**完成日期**: 2026-07-06
**模型**: DeepSeek V4 Pro (Claude Code via VSCode)
**总耗时**: ~8 小时（15 agent 并行执行）
