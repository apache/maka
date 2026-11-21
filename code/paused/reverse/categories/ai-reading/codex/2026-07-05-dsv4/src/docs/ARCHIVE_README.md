# Codex DSV4 — 归档说明

## 归档来源

- **原始文件**: `codex-source-code/` (Chrome 扩展解包目录)
- **来源**: Chrome Web Store — Codex v1.1.5
- **扩展 ID**: (从 `_metadata/verified_contents.json` 可获取)
- **解包日期**: 2026-07-05
- **逆向工程日期**: 2026-07-06

## 归档内容

原始 `codex-source-code/` 目录的 **完整复制** (包含所有文件、子目录和元数据) 已存放于 `dist/`。

`dist/` 中的文件列表与原始文件 **一一对应**，无修改、无删除、无添加。

### 文件清单 (12 个文件)

```
dist/
├── manifest.json         (1.08 KB) — 扩展清单 (MV3)
├── background.js         (144.7 KB) — Service Worker (Vite 单文件打包)
├── popup.html            (442 B) — 弹出窗口 HTML
├── chunks/
│   └── popup-CTe__03-.js — Vite 代码分割 chunk
├── assets/
│   └── popup-DzS88qVA.css — Tailwind CSS v4 完整构建产物
├── content-scripts/
│   └── codex.js          — 内容脚本 (WXT 构建)
├── images/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   ├── icon128.png
│   └── cursor-chat.png
└── _metadata/
    └── verified_contents.json
```

## 构建工具识别

| 特征 | 证据 |
|------|------|
| Vite | `__vite__` 注入代码、chunk 命名模式 |
| WXT | `wxt:content-script-started`、`wxt:locationchange` 事件 |
| Tailwind CSS v4 | `@layer theme`、CSS 变量系统、`--color-*` 变量 |
| OpenAI Design System | `https://cdn.openai.com/common/fonts/openai-sans/...` |

## 关键字符串索引

| 字符串 | 用途 |
|--------|------|
| `com.openai.codexextension` | Native Messaging Host 名称 |
| `AGENT_CURSOR_STATE` | 光标状态消息类型 |
| `AGENT_CURSOR_ARRIVED` | 光标动画完成消息类型 |
| `TAB_FAVICON_BADGE` | Favicon 徽章消息类型 |
| `codexAgentOverlayRoot` | 覆盖层 DOM ID |
| `codex-favicon-badge` | Favicon 徽章 data 属性 |
| `client-heartbeat-alarm` | 心跳 Alarm 名称 |
| `native-transport-reconnect` | 重连 Alarm 名称 |
| `codexSidePanelOpenWindowIds` | 侧边栏窗口跟踪 key |

## 未解包/未分析部分

以下内容在源码包中不可用 (需要运行时或额外逆向):

- Native Host 二进制文件 (桌面端，不在扩展包内)
- 实际 AI 模型推理逻辑 (在 Native Host 或云端)
- WebSocket 协议细节 (运行时抓包)
- 服务端 API 端点
- Chrome Web Store 签名/加密层

## 相关交付

- `../ARCHITECTURE.md` — 架构分析
- `../DATA_FLOW.md` — 数据流分析
- `../SECURITY_AUDIT.md` — 安全审计
- `../types/index.ts` — TypeScript 类型定义
