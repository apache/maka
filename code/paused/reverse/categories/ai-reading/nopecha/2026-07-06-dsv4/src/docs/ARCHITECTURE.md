# NopeCHA: CAPTCHA Solver v0.6.1 — 架构文档

## 1. 概述

NopeCHA 是一款基于 AI 识别的 Chrome 扩展（MV3），自动解决网页中的各类 CAPTCHA 验证。支持的 CAPTCHA 类型包括 reCAPTCHA v2/v3、hCAPTCHA、Funcaptcha (Arkose Labs)、Cloudflare Turnstile、AWS WAF Captcha、GeeTest、LeminCAPTCHA、PerimeterX 和 TextCaptcha。

### 技术栈

| 层次 | 技术选型 |
|------|---------|
| 打包工具 | Rspack (推断，基于 hashed chunk 命名和输出结构) |
| 运行时 | Chrome Extension MV3 (Service Worker) |
| 验证库 | Valibot (自定义打包副本，专为 Chrome 扩展裁剪) |
| UI 框架 | 原生 DOM 操作 + CSS Variables 主题系统 |
| CDP 模拟 | Chrome DevTools Protocol (Input.dispatchMouseEvent) |
| 网络层 | fetch API + XMLHttpRequest 拦截 + declarativeNetRequest |

---

## 2. 系统分层架构

```
┌──────────────────────────────────────────────────────┐
│                    Popup UI                          │
│  svndki.html + 43vsof.js + 43vsof.css               │
│  设置面板 / 状态 / 日志 / CAPTCHA 状态               │
├──────────────────────────────────────────────────────┤
│              Background Service Worker               │
│  bklhy9.js (125KB, 主逻辑核心)                       │
│  ┌──────────┬───────────┬──────────┬─────────────┐  │
│  │ API 通信 │ 设置管理  │ CDP 鼠标 │ 可观测性    │  │
│  │ 模块     │ (Valibot) │ 模拟引擎 │ 上报        │  │
│  ├──────────┼───────────┼──────────┼─────────────┤  │
│  │ Job 追踪 │ DNR 规则  │ Badge 状态│ 消息路由    │  │
│  └──────────┴───────────┴──────────┴─────────────┘  │
├──────────────────────────────────────────────────────┤
│               Content Scripts                        │
│  ┌──────────────┬──────────────┬──────────────────┐  │
│  │ vk3s1y.js    │ kathhh.js    │ t9kg5l.js        │  │
│  │ hCAPTCHA     │ reCAPTCHA    │ Funcaptcha       │  │
│  │ 131KB        │ 100KB        │ 58KB             │  │
│  ├──────────────┼──────────────┼──────────────────┤  │
│  │ x2ra3j.js    │ 9jm743.js    │ qfsud0.js        │  │
│  │ Turnstile    │ 通用主脚本   │ Element Locator  │  │
│  │ 47KB         │ 132KB        │ 27KB             │  │
│  └──────────────┴──────────────┴──────────────────┘  │
│  ┌──────────────┬──────────────┬──────────────────┐  │
│  │ t7658k.js    │ f58zgw.js    │ ga1w1f.js        │  │
│  │ hCaptcha     │ Settings     │ Installed        │  │
│  │ Hook (MAIN)  │ Setup Page   │ Detection        │  │
│  │ 3KB          │ 4KB          │ <1KB             │  │
│  ├──────────────┼──────────────┼──────────────────┤  │
│  │ 0fe7xa.js    │              │                  │  │
│  │ Funcaptcha   │              │                  │  │
│  │ Demo Page    │              │                  │  │
│  │ 15KB         │              │                  │  │
│  └──────────────┴──────────────┴──────────────────┘  │
├──────────────────────────────────────────────────────┤
│              外部 API                                │
│  api.nopecha.com                                    │
│  ├── /v1/status (GET)   — 账户/额度查询              │
│  ├── /v1/recognition (POST) — CAPTCHA 识别请求       │
│  └── /v1/observability (POST) — 遥测数据上报         │
└──────────────────────────────────────────────────────┘
```

---

## 3. 核心模块职责

### 3.1 Service Worker (bklhy9.js, ~125KB)

**是整个扩展的中枢大脑**，所有决策逻辑集中于此。

| 子模块 | 职责 |
|--------|------|
| **API 通信** (`ApiEndpoints`) | 向 api.nopecha.com 发送状态查询/识别请求，处理 rate limit 和 transient error |
| **设置管理** (`getSettings`) | 从 chrome.storage.local 加载设置，Valibot 验证，版本迁移 (_version 字段) |
| **鼠标模拟引擎** | 基于 5 种人类行为 Profile (measured-arc, brisk-direct, careful-settle, hesitant-search, broad-sweep)，通过 CDP 模拟逼真的鼠标移动/点击路径 |
| **Job 追踪** (`CaptchaJob`) | 维护所有活跃 CAPTCHA 任务的 Map，追踪 phase 转换、成功率和交互链 |
| **DNR 规则** | 通过 declarativeNetRequest 注入语言参数 (hl=en, lang=en) 到 CAPTCHA iframe URL，强制英文界面以便 AI 识别 |
| **Badge 状态** | 工具栏图标 badge 文字+颜色映射：可用额度/活跃/过期/错误 |
| **可观测性** (`observability` scheduler) | 定期向 /v1/observability 上报扩展运行数据（432 分钟间隔，首次延迟 2-3 分钟） |
| **消息路由** | 处理来自 Content Script 和 Popup 的 runtime.sendMessage / runtime.connect 消息 |

