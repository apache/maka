# React Context DevTool v4.4 — 逆向工程版本说明

## 基本信息

| 字段 | 值 |
|------|-----|
| 逆向日期 | 2026-07-06 |
| 工作流版本 | dsv4 |
| 模型 | deepseek-v4-pro |
| 原始版本 | 4.4 |
| Manifest 版本 | 3 |
| Chrome 最低版本 | 102 |
| 原始文件数 | 54 |
| 代码可读性 | 打包但可读（Webpack + Babel, 无 sourcemap） |

## 产出物

```
2026-07-06-dsv4/
├── dist/                       # 可加载到 Chrome 的完整扩展（= source-code 复制）
│   ├── manifest.json
│   ├── background.js
│   ├── injectGlobalHook.js
│   ├── mainContent.js
│   ├── assets/
│   │   ├── icons/             # 16 个图标 (icon16/32/48/128 × dev/prod/dis/def)
│   │   └── fonts/             # Montserrat 字体 18 变体
│   ├── devtool/
│   │   ├── devtool.html / devtool.js
│   │   ├── devpanel.html / devpanel.js / devpanel.css
│   │   └── devpanel.js.LICENSE.txt
│   ├── popup/
│   │   ├── disabled.html
│   │   ├── popup.html / popup.js / popup.css
│   │   └── popup.js.LICENSE.txt
│   └── options/
│       ├── options.html / options.js / options.css
│       └── options.js.LICENSE.txt
├── src/
│   ├── types/index.ts          # TypeScript 类型定义（推断）
│   └── docs/
│       ├── ARCHITECTURE.md     # 架构文档
│       ├── DATA_FLOW.md        # 数据流文档（含 Mermaid 图）
│       └── SECURITY_AUDIT.md   # 安全审计（9 维度）
├── package.json
└── README.md                   # 本文件
```

## 关键技术发现

1. **双层 Content Script 架构**：ISOLATED world (`injectGlobalHook.js`) + MAIN world (`mainContent.js`，通过 `chrome.scripting.executeScript` 动态注入）
2. **自建端口消息总线**：基于 `chrome.runtime.connect` 长连接，支持 `to`/`from` 路由、请求-响应模式、30s 超时、自动重连
3. **Hook 注入技术**：Monkey-patch `useReducer` 的 `queue.lastRenderedReducer` 和 `queue.dispatch` 来拦截 action/state
4. **Context 检测**：遍历 Fiber 树，识别 tag === 10 (ContextProvider)，直接读取 `memoizedProps`
5. **技术栈**：React 18 + CodeMirror + jsondiffpatch + classnames + Montserrat 字体
6. **三个独立 React SPA**：DevTools Panel、Popup、Options 各自独立打包

## 安全审计摘要

| 维度 | 评级 |
|------|------|
| 权限面 | 中 |
| 数据流 | 低 |
| CSP | 低 |
| 注入面 | 中 |
| 通信安全 | 中 |
| 存储安全 | 低 |
| 隐私 | 低 |
| 依赖安全 | 中 |
| 合规 | 低 |

详见 `src/docs/SECURITY_AUDIT.md`。

## 加载方式

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `dist/` 目录
