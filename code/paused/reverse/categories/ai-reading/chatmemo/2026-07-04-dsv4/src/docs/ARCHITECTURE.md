# Chat Memo v1.3.3 — 架构文档

**逆向日期**: 2026-07-04
**AI 助手**: Claude (DeepSeek-V4-Pro)
**原始扩展**: Chat Memo v1.3.3 (作者: 一泽Eze)

---

## 架构概览

```
┌──────────────────────────────────────────────────────────┐
│                    Chat Memo v1.3.3                       │
│            AI 聊天记录自动保存 Chrome 扩展                   │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Background   │  │   Content     │  │    Popup      │  │
│  │  Service      │  │   Scripts     │  │    (Sidebar)  │  │
│  │  Worker       │  │               │  │               │  │
│  │               │  │  8 adapters   │  │  Conversation │  │
│  │  IndexedDB    │  │  + common     │  │  Manager UI   │  │
│  │  CRUD API     │  │  + sidebar    │  │               │  │
│  │  Export(JSZip)│  │  + analytics  │  │  Search/Filter │  │
│  │  Analytics    │  │               │  │  Export UI     │  │
│  │  Settings     │  │               │  │               │  │
│  └──────┬───────┘  └──────┬────────┘  └───────┬───────┘  │
│         │                 │                    │          │
│         └────────┬────────┴────────────────────┘          │
│                  │  chrome.runtime.sendMessage             │
│                  ▼                                        │
│         ┌────────────────┐                                │
│         │  IndexedDB      │                               │
│         │  (KeepAIMemory) │                               │
│         └────────────────┘                                │
└──────────────────────────────────────────────────────────┘
```

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| Manifest | MV3 | Chrome Extension Manifest V3 |
| Background | Service Worker | 原生 JS，无框架 |
| Content | 原生 JS | 8 个 AI 平台适配器 |
| UI | Tailwind CSS + FontAwesome | Popup 界面 |
| 存储 | IndexedDB | `KeepAIMemoryDB`，单表 `conversations` |
| 导出 | JSZip | ZIP 打包导出 |
| 构建 | 无 | 手写 JS，无打包器 |

## 代码结构

```
chatmemo-source-code/
├── manifest.json              # 清单文件 (MV3)
├── js/
│   ├── background.js          # Service Worker (~35KB, 1142 行)
│   ├── content_common.js      # 通用 Content Script (~30KB)
│   ├── analytics.js           # 匿名统计 (~708B)
│   ├── popup.js               # Popup UI (~112KB)
│   ├── fallback_popup.js      # 降级 Popup (~461B)
│   ├── i18n.js                # 国际化 (~4.3KB)
│   ├── core/
│   │   ├── base.js            # 适配器基类 (~28KB, 913 行)
│   │   ├── compatibility.js   # 兼容性处理 (~14KB)
│   │   └── storage-manager.js # 智能增量存储 (~22KB)
│   └── adapters/              # 8 个平台适配器
│       ├── chatgpt.js         # ChatGPT (6KB)
│       ├── claude.js          # Claude (7.3KB)
│       ├── deepseek.js        # DeepSeek (5.4KB)
│       ├── gemini.js          # Gemini (8.7KB)
│       ├── yuanbao.js         # 腾讯元宝 (7.1KB)
│       ├── doubao.js          # 豆包 (6.5KB)
│       ├── kimi.js            # Kimi (5.5KB)
│       └── qianwen.js         # 千问 (4.5KB)
├── css/
│   ├── content.css            # Content 样式
│   └── fallback_popup.css     # 降级 Popup 样式
├── html/
│   ├── popup.html             # Popup 页面
│   └── fallback_popup.html    # 降级 Popup
├── lib/
│   ├── jszip.min.js           # JSZip (~98KB)
│   ├── tailwind.min.css       # Tailwind CSS
│   └── fontawesome/           # Font Awesome 图标
├── icons/                     # 扩展图标
│   ├── logo.svg
│   ├── logo_16.png
│   ├── logo_48.png
│   └── logo_128.png
└── _locales/
    ├── en/messages.json       # 英文
    └── zh_CN/messages.json    # 简体中文
```

## 核心设计模式

### 1. 适配器模式 (Adapter Pattern)

所有 AI 平台的差异被封装在 8 个适配器中，每个适配器只需实现 3 个方法：

```typescript
abstract class BasePlatformAdapter {
  abstract isValidConversationUrl(url: string): boolean;
  abstract extractConversationInfo(url: string): { ... };
  abstract extractMessages(): Message[];
  abstract isMessageElement(node: Node): boolean;
}
```

### 2. 观察者模式 (Observer Pattern)

- `MutationObserver` 监听 DOM 变化，自动检测新消息
- `IntersectionObserver` 检测消息可见性
- `CustomEvent` 实现跨组件通信（URL 变化、手动保存等）

### 3. 消息总线模式 (Message Bus)

三组件通过 `chrome.runtime.sendMessage` 通信：
- Content Script → Background: 数据 CRUD
- Background → Content Script: 设置更新、侧边栏开关
- Popup → Background: 查询/导出/删除

## 支持的 AI 平台

| # | 平台 | URL | 适配器大小 |
|---|------|-----|-----------|
| 1 | ChatGPT | chatgpt.com, chat.openai.com | 6 KB |
| 2 | Claude | claude.ai | 7.3 KB |
| 3 | DeepSeek | chat.deepseek.com | 5.4 KB |
| 4 | Gemini | gemini.google.com | 8.7 KB |
| 5 | 腾讯元宝 | yuanbao.tencent.com | 7.1 KB |
| 6 | 豆包 | doubao.com | 6.5 KB |
| 7 | Kimi | kimi.moonshot.cn | 5.5 KB |
| 8 | 千问 | qianwen.com | 4.5 KB |
