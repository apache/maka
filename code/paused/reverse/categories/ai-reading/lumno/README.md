# Lumno 聚焦搜索新标签页

**原始名称**: Lumno 聚焦搜索新标签页 | **商店版本**: 0.9.14 | **开发者**: Kubai087 | **Manifest**: V3

## 功能概述

Lumno 是一款集新标签页替换、覆盖层搜索和标签管理于一体的效率工具，主打"聚焦搜索"体验。

核心功能：
- 新标签页替换（壁纸 + 快捷搜索）
- 覆盖层搜索面板（Ctrl+Shift+K 在任意页面弹出搜索框）
- 标签切换器（Alt+Q，支持模糊搜索和指数衰减排序）
- 自动画中画检测（YouTube / Netflix / Bilibili 等 30+ 视频网站）
- 快捷键配置（Ctrl+Shift+L/C/V 预填充搜索）
- 书签/历史/常用网站管理

## 技术架构

- **框架**: 纯原生 JS，IIFE + `globalThis` 命名空间模块化
- **覆盖层**: Shadow DOM 注入（z-index: 2147483647）
- **搜索算法**: 六维评分（文本匹配/行为/来源/分类/导航/选择历史）
- **依赖**: 零外部依赖（pinyin-pro / Remix Icon / Open Sans 全部内联）

## 安全

无数据外发、无外部 CDN、无凭据存储，安全风险评级为低。

## 权限

`scripting`, `tabs`, `history`, `topSites`, `bookmarks`, `storage`, `search`, `favicon` + `all_urls` host

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 0.9.14 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
