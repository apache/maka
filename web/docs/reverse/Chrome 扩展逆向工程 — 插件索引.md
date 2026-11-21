# Chrome 扩展逆向工程 — 插件索引

本仓库对 Chrome Web Store 上的热门扩展进行系统化逆向工程，产出可运行的还原项目及完整分析文档。

**当前收录**：48 个扩展 | **最新批次**：2026-07-06 dsv4 | **模型**：DeepSeek V4 Pro

---

## 目录结构

```
reverse/
├── README.md                  ← 目录 SSOT 总索引
├── CLAUDE.md                  ← Agent 会话入口
├── docs/                      ← 方法论与批次索引（本文件在此）
│   └── Chrome扩展逆向工程指南.md ← 方法论与工作流程
├── categories/                ← 按用途分类的插件
│   ├── developer-tools/       ← 开发者工具 (16)
│   ├── browser-enhancement/   ← 浏览器增强 (12)
│   ├── ai-reading/            ← AI 与阅读 (12)
│   ├── site-specific/         ← 网站特定 (5)
│   └── download-integration/  ← 下载集成 (3)
├── crx-archive/               ← 原始 CRX 文件存档（按日期）
└── cases/                     ← 深度逆向案例（2026-02-* 批次、cursor-byok）
```

每个插件的内部结构：

```
categories/{分类}/{插件名}/
├── README.md                      ← 插件通用介绍（版本无关）
└── {YYYY-MM-DD}-{模型}/            ← 按日期 + AI 模型嵌套
    ├── dist/                      ← 可加载的 Chrome 扩展
    ├── src/types/index.ts         ← TypeScript 类型定义
    ├── src/docs/ARCHITECTURE.md   ← 架构文档
    ├── src/docs/DATA_FLOW.md      ← 数据流文档（Mermaid）
    ├── src/docs/SECURITY_AUDIT.md ← 安全审计报告
    ├── package.json
    └── README.md                  ← 该版本的逆向说明
```

---

## 插件总览

### 🛠 开发者工具 (16)

| 插件 | 版本 | 批次 | 简介 | 安全 |
|------|------|------|------|:----:|
| [ADB](categories/developer-tools/adb/) | 0.9.8 | 2026-07-06 | Android Chrome 远程调试引导（已废弃），~130 行 | 🟢 |
| [Automa](categories/developer-tools/automa/) | 1.30.01 | 2026-07-06 | 浏览器自动化工作流，Vue 3.4 + Webpack 5 | 🔴 |
| [Octotree](categories/developer-tools/octotree/) | 8.3.0 | 2026-07-06 | GitHub 代码树侧边栏，jQuery + jsTree | 🟡 |
| [Proxy SwitchyOmega](categories/developer-tools/proxy-switchyomega/) | 3.0.5 | 2026-07-06 | 代理切换管理，AngularJS 1.x + OmegaPac 引擎 | 🔴 |
| [React Context DevTool](categories/developer-tools/react-context-devtool/) | 4.4 | 2026-07-06 | React Context/useReducer 调试，Webpack + CodeMirror | 🟡 |
| [React Developer Tools](categories/developer-tools/react-developer-tools/) | 7.0.1 | 2026-07-06 | React 组件树调试，Webpack 5 + 4 层通信架构 | 🟡 |
| [Redux DevTools](categories/developer-tools/redux-devtools/) | 3.2.10 | 2026-07-06 | Redux 状态调试，React 18 + jsan 序列化 | 🟡 |
| [Tampermonkey](categories/developer-tools/tampermonkey/) | 5.5.0 | 2026-07-06 | 用户脚本管理器，Vault 沙箱 + 五层通信 | 🔴 |
| [VisBug](categories/developer-tools/visbug/) | 0.4.10 | 2026-07-06 | 开源浏览器设计工具，`<vis-bug>` 自定义元素 | 🟢 |
| [Wappalyzer](categories/developer-tools/wappalyzer/) | 6.12.3 | 2026-07-06 | 网站技术栈识别，8500+ 指纹规则 | 🟡 |
| [JSON Viewer Pro](categories/developer-tools/json-viewer-pro/) | 1.0.6 | 2026-07-05 | JSON 格式化/树形查看，React + CodeMirror 6 | 🟢 |
| [FeHelper](categories/developer-tools/fehelper/) | 2026.7.3 | 2026-07-05 | 30+ 开发者工具箱 | 🟡 |
| [WebInk](categories/developer-tools/webink/) | 0.5.1 | 2026-07-04 | 网页转 Markdown + Monaco + Mermaid | 🟢 |
| [CSS Peeper](categories/developer-tools/css-peeper/) | 1.2.2 | 2026-07-05 | CSS 样式检查，Plasmo 框架 | 🟡 |
| [Get CRX](categories/developer-tools/get-crx/) | 1.51 | 2026-07-05 | 下载任意 Chrome 扩展 CRX（64 行） | 🟢 |
| [Header Editor Lite](categories/developer-tools/header-editor-lite/) | 5.2.12 | 2026-07-05 | HTTP 请求头/响应体修改 | 🟢 |

