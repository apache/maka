# ADB — Chrome 扩展逆向工程

> **分类**：developer-tools  
> **Slug**：`adb`  
> **原始仓库**：[GoogleChrome/ADBPlugin](https://github.com/GoogleChrome/ADBPlugin)

## 简介

ADB（Android Debug Bridge）是一个 Chrome 扩展，用于通过 Chrome 浏览器对 Android 设备进行远程调试。该扩展最初依赖 NPAPI 插件与 Android 设备建立 ADB 连接，允许开发者在 Chrome DevTools 中直接检查和调试移动端网页。

Chrome 45（2015年9月）移除了 NPAPI 支持后，ADB 设备发现与调试功能被原生集成到 Chrome DevTools 的 `chrome://inspect` 页面中，此扩展因此废弃。当前版本仅作为功能引导入口，帮助用户发现已内置的远程调试功能。

## 关键特征

| 属性 | 值 |
|------|-----|
| **Manifest 版本** | 2 |
| **权限模型** | 零权限 |
| **打包工具** | 无（纯原生 JS） |
| **代码规模** | ~130 行 |
| **安全评级** | 🟢 低风险 |
| **当前状态** | 已废弃（NPAPI 移除，MV2 淘汰中） |

## 版本历史

| 版本 | 逆向日期 | 模型 | 目录 |
|------|----------|------|------|
| 0.9.8 | 2026-07-06 | dsv4 | [2026-07-06-dsv4](./2026-07-06-dsv4/) |

## 逆向产物结构

每个版本目录包含：
- `dist/` — 可直接加载到 Chrome 的扩展副本
- `src/types/index.ts` — TypeScript 类型定义
- `src/docs/ARCHITECTURE.md` — 架构文档
- `src/docs/DATA_FLOW.md` — 数据流文档
- `src/docs/SECURITY_AUDIT.md` — 安全审计报告
- `package.json` — 包配置
- `README.md` — 版本逆向说明
