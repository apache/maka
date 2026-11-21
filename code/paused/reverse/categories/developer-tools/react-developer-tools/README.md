# React Developer Tools

React Developer Tools 是 Chrome DevTools 的官方扩展，用于调试 React 应用。它提供组件树检查、Props/State 实时编辑、性能分析（Profiler）、组件高亮和 Suspense 边界可视化等功能。

## 功能概述

- **组件树检查**：以树形结构展示 React 组件层级，查看 Props、State、Hooks、Context
- **实时编辑**：在 DevTools 中直接修改组件的 Props、State 和 Hooks 值，触发页面实时更新
- **性能分析**：通过 Profiler 面板记录渲染性能数据，生成火焰图和时间线
- **组件高亮**：在页面上以彩色矩形覆盖显示选中的组件（margin 橙色、border 黄色、padding 绿色、content 蓝色）
- **跟踪更新**：高亮正在重新渲染的组件，颜色按更新频率从绿到红渐变
- **Suspense 可视化**：显示 Suspense 边界和挂起状态
- **错误/警告显示**：在组件树中标注有错误或警告的组件

## 技术架构

```
DevTools Panel (main.js) ←→ Background SW ←→ Content Scripts ←→ Main World (React Hook)
```

- **前端**：React 构建的 DevTools 面板 UI（Webpack 打包）
- **后台**：Chrome MV3 Service Worker，负责脚本注入和消息路由
- **内容脚本**：4 个动态注册的 content scripts，运行在 ISOLATED 和 MAIN world
- **后端**：注入到页面的 Agent/Bridge 架构，管理 React 渲染器接口

## 权限

| 权限 | 用途 |
|------|------|
| `scripting` | 动态注入调试脚本 |
| `storage` | 持久化调试设置 |
| `tabs` | 标签页状态监控 |
| `clipboardWrite`（可选） | 复制组件路径 |
| `<all_urls>` | 支持所有页面的 React 调试 |

## 分析版本

| 版本 | 日期 | 模型 | Manifest | 安全评级 |
|------|------|------|----------|----------|
| [7.0.1](./2026-07-06-dsv4/) | 2026-07-06 | dsv4 (DeepSeek V4 Pro) | MV3 | 中等偏高 |
