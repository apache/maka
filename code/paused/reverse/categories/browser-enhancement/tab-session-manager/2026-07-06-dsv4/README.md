# Tab Session Manager v7.3.0 — dsv4 逆向分析

**逆向日期**: 2026-07-06
**模型/工作流**: dsv4
**版本**: 7.3.0
**Manifest 版本**: 3

## 产出物

```
2026-07-06-dsv4/
├── dist/                          # 可加载到 Chrome 的扩展
├── src/
│   ├── types/index.ts             # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md         # 架构文档
│       ├── DATA_FLOW.md            # 数据流文档
│       └── SECURITY_AUDIT.md       # 安全审计
├── package.json
└── README.md                      # 本文件
```

## 分析摘要

### 代码结构

- **文件数**: 61 个（含 34 语言 i18n）
- **总大小**: ~1.85MB（未压缩 JS bundles）
- **打包方式**: Webpack 5 (单文件 bundle, 生产构建)
- **混淆程度**: 中等（代码压缩 + 变量名缩短，未手工混淆）

### 技术栈识别

| 组件 | 技术 | 证据 |
|------|------|------|
| UI 框架 | React 16.13.1 + ReactDOM | LICENSE.txt 声明, JSX 特征 |
| 跨浏览器 | webextension-polyfill | 每个 bundle 内联完整 polyfill |
| 工具库 | lodash 4.x | LICENSE.txt 声明 |
| 日期 | moment.js 2.x | LICENSE.txt 声明, locale 数据 |
| 存储 | idb (IndexedDB wrapper) | 代码中 DB 操作模式 |
| 云端 | Google Drive API v3 | OAuth 2.0 端点, drive.appfolder 作用域 |

### 数据模型 (推断)

```
Session { id, name, windows, date, tag?, tags?, driveFileId? }
  └── Window { id, tabs, left?, top?, width?, height?, tabGroups?, tstTree? }
       └── Tab { url, title, favIconUrl, index, pinned, active, status, cookieStoreId }
```

### 消息通信

20+ 种消息类型，通过 `browser.runtime.sendMessage()` 在 Service Worker、Popup、Options、Offscreen 之间通信。详见 [DATA_FLOW.md](src/docs/DATA_FLOW.md)。

### 安全评估

整体安全水平：**中上**。无第三方遥测，云端同步由用户主动控制。主要关注点：IndexedDB 明文存储浏览历史、React 16 已知漏洞。详见 [SECURITY_AUDIT.md](src/docs/SECURITY_AUDIT.md)。

## 与原始文件对照

| 原始文件 | 产出对应 | 说明 |
|----------|----------|------|
| `background/background.js` | `dist/background/background.js` | Webpack bundle, 原始复制 |
| `popup/popup.js` | `dist/popup/popup.js` | Webpack bundle, 原始复制 |
| `options/options.js` | `dist/options/options.js` | Webpack bundle, 原始复制 |
| `offscreen/offscreen.js` | `dist/offscreen/offscreen.js` | 独立文件, 原始复制 |
| `replaced/replaced.js` | `dist/replaced/replaced.js` | 独立文件, 原始复制 |
| `manifest.json` | `dist/manifest.json` | 原始复制 |
| 所有 HTML/CSS/icons | `dist/` | 原始复制 |
| `_locales/` | `dist/_locales/` | 34 种语言, 原始复制 |
| — | `src/types/index.ts` | 从 JS 代码推断的类型定义 |
| — | `src/docs/*.md` | 分析产物 |
