# CSS Peeper

**原始名称**: CSS Peeper | **商店版本**: 1.2.2 | **厂商**: Sparkglare Sp. z o.o. | **Manifest**: V3

## 功能概述

CSS Peeper 是一款面向设计师和前端开发者的网页样式检查工具，支持一键提取任意网页元素的 CSS 属性、颜色调色板、字体信息等。

核心功能：
- 元素定位器（hover 高亮页面元素）
- CSS 属性完整提取
- 颜色调色板（品牌色 / 语义色 / 对比度检测）
- 排版信息（字号 / 行高 / 字重 / 字体栈）
- Side Panel 集成（无需弹窗，在侧边栏中使用）

## 技术架构

- **框架**: Plasmo（Chrome 扩展框架）
- **打包器**: Parcel
- **Content Scripts**: 三层注入（element-locator / inspector-tools / inspector）
- **Side Panel**: Chrome Side Panel API

## 安全注意

- `externally_connectable` 允许 googletagmanager.com 和 csspeeper.com 通信
- `webRequest` 权限可监听网络请求
- 所有 JS 无 source map，原始 TS/React 代码不可恢复

## 权限

`storage`, `sidePanel`, `activeTab`, `tabs`, `alarms`, `scripting`, `unlimitedStorage`, `webRequest` + `http/https` hosts

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 1.2.2 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
