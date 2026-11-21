# MarkDownload v3.4.0 — dsv4 逆向工程

## 概要

- **扩展名称**: MarkDownload - Markdown Web Clipper
- **版本**: 3.4.0
- **作者**: Gordon Pedsersen
- **Manifest 版本**: 2
- **反向日期**: 2026-07-06
- **模型**: dsv4
- **安全评级**: B+ (良好)

## 功能概述

MarkDownload 将网页文章转换为 Markdown 格式并下载到本地。支持：

- 通过工具栏按钮、右键菜单、快捷键三种方式触发
- Readability 算法提取网页正文，自动过滤导航/广告/侧栏
- 可自定义的 Frontmatter / Backmatter 模板 (支持日期、标题、关键词变量替换)
- 图片可选下载 (纯 Markdown / Base64 内联 / Obsidian 嵌入)
- CodeMirror 编辑器预览与编辑转换结果
- Obsidian 集成 (通过 Advanced URI 插件)
- 多标签页批量下载与链接复制
- 右键菜单: 复制选中文本/链接/图片为 Markdown
- 选项配置导入/导出

## 技术栈

| 组件 | 技术 |
|------|------|
| 正文提取 | Mozilla Readability.js |
| HTML→MD 转换 | Turndown + turndown-plugin-gfm |
| Markdown 编辑器 | CodeMirror |
| 日期格式化 | moment.js |
| MIME 类型 | apache-mime-types |
| 跨浏览器 | webextension-polyfill v0.8.0 |
| 构建工具 | web-ext (仅用于开发打包) |

## 架构要点

- **无打包器**: 所有 JS 以独立 `<script>` 标签加载，全局作用域通信
- **双下载模式**: Downloads API (完整功能) + Content Link (Safari 降级)
- **惰性注入**: `ensureScripts()` 检测-注入模式避免 Content Script 重复注入
- **模板系统**: 三层变量替换 (Article 字段 / 日期格式化 / 命名风格转换)

## 产出文件

```
2026-07-06-dsv4/
├── dist/                          # 可加载到 Chrome 的扩展副本
├── src/
│   ├── types/index.ts             # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md         # 架构文档 (含分层图)
│       ├── DATA_FLOW.md            # 数据流文档 (含 Mermaid 图)
│       └── SECURITY_AUDIT.md       # 安全审计 (9 维度)
├── package.json                   # npm 配置
├── tsconfig.json                  # TypeScript 配置
└── README.md                      # 本文件
```

## 权限

- `<all_urls>` — 内容脚本注入 (高风险)
- `activeTab` — 标签页即时访问
- `downloads` — 文件下载
- `storage` — 选项持久化
- `contextMenus` — 右键菜单
- `clipboardWrite` — 剪贴板写入

## 安全审计摘要

| 维度 | 评级 |
|------|------|
| 权限面 | 中 |
| 数据流 | 低风险 |
| 注入面 | 中 |
| 通信安全 | 低风险 |
| 存储安全 | 低风险 |
| 隐私合规 | 低风险 |
| 依赖安全 | 中 |

**核心发现**: 无数据外传、无用户追踪、无第三方服务。主要风险为 `<all_urls>` 权限面较宽。详见 `src/docs/SECURITY_AUDIT.md`。
