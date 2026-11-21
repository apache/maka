# OneTab — Chrome 标签页管理器

> 将打开的标签页收纳为列表，一键恢复。号称节省 95% 内存。

## 功能

- 一键将所有标签页（或选定标签页）转换为结构化列表
- 支持按窗口、Chrome 标签组 (Tab Group)、文件夹组织
- 拖拽重组、搜索、批量操作
- 标签页恢复（单个/批量/整组/整窗口）
- 导入 Chrome 书签和阅读列表
- 导出为富文本或纯文本格式
- 云端分享与同步（需授权 one-tab.com）
- 暗色模式 / 自动主题
- 键盘快捷键 & 右键菜单 & 地址栏关键词 (`11`)
- 62 种语言支持

## 技术架构

- **Manifest V3** + Service Worker
- **无 UI 框架** — 自研 virtual DOM 风格的纯 JS 渲染
- **扁平化数据存储** — `chrome.storage.local` 存储 tab/group 树
- **RPC Proxy 模式** — 所有 UI 页面对 background 的调用通过 Proxy 透明代理

## 权限

| 权限 | 类型 | 用途 |
|------|------|------|
| tabs, activeTab | required | 标签页查询/操作 |
| storage, unlimitedStorage | required | 数据持久化 |
| favicon | required | 网站图标 |
| scripting | required | 动态注册 content script |
| contextMenus | required | 右键菜单 |
| tabGroups | optional | 标签组管理 |
| readingList | optional | 阅读列表导入 |
| bookmarks | optional | 书签导入 |
| `one-tab.com` host | optional | 分享与同步 |

## 分析版本

| 版本 | 日期 | 批次 | 模型 | 安全 |
|------|------|------|------|:----:|
| [2.18](2026-07-06-dsv4/README.md) | 2026-07-06 | dsv4 | DeepSeek V4 Pro | 🟡 |