### 🔧 浏览器增强 (12)

| 插件 | 版本 | 批次 | 简介 | 安全 |
|------|------|------|------|:----:|
| [OneTab](categories/browser-enhancement/onetab/) | 2.18 | 2026-07-06 | 标签页一键收纳入列表，62 语言 + 自研 virtual-DOM | 🟡 |
| [Shortkeys](categories/browser-enhancement/shortkeys/) | 5.0.1 | 2026-07-06 | 自定义键盘快捷键，Vite + Mousetrap.js | 🔴 |
| [SimpleUndoClose](categories/browser-enhancement/simpleundoclose/) | 3.0.1 | 2026-07-06 | 撤销关闭标签页，纯 Vanilla JS 零依赖 | 🟢 |
| [Tab Session Manager](categories/browser-enhancement/tab-session-manager/) | 7.3.0 | 2026-07-06 | 标签页会话保存/恢复，React 16 + Google Drive | 🟡 |
| [uBlock Origin Lite](categories/browser-enhancement/ublock-origin-lite/) | 2026.628.2035 | 2026-07-06 | 轻量内容拦截器，原生 ES Module 无打包 | 🟢 |
| [复制链接到剪贴板](categories/browser-enhancement/copy-link-to-clipboard/) | 15.1.3 | 2026-07-06 | 16 种链接格式复制，30+ ES Module 零打包 | 🟢 |
| [网页万能复制](categories/browser-enhancement/universal-copy/) | 1.0.28 | 2026-07-06 | 解除网页复制限制，四层破解策略 | 🔴 |
| [crxMouse](categories/browser-enhancement/crxmouse/) | 7.0.5 | 2026-07-05 | 鼠标手势/超级拖拽，400+ 文件 | 🔴 |
| [iTab](categories/browser-enhancement/itab/) | 2.1.17 | 2026-07-04 | 组件化卡片桌面新标签页，Vue 3 | 🟢 |
| [ContextSearch web-ext](categories/browser-enhancement/contextsearch-web-ext/) | 1.48.4 | 2026-07-05 | 右键多引擎搜索/QuickMenu | 🟢 |
| [Chrome Font Super Enhancer](categories/browser-enhancement/chrome-font-super-enhancer/) | 2.25 | 2026-07-05 | 字体渲染增强（text-shadow） | 🟢 |
| [EditThisCookie V3](categories/browser-enhancement/editthiscookie-v3/) | 3.0.5 | 2026-07-05 | Cookie 编辑器，32 语言 | 🟡 |

### 🤖 AI 与阅读 (12)

