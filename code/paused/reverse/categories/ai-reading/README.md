# 🤖 AI 与阅读

利用 AI 技术增强网页阅读体验、对话管理和浏览器智能控制的扩展。

## 包含插件

| 插件 | 版本 | 功能 | 技术栈 | 最新分析 |
|------|------|------|--------|----------|
| [MarkDownload](markdownload/) | 3.4.0 | 网页转 Markdown 下载 | Readability + Turndown + GFM | [2026-07-06-dsv4](markdownload/2026-07-06-dsv4/) |
| [Multi Highlight](multi-highlight/) | 2.11.1 | 高效在线高亮标注，多色关键词 | 原生 JS 零依赖零外传 | [2026-07-06-dsv4](multi-highlight/2026-07-06-dsv4/) |
| [NopeCHA](nopecha/) | 0.6.1 | AI CAPTCHA 自动求解 | Rspack + CDP 鼠标模拟 | [2026-07-06-dsv4](nopecha/2026-07-06-dsv4/) |
| [i微信读书](weread-helper/) | 0.9.22 | 微信读书增强: 划线/导出/同步 Flomo/Notion/Readwise/换肤 | Webpack 5 + React 17 | [2026-07-06-dsv4](weread-helper/2026-07-06-dsv4/) |
| [陪读蛙](read-frog/) | 1.37.2 | 翻译与学习助手，20+ LLM 提供商 | WXT + React 18 + Vite | [2026-07-06-dsv4](read-frog/2026-07-06-dsv4/) |
| [ChatLine](chatline/) | 3.8.0 | 13+ AI 平台增强（时间线/导出/代码执行） | 原生 JS + Adapter 模式 | [2026-07-04-dsv4](chatline/2026-07-04-dsv4/) |
| [Chat Memo](chatmemo/) | 1.3.3 | AI 聊天记录自动保存（8 平台） | 原生 JS + Adapter 模式 | [2026-07-04-dsv4](chatmemo/2026-07-04-dsv4/) |
| [ChatGPT Degrade Checker](degradechecker/) | 2.4.6 | ChatGPT 模型降级检测 | 原生 JS | [2026-07-04-dsv4](degradechecker/2026-07-04-dsv4/) |
| [Clearly Reader](clearly-reader/) | 4.7.0 | 网页转可读视图 + AI 摘要/翻译/语音 | rspack + React + MBus | [2026-07-05-dsv4](clearly-reader/2026-07-05-dsv4/) |
| [Codex](codex/) | 1.1.5 | OpenAI Codex CLI 配套浏览器控制 | Vite + CDP + Native Messaging | [2026-07-05-dsv4](codex/2026-07-05-dsv4/) |
| [Lumno](lumno/) | 0.9.14 | AI 聚焦搜索新标签页 + 覆盖层搜索 | 原生 IIFE 模块 | [2026-07-05-dsv4](lumno/2026-07-05-dsv4/) |
| [YouMind](youmind/) | 0.3.0.33 | AI 网页剪藏/YouTube 笔记/思维导图 | 原生 JS | [2026-07-04-dsv4](youmind/2026-07-04-dsv4/) |

## 安全热点

| 等级 | 插件 | 主要风险 |
|:----:|------|------|
| 🔴 | NopeCHA, i微信读书, Codex | debugger 完全浏览器控制 + CAPTCHA 数据外传、飞书 App Secret 硬编码 + Notion Token 中转、CDP 全端口开放 |
| 🟡 | 陪读蛙, Clearly Reader, ChatLine | API Key 明文存储 + MAIN world 注入 + cookies 权限、AI 平台数据采集 |
| 🟢 | MarkDownload, Multi Highlight, Chat Memo, DegradeChecker, Lumno, YouMind | 零外部请求/零遥测，权限最小化 |
