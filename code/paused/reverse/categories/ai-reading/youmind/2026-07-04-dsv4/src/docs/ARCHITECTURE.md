# YouMind v0.3.0.33 — 架构文档 (dsv4)

**版本升级**: v0.3.0-alpha21 → v0.3.0-alpha33
**文件数**: 264 | **Permissions**: 12 项

## 变更摘要

| 维度 | alpha21 | alpha33 | 变化 |
|------|---------|---------|------|
| Permissions | 基础 | 12 项 | **大幅扩展** |
| Content Scripts | 少量 | 6 条 | **+MAIN world** |
| 第三方集成 | - | Jina AI, Supadata | **新增** |
| X/Twitter | 基础 | MAIN world 注入 | **新增** |
| YouTube | - | embed all_frames | **新增** |
| 图库 | - | Cytoscape, Mermaid | **新增** |

## 核心模块

```
sidebar-B5mEHauM.js      — 侧边栏主 UI (4.5MB)
useLiquidGlass-B3sxPNfC.js — LiquidGlass 渲染引擎 (1.3MB)
cytoscape.esm-2z9LKCB3.js  — 图形可视化 (425KB)
```

## 新增 Permissions

- `tabGroups`, `alarms`, `cookies` — 标签管理增强
- `downloads` — 导出功能
- `debugger` — 高级调试
- `commands` — 快捷键 Alt+Y/C/S/T
