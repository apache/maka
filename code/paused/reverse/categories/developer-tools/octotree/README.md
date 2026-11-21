# Octotree - GitHub code tree

**原始名称**: Octotree - GitHub code tree | **商店版本**: 8.3.0 | **Manifest**: V3

## 功能概述

Octotree 是一款浏览器扩展，为 GitHub 仓库页面添加 IDE 风格的侧边栏文件浏览器。支持树形目录浏览、快速文件导航、语法高亮文件预览、文件搜索等功能，大幅提升 GitHub 上的代码浏览和审查效率。

核心功能：
- 侧边栏树形文件视图（使用 jsTree）
- 代码文件内容预览（含语法高亮）
- 文件名/路径模糊搜索
- VSCode 风格文件图标（250+ 文件类型）
- 深色/浅色主题切换
- 11 种等宽代码字体可选
- Pull Request 变更文件树
- GitHub Enterprise 支持（通过域名权限授予）
- GitHub pjax 导航兼容

## 技术架构

- **前端**: jQuery + jQuery UI + jsTree（树形渲染）
- **打包**: Webpack 5（background.js ~21KB, content.js ~565KB）
- **通信**: Content Script -> Service Worker -> Octotree API（代理模式）
- **存储**: chrome.storage.local（设置/Token/许可证）
- **权限**: 动态域名授权（optional_host_permissions）+ 右键菜单切换
- **兼容**: webextension-polyfill（Firefox/Chrome 兼容层）

## 权限

`storage`, `contextMenus`, `activeTab`, `scripting` + 固定主机 `api.github.com`, `octotree.io` + 可选主机 `*://*/*`

## 安全注意

Octotree 将用户的 GitHub Personal Access Token 发送至 `api.octotree.io` 后端服务。详见[安全审计报告](2026-07-06-dsv4/src/docs/SECURITY_AUDIT.md)。

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 8.3.0 | 2026-07-06 | DeepSeek V4 Pro | [2026-07-06-dsv4/](2026-07-06-dsv4/) |
