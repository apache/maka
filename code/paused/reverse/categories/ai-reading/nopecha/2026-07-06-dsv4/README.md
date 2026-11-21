# NopeCHA: CAPTCHA Solver v0.6.1 — dsv4 逆向工程

**逆向日期**: 2026-07-06
**模型**: DeepSeek V4 Pro (dsv4)
**原始版本**: v0.6.1 (MV3)

## 概述

NopeCHA 是一款基于 AI 识别的 Chrome 扩展，用于自动解决网页中的各类 CAPTCHA 验证。支持 reCAPTCHA v2/v3、hCAPTCHA、Funcaptcha (Arkose Labs)、Cloudflare Turnstile、AWS WAF Captcha、GeeTest、LeminCAPTCHA、PerimeterX 和 TextCaptcha 共 9 种 CAPTCHA 类型。

核心机制：
- **AI 识别**：将 CAPTCHA 图片发送至 api.nopecha.com 的识别服务
- **人类行为模拟**：通过 Chrome DevTools Protocol (CDP) 模拟逼真的鼠标移动轨迹（5 种行为 Profile）
- **hCaptcha 解密**：在 MAIN world 拦截加密的 XHR 响应并解码

## 产出清单

| 文件 | 用途 |
|------|------|
| `dist/` | 可加载 Chrome 扩展 (原始 CRX 解压副本) |
| `src/types/index.ts` | TypeScript 类型定义 (从混淆 JS 推断) |
| `src/docs/ARCHITECTURE.md` | 架构文档：分层图 / 模块职责 / 技术决策 |
| `src/docs/DATA_FLOW.md` | 数据流文档：Mermaid 序列图 (8 条流程) |
| `src/docs/SECURITY_AUDIT.md` | 安全审计报告：9 维度评估 (含 8 项发现) |
| `package.json` | TypeScript + @types/chrome 开发依赖 |

## 技术要点

- **打包工具**: Rspack (推断，hashed chunk 命名)
- **验证库**: Valibot (内联裁剪版)
- **UI**: 原生 DOM + CSS Variables 暗色主题
- **通信**: Chrome runtime.sendMessage + runtime.connect (stream/broadcast)
- **网络**: fetch API + XMLHttpRequest 拦截 + declarativeNetRequest

## 权限与安全

| 权限 | 用途 | 风险 |
|------|------|------|
| `debugger` | CDP 鼠标模拟 | **严重** |
| `host_permissions: <all_urls>` | 全站内容脚本注入 | **高** |
| `scripting` | 动态注入定位工具 | **高** |
| `declarativeNetRequest` | HTTP 参数注入 | **中** |
| `storage` | 用户设置 | **低** |

详见 `src/docs/SECURITY_AUDIT.md` 完整安全审计报告。

## 代码统计

| 指标 | 数值 |
|------|------|
| JS 文件数 | 12 |
| 总 JS 体积 | ~725KB |
| 最大模块 | vk3s1y.js (hCaptcha, 131KB) + 9jm743.js (通用主脚本, 132KB) |
| 代码可读性 | 打包且混淆 (变量名缩短), 可通过函数调用模式推断逻辑 |
