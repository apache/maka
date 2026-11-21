# 复制链接到剪贴板 v15.1.3 — dsv4 逆向工程

## 版本信息

- **逆向日期**: 2026-07-06
- **AI 模型**: DeepSeek V4 Pro (dsv4)
- **原始版本**: 15.1.3
- **Manifest 版本**: 3
- **扩展 ID**: url2clipboard@asamuzak.jp
- **原始仓库**: https://github.com/asamuzaK/url2clipboard
- **许可**: MPL-2.0

## 功能概述

以 16 种标记格式复制页面链接到剪贴板:

| 格式 | 示例输出 |
|------|----------|
| HTML (text/plain) | `<a href="..." title="...">Title</a>` |
| HTML (text/html) | `<a href="..." title="...">Title</a>` (富文本) |
| Markdown | `[Title](url "title")` |
| BBCode | `[url=...]Title[/url]` |
| Textile | `"Title":url` |
| AsciiDoc | `link:url[Title]` |
| MediaWiki | `[url Title]` |
| DokuWiki | `[[url\|Title]]` |
| Jira | `[Title\|url]` |
| reStructuredText | `` `Title <url>`_ `` |
| LaTeX | `\href{url}{Title}` |
| Org Mode | `[[url]Title]` |
| CSV | `Title,url` |
| Text & URL | `Title url` |
| Text | `Title` |
| URL | `url` |

## 触发方式

1. **右键菜单**: 在页面/链接/标签页上右键复制 (3 层嵌套菜单: 场景→格式→子选项)
2. **键盘快捷键**: 16 个可自定义快捷键 (Alt+Shift+C 打开弹窗及其他格式快捷键)
3. **弹出窗口**: 点击工具栏图标, 在悬浮窗中选择格式并编辑内容后复制

## 技术架构

- **MV3 Service Worker** (ES Module), 无持久化后台页面
- **Offscreen Document** 用于剪贴板写入和 HTML 净化 (因 SW 无 DOM)
- **内容脚本按需注入** (`chrome.scripting.executeScript`), 无需持久化 content_scripts
- **DOMPurify + url-sanitizer** 双净化防护 XSS/URL 注入
- **webext-polyfill** 跨浏览器兼容 (Firefox/Chrome)

完整架构文档见 `src/docs/ARCHITECTURE.md`。

## 目录结构

```
2026-07-06-dsv4/
├── dist/              ← 可加载到 Chrome 的扩展 (直接从 CRX 提取)
├── src/
│   ├── types/index.ts ← TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md   ← 架构分析
│       ├── DATA_FLOW.md      ← 数据流分析 (含 Mermaid 图)
│       └── SECURITY_AUDIT.md ← 安全审计 (9 维度)
├── package.json       ← TypeScript 开发依赖
└── README.md          ← 本文件
```

## 安装与运行

1. 打开 Chrome, 访问 `chrome://extensions`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序", 选择 `dist/` 目录
4. 扩展加载后, 在页面/链接上右键即可看到复制菜单
