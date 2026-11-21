# EditThisCookie (V3)

**原始名称**: EditThisCookie (V3) | **商店版本**: 3.0.5 | **Manifest**: V3

## 功能概述

EditThisCookie 是 Chrome 最流行的 Cookie 管理扩展，支持查看、编辑、删除、导入导出当前页面的 Cookie，并集成了 DevTools 面板。

核心功能：
- Cookie 表格查看（搜索/排序/过滤）
- 单条/批量编辑 Cookie（名称/值/域/路径/过期时间/SameSite 等）
- 导入导出（JSON / Netscape / SemicolonPairs / LPW 四种格式）
- Cookie 保护（防止被页面 JS 删除）
- Cookie 标记（收藏常用 Cookie）
- DevTools 集成面板
- 32 种语言界面

## 技术架构

- **框架**: 原生 ES Module + jQuery + jQuery UI
- **Service Worker**: Module 类型（`"type": "module"`）
- **存储**: chrome.storage.local + `Object.prototype.watch()` 双向同步
- **DevTools**: 独立面板，使用 tablesorter + jeditable 插件

## 安全注意

`cookies` + `all_urls` 权限组合可访问所有域名的所有 Cookie，`clipboardWrite` 会将 Cookie 明文写入系统剪贴板。

## 权限

`tabs`, `cookies`, `contextMenus`, `unlimitedStorage`, `storage`, `clipboardWrite` + `all_urls` host

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 3.0.5 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
