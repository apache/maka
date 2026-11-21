# Tab Session Manager

**Save and restore the state of windows and tabs. It also supports automatic saving.**

## 功能概述

Tab Session Manager 是一个 Chrome/Firefox/Edge 扩展，提供完整的浏览器会话管理功能：

- 保存和恢复窗口及标签页状态（单个窗口或所有窗口）
- 自动保存（定时/窗口关闭/浏览器退出）
- 会话分类、标签、搜索、排序
- Google Drive 云端同步（可选，Beta）
- 会话追踪（实时跟踪标签页变化）
- 导出/导入会话（JSON 格式，支持 Session Buddy 迁移）
- Tree Style Tab 支持
- Chrome Tab Groups 支持
- Favicon 压缩（减少存储占用）

## 技术架构

| 项目 | 详情 |
|------|------|
| 版本 | MV3 (Manifest V3) |
| 框架 | React 16.13.1 |
| 打包 | Webpack 5 |
| 跨浏览器 | webextension-polyfill |
| 存储 | IndexedDB (会话) + chrome.storage.local (设置) |
| 云端 | Google Drive API v3 + OAuth 2.0 |
| 语言 | 34 种语言 i18n |

## 权限

- `storage` / `unlimitedStorage` — 本地数据存储
- `tabs` — 读写标签页
- `downloads` — 会话备份下载
- `identity` — Google OAuth (云端同步)
- `alarms` — 定时自动保存
- `offscreen` — MV3 下载处理
- `tabGroups` (可选) — 标签组支持
- `https://www.googleapis.com/*` (可选) — Drive API

## 版本分析记录

| 日期 | 版本 | 模型 | 目录 |
|------|------|------|------|
| 2026-07-06 | 7.3.0 | dsv4 | [2026-07-06-dsv4/](./2026-07-06-dsv4/) |
