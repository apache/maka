# ChatLine v3.8.0 — 架构文档

**逆向日期**: 2026-07-04 | **AI**: Claude (DeepSeek-V4-Pro)
**作者**: yanchao hou | **原始文件**: 160 JS files, 305 total

---

## 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    ChatLine v3.8.0                         │
│                  AI 对话增强工具箱                          │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐  ┌──────────────────────────────────┐  │
│  │  Background   │  │  Content Script (ISOLATED)        │  │
│  │  Worker       │  │  ┌─────────────────────────────┐ │  │
│  │              │  │  │ Global Layer                  │ │  │
│  │  Google Drive │  │  │ ├─ constants.js (SITE_INFO)   │ │  │
│  │  同步         │  │  │ ├─ URL 变化监听               │ │  │
│  │  OAuth2       │  │  │ ├─ DOM 观察器管理            │ │  │
│  │              │  │  │ ├─ AI 状态监听                │ │  │
│  │  动态加载     │  │  │ ├─ Tooltip/Toast/Modal       │ │  │
│  │  Runner/      │  │  │ └─ Event Delegate            │ │  │
│  │  Formula/     │  │  └─────────────────────────────┘ │  │
│  │  Mermaid      │  │  ┌─────────────────────────────┐ │  │
│  └──────────────┘  │  │ Feature Modules               │ │  │
│                    │  │ ├─ Timeline (时间轴)           │ │  │
│  ┌──────────────┐  │  │ │  └─ 13 adapters + 收藏/笔记 │ │  │
│  │  Main World   │  │  │ ├─ PanelModal (设置面板)     │ │  │
│  │  (page ctx)   │  │  │ │  └─ 10 tabs                │ │  │
│  │              │  │  │ ├─ SmartInputBox (智能输入)   │ │  │
│  │ fiber-bridge  │  │  │ │  └─ 13 adapters + 动画     │ │  │
│  │ (React Fiber) │  │  │ ├─ ConversationExport (导出) │ │  │
│  └──────────────┘  │  │ ├─ Runner (代码运行器)       │ │  │
│                    │  │ │  └─ JS/TS/SQL 沙箱          │ │  │
│                    │  │ ├─ Highlight (文本高亮)       │ │  │
│                    │  │ ├─ Formula (LaTeX 公式)       │ │  │
│                    │  │ ├─ Mermaid (图表渲染)         │ │  │
│                    │  │ ├─ QuickAsk (快速追问)        │ │  │
│                    │  │ └─ ChatWidth (聊天宽度)       │ │  │
│                    │  └─────────────────────────────┘ │  │
│                    └──────────────────────────────────┘  │
│                                                          │
│  存储: chrome.storage.local + chrome.storage.sync         │
│  沙箱: sandbox pages (JS/TS/SQL) + CSP                    │
└──────────────────────────────────────────────────────────┘
```

## 支持的平台

| # | 平台 | 域名 | Timeline | SmartInput | 导出 |
|---|------|------|----------|------------|------|
| 1 | ChatGPT | chatgpt.com | ✅ | ✅ | ✅ |
| 2 | Gemini | gemini.google.com | ✅ | ✅ | ✅ |
| 3 | DeepSeek | chat.deepseek.com | ✅ | ✅ | ✅ |
| 4 | Kimi | kimi.com | ✅ | ✅ | ✅ |
| 5 | 千问 | tongyi.aliyun.com | ✅ | ✅ | ✅ |
| 6 | 千问国际版 | chat.qwen.ai | ✅ | ✅ | ✅ |
| 7 | 豆包 | doubao.com | ✅ | ✅ | ✅ |
| 8 | 元宝 | yuanbao.tencent.com | ✅ | ✅ | ✅ |
| 9 | 文心一言 | yiyan.baidu.com | ✅ | - | ✅ |
| 10 | Grok | grok.com | ✅ | ✅ | ✅ |
| 11 | Perplexity | perplexity.ai | ✅ | ✅ | ✅ |
| 12 | Claude | claude.ai | ✅ | ✅ | ✅ |
| 13 | NotebookLM | notebooklm.google.com | - | ✅ | ✅ |

## 核心功能模块

### 1. Timeline (时间轴) — js/timeline/
- 13 平台适配器（通过 registry 模式注册）
- 长对话性能优化器
- 时间记录器（chat-times）
- 问题列表（question-list）
- 便签功能（notepad）
- 消息收藏（star-input-modal）

### 2. PanelModal (设置面板) — js/panelModal/
- 10 个 Tab 页：收藏、时间轴、提示词、智能输入、公式、导出、动画、运行器、数据同步、关于
- Tab 注册表模式

### 3. Code Runner (代码运行器) — js/runner/
- JS/TS/SQL 沙箱执行（sandbox pages + CSP）
- CodeMirror 编辑器集成
- Highlight.js 代码高亮
- 6 种语言支持

### 4. 动态加载 — js/global/optional-feature-loader.js
- 按需注入 Runner、Formula、QuickAsk、ScrollToBottom、Animation
- 减少初始 Content Script 体积

## 技术栈

| 层级 | 技术 |
|------|------|
| Manifest | MV3 |
| Background | Service Worker (Google Drive OAuth2) |
| 沙箱 | sandbox pages + wasm (sql-wasm) |
| LaTeX | temml |
| 图表 | Mermaid |
| 代码编辑 | CodeMirror 6 |
| 差异对比 | diff-match-patch |
| 代码高亮 | Highlight.js |
| Markdown 渲染 | marked |
