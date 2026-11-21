# Clearly Reader

**原始名称**: Clearly Reader - 你的AI阅读助手 | **商店版本**: 4.7.0 | **Manifest**: V3

## 功能概述

Clearly Reader 是一款 AI 驱动的网页阅读增强工具，将杂乱网页转换为清爽的阅读视图，并支持 AI 摘要、翻译、语音朗读等功能。

核心功能：
- 一键转换网页为可读模式（Readability 提取）
- AI 摘要（调用 api.clearlyreader.com）
- 多语言翻译（Google Translate API）
- TTS 语音朗读
- Skim 快速浏览面板（Alt+S）
- 文本高亮和注释
- 多种字体/主题/间距定制
- 快捷键：Alt+R 激活阅读模式

## 技术架构

- **打包器**: rspack 1.7.11（5 个独立 bundle）
- **UI**: React（JSX）+ marked（Markdown 渲染）
- **消息总线**: 自研 MBus
- **Source Map**: content.bundle.js 和 app.bundle.js 有 source map
- **架构**: Service Worker → Content Script → iframe 三层

## 安全注意

- `web_accessible_resources: ["*"]` 暴露所有扩展文件
- API 令牌明文存储在 chrome.storage.local
- Content Script 与 iframe 间 postMessage 通信无 origin 验证

## 权限

`activeTab`, `storage`, `contextMenus`, `commands` + `http/https` hosts

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 4.7.0 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
