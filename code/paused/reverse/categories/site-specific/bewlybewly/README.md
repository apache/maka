# BewlyBewly

**原始名称**: BewlyBewly | **商店版本**: 0.41.2 | **Manifest**: V3

## 功能概述

BewlyBewly 是一款专门针对 Bilibili（哔哩哔哩）网站的主页重设计扩展，用现代化的 Vue 3 SPA 替换 B 站原生首页布局。

核心功能：
- Bilibili 首页完全重设计（glassmorphism 毛玻璃风格）
- 视频推荐卡片重新布局
- 频道页增强
- 深色/浅色主题切换
- `--bew-*` CSS Design Token 设计系统

## 技术架构

- **框架**: Vue 3.4.27 + vue-i18n 9.13.1
- **打包器**: Vite
- **Content Script ISOLATED world**: Vue 3 SPA 完整应用
- **MAIN world inject**: 仅 50 行 — 重写 `history.{pushState,replaceState,forward}` 触发 `CustomEvent('historyChange')`
- **API 代理**: 12 个命名空间 40+ 个 Bilibili API 端点
- **DNR**: 2 条规则伪装 `Origin`/`Referer` 请求头

## 权限

`storage`, `declarativeNetRequest` + `*.bilibili.com`, `*.hdslb.com` hosts

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 0.41.2 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
