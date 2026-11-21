# X-Track — 推特足迹 / 书签管理器

**商店版本**: 1.3.1 | **Manifest**: V3

## 功能概述

X-Track 是一款 Twitter/X 浏览行为追踪和书签管理工具，记录用户在 Twitter 上的浏览历史和停留时间。

核心功能：
- 推文浏览历史自动追踪（停留时间 > 1 秒触发记录）
- 浏览历史时间线查看
- 书签管理
- IndexedDB 本地持久化存储

## 技术架构

- **框架**: 原生 JS
- **打包器**: Vite/Rollup（旧分析曾误判为 Webpack）
- **存储**: IndexedDB（Dexie.js）
- **注入**: inject.js 拦截 Twitter API 网络响应 → content.js 解析推文数据 → background.js 存储
- **可见性检测**: IntersectionObserver

## 权限

`storage`, `tabs`, `webRequest` 等

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 1.3.1 | 2026-07-04 | DeepSeek V4 Pro | [2026-07-04-dsv4/](2026-07-04-dsv4/) |
