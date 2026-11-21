# 复制链接到剪贴板 (Copy Link to Clipboard)

> Copy page links in various formats -- 以多种格式复制页面链接到剪贴板。

## 功能概述

复制当前页面 URL、链接 URL、或标签页 URL 到剪贴板, 支持 16 种标记格式输出:
HTML (纯文本/富文本)、Markdown、BBCode、Textile、AsciiDoc、MediaWiki、DokuWiki、Jira、reStructuredText、LaTeX、Org Mode、CSV、Text & URL、纯文本、纯 URL。

## 触发方式

- **右键菜单**: 页面/链接/标签页上右键, 多级子菜单选择格式
- **键盘快捷键**: 16 个可自定义快捷键, 一键复制指定格式
- **弹出窗口**: 工具栏图标悬浮窗, 支持编辑内容后复制

## 技术架构

- **Manifest V3** Service Worker (ES Module)
- **Offscreen Document** 用于剪贴板写入和 HTML 净化
- **内容脚本按需注入** (chrome.scripting API)
- **DOMPurify + url-sanitizer** 双重 XSS/URL 注入防护
- **webext-polyfill** 跨浏览器兼容 (Firefox/Chrome)

## 权限

| 权限 | 用途 |
|------|------|
| activeTab | 读取当前标签页 URL/标题 |
| clipboardWrite | 写入剪贴板 |
| contextMenus | 右键菜单 |
| offscreen | 隐形文档 (剪贴板写入/净化) |
| scripting | 注入内容脚本获取页面上下文 |
| storage | 保存用户设置 |
| tabs | 读取标签页信息 |
| notifications (可选) | 复制成功通知 |

## 分析版本

| 版本 | 日期 | 模型 | 安全等级 | 文档 |
|------|------|------|----------|------|
| v15.1.3 | 2026-07-06 | dsv4 | 低风险 | [2026-07-06-dsv4/](2026-07-06-dsv4/) |

## 原始信息

- **扩展 ID**: url2clipboard@asamuzak.jp
- **原始仓库**: https://github.com/asamuzaK/url2clipboard
- **许可**: MPL-2.0
