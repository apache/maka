# 飞书转存专家 v0.7.27 — 架构文档 (dsv4)

**版本跳跃**: v0.1.80 → v0.7.27 (跨 6 个大版本)
**文件数**: 274 | **最大 JS**: background.js (2.9MB)

## 变更摘要

| 维度 | v0.1.80 | v0.7.27 | 变化 |
|------|---------|---------|------|
| 文件数 | ~30 | 274 | +9x |
| Permissions | 基础 | 11 项 | **全面扩展** |
| Content Scripts | 2-3 条 | 5 条 | +task-panel, +scys |
| 支持平台 | 飞书 | 飞书/金山/腾讯/语雀/公众号/生菜 | **多平台** |
| 导出格式 | PDF/Word/MD/HTML/Img | +Excel/PPT/Text | **扩展** |

## 新增平台支持

| 平台 | 注入文件 | 大小 |
|------|---------|------|
| 金山文档 | kdocs.js | 386KB |
| 腾讯文档 | injected-qq-slide.js | 784KB |
| 生菜 | sc-article-extractor.js | 新 |
| 公众号 | content.js (增强) | 新 |

## 核心模块

```
background.js              — Service Worker (2.9MB, 最大文件)
injected-qq-slide.js       — 腾讯文档幻灯片 (784KB)
injected-word.js           — Word 导出 (454KB)
injected-md.js             — Markdown 导出 (244KB)
exceljs.min-CACWcEMR.js    — Excel 处理 (939KB)
mermaid.core-tR8zO_Qe.js   — 图表渲染 (581KB)
history-page-DmFaxrV_.js   — 历史记录页 (794KB)
```

## 技术栈

- 框架: 原生 JS (无构建框架识别特征)
- 库: ExcelJS, Mermaid, Cytoscape, KaTeX, html2canvas, jsPDF
- API: side_panel, offscreen, declarativeNetRequest
- 外部连接: externally_connectable to shenxin.space
