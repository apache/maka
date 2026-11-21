# i微信读书 (WeRead Helper) v0.9.22 逆向工程分析

## 版本信息

- **原扩展版本**: 0.9.22
- **分析版本**: 2026-07-06-dsv4 (DeepSeek V4 Pro)
- **Manifest 版本**: MV2
- **打包方式**: Webpack 5 + React 17

## 项目概述

本项目是对 **i微信读书** Chrome 浏览器扩展的逆向工程分析。

**原扩展简介**: 微信读书网页版增强工具，支持划线摘抄/划线生成分享书签图片/一键导出读书笔记/划线同步第三方(Flomo/Readwise/Notion)/切换字体/切换皮肤/切换纸张纹理等功能。

## 项目结构

```
2026-07-06-dsv4/
├── README.md                         # 本文件
├── package.json                      # Node.js 项目配置
├── dist/                             # 原始扩展文件 (完整副本)
│   ├── manifest.json                 # MV2 扩展清单
│   ├── background.js                 # 后台脚本 (Persistent)
│   ├── contentScript.js              # Content Script
│   ├── i.js                          # 页面注入脚本 (Function 劫持)
│   ├── m.js                          # 腾讯云/阿里云 CPS 脚本
│   ├── popup.html / popup.js         # 弹出窗口
│   ├── plugin.js                     # Webpack Bundle (~4.3MB)
│   ├── plugin.js.map                 # Source Map (~4.8MB)
│   ├── plugin.*.hot-update.js(x4)    # HMR 热更新残留
│   ├── fonts/                        # 字体文件 (5 个 ttf)
│   ├── images/                       # 图标 + QR 码
│   └── _metadata/                    # CWS 元数据
└── src/
    ├── types/
    │   └── index.ts                  # TypeScript 类型定义
    └── docs/
        ├── ARCHITECTURE.md           # 架构分析文档
        ├── DATA_FLOW.md              # 数据流文档 (8 张 Mermaid 图)
        └── SECURITY_AUDIT.md         # 安全审计报告
```

## 核心技术发现

### 架构模式

- **三层注入架构**: Background Script -> Content Script -> Inject Script
- **跨上下文通信**: CustomEvent (textselect) + chrome.runtime.sendMessage
- **Store 代理模式**: Proxy(window.r) 实现微信读书 Store 的热引用
- **UI 框架**: React 17 (Class Component + Function Component 混用)

### 功能矩阵

| 功能 | 实现方式 |
|------|---------|
| 划线摘抄 | Function.prototype 劫持 → 拦截 showSelectionToolBar |
| 同步 Flomo | 用户配置 API URL → fetch POST |
| 同步 Readwise | Readwise API v2 → 格式化笔记后批量上传 |
| 同步 Notion | 通过 wx.redream.cn 中转代理 → Notion API |
| 导出划线/笔记 | HTML → turndown → Markdown → 复制到剪切板 |
| 书签卡片 | html2canvas → Canvas → PNG 下载 |
| 换肤/主题 | CSS class 切换 + transparenttextures.com 纹理 |
| 字体切换 | @font-face 注入 + 微信读书 canvas 重绘 |
| 代码高亮 | highlight.js |
| 宽度调节 | .app_content maxWidth + 微信读书重绘 |
| CSP 绕过 | webRequest.onHeadersReceived 移除 CSP |

### 外部依赖

| 服务 | 用途 | 认证 |
|------|------|------|
| Sentry (sentry.io) | 前端错误追踪 | 硬编码 DSN |
| 百度统计 (hm.baidu.com) | 用户行为分析 | 硬编码 ID |
| Unsplash (source.unsplash.com) | 书签卡片背景图 | 无 |
| transparenttextures.com | 纸张纹理 | 无 |
| Flomo (flomoapp.com) | 划线同步 | 用户 API URL |
| Readwise (readwise.io) | 笔记同步 | 用户 Token |
| wx.redream.cn | Notion 中转代理 | 用户 Token (经中转) |
| 飞书 (open.feishu.cn) | 文档创建 | 硬编码凭据 |
| md.redream.cn | Markdown 预览 | 无 |

### 第三方库

| 库 | 用途 |
|---|------|
| react + react-dom (17.x) | UI |
| @sentry/react + @sentry/tracing (6.x) | 错误监控 |
| html2canvas (1.x) | 卡片截图 |
| turndown (7.x) | HTML → Markdown |
| store2 (2.x) | localStorage 封装 |
| highlight.js (11.x) | 代码高亮 |
| @babel/runtime (7.x) | Polyfill |
| regenerator-runtime | async/await |

## 安全要点

详细审计报告见 [SECURITY_AUDIT.md](src/docs/SECURITY_AUDIT.md)。关键发现：

1. **飞书 App ID/Secret 硬编码泄露** — 明文写在 background.js 和 plugin.js 中
2. **Notion Token 经过作者服务器中转** — `wx.redream.cn` 可获取用户的 Notion 数据库权限
3. **CSP 完全移除** — webRequest 清空被拦截域名的 Content-Security-Policy
4. **API Token 明文 localStorage 存储** — Flomo/Readwise/Notion 所有凭证明文存储
5. **权限膨胀** — `*://*.tencent.com/*` 远超功能所需

**安全评分: 3.5/10（低安全水平）**

## 使用说明

### 安装依赖

```bash
cd weread-helper-dsv4
npm install
```

### 类型检查

```bash
npm run check
```

### 安装原扩展 (测试用)

1. 打开 Chrome, 进入 `chrome://extensions/`
2. 启用「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `dist/` 目录

## 文件清单

| 文件 | 大小 | 说明 |
|------|------|------|
| `plugin.js` | ~4.3 MB | Webpack Bundle (主应用) |
| `plugin.js.map` | ~4.8 MB | Source Map |
| `fonts/` | ~23 MB | 5 个中文字体 (ttf) |
| `background.js` | ~5 KB | 后台脚本 |
| `contentScript.js` | ~2 KB | Content Script |
| `i.js` | ~4 KB | 页面注入脚本 |
| `m.js` | ~0.9 KB | CPS 推广脚本 |
| `popup.html` | ~1.5 KB | 弹出窗口 |

## 免责声明

本项目仅用于技术研究和学习目的。原始扩展 i微信读书 的版权归其原作者所有。请勿将本项目用于任何商业或非法用途。
