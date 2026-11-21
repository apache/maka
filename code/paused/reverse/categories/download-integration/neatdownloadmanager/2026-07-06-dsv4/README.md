# NeatDownloadManager Extension v1.9.92 — dsv4 逆向工程

## 版本信息

| 属性 | 值 |
|------|-----|
| 版本号 | 1.9.92 |
| Manifest 版本 | V3 |
| 逆向日期 | 2026-07-06 |
| 逆向模型 | dsv4 |
| 原始作者 | Javad Motallebi |
| 官方网站 | https://www.neatdownloadmanager.com/ |

## 功能概述

NeatDownloadManager Extension 是 Neat Download Manager 桌面下载管理器的 Chrome 浏览器伴侣扩展。它拦截浏览器中的 HTTP/HTTPS 请求，识别可下载资源（文件、视频、音频），并将下载任务转发给本地桌面应用处理。

核心能力:
- 自动拦截浏览器中的下载链接，发送到桌面下载管理器
- 检测页面上的视频/音频元素，提供浮动下载面板
- 支持 M3U8/HLS 流媒体解析
- Facebook、Vimeo 视频站点适配
- 右键菜单快速下载
- 拦截 Chrome 内置下载管理器，确保下载统一由桌面应用处理

## 产物清单

```
2026-07-06-dsv4/
├── dist/                          # 原始代码副本 (可直接加载到 Chrome)
│   ├── manifest.json
│   ├── bg.js                      # Background Service Worker
│   ├── ct.js                      # Content Script
│   ├── img/                       # 图标资源
│   └── _metadata/                 # CWS 元数据
├── src/
│   ├── types/
│   │   └── index.ts               # TypeScript 类型定义 (从 JS 推断)
│   └── docs/
│       ├── ARCHITECTURE.md         # 架构文档
│       ├── DATA_FLOW.md            # 数据流文档 (含 Mermaid 图)
│       └── SECURITY_AUDIT.md       # 安全审计报告
├── package.json
├── tsconfig.json
└── README.md                      # 本文件
```

## 技术架构摘要

- **Background Service Worker**: webRequest 四阶段拦截 (onBeforeRequest → onBeforeSendHeaders → onHeadersReceived → onCompleted)
- **WebSocket 本地通信**: `ws://127.0.0.1:10007/download` (协议 `neatextension.v1`)
- **Content Script**: `all_frames` + `document_start` 注入，浮动面板 UI，媒体元素发现
- **Runtime Port 通信**: Background <-> Content Script 双向消息传递

## 安全关注点

- `cookies` + `webRequest` + `<all_urls>` 三高权限组合
- Cookie 明文通过未加密 WebSocket 传输
- 未使用 Chrome Native Messaging 标准
- 详细信息见 `src/docs/SECURITY_AUDIT.md`

## 发现的 Bug

1. **storage 键名不一致**: 读取使用 `ShowMediaPanel`，写入使用 `ka`，导致面板状态无法持久化
2. **manifest 描述拼写**: "Neat Download Manager" vs "NeatDownloadManager" (品牌名不一致)
