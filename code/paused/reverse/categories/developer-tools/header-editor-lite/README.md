# Header Editor Lite

**原始名称**: Header Editor Lite | **商店版本**: 5.2.12 | **Manifest**: V3

## 功能概述

Header Editor Lite 是一款 HTTP 请求头和响应体修改工具，支持创建规则来自动修改网页请求的头信息和响应内容。

核心功能：
- 请求头/响应头修改
- 响应体替换（借助 chrome.debugger CDP Fetch）
- 规则分组管理（导入/导出/云备份）
- 代码编辑器集成（CodeMirror 6）
- URL 匹配（正则/通配符/精确）

## 技术架构

- **UI**: React 18 + Semi Design (字节跳动)
- **编辑器**: CodeMirror 6
- **双引擎**: DNR（高性能头部修改）+ CDP Fetch（响应体修改）
- **存储**: IndexedDB 4 表（request / sendHeader / receiveHeader / receiveBody）
- **打包**: Webpack（无 source map）
- **偏好同步**: chrome.storage.sync 跨设备 + EventEmitter 广播

## 权限

`tabs`, `storage`, `unlimitedStorage`, `declarativeNetRequest`, `debugger` + `*://*/*` host

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 5.2.12 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
