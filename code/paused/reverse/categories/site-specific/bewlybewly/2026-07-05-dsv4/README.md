# BewlyBewly — 逆向工程档案 (dsv4)

> **源扩展**: BewlyBewly v0.41.2 — Bilibili 首页重设计 Chrome 扩展
> **源仓库**: [hakadao/BewlyBewly](https://github.com/hakadao/BewlyBewly)
> **逆向日期**: 2026-07-05
> **逆向产物**: 本仓库
> **构建工具**: Vite + Vue 3.4.27 (生产构建, 无 source map)

---

## 项目结构

```
bewlybewly-dsv4/
├── dist/                          # 原始构建产物 (从 CRX 提取)
│   ├── manifest.json              # MV3 清单文件
│   ├── background/index.js        # Service Worker (API 代理层)
│   ├── contentScripts/
│   │   ├── index.global.js        # Vue 3 应用 (约 7MB, minified)
│   │   └── style.css              # 全局 CSS (约 430KB)
│   ├── inject/index.js            # MAIN world 注入脚本
│   ├── popup/index.html           # 扩展弹窗
│   ├── options/index.html         # 设置页面
│   └── assets/                    # 静态资源 (字体、图标、CSS chunks)
├── src/
│   ├── types/index.ts             # 逆向提取的类型定义
│   └── docs/
│       ├── ARCHITECTURE.md        # 架构文档
│       ├── DATA_FLOW.md           # 数据流文档 (含 Mermaid 图)
│       └── SECURITY_AUDIT.md      # 安全审计报告
├── package.json                   # TypeScript 项目配置
└── README.md                      # 本文件
```

## 技术栈

| 组件 | 版本 | 用途 |
|------|------|------|
| Vue 3 | 3.4.27 | UI 框架 (runtime + compiler) |
| vue-i18n | 9.13.1 | 国际化 |
| qrcode.vue | 3.4.1 | 登录二维码 |
| webextension-polyfill | 0.12.0 | 跨浏览器兼容 |
| Vite | — | 构建工具 (已剥离) |

## 核心发现

1. **三层架构**: Background Worker (API 代理) + Content Script ISOLATED world (Vue UI) + MAIN world inject (History hook)
2. **API 代理模式**: Background 接收 content script 的 `contentScriptQuery` 消息，查表后转发到 Bilibili API，避免 content script 直接跨域请求
3. **SPA 路由检测**: 通过重写 `window.history` 方法 + `CustomEvent('historyChange')` 跨 world 通信
4. **请求头伪装**: `declarativeNetRequest` 修改 Origin/Referer 为 `www.bilibili.com`，绕过 API CORS 校验
5. **CSS 设计系统**: 基于 CSS Custom Properties 的完整 Design Token 体系，支持明暗主题和 glassmorphism 效果

## 文档索引

- [架构文档](./src/docs/ARCHITECTURE.md) — 模块分解、权限分析、安全边界
- [数据流文档](./src/docs/DATA_FLOW.md) — 含 Mermaid 时序图和流程图
- [安全审计报告](./src/docs/SECURITY_AUDIT.md) — 权限、CSP、威胁模型、改进建议
- [类型定义](./src/types/index.ts) — Bilibili API 数据结构 TypeScript 类型

## 权限清单

| 权限 | 用途 |
|------|------|
| `storage` | 用户配置持久化 |
| `declarativeNetRequest` | 修改 API 请求头 (Origin/Referer) |
| `*://*.bilibili.com/*` | 页面注入 + API 代理 |
| `*://*.hdslb.com/*` | 同上 (备用域名) |

## 注意事项

- 本仓库仅包含**逆向工程分析产物** (类型定义、文档、原始构建产物), 不包含可运行的源码
- JS 文件均为 Vite 生产构建的 **minified** 产物, 无 source map, 不可直接阅读
- 类型定义基于 manifest 声明、API 映射表和运行时行为反推, 可能与原始源码有差异
- 安全审计基于静态分析, 未经动态验证
