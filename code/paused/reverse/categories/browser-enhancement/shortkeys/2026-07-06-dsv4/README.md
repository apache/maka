# Shortkeys (Custom Keyboard Shortcuts) v5.0.1 — dsv4 逆向工程

**逆向日期**: 2026-07-06
**模型**: dsv4 (DeepSeek v4)
**原始版本**: 5.0.1
**Manifest 版本**: 3
**代码可读性**: Vite 打包, 变量名缩短但逻辑清晰可读

## 功能概述

Shortkeys 是一个 Chrome 浏览器快捷键自定义扩展。用户可以为 80+ 内建浏览器操作绑定自定义键盘组合，支持按网站分别激活不同的快捷键配置。

**核心能力**:
- 标签页管理 (切换/关闭/移动/分组/固定等 25+ 操作)
- 窗口管理 (新建/关闭/全屏/隐私窗口)
- 页面导航 (前进/后退/URL 操作/翻页)
- 页面滚动 (方向/页/平滑滚动)
- 缩放控制
- 剪贴板操作 (复制 URL/标题/Markdown 链接; 从剪贴板打开 URL)
- 书签管理 (搜索/打开/创建/删除, 支持 bookmarklet)
- 视频控制 (播放/暂停/静音/速度/快进/画中画)
- 搜索引擎快捷搜索 (Google/YouTube/Wikipedia/GitHub)
- JavaScript 执行 (自定义代码注入 + 内建 20+ 页面脚本)
- 宏 (多步骤操作链, 支持延迟)
- 截图 (可视区域/完整页面, 通过 CDP)
- 链接提示 (键盘选链接, SADFJKLEWCMPGH 字符集)
- Cheat Sheet 覆盖层 (显示当前页所有快捷键)
- 暗色模式切换

## 目录结构

```
2026-07-06-dsv4/
├── dist/                          # 可加载到 Chrome 的原始扩展
│   ├── manifest.json
│   ├── background.js              # Service Worker (IIFE, Vite)
│   ├── content-scripts/content.js # 内容脚本
│   ├── chunks/                    # Vite 代码分割
│   │   ├── options-D7Jpik--.js    # 设置页面
│   │   ├── popup-B1yKYaqZ.js      # 弹出面板
│   │   └── storage-DL2X4Nnb.js    # 共享存储模块
│   ├── assets/                    # CSS 样式
│   ├── images/                    # 图标和截图
│   ├── options.html               # 设置页入口
│   ├── popup.html                 # 弹出页入口
│   └── _locales/                  # 国际化
├── src/
│   ├── types/index.ts             # TypeScript 类型定义 (推断还原)
│   └── docs/
│       ├── ARCHITECTURE.md        # 架构文档
│       ├── DATA_FLOW.md           # 数据流文档 (含 Mermaid 图)
│       └── SECURITY_AUDIT.md      # 安全审计报告
├── package.json
└── README.md                      # 本文件
```

## 技术架构

- **打包工具**: Vite (IIFE format for SW, ES Module for chunks)
- **UI 框架**: 自研响应式 (无 React/Vue)
- **键盘库**: Mousetrap.js (内联修改版)
- **图标**: Material Design Icons (CDN)
- **内容脚本生命周期**: WXT-based (ContentScriptContext, LocationChangeWatcher)

## 权限分析

| 风险 | 权限 | 用途 |
|------|------|------|
| 低 | storage | 快捷键配置持久化 |
| 低 | activeTab, scripting, clipboardWrite, downloads, notifications | 核心功能 |
| 中 | tabs, bookmarks, sessions, tabGroups | 标签/书签管理 |
| 中 | browsingData | 仅清除下载历史 |
| 高 | management | 启动 Chrome App |
| **高** | **debugger** | 完整页面截图 (CDP), 使用后立即 detach |
| **高** | **userScripts** | MAIN world 执行用户 JS |
| **高** | ***://\*/\*** | 全局内容脚本 + userScripts 注入 |

## 安全审计摘要

见 `src/docs/SECURITY_AUDIT.md` 完整报告。

**关键发现**:
- debugger 使用后立即释放, 仅用于截图, 符合最小权限
- userScripts 注入 `*://*/*` 所有网站, 风险较高但为核心功能所需
- `fetchUrl` 消息处理本质上是无限制 HTTP 代理 (SSRF-like)
- reader-mode 操作中使用 innerHTML 未清洗, 存在残留 HTML 风险
- 无外部遥测, 数据仅本地存储
- externally_connectable 限于 shortkeys.app + localhost

**总体评级: 中-高**

## 分析版本

| 日期 | 版本 | 模型 | 备注 |
|------|------|------|------|
| 2026-07-06 | 5.0.1 | dsv4 | 初始逆向 |

## 加载方式

1. 打开 Chrome, 进入 `chrome://extensions`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `dist/` 目录
