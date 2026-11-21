# FeHelper dsv4 — 反向工程文档

> **反向工程版本**：dsv4 | **原始版本**：v2026.7.3 | **原始作者**：nicetool.net  
> **原始仓库**：[github.com/zxlie/FeHelper](https://github.com/zxlie/FeHelper)  
> **原始官网**：[fehelper.com](https://fehelper.com/)  
> **原扩展 ID**：`pkgccpejnmalmdinmhkkfafefagiiiad`

---

## 项目概述

本仓库是对 FeHelper（前端助手）Chrome 扩展 v2026.7.3 的完整反向工程分析。FeHelper 是一个包含 **30+** 开发者工具的 Chrome 扩展，涵盖 JSON 格式化、编解码、二维码生成、代码美化、API 调试、密码生成、正则测试等日常开发高频场景。

本反向工程的目标：理解其架构设计、模块通信方式、安全边界和数据流，为插件开发研究提供参考。

---

## 目录结构

```
fehelper-dsv4/
├── package.json                  # TypeScript 项目配置
├── README.md                     # 本文件 — 工具全景总览
├── README.archive.md             # 归档说明
├── dist/                         # 原始源码完整副本（263 个文件）
│   ├── manifest.json             # MV3 清单
│   ├── background/               # Service Worker (9 个模块)
│   ├── popup/                    # 弹窗页面 (Lite/Omni)
│   ├── options/                  # 设置控制台
│   ├── dynamic/                  # 沙箱与运行时可执行页
│   ├── static/                   # 全局资源（CSS/JS/图片/第三方库）
│   ├── aiagent/                  # AI 智能助手
│   ├── json-format/              # -> 以下是 31 个独立工具目录
│   ├── en-decode/
│   ├── qr-code/
│   └── ... (其他 28 个工具)
└── src/
    ├── types/index.ts            # 完整 TypeScript 类型定义
    └── docs/
        ├── ARCHITECTURE.md       # 架构文档
        ├── DATA_FLOW.md          # 数据流文档（含 Mermaid 图）
        └── SECURITY_AUDIT.md     # 安全审计文档
```

---

## 全部工具一览（34 个）

### 开发工具类

| # | 工具名称 | 目录 | 功能描述 | 页面注入 |
|---|---------|------|---------|---------|
| 1 | JSON 格式化 | `json-format/` | 页面自动检测/格式化/排序/解码/BigInt精度/编辑/下载/主题 | 是（系统内置） |
| 2 | JSON Diff | `json-diff/` | 文本/JSON 结构化对比，支持代码/日志/Markdown 按行对比 | 否 |
| 3 | 代码美化 | `code-beautify/` | JavaScript/CSS/HTML/XML/SQL 多语言代码格式化 | 是 |
| 4 | 代码压缩 | `code-compress/` | HTML/JavaScript/CSS 代码压缩 | 否 |
| 5 | 简易 Postman | `postman/` | GET/POST/HEAD 接口调试，JSON 自动格式化 | 否 |
| 6 | WebSocket | `websocket/` | WebSocket 连接测试、消息发送、结果分析 | 否 |
| 7 | 正则速查 | `regexp/` | JS/Python/PHP/Java 正则速查和测试 | 否 |
| 8 | 网站性能优化 | `page-timing/` | Core Web Vitals (LCP/FID/CLS)、资源加载、内存、长任务分析 | 是 |

### 编解码转换类

| # | 工具名称 | 目录 | 功能描述 |
|---|---------|------|---------|
| 9 | 信息编解码 | `en-decode/` | 24 种编解码：Unicode/URL/UTF16/Base64/MD5/Hex/SHA1/Gzip/HTML实体/JWT/Cookie/Proto Hex |
| 10 | 进制转换 | `trans-radix/` | 2~36 进制任意互转 |
| 11 | 时间戳转换 | `timestamp/` | 时间<>时间戳互转，秒/毫秒，世界时区，各时区时钟 |
| 12 | 颜色转换 | `trans-color/` | HEX 与 RGB 格式互转 |
| 13 | 时间戳计算器 | `datetime-calc/` | 多格式时间解析、批量转换、时区转换、数据库格式生成 |
| 14 | 存储单位转换 | `byte-unit/` | B/KB/MB/GB/TB 双向换算 |

### 图像处理类

| # | 工具名称 | 目录 | 功能描述 |
|---|---------|------|---------|
| 15 | 二维码工具 | `qr-code/` | 自定义颜色/Icon 二维码生成，条形码，截图解码 | 是 |
| 16 | 图片/Base64 | `image-base64/` | 链接/截图/文件粘贴转 Base64，Base64 逆转图片 |
| 17 | SVG 转图片 | `svg-converter/` | SVG 转 PNG/JPG/WEBP，自定义尺寸，文件拖放和 URL 导入 |
| 18 | 图表制作 | `chart-maker/` | 柱状图/折线图/饼图等，可导出图片 |
| 19 | 海报生成 | `poster-maker/` | 朋友圈/小红书等营销模板，自定义文字/图片/配色 |
| 20 | 网页截屏 | `screenshot/` | 可视区域/全网页滚动截屏，预览后保存 | 是 |
| 21 | 页面取色 | `color-picker/` | 网页元素色值采集，单击取色 | 是 |

### 效率工具类

| # | 工具名称 | 目录 | 功能描述 |
|---|---------|------|---------|
| 22 | AI 智能助手 | `aiagent/` | Chrome Built-in AI (Gemini Nano) 对话，代码生成/分析/方案设计 |
| 23 | 便签笔记 | `sticky-notes/` | 分类管理、自动保存、批量导入导出 |
| 24 | Markdown 转换 | `html2markdown/` | HTML 转 Markdown，Markdown 编辑预览，PDF 导出 |
| 25 | 网页油猴 | `page-monkey/` | @include/@exclude/@require/@match，GM_* API 兼容 | 是 |

### 计算工具类

| # | 工具名称 | 目录 | 功能描述 |
|---|---------|------|---------|
| 26 | Crontab | `crontab/` | Crontab 表达式生成，分时日月周高亮 |
| 27 | 贷/还利率 | `loan-rate/` | 贷款/还款计算，按月呈现还款计划，反向推算利率 |
| 28 | 随机密码 | `password/` | 数字/大小写字母/特殊符号组合，指定长度 |
| 29 | UUID/ID 生成 | `uuid-gen/` | UUID v4、雪花 ID (Twitter Snowflake)、NanoID，雪花 ID 解析 |

### 其他工具

| # | 工具名称 | 目录 | 功能描述 |
|---|---------|------|---------|
| 30 | 数据 Mock | `mock-data/` | 个人信息/商业数据/技术数据等模板快速生成 |
| 31 | 思维导图 | `naotu/` | 轻量思维导图，自动保存、导入导出、图片下载 |
| 32 | 栅格标尺 | `grid-ruler/` | 横竖尺子 10px 单位，检测网页栅格对齐率 | 是 |
| 33 | Excel 转 JSON | `excel2json/` | Excel/CSV 转 JSON/XML/MySQL/PHP |
| 34 | FH 开发者工具 | `devtools/` | 第三方工具托管平台，支持用户自开发插件集成 | 是 |

---

## 技术架构要点

### Manifest V3

- Service Worker（非持久 Background Page）
- `type: "module"` ES 模块系统
- `sandbox.pages` 隔离第三方开发工具
- `chrome.scripting.executeScript` 替代 `tabs.executeScript`
- `chrome.storage.session` 轻量会话存储

### 通信模式

```
Content Scripts ←→ Service Worker ←→ 工具页面 / Popup / Options
                         ↕
                    Sandbox 沙箱
```

消息类型体系（`static/js/common.js` → `MSG_TYPE`）：
- `open-dynamic-tool` — 打开工具页面
- `dynamic-tool-install-or-offload` — 工具安装/卸载
- `fh-dynamic-any-thing` — 多功能操作总线（截图/美化/设置/统计/热修复等 20+ 操作）

### 存储设计

- **chrome.storage.local** — 工具安装状态、用户设置、油猴脚本、统计数据
- **chrome.storage.session** — 工具间内容传递（如 JSON 原文）
- **localStorage** — 油猴 GM_* 值、夜间模式状态

### UI 框架

- Vue.js 2.x（无构建步骤，script 标签直接加载）
- 双模式设计：**Lite**（极简，高频使用）和 **Omni**（完整，适合深度用户）

---

## 关键文件速查

| 文件 | 作用 |
|------|------|
| `manifest.json` | MV3 扩展声明 |
| `background/background.js` | Service Worker 入口，消息总线 |
| `background/awesome.js` | 工具安装/卸载/存储管理 |
| `background/tools.js` | 34 个工具元数据注册表 |
| `background/menu.js` | 右键菜单管理 |
| `background/monkey.js` | 油猴脚本运行时 |
| `background/inject-tools.js` | 内容脚本注入引擎 |
| `popup/index.js` | 弹窗逻辑（Vue.js） |
| `options/index.js` | 设置控制台逻辑（Vue.js） |
| `dynamic/sandbox.js` | 沙箱页 postMessage 处理 |
| `dynamic/runtime.js` | 第三方工具运行时 |
| `static/js/common.js` | MSG_TYPE 消息类型枚举 |
| `aiagent/fh.ai.js` | AI 核心（Gemini Nano） |

---

## 许可声明

原始 FeHelper 扩展版权归 nicetool.net 所有。本仓库为技术研究和学习目的的反向工程分析，包含：

- **文档**：架构分析、数据流、安全审计（原创分析）
- **类型定义**：TypeScript 接口定义（基于运行时行为推断）
- **源码副本**：`dist/` 目录中的文件为原始扩展的未经修改副本

`package.json` 中 `"license": "UNLICENSED"` 表示本反向工程仓库不授予任何原始代码的再分发许可。