| 插件 | 版本 | 批次 | 简介 | 安全 |
|------|------|------|------|:----:|
| [MarkDownload](categories/ai-reading/markdownload/) | 3.4.0 | 2026-07-06 | 网页转 Markdown 下载，Readability + Turndown + GFM | 🟢 |
| [Multi Highlight](categories/ai-reading/multi-highlight/) | 2.11.1 | 2026-07-06 | 高效在线高亮标注，原生 JS 零依赖零外传 | 🟢 |
| [NopeCHA](categories/ai-reading/nopecha/) | 0.6.1 | 2026-07-06 | AI CAPTCHA 自动求解，CDP 鼠标模拟 | 🔴 |
| [i微信读书](categories/ai-reading/weread-helper/) | 0.9.22 | 2026-07-06 | 微信读书增强，划线导出到 Flomo/Notion/飞书 | 🔴 |
| [陪读蛙](categories/ai-reading/read-frog/) | 1.37.2 | 2026-07-06 | 翻译与学习助手，WXT + React 18 + 20+ LLM | 🟡 |
| [ChatLine](categories/ai-reading/chatline/) | 3.8.0 | 2026-07-04 | 13+ AI 平台增强（时间线/导出/代码执行） | 🟡 |
| [Chat Memo](categories/ai-reading/chatmemo/) | 1.3.3 | 2026-07-04 | AI 聊天记录自动保存（8 平台 Adapter） | 🟢 |
| [Degrade Checker](categories/ai-reading/degradechecker/) | 2.4.6 | 2026-07-04 | ChatGPT 模型降级检测 | 🟢 |
| [Clearly Reader](categories/ai-reading/clearly-reader/) | 4.7.0 | 2026-07-05 | AI 阅读助手（摘要/翻译/语音） | 🟡 |
| [Codex](categories/ai-reading/codex/) | 1.1.5 | 2026-07-05 | OpenAI Codex CLI 浏览器控制 | 🔴 |
| [Lumno](categories/ai-reading/lumno/) | 0.9.14 | 2026-07-05 | 聚焦搜索新标签页 + 覆盖层搜索 | 🟢 |
| [YouMind](categories/ai-reading/youmind/) | 0.3.0.33 | 2026-07-04 | AI 网页剪藏/YouTube 笔记/思维导图 | 🟢 |

### 🎯 网站特定 (5)

| 插件 | 版本 | 批次 | 简介 | 安全 |
|------|------|------|------|:----:|
| [CubeSeller](categories/site-specific/cubeseller/) | 11.1.5 | 2026-07-06 | 65+ 电商平台商品图片视频下载，Vue 3 | 🔴 |
| [yuque-helper](categories/site-specific/yuque-helper/) | 1.6.0 | 2026-07-06 | 语雀网页转存助手，Vue 2 + Element UI | 🟡 |
| [BewlyBewly](categories/site-specific/bewlybewly/) | 0.41.2 | 2026-07-05 | Bilibili 主页重设计，Vue 3 SPA | 🟢 |
| [Material Icons for GitHub](categories/site-specific/material-icons-for-github/) | 1.16.2 | 2026-07-05 | Git 平台 Material Design 文件图标 | 🟢 |
| [X-Track](categories/site-specific/xtrack/) | 1.3.1 | 2026-07-04 | Twitter/X 浏览追踪与书签 | 🟢 |

### 📥 下载集成 (3)

| 插件 | 版本 | 批次 | 简介 | 安全 |
|------|------|------|------|:----:|
| [NeatDownloadManager](categories/download-integration/neatdownloadmanager/) | 1.9.92 | 2026-07-06 | 下载链接发送到 Neat Download Manager，裸 WebSocket | 🔴 |
| [IDM Integration Module](categories/download-integration/idm-integration-module/) | 6.43.1 | 2026-07-05 | IDM 桌面软件浏览器集成 (ROT13) | 🟡 |
| [飞书转存专家](categories/download-integration/feishu/) | 0.7.27 | 2026-07-04 | 飞书文档多格式导出 (PDF/Word/MD) | 🟢 |

