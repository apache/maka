# NeatDownloadManager Extension v1.9.92 — 架构文档

## 概述

NeatDownloadManager Extension 是一个 Chrome 浏览器扩展 (Manifest V3)，作为 Neat Download Manager 桌面应用的浏览器端代理。它在浏览器侧拦截所有 HTTP/HTTPS 网络请求，识别可下载资源（文件、视频、音频），并将下载任务通过本地 WebSocket 转发给桌面应用处理。

## 分层架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        桌面应用 (Neat Download Manager)                │
│                    ws://127.0.0.1:10007/download                     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ WebSocket (neatextension.v1)
┌───────────────────────────────┴─────────────────────────────────────┐
│                     Background Service Worker (bg.js)                 │
│  ┌──────────┐ ┌──────────────┐ ┌───────────┐ ┌───────────────────┐  │
│  │ webReq   │ │ 下载类型判定  │ │ M3U8/HLS  │ │  桌面通信管理      │  │
│  │ 拦截器   │ │ (MIME/扩展名) │ │ 解析器    │ │  (WebSocket 客户端) │  │
│  └────┬─────┘ └──────┬───────┘ └─────┬─────┘ └─────────┬─────────┘  │
│       │              │               │                  │             │
│  ┌────┴──────────────┴───────────────┴──────────────────┴────────┐  │
│  │                      Port 消息路由中枢                          │  │
│  └──────────────────────────────┬─────────────────────────────────┘  │
│  ┌──────────────────────────────┴─────────────────────────────────┐  │
│  │  Context Menu  │  下载拦截     │  Cookie 提取  │  Storage 管理   │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ chrome.runtime.connect() (Port API)
┌───────────────────────────────┴─────────────────────────────────────┐
│                     Content Script (ct.js) — all_frames               │
│  ┌──────────────┐ ┌──────────────────┐ ┌─────────────────────────┐  │
│  │ 媒体元素检测  │ │ 浮动下载面板 UI  │ │ 站点适配 (FB/Vimeo)    │  │
│  │ VIDEO/AUDIO/ │ │ (DIV + TABLE)   │ │ MutationObserver       │  │
│  │ OBJECT/EMBED │ │ 拖拽/折叠/半透明 │ │ 页面脚本解析            │  │
│  └──────────────┘ └──────────────────┘ └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                │ DOM 注入
┌───────────────────────────────┴─────────────────────────────────────┐
│                          目标网页 (Host Page)                         │
└─────────────────────────────────────────────────────────────────────┘
```

## 模块职责表

| 模块 | 文件 | 代码规模 | 核心职责 |
|------|------|----------|----------|
| **Background Service Worker** | `bg.js` | ~40行 (压缩后，约4000 tokens) | webRequest 拦截、下载判定、本地通信、Cookie 管理 |
| **Content Script** | `ct.js` | ~29行 (压缩后，约3000 tokens) | 页面媒体元素发现、浮动面板 UI、社交平台适配 |
| **manifest** | `manifest.json` | 35行 | MV3 配置、权限声明、资源声明 |

### Background Service Worker 内部模块分解

| 子模块 | 关键函数/对象 | 功能 |
|--------|--------------|------|
| 请求生命周期管理 | `U` (构造函数), `U.T` (onBeforeRequest), `U.U` (onBeforeSendHeaders), `U.V` (onHeadersReceived), `U.N` (onCompleted/onErrorOccurred) | 在四个 webRequest 阶段持续跟踪 HTTP 请求，积累元数据 |
| 下载判定引擎 | 内嵌在 `U.V` (onHeadersReceived) 中 | 基于 Content-Type、Content-Disposition、文件扩展名、资源类型、响应码的组合逻辑 |
| 桌面通信 | `U.I`, `U.L`, `U.G` (WebSocket) | 建立 ws://127.0.0.1:10007 连接，发送下载任务字符串，接收控制指令 |
| Cookie 收集 | `U.J`, `chrome.cookies.getAll` | 对每个候选下载 URL 提取关联 Cookie |
| HLS/M3U8 解析 | `W` (构造函数), `W.i` | 解析 M3U8 播放列表，提取 TS 分片和 EXT-X-STREAM-INF 流 |
| Vimeo API 适配 | 内嵌在 `U.V` 中 | 解析 Vimeo progressive JSON，提取多清晰度 MP4 链接 |
| 内置下载拦截 | `U.X` | 监听 `chrome.downloads.onCreated`，取消 Chrome 内置下载管理器发起的下载 |
| 右键菜单 | `chrome.contextMenus` | "Download by NeatDownloadManager" 上下文菜单项 |

### Content Script 内部模块分解

| 子模块 | 关键函数/对象 | 功能 |
|--------|--------------|------|
| 连接管理 | `N` (构造函数), `N.W` (重连) | `chrome.runtime.connect()` 建立长连接，断线自动重连 |
| 浮动面板 | `L` (构造函数) | 在页面创建可拖动、半透明渐隐的媒体下载面板，最多显示多个候选文件 |
| 媒体元素发现 | `N.fa` | 通过 `elementFromPoint`、tagName 筛选 (VIDEO/AUDIO/OBJECT/EMBED)、面积计算定位页面上的媒体源 |
| Facebook 适配 | `N.ja` (MutationObserver), `N.da`, `N.ka` | 监听 DOM 变化发现 Facebook 视频链接，通过嵌入 API 获取 sd/hd 源 |
| Vimeo 适配 | `N.X` | 扫描页面 `<script>` 标签提取 `progressive` JSON 块 |
| 事件监听 | `N.m` | keydown/keyup/mouseup/resize/DOMContentLoaded/click 全局事件 |

## 技术决策

### 1. 为什么用 WebSocket 而非 Native Messaging？

扩展使用原始 WebSocket (`ws://127.0.0.1:10007/download`) 与桌面应用通信，而非 Chrome 标准的 Native Messaging 协议。这简化了客户端实现（不需要注册 native host manifest），但引入安全隐患（见安全审计）。

