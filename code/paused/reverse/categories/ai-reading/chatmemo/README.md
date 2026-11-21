# Chat Memo

**商店版本**: 1.3.3 | **Manifest**: V3

## 功能概述

Chat Memo 自动保存用户在 ChatGPT、Gemini、Claude、DeepSeek、Kimi、豆包、通义千问、元宝等 AI 平台的聊天记录到本地。

核心功能：
- 自动检测 AI 平台对话并保存
- 多平台 Adapter 模式（chatgpt/claude/gemini/deepseek/kimi/doubao/qianwen/yuanbao）
- 对话历史查看与搜索
- 导出聊天记录

## 技术架构

- **框架**: 纯原生 JavaScript，Adapter 模式
- **存储**: chrome.storage.local
- **UI**: Tailwind CSS + Font Awesome
- **库**: JSZip（导出压缩）

## 权限

`storage`, `tabs`, `activeTab`, `scripting` 等

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 1.3.3 | 2026-07-04 | DeepSeek V4 Pro | [2026-07-04-dsv4/](2026-07-04-dsv4/) |