---

## 安全风险一览

| 等级 | 数量 | 插件 |
|:----:|:----:|------|
| 🔴 高 | 11 | crxMouse, Codex, Tampermonkey, Proxy SwitchyOmega, Automa, Shortkeys, NopeCHA, i微信读书, CubeSeller, NeatDownloadManager, 网页万能复制 |
| 🟡 中 | 15 | FeHelper, CSS Peeper, EditThisCookie, Clearly Reader, IDM, ChatLine, Octotree, React Context DevTool, React Developer Tools, Redux DevTools, Wappalyzer, OneTab, Tab Session Manager, 陪读蛙, yuque-helper |
| 🟢 低 | 22 | 其余全部 |

---

## 技术栈分布

| 类别 | 插件 |
|------|------|
| **原生 JS / 无框架** | Get CRX, Chrome Font, EditThisCookie, ContextSearch, IDM, Lumno, FeHelper, Material Icons, ChatLine, ChatMemo, DegradeChecker, ADB, VisBug, SimpleUndoClose, Multi Highlight, uBlock Origin Lite, 复制链接到剪贴板, Wappalyzer, MarkDownload |
| **React** | JSON Viewer Pro, Header Editor Lite, Clearly Reader, Tab Session Manager, 陪读蛙 |
| **Vue 2** | yuque-helper |
| **Vue 3** | BewlyBewly, iTab, Automa, CubeSeller |
| **AngularJS 1.x** | Proxy SwitchyOmega |
| **Plasmo** | CSS Peeper, WebInk |
| **Webpack** | Tampermonkey, Header Editor Lite, crxMouse, Automa, Octotree, Redux DevTools, React Context DevTool, React Developer Tools, yuque-helper, i微信读书 |
| **Vite/Rollup/WXT** | Codex, BewlyBewly, X-Track, iTab, 陪读蛙, Shortkeys |
| **rspack** | Clearly Reader, NopeCHA（推断） |
| **Parcel** | CSS Peeper, WebInk |
| **WXT** | 陪读蛙 |

---

## 批次历史

| 批次 | 日期 | 模型 | 数量 | 说明 |
|------|------|------|:----:|------|
| 2026-07-06-dsv4 | 2026-07-06 | DeepSeek V4 Pro | 25 | 全并行 agent 策略，26 CRX 一次性提取逆向 |
| 2026-07-05-dsv4 | 2026-07-05 | DeepSeek V4 Pro | 15 | 规模化批量逆向，统一三段式文档 |
| 2026-07-04-dsv4 | 2026-07-04 | DeepSeek V4 Pro | 8 | 早期项目重做（WebInk/X-Track/飞书等升级版） |
| 2026-02 | 2026-02 | 多种 | 8 | 首批逆向项目原始分析 |

---

## 快速使用

```bash
# 查看某个插件
cd categories/{分类}/{插件名}/{YYYY-MM-DD}-dsv4/

# 在 Chrome 加载
# chrome://extensions/ → 开发者模式 → 加载已解压的扩展程序 → 选择 dist/

# TypeScript 类型检查
npm install && npx tsc --noEmit
```

---

## 相关资源

- [Chrome 扩展逆向工程指南](Chrome扩展逆向工程指南.md) — 完整方法论（CRX提取→代码分析→类型重建→安全审计）
- [逆向工程案例库](逆向工程案例库.md) — 早期项目实战对比、打包工具特征识别、核心库检测方法
- [AI辅助逆向工程Skills指南](AI辅助逆向工程Skills指南.md) — ReVa Skills 介绍与 Chrome 扩展场景映射
- [原始 CRX 文件存档](temp/) — 按日期存放
- 每个插件的 `src/docs/` 目录包含：架构文档、数据流图、安全审计

---

*最后更新: 2026-07-06 — 48 个插件，5 个分类*