### 2. 四阶段 webRequest 拦截

扩展利用 `onBeforeRequest` -> `onBeforeSendHeaders` -> `onHeadersReceived` -> `onCompleted` 四个 webRequest 生命周期钩子，逐步积累 HTTP 请求的完整元数据：

- **onBeforeRequest**: 捕获 URL、方法、POST body
- **onBeforeSendHeaders**: 捕获请求头 (含 Cookie)
- **onHeadersReceived**: 核心判定点 —— 基于响应头 (Content-Type、Content-Disposition、Content-Length、状态码) 和请求属性判定是否下载
- **onCompleted/onErrorOccurred**: 清理内部跟踪状态

### 3. 下载判定策略

判定逻辑使用**白名单+黑名单**双重过滤：

1. **排除规则**（按优先级）:
   - 图片类型 (Content-Type 含 `image/`) — 直接跳过
   - 浏览器可渲染文件 (HTML, CSS, JS, SVG, 图片等 >50 种扩展名)
   - JSON 响应
   - 小于 512KB 的非媒体文件
   - wasm, dict, favicon, pem 等特殊文件

2. **命中规则**:
   - `Content-Disposition: attachment` (强制下载)
   - 二进制 MIME 类型 (`application/x-apple-diskimage`, `binary/octet-stream` 等)
   - 媒体扩展名 (FLV, MP4, AVI, MKV, WEBM 等 30+ 种)
   - `main_frame` 且扩展名为视频格式
   - `other` 类型且为媒体格式

### 4. 内置下载拦截

扩展监听 `chrome.downloads.onCreated` 事件。当检测到 Chrome 自身发起的下载 URL 与已捕获的下载 URL 匹配时，立即取消 Chrome 下载并清除下载记录，确保下载仅通过桌面应用执行。

### 5. Vimeo / YouTube 特殊处理

对于 Vimeo (`player.vimeo.com`)，扩展直接发起 `fetch` 请求获取视频配置 JSON，提取 `request.files.progressive` 中的多清晰度 MP4 URL。这绕过了 Vimeo 的常规页面渲染流程。

### 6. Content Script 的 `all_frames` + `document_start`

扩展在**所有 frame**、**document_start** 阶段注入 content script。这意味着它在 iframe 中也生效，且先于页面其他脚本执行。

## 权限清单

| 权限 | 用途 | 敏感度 |
|------|------|--------|
| `webRequest` | 拦截所有 HTTP/HTTPS/FTP 请求，读取请求/响应头 | **高** |
| `webNavigation` | 监听 `onHistoryStateUpdated` 跟踪 SPA 页面 URL 变化 | 中 |
| `cookies` | 提取每个下载 URL 关联的 Cookie 并转发给桌面应用 | **极高** |
| `contextMenus` | 注册右键菜单项 "Download by NeatDownloadManager" | 低 |
| `storage` | 保存 `ShowMediaPanel` 开关状态 | 低 |
| `downloads` | 取消 Chrome 内置下载管理器发起的下载 | 高 |
| `host_permissions: <all_urls>` | 在**所有网站**上运行 content script 并拦截所有请求 | **极高** |

## 通信协议

### Background <-> 桌面应用 (WebSocket)

基于文本帧的简单协议（协议标识 `neatextension.v1`）：

**扩展发送给桌面应用** (`U.I` 方法):
```
1:GET\r\n
2:https://example.com/file.mp4\r\n
3:(可选的额外数据)\r\n
6:media\r\n
4:页面标题\r\n
Origin: https://example.com\r\n
Referer: https://example.com/page\r\n
5:(Referer/来源URL)\r\n
Cookie: name1=value1; name2=value2\r\n
Content-Type: video/mp4\r\n
Content-Disposition: attachment; filename="file.mp4"\r\n
9:(文件名描述)\r\n
7:(Content-Length)\r\n
8:(Content-Type原始值)\r\n
(如果有 POST body):
__0NeatPostData9__:(POST body)
```

**桌面应用发送给扩展**:
- `waiting` — 告知扩展有下载队列等待
- `nowaiting` — 告知扩展队列空闲
- `ShowPanelChrome=0|1` — 控制媒体面板显隐
- `Version:(版本号)` — 版本信息

### Background <-> Content Script (Port)

基于 Chrome Runtime Port 的数组消息协议：

| 消息码 | 方向 | 含义 |
|--------|------|------|
| `[1, item, pageUrl, title]` | BG -> CT | 推送检测到的下载项到浮动面板 |
| `[2, tabUrl, pageUrl, title]` | CT -> BG | 上报当前标签页 URL 变更 |
| `[3, connectionId]` | BG -> CT | 分配端口连接 ID |
| `[4, keyState]` | CT -> BG | Delete 键按下/释放通知 (切换下载拦截) |
| `[5]` | BG -> CT | 面板显隐开关通知 |
| `[6, request, pageUrl, title, name]` | CT -> BG | 用户在面板点击下载项，发起实际下载请求 |
| `[11, url]` | BG -> CT | SPA 页面 URL 变更通知 |
| `[13, show]` | BG -> CT | ShowMediaPanel 配置变更通知 |
| `[15]` | BG -> CT | 桌面应用连接失败告警 |
