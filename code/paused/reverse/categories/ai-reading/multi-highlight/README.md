# Multi Highlight

**原始名称**: Multi Highlight | **商店版本**: 2.11.1 | **Manifest**: V3

## 功能概述

Multi Highlight 是一款高效的网页阅读高亮工具，使用户能够同时高亮多个关键词，每个关键词以不同颜色区分，方便在长篇文章中快速定位关键信息。

核心功能：
- 多关键词彩色高亮（20 种颜色自动轮转）
- 实时高亮搜索（输入即搜索）
- 右键菜单快速添加/删除关键词
- 全词匹配 / 大小写敏感搜索
- DOM 内容变化自动重新高亮
- 换行切换颜色 / 按关键词轮转颜色
- 关键词列表标签页间保留
- 页面关键词可用性检查（灰色表示不存在）
- Ctrl+Shift+F 快捷键激活扩展

## 技术架构

- **打包器**: 无（原生 JavaScript，无框架依赖）
- **DOM 操作**: jQuery v3.x
- **高亮引擎**: 修改版 jQuery Highlight 插件（基于 Bartek Szopka 的 highlight v3）
- **存储**: chrome.storage.local（标签页独立状态）
- **架构**: Service Worker -> Content Script -> Popup UI 三层

## 安全注意

- 无外部网络请求（零数据外传）
- 所有数据处理在本地完成
- Content Script 注入范围包括 `file://*/*`
- 关键词标签 HTML 构建未转义（扩展内低危 XSS）
- 无用户数据收集、无追踪

## 权限

`activeTab`, `storage`, `contextMenus`, `scripting` + `http/https` hosts

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 2.11.1 | 2026-07-06 | DeepSeek V4 Pro | [2026-07-06-dsv4/](2026-07-06-dsv4/) |
