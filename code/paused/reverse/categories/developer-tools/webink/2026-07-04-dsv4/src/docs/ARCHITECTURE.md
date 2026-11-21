# WebInk v0.5.1 — 架构文档 (dsv4)

**版本升级**: v0.4.2 → v0.5.1 | **文件数**: 364 (v0.4.2: 359)
**框架**: Plasmo | **打包**: Parcel

---

## 变更摘要 (v0.4.2 → v0.5.1)

| 维度 | v0.4.2 | v0.5.1 | 变化 |
|------|--------|--------|------|
| 文件数 | 359 | 364 | +5 |
| Side Panel | ❌ | ✅ | **新增** |
| options_ui | ✅ | ✅ | 保持 |
| Mermaid 图表 | ~15 种 | ~20 种 | **扩展** |
| CSP | 标准 | +wasm-unsafe-eval | **放宽** |

## 核心模块

```
content.06af5f40.js   — 内容脚本 (核心提取 + Turndown + Readability)
sidepanel.b7741352.js — 侧边栏 (3.8MB, Monaco Editor + Mermaid)
options.95eda3f3.js   — 设置页 (1.4MB)
background/index.js   — Service Worker (轻型)
```

## 第三方库

- `@mozilla/readability` — 内容提取
- `turndown` — HTML → Markdown
- `monaco-editor` — 代码编辑器 (200+ 语言包)
- `mermaid` — 图表渲染 (20+ 类型)
