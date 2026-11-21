# NeatDownloadManager Extension

## 简介

NeatDownloadManager Extension 是 [Neat Download Manager](https://www.neatdownloadmanager.com/) 桌面下载管理器的 Chrome 浏览器伴侣扩展，用于将浏览器中的下载任务转发到本地桌面应用处理。

- **分类**: 下载集成 (Download Integration)
- **作者**: Javad Motallebi
- **官网**: https://www.neatdownloadmanager.com/
- **Manifest 版本**: V3

## 功能

- 自动拦截浏览器中的 HTTP/HTTPS/FTP 下载链接
- 视频/音频媒体元素检测与浮动下载面板
- M3U8/HLS 流媒体解析支持
- Facebook / Vimeo 等视频站点适配
- 右键菜单快速下载
- 接管 Chrome 内置下载管理器

## 技术架构

- **Background**: Service Worker (MV3)，webRequest 四阶段拦截
- **Content Script**: 全 frame 注入 (all_frames, document_start)
- **本地通信**: WebSocket `ws://127.0.0.1:10007/download`
- **扩展内通信**: Chrome Runtime Port API

## 权限

| 权限 | 用途 |
|------|------|
| `webRequest` | 拦截网络请求 |
| `webNavigation` | 监听 SPA 页面 URL 变更 |
| `cookies` | 提取下载 URL 关联的 Cookie |
| `contextMenus` | 右键菜单下载入口 |
| `storage` | 保存面板显示状态 |
| `downloads` | 拦截/取消 Chrome 内置下载 |
| `host_permissions: <all_urls>` | 全站 content script 注入 |

## 安全评估概要

综合安全评分 **5.4/10** — 主要风险来自 Cookie 通过未加密 WebSocket 传输，以及 `<all_urls>` + `cookies` + `webRequest` 三高权限组合。详见各版本安全审计文档。

## 逆向分析版本

| 日期 | 版本 | 模型 | 目录 |
|------|------|------|------|
| 2026-07-06 | 1.9.92 | dsv4 | [2026-07-06-dsv4/](./2026-07-06-dsv4/) |
