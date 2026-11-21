# CSS Peeper dsV4 — 归档说明

## 归档信息

| 字段 | 值 |
|------|-----|
| 项目名称 | css-peeper-dsv4 |
| 创建日期 | 2026-07-05 |
| 反向工程目标 | CSS Peeper Chrome 扩展 v1.2.2 |
| 原始作者 | Sparkglare Sp. z o.o. |
| 源文件路径 | `css-peeper-source-code/` |
| 输出路径 | `css-peeper-dsv4/` |

## 源文件清单 (27 个文件)

### 入口与配置 (3)
- `manifest.json` — MV3 扩展清单
- `sidepanel.html` — Side Panel 入口 HTML
- `file-manifest.json` — 构建产物映射

### Service Worker (1)
- `static/background/index.js` — Service Worker (~170 KB)

### Content Scripts (3)
- `sidebar-element-locator.2f29fd82.js` — 元素定位器 (~8 KB)
- `csspeeper-inspector-tools.eb9765a1.js` — 检查工具集 (~180 KB)
- `inspector.b9415ea5.js` — 主检查器 (~1.4 MB)

### Side Panel UI (2)
- `sidepanel.b7741352.js` — React 应用 (~1.3 MB)
- `sidepanel.7c54f4bc.css` — Tailwind CSS (~48 KB)

### 静态资源 (19)
- 5 个图标文件 (16/32/48/64/128px)
- 2 个 SVG (元素指示器图标)
- 12 个 PNG (功能截图、Onboarding 引导图、侧栏背景)

### 元数据 (1)
- `_metadata/verified_contents.json` — Chrome Web Store 签名数据

## 产出物清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `dist/` (27 个文件) | 二进制副本 | 原始扩展文件的完整拷贝 |
| `src/types/index.ts` | TypeScript | 12 个核心接口和类型定义 |
| `src/docs/ARCHITECTURE.md` | 文档 (中文) | 完整架构分析，含组件关系图和设计 token 表 |
| `src/docs/DATA_FLOW.md` | 文档 (中文) | 数据流分析，含 5 个 Mermaid 图表 |
| `src/docs/SECURITY_AUDIT.md` | 文档 (中文) | 安全审计报告，含权限评估和改善建议 |
| `package.json` | 配置 | Node.js 项目配置 |
| `README.md` | 文档 (中文) | 项目总览和快速开始 |
| `archive.md` | 文档 (中文) | 本归档说明 |

## 关键记号

- **构建框架**: Plasmo (通过图标文件名 `plasmo` 前缀和 `__plasmo` DOM 挂载点确认)
- **打包工具**: Parcel (通过 `parcelRequire` 模块加载器确认)
- **UI 框架**: React (通过 JSX 编译产物推断)
- **CSS 方案**: Tailwind CSS (通过完整的 utility class 确认)

## 未解析项

- `externally_connectable` 中 `googletagmanager.com` 的确切使用方式
- `sandbox` CSP 配置对应的沙盒页面文件 (未在产物中发现独立的 sandbox HTML)
- Pro/Free 许可功能的具体差异化逻辑
- `webRequest` 权限在代码中的具体使用位置

## 说明

- 本归档仅供技术学习和研究使用
- 原始扩展版权归 Sparkglare Sp. z o.o. 所有
- 所有 JS 代码经 Parcel 高度打包混淆，无 source map，无法还原原始源码
- 类型定义基于功能行为推断，可能与实际内部实现有偏差
