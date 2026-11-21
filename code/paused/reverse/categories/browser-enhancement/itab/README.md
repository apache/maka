# iTab 新标签页

**商店版本**: 2.1.17 | **Manifest**: V3

## 功能概述

iTab 是一款高度可定制的 Chrome 新标签页替代品，采用组件化卡片桌面设计，支持丰富的内置和第三方卡片。

核心功能：
- 组件化卡片桌面（天气/日历/待办/书签/RSS/笔记...）
- Vue 3 生态（Element UI + Tailwind CSS）
- 卡片市场（第三方扩展卡片）
- 壁纸/主题定制
- 数据导出/备份（JSZip）

## 技术架构

- **框架**: Vue 3 + Element UI + Tailwind CSS
- **打包器**: Vite
- **存储**: chrome.storage
- **文件数**: 647（本轮最多）
- **库**: JSZip

## 权限

`storage`, `tabs`, `bookmarks`, `topSites` 等

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 2.1.17 | 2026-07-04 | DeepSeek V4 Pro | [2026-07-04-dsv4/](2026-07-04-dsv4/) |
