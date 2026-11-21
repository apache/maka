# crxMouse Chrome Gestures v7.0.5 — 逆向工程分析 (dsv4)

> 逆向工程交付物 | 2026-07-06

---

## 项目概要

本项目是对 **crxMouse Chrome Gestures** Chrome 浏览器扩展 v7.0.5 版本的完整逆向工程分析。

**原始扩展**：crxMouse Chrome Gestures (作者: WeKnowNet)，是一款 Chrome 鼠标手势扩展，提供鼠标手势、超级拖拽、滚轮手势、摇杆手势、自定义光标等功能。

---

## 交付物

```
crxmouse-dsv4/
├── README.md                      # 本文件
├── package.json                   # 项目配置
├── tsconfig.json                  # TypeScript 配置
├── dist/                          # 原始扩展源码副本 (403 文件)
│   ├── manifest.json              # MV3 清单
│   ├── service_worker.js          # Service Worker (274KB)
│   ├── content.js                 # 主内容脚本 (82KB)
│   ├── contentStart.js            # 模块系统引导 (1.8KB)
│   ├── contentEnd.js              # JSON 引擎 + 反馈管道 (32KB)
│   ├── 130.js / 946.js            # Webpack chunk
│   ├── js/                        # 辅助脚本 (13 文件)
│   ├── css/                       # 样式 (4 文件)
│   ├── image/                     # 图像资源 (含 68 个光标主题目录)
│   ├── _locales/                  # 14 个语言包
│   └── ...
└── src/
    ├── types/
    │   └── index.ts               # TypeScript 类型定义
    └── docs/
        ├── ARCHITECTURE.md         # 架构文档 (中文)
        ├── DATA_FLOW.md            # 数据流文档 (中文, 含 Mermaid 图)
        └── SECURITY_AUDIT.md       # 安全审计报告 (中文)
```

---

## 关键发现

### 架构亮点

1. **5 个 Content Script 注入点** — 在不同阶段 (`document_start`/`document_end`) 和范围 (`*://*/*`/`<all_urls>`/含 `about:blank`) 注入 5 个独立脚本，是同类扩展中最复杂的注入策略。

2. **自定义模块系统 (MpiUO)** — `contentStart.js` 实现了一个轻量级的模块注册和依赖解析系统，支持异步初始化和指数退避重试。

3. **JSON 表达式引擎** — `contentEnd.js` 包含一个完整的 JSON 驱动的条件判断和 DOM 操作引擎 (jfq 模块)，支持服务端下发规则。

4. **VAST 广告检测** — 扩展内建 VAST XML 解析器，可检测网页中的视频广告并提取广告数据。

5. **双设计系统** — 同时维护 Classic 和 Redesign 两套 UI，通过 `designOrchestrator.js` 动态切换。

### 安全关注点

- **权限极高**: `webRequest` + `clipboardRead`/`clipboardWrite` + `bookmarks` + `<all_urls>` 组合，是 Chrome 扩展最高权限组合之一。
- **数据采集广泛**: Privacy Policy 声明采集浏览域名、广告内容、以及 "AI 请求和响应（含附件和图片）"，并分享给关联公司用于市场情报。
- **代码深度混淆**: 使用 `proconstantinator_key` 动态字符串替换、短变量名混淆、core-js polyfill 内联增加逆向难度。
- 详见 `src/docs/SECURITY_AUDIT.md`

---

## 使用方法

```bash
# 安装依赖 (仅 TypeScript 类型检查)
cd crxmouse-dsv4
npm install

# 类型检查
npm run check

# 构建类型声明
npm run build
```

---

## 许可证

本项目仅用于安全研究和教育目的。原始扩展版权归 WeKnowNet 所有。