### 3.2 Content Scripts

| 文件 | 匹配 URL | run_at | 职责 |
|------|---------|--------|------|
| `vk3s1y.js` (131KB) | `*.hcaptcha.com/captcha/*` | document_start | hCAPTCHA 自动解决：监听 iframe 加载、提取图片 base64、发送到 SW 识别、填写 token |
| `kathhh.js` (100KB) | `*.google.com/recaptcha/*`, `*.recaptcha.net/recaptcha/*` | document_start | reCAPTCHA v2/v3 自动解决：劫持 grecaptcha API、自动点击、token 注入 |
| `t9kg5l.js` (58KB) | `*.arkoselabs.com/fc/*`, `*.funcaptcha.com/fc/*` | document_end | Funcaptcha 自动解决 |
| `x2ra3j.js` (47KB) | `challenges.cloudflare.com/cdn-cgi/challenge-platform/*` | document_start | Cloudflare Turnstile 自动解决 |
| `9jm743.js` (132KB) | `<all_urls>` | document_end | **通用主脚本**：注入到所有页面，建立与 SW 的 Channel Messaging，协调 CAPTCHA 检测和交互 |
| `0fe7xa.js` (15KB) | `nopecha.com/demo/funcaptcha` | document_end | Funcaptcha 演示页面脚本 |
| `ga1w1f.js` (<1KB) | `nopecha.com/*` | document_end | 注入 `installed` 属性到 nopecha.com DOM |
| `f58zgw.js` (4KB) | `nopecha.com/setup` | document_end | 设置导入页面：解析 URL hash 参数并写入 chrome.storage |
| `t7658k.js` (3KB) | hCaptcha challenge frame | MAIN world | **hCaptcha 响应解密**：在主世界拦截 XHR 到 getcaptcha，解码二进制响应为 JSON |
| `qfsud0.js` (27KB) | 动态注入 (all_frames) | ISOLATED | **元素定位工具**：可视化高亮页面元素，生成 CSS Selector（用于 TextCaptcha 配置） |

### 3.3 Popup UI (43vsof.js + 43vsof.css, ~84KB)

- 原生 DOM 组件系统，基于 CSS Variables 暗色主题
- 功能页面：Sitekey 状态、设置面板、Debug 面板、日志查看器
- 设置支持：API Key、开关各类型 CAPTCHA、鼠标速度/输入方式/Hook 方法选择、延迟时间（毫秒）、禁用站点列表
- Pro 计划进度条、额度/配额显示

### 3.4 hCaptcha 响应解密 (t7658k.js)

这是一个关键模块，运行在 **MAIN world**（绕过内容脚本隔离）：
- 拦截 `XMLHttpRequest` 到 `*/hcaptcha.com/*/getcaptcha`
- 将 `Accept` 头从 `application/octet-stream` 改为 `application/json`
- 解码 hCaptcha 的自定义二进制响应格式为 JSON
- 通过 `window.postMessage` 将明文传回 ISOLATED world 的内容脚本

---

## 4. 权限分析

| 权限 | 用途 | 风险等级 |
|------|------|---------|
| `scripting` | 动态注入元素定位脚本 (qfsud0.js) | 中 |
| `storage` | 保存用户设置、可观测性调度状态 | 低 |
| `debugger` | CDP 鼠标模拟 (Input.dispatchMouseEvent) | **高** |
| `declarativeNetRequest` | DNR 规则注入语言参数 | 中 |
| `host_permissions: <all_urls>` | 在所有页面注入 9jm743.js + 访问 CAPTCHA iframe | **高** |

---

## 5. 关键技术决策

1. **CDP 鼠标模拟**而非 JavaScript 事件合成：提供更难以被检测的人类行为模拟（带震颤、微调、暂停、路径弯曲）
2. **Valibot 内联**而非 npm 依赖：针对 Chrome 扩展裁剪，不依赖 Node.js/Symbol/TypedArray
3. **MAIN world 注入**用于 hCaptcha 解密：突破内容脚本隔离获取二进制响应
4. **DNR 语言注入**：不修改 DOM 即可统一 CAPTCHA 语言为英文，降低 AI 识别复杂度
5. **5 种鼠标行为 Profile**：随机轮换 + 种子确定性模拟，平衡不可预测性和一致性
6. **Stream/Broadcast 通信通道**：使用 `chrome.runtime.connect` 长连接而非一次性 sendMessage，支持实时状态推送

---

## 6. 模块依赖图

```
Popup (43vsof.js)
  │
  ├─ chrome.runtime.connect("popup-stream") ──┐
  │                                            │
  └─ chrome.runtime.sendMessage ─────────────┐ │
                                              ▼ ▼
                                    Background SW (bklhy9.js)
                                      │
                                      ├─ chrome.runtime.onConnect("stream")
                                      │    ◄── Content Scripts (9jm743.js etc.)
                                      │
                                      ├─ chrome.runtime.onConnect("broadcast")
                                      │    ◄── Element Locator (qfsud0.js)
                                      │
                                      ├─ chrome.tabs.sendMessage
                                      │    ◄── Per-CAPTCHA solvers
                                      │
                                      ├─ fetch("api.nopecha.com")
                                      │    External API
                                      │
                                      └─ chrome.debugger (CDP)
                                           Mouse Simulation
```
