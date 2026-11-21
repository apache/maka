# JSON Viewer Pro

**原始名称**: JSON Viewer Pro | **商店版本**: 1.0.6 | **Manifest**: V3

## 功能概述

JSON Viewer Pro 是一款 Chrome 扩展，当浏览器访问 JSON 文件或 API 端点返回 JSON 时，自动将其格式化并以树形视图、图表等形式呈现，替代浏览器默认的纯文本显示。

核心功能：
- JSON 树形查看器（可折叠/展开）
- JSON 图表可视化
- 自定义 CSS 主题（Dark Pro / MDN Light）
- 右键菜单快速格式化剪贴板 JSON
- 独立的 JSON 编辑器标签页

## 技术架构

- **UI**: React 18（生产打包）+ CodeMirror 6
- **JSON 检测**: Content-Type 匹配 + JSON.parse 校验双重策略
- **通信**: Service Worker → Content Script → 页面 meta 标签 → React App
- **配置**: chrome.storage.local 持久化，Service Worker 广播变更

## 权限

`contextMenus`, `storage` + `*://*/*` host

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 1.0.6 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
