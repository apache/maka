# Proxy SwitchyOmega (V3) v3.0.5 — 逆向工程说明 (dsv4)

## 版本信息

| 属性 | 值 |
|---|---|
| **扩展名称** | Proxy SwitchyOmega (V3) |
| **版本号** | 3.0.5 |
| **Manifest 版本** | 3 |
| **逆向日期** | 2026-07-06 |
| **工作流** | dsv4 |
| **源代码仓库** | <https://github.com/mrfanii/SwitchyOmega-V3> |
| **Chrome Web Store ID** | `padekgcemlokbadohgkifijomclgjgif` |
| **最低 Chrome 版本** | 111 |

## 功能概述

Proxy SwitchyOmega (V3) 是一款 Chrome 浏览器代理管理和自动切换扩展。它是经典 SwitchyOmega 的 Manifest V3 迁移版本, 支持:

- 多种代理类型: HTTP / HTTPS / SOCKS4 / SOCKS5 / PAC 脚本
- 基于 URL 规则的自动代理切换 (通配符/正则/IP/时间段/星期)
- 快速切换面板 (Popup)
- 完整的配置导入/导出
- 代理认证支持 (包括 SOCKS5 auth)
- 在线规则列表和 PAC 脚本自动更新
- 条件切换支持 (HostWildcard / UrlRegex / Keyword / Weekday / Time / IP)
- 配置跨设备同步 (通过 chrome.storage.sync)
- 外部扩展 API (允许其他扩展远程控制)

## 技术架构

- **UI 框架**: AngularJS 1.x + UI-Router + UI-Bootstrap
- **后台**: Service Worker (ES Module), 通过消息通信
- **代理引擎**: 自研 OmegaPac (PAC 生成 + 条件匹配 + 配置管理)
- **存储**: chrome.storage.local (主配置) + localStorage (状态) + chrome.storage.sync (跨设备)
- **打包方式**: 原始 (非 Webpack/Parcel/Vite), 使用 $script.js 异步加载
- **代码可读性**: 核心业务逻辑 minified (omega_pac.min.js, omega_target.min.js), UI 代码未压缩可读

## 项目结构

```
2026-07-06-dsv4/
├── dist/                          # 可加载的扩展目录 (source-code 完整复制, 297 files)
├── src/
│   ├── types/
│   │   └── index.ts               # TypeScript 类型定义 (Core types)
│   └── docs/
│       ├── ARCHITECTURE.md        # 架构文档 (含 Mermaid 分层图)
│       ├── DATA_FLOW.md           # 数据流文档 (含 Mermaid 序列图)
│       └── SECURITY_AUDIT.md      # 安全审计 (9 维度)
├── package.json
└── README.md                      # 本文件
```

## 安全审计摘要

详见 `src/docs/SECURITY_AUDIT.md`。

关键发现:
- **高风险 1**: 分析追踪 (`page_statistics.js`) 自动上报用户浏览 URL 到 `analytics.editcookie.com`, 用户不知情且无 opt-out
- **高风险 2**: 代理用户名/密码以明文 JSON 存储于 `chrome.storage.local`
- **中风险**: ExternalApi 无调用者认证、AngularJS 1.x EOL、日志中可能含敏感信息

## 关键文件说明

| 文件 | 用途 |
|---|---|
| `x-background.js` | Service Worker ES Module 入口 (import 链) |
| `js/background.js` | 核心业务逻辑编排 (消息路由/代理决策/图标更新) |
| `js/omega_pac.min.js` | PAC 脚本生成 + 配置匹配 + 规则解析引擎 |
| `js/omega_target.min.js` | 平台无关核心 (Promise/Storage/Options/PAC) |
| `js/omega_target_chromium_extension.min.js` | Chrome 平台适配 (proxy/webRequest/badge) |
| `js/omega.js` | AngularJS UI 控制器和过滤器 |
| `js/options.js` | 选项页面脚本加载器 |
| `page_statistics.js` | 页面访问统计上报 (隐私关注点) |
| `content_scripts.js` | 页面 URL 变更监听 |
| `idb-keyval.js` | IndexedDB 键值存储 |
| `localstorage-polyfill.js` | Service Worker localStorage polyfill |

## 关于 dsv4 工作流

dsv4 是 Chrome 扩展逆向工程标准工作流, 包含 6 个阶段: CRX 提取 -> Manifest 分析 -> 类型定义 -> 文档生成 (三段式) -> 打包 -> README。每个 dsv4 项目产出完整的可运行 `dist/`、TypeScript 类型定义和三份技术文档。

## 许可证

原始扩展许可证: GPL-3.0 (见 dist/COPYING)
逆向产物: UNLICENSED (仅供学习研究)
