# WebInk — 智能网页转 Markdown

**商店版本**: 0.5.1 | **Manifest**: V3 | **框架**: Plasmo + Parcel

## 功能概述

WebInk 是一款将任意网页一键转换为干净 Markdown 格式的 Chrome 扩展，支持代码块、表格、图片完整保留，并集成了 Monaco Editor 和 Mermaid 图表渲染。

核心功能：
- 网页内容提取（Readability）+ HTML → Markdown（Turndown）
- Monaco Editor 集成（200+ 语言语法高亮）
- Mermaid 图表渲染（20+ 图表类型）
- Side Panel 编辑器
- 多语言翻译

## 技术架构

- **框架**: Plasmo
- **打包器**: Parcel（v0.4.x） → Parcel（v0.5.x）
- **核心库**: Turndown + Readability + Monaco Editor + Mermaid

## 权限

`storage`, `activeTab`, `tabs`, `scripting` 等

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 0.5.1 | 2026-07-04 | DeepSeek V4 Pro | [2026-07-04-dsv4/](2026-07-04-dsv4/) |
