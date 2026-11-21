# crxMouse Chrome 手势

**原始名称**: crxMouse Top Gestures | **商店版本**: 7.0.5 | **Manifest**: V3

## 功能概述

crxMouse 是 Chrome 最流行的鼠标手势扩展，支持通过鼠标拖拽轨迹触发浏览器操作（前进/后退/关闭标签/滚动等），以及超级拖拽、滚轮手势、自定义光标等功能。

核心功能：
- 鼠标手势（按右键画轨迹触发操作）
- 摇杆手势（左键+右键组合）
- 超级拖拽（拖拽链接/图片/文字执行搜索/打开/保存）
- 滚轮手势（滚轮+右键组合）
- 100+ 自定义光标主题
- 14 种语言支持

## 技术架构

- **核心**: 自定义模块系统 MpiUO（依赖解析 + 异步初始化）
- **Content Scripts**: 5 个脚本在不同注入点（contentStart/content/contentEnd/frame/websiteHandler）
- **打包**: Webpack（130.js, 946.js 分块）+ jQuery
- **混淆**: `proconstantinator_key` 常量表运行时加载
- **手势引擎**: content.js 主逻辑（32k tokens）

## ⚠️ 安全警告

该扩展拥有 **最危险的权限组合**：`webRequest` + `clipboardRead` + `clipboardWrite` + `bookmarks` + `all_urls`。Privacy Policy 明确声明采集 AI 请求响应数据并分享给关联公司。

## 权限

`tabs`, `storage`, `contextMenus`, `webNavigation`, `webRequest`, `clipboardRead`, `clipboardWrite`, `bookmarks`, `unlimitedStorage`, `scripting`, `sessions`, `alarms` + `*://*/*` host

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 7.0.5 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
