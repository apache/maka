# 篡改猴 (Tampermonkey)

> 全球最流行的用户脚本管理器，Chrome Web Store 1000万+用户

## 功能概述

Tampermonkey 允许用户安装和运行自定义 JavaScript 脚本（用户脚本），这些脚本可以修改网页的外观、功能和行为。典型用途包括广告屏蔽、页面增强、自动化操作、数据提取等。

- **脚本管理**: 安装、编辑、启用/禁用、排序、标签分类
- **脚本同步**: 支持 Google Drive / OneDrive / Dropbox / WebDAV / Yandex 云同步
- **网络控制**: 通过 GM_webRequest 拦截/重定向请求，通过 GM_xmlhttpRequest 发起跨域请求
- **页面交互**: GM_addStyle、GM_addElement、GM_setClipboard、GM_notification 等
- **数据存储**: GM_setValue/GM_getValue，脚本间可共享数据
- **右键菜单**: GM_registerMenuCommand 自定义右键菜单
- **编辑器**: 内置 CodeMirror 6 编辑器 + ESLint 实时校验

## 技术架构

- **Manifest 版本**: MV3
- **打包工具**: Webpack
- **编辑器**: CodeMirror 6
- **存储**: IndexedDB (脚本) + chrome.storage (设置)
- **沙箱**: 自定义 Vault 机制隔离用户脚本与页面上下文
- **通信**: chrome.runtime.Port 长连接 + DOM 事件桥接

## 权限

Tampermonkey 需要大量权限以提供完整的脚本管理功能：

| 类别 | 权限 | 用途 |
|------|------|------|
| 网络 | webRequest, webRequestBlocking, <all_urls> | 脚本拦截/重定向网络请求 |
| 注入 | scripting, userScripts | 脚本注入到页面 |
| 存储 | unlimitedStorage, storage | 存储大量脚本数据 |
| 页面 | tabs, webNavigation, idle | 页面导航监听和标签管理 |
| UI | notifications, contextMenus, offscreen | 通知、右键菜单、剪贴板 |
| 数据 | cookies, clipboardWrite | Cookie操作和剪贴板写入 |
| 可选 | downloads | 文件下载 |

## 分析版本

| 版本 | 日期 | 模型 | 目录 |
|------|------|------|------|
| 5.5.0 | 2026-07-06 | DeepSeek V4 Pro | [2026-07-06-dsv4](./2026-07-06-dsv4/) |

## 安全评估

- **总体等级**: 🔴 高风险
- **原因**: webRequestBlocking + <all_urls> 组合可拦截所有网络流量；userScripts 权限允许注入任意JS到任意页面
- **注意**: 用户脚本本身不受 CSP 限制，恶意脚本可窃取敏感信息。Tampermonkey 通过 @grant 机制和沙箱隔离降低风险，但无法消除恶意脚本的威胁。建议只安装可信来源的脚本。

## 更多信息

- [Chrome Web Store](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- [官方网站](https://www.tampermonkey.net/)
