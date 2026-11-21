# React Context DevTool

Devtool for React Context and useReducer — Chrome 扩展逆向工程。

## 功能概述

React Context DevTool 是一款 Chrome DevTools 扩展，用于实时调试 React 应用中的：

- **Context API**：追踪所有 Context.Provider 的值变化，可视化新旧值对比（JSON diff）
- **useReducer Hook**：记录 action 序列和 state 历史，支持时间旅行（重新 dispatch action）

扩展提供三种界面入口：

- **DevTools Panel**：完整的调试面板（侧边栏 + JSON 查看器 + Diff 视图 + Action Dispatcher）
- **Browser Action Popup**：轻量弹出窗口（React 检测到后自动切换到交互模式）
- **Options Page**：设置（调试启动时机 / 启用 Context 监控 / 启用 useReducer 监控）

## 技术架构

- **Manifest 版本**：MV3
- **依赖库**：React 18 + CodeMirror + jsondiffpatch + classnames
- **核心技术**：React Fiber 树遍历、Hook 拦截（Monkey-patching）、端口消息总线
- **权限**：`storage`、`scripting`、`<all_urls>` host permission

## 分析版本

| 日期 | 版本 | 工作流 | 产出目录 |
|------|------|--------|----------|
| 2026-07-06 | 4.4 | dsv4 | [2026-07-06-dsv4/](./2026-07-06-dsv4/) |

## 文件结构

```
react-context-devtool/
├── README.md                  # 本文件
└── 2026-07-06-dsv4/
    ├── dist/                  # 可加载的扩展
    ├── src/
    │   ├── types/index.ts     # TypeScript 类型
    │   └── docs/
    │       ├── ARCHITECTURE.md
    │       ├── DATA_FLOW.md
    │       └── SECURITY_AUDIT.md
    └── README.md
```
