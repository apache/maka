# IDM Integration Module — 逆向工程 (dsv4)

> Internet Download Manager Chrome 扩展 v6.43.1 逆向分析项目

---

## 项目概述

本项目是对 **IDM Integration Module** (Internet Download Manager 的 Chrome 浏览器扩展) 的完整逆向工程分析。

- **扩展名称**: IDM Integration Module
- **版本**: 6.43.1
- **厂商**: Tonec FZE
- **Manifest 版本**: MV3 (Manifest V3)
- **Chrome Web Store**: 数千万用户
- **逆向日期**: 2026-07-05

---

## 项目结构

```
idm-integration-module-dsv4/
├── dist/                              # 原始扩展源码 (未修改)
│   ├── manifest.json                  # MV3 清单文件
│   ├── background.js                  # Service Worker (56KB, ROT13 混淆)
│   ├── content.js                     # 内容脚本 (29KB, ROT13 混淆)
│   ├── document.js                    # Web 可访问脚本 — XHR/fetch Hook (5KB)
│   ├── debug.js                       # 调试抑制脚本
│   ├── captured.js / captured.html    # 下载中转页面
│   ├── welcome.js / welcome.html      # 安装欢迎页面
│   ├── images/                        # 图标资源
│   ├── _locales/                      # 16 种语言本地化
│   └── _metadata/                     # CWS 签名验证元数据
├── src/
│   ├── types/
│   │   └── index.ts                   # TypeScript 类型定义
│   │                                 #   DownloadTask, MediaInfo, NativeMessage 等
│   └── docs/
│       ├── ARCHITECTURE.md            # 架构分析文档 (中文)
│       ├── DATA_FLOW.md               # 数据流分析 (含 Mermaid 流程图)
│       └── SECURITY_AUDIT.md          # 安全审计报告 (中文)
├── tsconfig.json                      # TypeScript 配置
├── package.json                       # 项目元数据
└── README.md                          # 本文件
```

---

## 核心文件说明

### background.js (Service Worker)

- **代码量**: ~1400 行 (混淆后)
- **功能**:
  - 自定义二进制协议解析器 (`MSG#` 帧格式)
  - 与 IDM 桌面应用的 Native Messaging / WebSocket 桥接
  - webRequest API 全流量拦截 (请求头/响应头/请求体)
  - 下载分类器 (基于 Content-Type, URL 模式, 站点规则)
  - 代理配置实时监控和同步
  - 标签页/窗口状态管理
  - 28+ 站点特定适配器 (YouTube, Vimeo, Facebook, Instagram 等)
- **混淆**: 使用 ROT13 隐藏 API 方法名

### content.js (内容脚本)

- **代码量**: ~670 行 (混淆后)
- **功能**:
  - DOM MutationObserver / ResizeObserver / IntersectionObserver
  - 媒体元素 (video/audio/object/embed) 自动发现
  - CSS 选择器级联匹配 (YouTube, Vimeo, Facebook, Twitter, Instagram)
  - 页面链接提取和去重
  - 键盘/鼠标事件监听
  - 与 Service Worker 的 Port 通信
- **混淆**: CSS 选择器和正则表达式经 ROT13 编码

### document.js (API Hook)

- **代码量**: ~130 行 (高度混淆)
- **功能**:
  - 拦截 `XMLHttpRequest.prototype.open/send/setRequestHeader`
  - 拦截 `fetch()` 返回的 Response
  - 拦截 `Response.prototype.text/json/arrayBuffer/blob`
  - 拦截 `ReadableStream.prototype.getReader`
  - 注入追踪标记 (`pfm-*` / `pxr-*`)
  - 通过 `window.postMessage` (消息码 1229212980) 转发至 Service Worker
- **混淆**: 所有 API 名称通过 ROT13 编码，变量名压缩为单字符

---

## 关键技术点

### ROT13 混淆

扩展使用 ROT13 字符替换进行代码混淆，主要目的为规避 Chrome Web Store 的自动审查机制。

- **解码函数**: `ua()` (background.js) / `B()` (content.js)
- **混淆范围**: 12+ 处 (background.js) / 30+ 处 (content.js)
- **解码**: `a.replace(/[a-z]/gi, b => String.fromCharCode(b.charCodeAt(0) + ((b.charCodeAt(0)&31)>13?-13:13)))`

### Native Messaging 桥接

```
Primary:   chrome.runtime.connectNative("com.tonec.idm")
Fallback:  WebSocket ws://127.0.0.1:1001 (子协议: plugin.v3.internetdownloadmanager.com)
```

### 自定义应用层协议

消息帧格式: `MSG#<seq>#<type>#<flags>#<subtype>:<params>,<key>=<value>...`

---

## 权限清单

| 权限 | 用途 | 风险等级 |
|------|------|----------|
| `nativeMessaging` | 与 IDM 桌面应用通信 | 高 |
| `proxy` | 读取代理设置 | 高 |
| `cookies` | 读取 Cookie 用于下载认证 | 中高 |
| `webRequest` | 拦截所有 HTTP 请求 | 高 |
| `scripting` + `<all_urls>` | 注入脚本到所有页面 | 高 |
| `downloads` + `downloads.shelf` + `downloads.ui` | 接管浏览器下载 | 中 |
| `declarativeNetRequest` | URL 重定向 | 中 |
| `management` | 竞品检测和禁用 | 中 |
| `externally_connectable` | 外部域消息 | 中 |

完整安全审计见: [src/docs/SECURITY_AUDIT.md](src/docs/SECURITY_AUDIT.md)

---

## 快速开始

```bash
# 安装依赖
npm install

# 类型检查
npm run check
```

---

## 许可

本项目仅用于安全和逆向工程研究目的。扩展源代码版权归 Tonec FZE 所有。

`src/` 目录下的分析文档和类型定义使用 UNLICENSED 许可。
