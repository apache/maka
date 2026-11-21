# ContextSearch web-ext

**原始名称**: ContextSearch web-ext | **商店版本**: 1.48.4.13 | **Manifest**: V3

## 功能概述

ContextSearch web-ext 是一款强大的右键菜单搜索扩展，支持从选中文字展开多引擎搜索，并提供 QuickMenu 悬浮面板、侧边栏搜索、Omnibox 关键词搜索等多种搜索入口。

核心功能：
- 右键菜单多引擎搜索（支持文件夹分组）
- QuickMenu 悬浮面板（选中文字后弹出多引擎图标）
- 侧边栏搜索面板
- 搜索引擎管理（添加/编辑/导入/导出）
- 外部程序调用（Native Messaging）
- 高亮搜索结果
- Omnibox 关键词搜索（`cs` 前缀）

## 技术架构

- **框架**: 原生 JS，Service Worker 使用 `importScripts()` 加载依赖
- **消息系统**: `notify()` 函数分发 100+ 种消息类型
- **节点树**: 7 种节点类型，位掩码上下文过滤
- **注入策略**: 延迟注入（先装监听器，按需注入主逻辑）

## 权限

`activeTab`, `contextMenus`, `storage`, `tabs`, `unlimitedStorage`, `webNavigation`, `scripting`, `userScripts`, `sidePanel` + `all_urls` host

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 1.48.4.13 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
