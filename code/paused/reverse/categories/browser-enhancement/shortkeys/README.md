# Shortkeys (Custom Keyboard Shortcuts)

> 自定义浏览器快捷键 — 为 80+ 内建浏览器操作绑定任意键盘组合

**Chrome Web Store**: [Shortkeys](https://chromewebstore.google.com/detail/shortkeys-custom-keyboard/logpjaafikfboejmcafdlpmjbpbndkco)
**官方网站**: [shortkeys.app](https://shortkeys.app)

## 功能概述

Shortkeys 允许用户为浏览器操作设置自定义键盘快捷键。支持按网站分别激活不同的快捷键配置，并提供 80+ 内建操作，涵盖标签页管理、窗口控制、页面导航、滚动、视频控制、书签、搜索引擎快捷查询、JavaScript 注入、宏执行、截图等功能。

## 技术架构

- **Manifest 版本**: 3 (MV3)
- **打包工具**: Vite
- **UI**: 自研响应式框架
- **键盘库**: Mousetrap.js (内联)
- **存储**: chrome.storage.sync + local 双存储

## 权限

该扩展声明了较广泛的权限，主要用于实现丰富的标签页/窗口/书签/截图/脚本注入功能。详见各版本的安全审计报告。

关键权限: `tabs`, `storage`, `bookmarks`, `sessions`, `debugger` (截图), `userScripts` (JS 执行), `browsingData` (清除下载记录), `management` (启动应用), `*://*/*` (全局内容脚本)

## 分析版本

| 日期 | 版本 | 模型 | 目录 | 安全评级 |
|------|------|------|------|----------|
| 2026-07-06 | 5.0.1 | dsv4 | [2026-07-06-dsv4/](./2026-07-06-dsv4/) | 中-高 |

## 快速导航

- [v5.0.1 架构文档](./2026-07-06-dsv4/src/docs/ARCHITECTURE.md)
- [v5.0.1 数据流文档](./2026-07-06-dsv4/src/docs/DATA_FLOW.md)
- [v5.0.1 安全审计](./2026-07-06-dsv4/src/docs/SECURITY_AUDIT.md)
- [v5.0.1 类型定义](./2026-07-06-dsv4/src/types/index.ts)
