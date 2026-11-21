# IDM Integration Module

**原始名称**: IDM Integration Module | **商店版本**: 6.43.1 | **厂商**: Tonec FZE | **Manifest**: V3

## 功能概述

IDM Integration Module 是 Internet Download Manager 桌面软件的浏览器集成扩展，负责检测网页中的视频/音频/文件资源，并将其发送到 IDM 桌面应用进行下载。

核心功能：
- 网页媒体资源自动嗅探（video/audio/下载链接）
- XHR/Fetch API Hook（通过 document.js 原型链拦截）
- 原生下载链接捕获
- IDM 桌面应用通信（Native Messaging + WebSocket fallback）
- 多语言支持（16 种语言）

## 技术架构

- **框架**: 纯原生 JS（手工混淆）
- **混淆**: ROT13 加密所有 API 名称和 CSS 选择器（content.js 30+ 处，background.js 12+ 处）
- **通信**: 主通道 `com.tonec.idm` Native Messaging Host，fallback `ws://127.0.0.1:1001`
- **代理**: `proxy` 权限可能用于 PAC 脚本配置

## 安全注意

- `proxy` 权限可控制所有浏览器流量代理设置
- `externally_connectable` 开放 IDM 和 Tonec 域名
- `cookies` 权限可读取任何域名的 Cookie
- 16 个语言包中存在潜在遗漏翻译

## 权限

`scripting`, `tabs`, `cookies`, `contextMenus`, `webNavigation`, `webRequest`, `declarativeNetRequest`, `downloads`, `downloads.shelf`, `downloads.ui`, `management`, `storage`, `proxy`, `nativeMessaging` + `all_urls` host

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 6.43.1 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
