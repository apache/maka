# iTab v2.1.17 — 架构文档 (dsv4)

**文件数**: 647 (本轮最多) | **技术栈**: Vue + Element UI + Tailwind + JSZip

## 重大变更（与旧版比）

| 变更 | 旧版 | v2.1.17 |
|------|------|---------|
| Content Script | 声明式 | **空数组，动态注入** |
| 注入方式 | content_scripts | `chrome.scripting.executeScript` |
| optional_permissions | 少量 | +offscreen, +desktopCapture |
| PDF | - | pdf.worker (970KB) |
| 桌面捕获 | - | desktopCapture |

## 核心模块

```
assets/pdf.worker-DgsYzxK6.js — PDF Worker (970KB)
content-scripts/content.js      — 动态注入内容脚本 (759KB)
chunks/Content-DhlU6SBh.js      — 主要内容 (651KB)
chunks/install-D-G6L0xr.js      — 安装引导 (472KB)
background.js                   — Service Worker
```

## 架构模式

- **chrome_url_overrides**: `newtab` — 替换新标签页
- **动态注入**: 通过 `scripting` permission + `executeScript` 注入
- **Vue 3**: Composition API + TypeScript
- **Element UI**: 组件库
- **离线资源**: 庞大的本地静态资源包
