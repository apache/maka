# ADB v0.9.8 — 逆向工程报告

> **逆向日期**：2026-07-06  
> **模型**：dsv4  
> **Manifest 版本**：2  
> **原始仓库**：[GoogleChrome/ADBPlugin](https://github.com/GoogleChrome/ADBPlugin)

## 概述

ADB（Android Debug Bridge）是一个 Chrome 扩展，用于通过 Chrome 浏览器对 Android 设备进行远程调试。该扩展最初依赖 NPAPI 插件（`application/x-adbplugin`）与 Android 设备通信，Chrome 45+ 移除 NPAPI 后，该功能被直接集成到 Chrome DevTools 的 `chrome://inspect` 页面中，此扩展因而废弃。

## 技术栈

| 项目 | 详情 |
|------|------|
| **清单版本** | Manifest V2 |
| **打包工具** | 无（纯原生 JS） |
| **框架** | 无 |
| **NPAPI 插件** | `application/x-adbplugin`（已废弃） |
| **API 使用** | `chrome.tabs.create`, `chrome.extension.getBackgroundPage` |
| **权限声明** | 无（零权限清单） |

## 版本子目录结构

```
2026-07-06-dsv4/
├── dist/                    # 可直接加载到 Chrome 的扩展副本
│   ├── manifest.json
│   ├── background.html
│   ├── background.js
│   ├── popup.html
│   ├── popup.js
│   └── *.png               # 图标资源
├── src/
│   ├── types/
│   │   └── index.ts        # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md  # 架构文档
│       ├── DATA_FLOW.md     # 数据流文档
│       └── SECURITY_AUDIT.md # 安全审计报告
├── package.json
└── README.md               # 本文件
```

## 核心逻辑摘要

1. **Popup 页面**（`popup.html` + `popup.js`）：展示三个操作入口 — "View Inspection Targets"、"Help & Documentation"、"File a ticket"
2. **平台检测**：通过 `navigator.userAgent` 匹配 Windows/Mac/Linux，添加对应 CSS class 以适配不同操作系统字体
3. **后台页面**（`background.html` + `background.js`）：暴露 `devices()` / `help()` / `ticket()` 三个函数，通过 `chrome.tabs.create()` 打开对应 URL
4. **跨上下文通信**：Popup 通过 `chrome.extension.getBackgroundPage()` 直接调用后台页面函数

## 安全评估

该扩展声明零权限，不使用 `eval`/`innerHTML`/`XMLHttpRequest`/`fetch`，无数据外传路径。唯一外部通信为通过 `chrome.tabs.create` 打开 `chrome://inspect` 和两个 Google/GitHub URL。详见 `src/docs/SECURITY_AUDIT.md`。
