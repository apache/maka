# Wappalyzer v6.12.3 — dsv4 逆向还原

## 版本信息

| 属性 | 值 |
|------|-----|
| 插件名 | Wappalyzer - Technology profiler |
| 版本 | 6.12.3 |
| Manifest 版本 | 3 |
| 最低 Chrome 版本 | 121 |
| 逆向日期 | 2026-07-06 |
| 工作流 | dsv4 |
| 代码可读性 | 无打包器，手写纯 JavaScript，可直接阅读 |
| 安全等级 | 🟡 Medium（详见安全审计） |

## 功能概述

Wappalyzer 是 Chrome Web Store 上最流行的网站技术栈识别工具。通过分析网页的 HTTP 响应头、HTML 结构、JavaScript 全局变量、Cookie、Meta 标签、CSS 规则和外部脚本引用等信号，自动识别网站所使用的 CMS、框架、分析工具、CDN 等技术。

v6.12.3 版本覆盖 **27 个字母分片的指纹数据库**（~8,500+ 条技术记录），支持 **111 个技术分类**（CMS、JavaScript 框架、分析工具、CDN 等），提供 **18 个顶级分组**，并提供 Wappalyzer Plus 付费功能（公司/联系人详情、CSV 导出）。

## 技术架构

- **无打包器**：所有 JS 文件为手写纯 JavaScript，无 webpack/parcel/vite/rspack
- **MV3 Service Worker**：通过 `importScripts()` 加载核心引擎
- **Content Script 隔离世界**：通过 `<script>` 标签注入 `js.js`/`dom.js` 到页面主世界，突破 Chrome 隔离限制
- **模式匹配引擎**：自定义 DSL 格式 `regex\;version:\1\;confidence:50`，支持版本提取、置信度累加、技术互斥与推导
- **27 个 JSON 分片**：技术指纹数据库按首字母分片（a-z + _），通过 27 个并行 fetch 加载
- **Ping 匿名上报**：去重后的技术栈 + hostname 发送到 ping.wappalyzer.com

## 文件清单

```
├── manifest.json           — MV3，4 权限 + full host
├── categories.json         — 111 技术分类
├── groups.json             — 18 顶级分组
├── schema.json             — storage schema (tracking)
├── technologies/           — 27 个 JSON 指纹数据库
├── js/
│   ├── background.js       — SW 入口 (importScripts)
│   ├── wappalyzer.js       — 核心匹配引擎
│   ├── utils.js            — 浏览器工具库
│   ├── index.js            — 主调度器 (Driver)
│   ├── content.js          — Content Script 采集器
│   ├── popup.js            — 弹窗 UI
│   ├── options.js          — 设置页面
│   ├── terms.js            — 隐私条款页面
│   ├── js.js               — 注入: JS 全局变量检测
│   └── dom.js              — 注入: DOM 属性检测
├── html/                   — 4 个 HTML 页面
├── css/styles.css          — 全局样式 (BEM + CSS 变量)
├── images/                 — 图标 + 技术 logo (~1000+)
└── _locales/               — 34 种语言
```

## 还原产出

| 产物 | 路径 | 说明 |
|------|------|------|
| 可运行副本 | `dist/` | 完整源码，可直接加载到 Chrome |
| 类型定义 | `src/types/index.ts` | TypeScript 接口定义 |
| 架构文档 | `src/docs/ARCHITECTURE.md` | 分层架构、模块职责、技术决策 |
| 数据流文档 | `src/docs/DATA_FLOW.md` | Mermaid 序列图，6 大核心流程 |
| 安全审计 | `src/docs/SECURITY_AUDIT.md` | 9 维度评估，风险等级与缓解建议 |
| 包配置 | `package.json` | TypeScript 类型检查配置 |

## 权限清单

| 权限 | 类型 | 用途 |
|------|------|------|
| `cookies` | 必需 | 读取浏览器 Cookie 用于技术检测 |
| `storage` | 必需 | 保存设置与检测缓存 |
| `tabs` | 必需 | 管理标签页、读取 URL |
| `webRequest` | 必需 | 监听网络请求（headers/scripts/xhr） |
| `http://*/*` `https://*/*` | Host | Content Script 在所有页面运行 |
| `downloads` | 可选 | CSV 数据导出 |

## 分析版本

| 日期 | 版本 | 工作流 | 备注 |
|------|------|--------|------|
| 2026-07-06 | 6.12.3 | dsv4 | 首次逆向还原 |
