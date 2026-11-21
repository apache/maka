# MarkDownload - Markdown Web Clipper

> 将网页文章转换为 Markdown 格式并下载的 Chrome 扩展

## 功能简介

MarkDownload 是一款网页剪藏工具，与传统的 HTML 剪藏不同，它使用 Mozilla Readability 算法提取网页正文，并通过 Turndown 引擎转换为干净的 Markdown 格式。支持自定义模板 (Frontmatter/Backmatter)、图片下载、Obsidian 集成和多种触发方式。

## 技术架构

- **正文提取**: Mozilla Readability.js
- **HTML→Markdown**: Turndown + GFM 插件
- **Markdown 编辑**: CodeMirror
- **跨浏览器兼容**: webextension-polyfill
- **清单版本**: Manifest V2

## 权限概览

`<all_urls>` / `activeTab` / `downloads` / `storage` / `contextMenus` / `clipboardWrite`

## 分析版本

| 版本 | 日期 | 模型 | 安全评级 | 文档 |
|------|------|------|----------|------|
| [3.4.0](2026-07-06-dsv4/) | 2026-07-06 | dsv4 | B+ | [架构](2026-07-06-dsv4/src/docs/ARCHITECTURE.md) / [数据流](2026-07-06-dsv4/src/docs/DATA_FLOW.md) / [安全审计](2026-07-06-dsv4/src/docs/SECURITY_AUDIT.md) |
