# Get CRX

**原始名称**: Get CRX | **商店版本**: 1.51 | **Manifest**: V3

## 功能概述

Get CRX 是最简单的 Chrome 扩展之一 — 它允许用户从 Chrome Web Store 下载任意扩展的 CRX 安装包文件。

核心功能：
- 在扩展详情页右键，通过 Google CRX Update API 下载 CRX
- 支持新旧两种 Chrome Web Store URL 格式
- 自动检测页面中的扩展 ID

## 技术架构

- **代码量**: 仅 64 行 JS（bg.js）
- **API**: 调用 `https://clients2.google.com/service/update2/crx` 构造签名 URL
- **扩展 ID 提取**: 从 URL 路径段解析（经典版第 6 段，新版第 5 段）
- **浏览器兼容**: 仅需 `contextMenus` + `downloads` 权限

## 工程问题

- 全局变量 `ExtName` 在连续触发时存在竞态条件
- 文件名净化仅过滤 Windows 非法字符，未处理保留设备名

## 权限

`contextMenus`, `downloads` + `chrome.google.com/webstore/detail/*` host

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 1.51 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
