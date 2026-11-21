# Codex

**原始名称**: Codex | **商店版本**: 1.1.5 | **Manifest**: V3

## 功能概述

Codex 是 OpenAI Codex CLI 的 Chrome 配套扩展，允许 AI 通过 CDP（Chrome DevTools Protocol）和 Native Messaging 远程控制浏览器，实现自动化操作。

核心功能：
- 接收 AI 指令执行浏览器操作（打开/关闭标签、导航、点击、输入等）
- Agent 光标动画（自研弹簧物理引擎 + Bezier/Scoot 路径）
- Favicon 提取与缓存
- 标签租约管理
- WebSocket/HTTP localhost 实时通信

## 技术架构

- **打包器**: Vite（hashed chunk 命名）
- **通信**: Native Messaging Host (`com.openai.codexextension`) + WebSocket/HTTP localhost 任意端口
- **CDP**: `chrome.debugger` API — `Target.getTargets` / `Emulation.setDeviceMetricsOverride`
- **动画**: 60fps Shadow DOM 覆盖层

## ⚠️ 安全警告

- `debugger` 权限允许完全控制浏览器（拦截/修改所有网络请求、注入任意脚本）
- CSP 开放 `localhost:*` 和 `127.0.0.1:*` 全端口连接
- 3 个已声明但未使用的权限: `notifications`, `readingList`, `topSites`

## 权限

`alarms`, `bookmarks`, `debugger`, `downloads`, `downloads.ui`, `favicon`, `history`, `nativeMessaging`, `notifications`, `readingList`, `scripting`, `sessions`, `storage`, `tabGroups`, `tabs`, `topSites` + `all_urls` host

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 1.1.5 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
