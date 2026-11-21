# yuque-helper (语雀助手)

**语雀知识库 Chrome 辅助扩展** — 内容增强编辑、图片搜索、文本格式化、思维导图、日记生成。

[Chrome Web Store](https://chromewebstore.google.com/detail/yuque-helper) | 作者: [coder4j](https://blog.coder4j.cn)

## 功能简介

- Markdown 全屏编辑器 + 分屏预览
- 图片搜索与一键插入 (Pexels API)
- 全角/半角字符格式化
- 文档目录自动提取
- 标题转思维导图 (Markmap)
- 网页内容转存到语雀知识库
- 日记自动生成
- 字数统计与彩色标题头

## 技术架构

| 项目 | 内容 |
|------|------|
| 分类 | site-specific |
| Manifest | V2 |
| UI 框架 | Vue.js 2.6.12 + Element UI |
| 构建工具 | Webpack 4 |
| 编辑器 | CodeMirror |
| 思维导图 | markmap-lib + d3.js |

## 分析版本

| 版本 | 日期 | 模型 | 安全等级 | 文档 |
|------|------|------|----------|------|
| [1.6.0](2026-07-06-dsv4/) | 2026-07-06 | dsv4 | 中 | ARCHITECTURE / DATA_FLOW / SECURITY_AUDIT |

## 主要发现

- 扩展通过 `<all_urls>` 权限在 `document_start` 注入所有页面，支持"网页转存"功能
- 内嵌的 Pexels API Key 可被反编译提取
- Vue 2.6.12 存在已知 CVE-2024-21488，建议升级
- Element UI 已停止维护，长期安全性无保障
- 未发现恶意行为、静默上报或广告注入
