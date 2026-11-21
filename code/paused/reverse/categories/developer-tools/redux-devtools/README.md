# Redux DevTools

Redux DevTools 是调试 Web 应用中 Redux 状态变更的 Chrome 扩展。它提供了时间旅行调试、action 日志查看、状态快照对比、导入/导出等功能。

## 功能概述

- **Action 日志**: 记录每个 dispatch 的 action，含时间戳和调用栈
- **State 树查看器**: 以树形结构浏览应用状态
- **Diff 对比**: 直观对比前后状态变化
- **时间旅行调试**: 可以跳转到任意历史 action 的状态
- **Action 跳过/重排**: 选择性忽略或调整 action 顺序
- **导入/导出**: 导出完整的 action 历史为 JSON，支持导入恢复调试会话
- **远程调试**: 支持连接到远程 Redux 实例 (React Native 等)
- **编辑器集成**: 支持 VSCode / Atom / WebStorm 跳转到 action 源码

## 技术架构

- **平台**: Chrome Extension (Manifest V3)
- **UI**: React 18.3.1 + CodeMirror
- **序列化**: jsan (支持循环引用、函数、Symbol、Immutable.js)
- **打包**: Webpack 5
- **通信**: postMessage + chrome.runtime.connect

## 权限

| 权限 | 用途 |
|------|------|
| `notifications` | 错误通知 |
| `contextMenus` | 右键菜单 |
| `storage` | 选项持久化 |
| `host_permissions` | 调试所有页面 (含 file://) |

## 分析版本

| 版本 | 日期 | 模型 | 目录 |
|------|------|------|------|
| 3.2.10 | 2026-07-06 | dsv4 (DeepSeek V4 Pro) | [2026-07-06-dsv4/](./2026-07-06-dsv4/) |

## 相关链接

- 官方仓库: https://github.com/reduxjs/redux-devtools
- Chrome Web Store: Redux DevTools
