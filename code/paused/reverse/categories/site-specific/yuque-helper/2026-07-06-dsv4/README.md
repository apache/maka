# yuque-helper v1.6.0 (dsv4 逆向工程)

**语雀助手** — 语雀知识库平台的 Chrome 辅助扩展，提供内容增强编辑、图片搜索、文本格式化、思维导图、日记生成等功能。

## 快速信息

| 项目 | 内容 |
|------|------|
| 插件名 | yuque-helper (语雀助手) |
| 版本 | 1.6.0 |
| Manifest | V2 |
| 构建工具 | Webpack 4 |
| UI 框架 | Vue.js 2.6.12 + Element UI |
| 分类 | site-specific |
| 安全等级 | 中 |
| 作者主页 | https://blog.coder4j.cn |
| 逆向日期 | 2026-07-06 |
| 模型 | dsv4 |

## 功能概述

- **Markdown 编辑器**: 全屏编辑、分屏预览、代码块语法高亮、导入/导出
- **图片搜索**: 集成 Pexels API，在语雀编辑器内快速搜索和插入图片
- **文本格式化**: 全角/半角字符转换、全角引号替换
- **目录提取**: 自动生成文档目录导航
- **思维导图**: 基于 Markmap 将文档标题层级转为可视化思维导图
- **网页转存**: 将任意网页转为 Markdown 保存到语雀知识库
- **日记生成**: 按模板自动生成每日日记
- **字数统计**: 可配置的字数统计显示
- **彩色标题头**: 一键插入带颜色标记的标题
- **表情与提示框**: 内置语雀风格表情和提示框模板

## 目录结构

```
2026-07-06-dsv4/
├── dist/                          # 可加载到 Chrome 的扩展副本
│   ├── manifest.json
│   ├── background.js
│   ├── content_scripts/test.js
│   ├── popup/
│   ├── options/
│   ├── editor/
│   ├── markmap/
│   └── icons/
├── src/
│   ├── types/index.ts             # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md         # 架构文档
│       ├── DATA_FLOW.md            # 数据流文档
│       └── SECURITY_AUDIT.md       # 安全审计
├── package.json
└── README.md                      # 本文件
```

## 使用方式

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `dist/` 目录

## 技术说明

- 所有 JS 文件均为 Webpack bundle，Vue.js 2.6.12 内联在 bundle 模块 0 中
- Content script (`content_scripts/test.js`) 使用 jQuery + Turndown + Mozilla Readability 组合，在 `document_start` 注入所有页面
- 编辑器基于 CodeMirror，markmap 独立页面使用 d3.js + markmap-lib
- 跨组件通信使用 `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`
- 设置通过 `chrome.storage.sync` 持久化

## 已知限制

- Manifest V2，未来 Chrome 版本可能拒绝加载
- `<all_urls>` 权限过度申请（功能需要，但应在安装时披露）
- Vue 2.6.12 存在已知 CVE (CVE-2024-21488)
- Element UI 已停止维护
- Pexels API Key 硬编码，反编译即可提取
