# SimpleUndoClose

> 一款轻量级 Chrome 扩展 (MV3)，通过弹出面板让用户查看和恢复最近关闭的标签页。

## 功能概述

- 追踪所有打开标签页，关闭后自动保存快照
- 弹出面板展示已关闭标签页列表 (时间倒序、分页、搜索)
- 一键恢复/后台打开/批量操作
- 19 项可定制设置 (主题/样式/分页/搜索/工具栏)
- 8 种语言国际化
- 3 种主题模式
- 快捷键恢复 (Alt+Z)

## 技术架构

- **技术栈**: Vanilla JS (无框架、无打包器、零 npm 依赖)
- **Manifest**: V3 (Service Worker + `"type": "module"`)
- **后台**: background.js (Service Worker — 标签页追踪/存储/消息路由)
- **前端**: popup.html + popup.js (弹出面板), options.html + options.js (设置页)
- **存储**: `chrome.storage.local` (settings + 标签页快照)
- **通信**: `chrome.runtime.sendMessage` 内部消息协议
- **代码风格**: 早期 ES5+ 混用 (var + async/await)，未混淆，波兰语注释 + 英文命名

## 权限

| 权限 | 用途 |
|------|------|
| `tabs` | 标签页状态追踪和恢复 |
| `storage` | 持久化设置和标签页快照 |
| `favicon` | 声明但未实际使用 (通过 Google Favicon API URL 获取) |
| `<all_urls>` | 声明但多余 (仅用于 `tabs.query` 的 URL 模式参数) |

## 分析版本

| 日期 | 版本 | 模型 | 目录 |
|------|------|------|------|
| 2026-07-06 | 3.0.1 | dsv4 (DeepSeek V4 Pro) | [2026-07-06-dsv4/](./2026-07-06-dsv4/) |
