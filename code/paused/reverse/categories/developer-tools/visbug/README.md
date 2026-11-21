# VisBug — Chrome 扩展逆向工程

> Open source browser design tools — 可视化的浏览器设计工具

## 功能概述

VisBug 是一款开源浏览器端可视化设计工具，允许设计师和开发者在任意网页上直接进行拖拽式 CSS 调试和视觉调整。它提供类似 Firebug 的交互体验，但聚焦于设计工作流：

- 元素选择、拖拽、移动和尺寸调整
- Margin/Padding/Border 可视化编辑
- 颜色取色与格式切换 (hex/rgb/hsl)
- 文本样式实时编辑 (font-size, line-height, letter-spacing 等)
- 间距/对齐参考线
- Box-shadow 可视化编辑
- 内置交互动画教程 (13 个 GIF)
- 支持亮色/暗色/自动主题切换
- 键盘快捷键操作

## 技术架构

| 维度 | 详情 |
|------|------|
| Manifest 版本 | 3 |
| Service Worker | visbug.js (ES module) |
| 权限 | activeTab, contextMenus, scripting, storage |
| UI 实现 | 自定义元素 `<vis-bug>` + Canvas/DOM 操作 |
| 打包方式 | 手工压缩 (bundle.min.js) |
| 第三方依赖 | hotkeys-js v3.13.7 (MIT, 键盘快捷键) |
| 浏览器兼容 | Chrome / Firefox (通过 browser/chrome 命名空间适配) |

## 权限说明

| 权限 | 用途 |
|------|------|
| `activeTab` | 仅在用户激活时访问当前页面 |
| `contextMenus` | 提供右键菜单 (启动/颜色格式/主题) |
| `scripting` | 注入 VisBug UI 到页面 |
| `storage` | 跨设备同步颜色偏好 |

## 逆向分析版本

| 日期 | 版本 | 模型 | 说明 |
|------|------|------|------|
| [2026-07-06](./2026-07-06-dsv4/) | 0.4.10 | dsv4 | 初始逆向，完整分析 |

## 开源仓库

GitHub: https://github.com/GoogleChromeLabs/visbug

## 安全评估

详见各版本目录下的 `src/docs/SECURITY_AUDIT.md`。总体评估：**低风险** — 权限最小化，无外部网络请求，无数据外传，无 PII 收集。
