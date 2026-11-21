# uBlock Origin Lite v2026.628.2035 — 逆向工程 (dsv4)

> **逆向日期:** 2026-07-06 | **模型:** DeepSeek V4 Pro  
> **版本:** 2026.628.2035 | **Manifest V3**

## 版本概述

uBlock Origin Lite (uBOL) 是经典内容拦截器 uBlock Origin 的 MV3 合规版本。它完全依赖 Chrome 的 `declarativeNetRequest` (DNR) API 实现网络请求过滤, 通过 `scripting` API 动态注入内容脚本完成 cosmetic 过滤, 利用 `userScripts` API 实现 scriptlet 注入。与 MV2 版本相比, uBOL 在功能上做了妥协 (无法使用 `webRequest` 阻塞), 但通过精妙的分层架构弥补了大部分差距。

## 产出物

| 文件 | 说明 |
|------|------|
| `dist/` | 完整可加载扩展 (从 CRX 解包) |
| `src/types/index.ts` | TypeScript 类型定义 — 消息接口、配置结构、存储 schema |
| `src/docs/ARCHITECTURE.md` | 架构文档 — 分层架构图、52 个模块职责表、技术决策、权限分析 |
| `src/docs/DATA_FLOW.md` | 数据流文档 — 7 个 Mermaid 序列图/流程图, 覆盖所有核心流程 |
| `src/docs/SECURITY_AUDIT.md` | 安全审计 — 9 维度评估, 重点关注 DNR 规则和 userScripts 权限 |
| `package.json` | 项目配置 (TypeScript + @types/chrome) |
| `tsconfig.json` | TypeScript 编译配置 |

## 关键发现

### 技术架构

- **无打包器:** 100% 原生 ES Module, Chrome MV3 service worker 原生支持静态 import
- **Hub-and-spoke:** Service Worker (`background.js`) 是中心枢纽, 80+ 消息类型通过 `request.what` 路由
- **动态内容脚本注册:** 不使用 manifest.json 的 `content_scripts`, 而是通过 `scripting.registerContentScripts()` 在运行时根据过滤模式动态注册
- **Offscreen Document:** 用于过滤器编译 (需要 DOM API, Service Worker 无 DOM)

### 过滤模式

4 级过滤 (none / basic / optimal / complete), 按 hostname 精细控制:
- **Basic:** 无需 host 权限, 仅 DNR 网络拦截
- **Optimal:** 需要特定站点 host 权限, DNR + 特定 cosmetic 过滤
- **Complete:** 需要 `<all_urls>` 权限, DNR + 通用 cosmetic 过滤

### 安全评估: 🟢 低风险

- 无数据外传、无遥测、无 PII 收集
- 无 `eval()` / `new Function()` 动态执行
- 消息来源验证 (origin check)
- Trusted scriptlet 机制限制高权限脚本
- GPL-3.0 开源, 知名作者 (Raymond Hill)

### 关键数字

| 指标 | 值 |
|------|:--:|
| JS 模块数 | 80+ (SW 20 + 内容脚本 14 + scriptlet 30+ + offscreen 10) |
| DNR 静态规则集 | 60+ (6 个默认启用) |
| 支持的 UI 页面 | 7 (popup, dashboard, matched-rules, report, strictblock, picker, zapper) |
| 本地化语言 | 80+ |
| 代码库大小 | ~800KB JS + ~3MB rulesets JSON |
| 第三方库 | 5 (CodeMirror, CSS Tree, Regex Analyzer, S14E, Punycode) |

## 加载方式

1. 打开 `chrome://extensions/`
2. 启用 "开发者模式"
3. 点击 "加载已解压的扩展程序"
4. 选择 `dist/` 目录

## 构建方式

```bash
# 类型检查
npm run check

# 编译类型声明
npm run build
```

## 原始来源

- GitHub: https://github.com/gorhill/uBlock
- Chrome Web Store: uBlock Origin Lite
