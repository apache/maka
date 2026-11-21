# NopeCHA: CAPTCHA Solver

**分类**: AI 与阅读 (ai-reading)
**Chrome Web Store**: [NopeCHA: CAPTCHA Solver](https://chromewebstore.google.com/detail/nopecha-captcha-solver)
**最新版本**: v0.6.1
**Manifest 版本**: MV3

## 功能概述

NopeCHA 是一款基于 AI 识别的 Chrome 扩展，自动解决网页中的各类 CAPTCHA 验证。

### 支持的 CAPTCHA 类型

| 类型 | 提供商 | 自动化方式 |
|------|--------|-----------|
| reCAPTCHA v2/v3 | Google | 图片网格识别 + 自动点击 |
| hCAPTCHA | Intuition Machines | 图片分类识别 + 响应解密 |
| Funcaptcha | Arkose Labs | 图片方向识别 |
| Turnstile | Cloudflare | 自动 checkbox + 视觉挑战 |
| AWS WAF Captcha | Amazon | 图片验证 |
| GeeTest | GeeTest | 滑块/点选 |
| LeminCAPTCHA | Lemin | 旋转/点选 |
| PerimeterX | HUMAN | 行为分析验证 |
| TextCaptcha | 自定义 | CSS 选择器 + OCR |

### 核心技术

- **AI 视觉识别**：将 CAPTCHA 图片发送至远程 API 进行识别
- **人类行为模拟**：通过 Chrome DevTools Protocol (CDP) 实现 5 种鼠标移动行为 Profile
- **hCaptcha 解密**：在 MAIN world 拦截和解码加密响应

## 技术架构

| 层次 | 技术 |
|------|------|
| 打包 | Rspack |
| 验证 | Valibot (内联) |
| UI | 原生 DOM + CSS Variables 暗色主题 |
| 鼠标模拟 | CDP Input.dispatchMouseEvent + 贝塞尔曲线路径 |
| 网络 | fetch + XHR 拦截 + declarativeNetRequest |
| 通信 | runtime.sendMessage / runtime.connect (stream/broadcast) |

## 权限

| 权限 | 用途 |
|------|------|
| `scripting` | 动态注入元素定位工具 |
| `storage` | 保存用户设置 |
| `debugger` | CDP 鼠标模拟 |
| `declarativeNetRequest` | HTTP 参数注入 (语言设置) |
| `host_permissions: <all_urls>` | 全站内容脚本注入 |

## 安全评级

**安全等级: C** (中高风险)

主要风险：
- `debugger` + `<all_urls>` 权限组合可完全控制浏览器
- CAPTCHA 图片上传至第三方 API 可能含网站 UI 截图
- API Key 明文存储在 `chrome.storage.local`
- `world:"MAIN"` 脚本存在 postMessage 伪造风险

## 逆向分析版本

| 日期 | 版本 | 模型 | 目录 |
|------|------|------|------|
| 2026-07-06 | v0.6.1 | dsv4 (DeepSeek V4 Pro) | [2026-07-06-dsv4](./2026-07-06-dsv4/) |

---

*本目录包含对 NopeCHA 扩展的逆向工程分析产出。原始扩展版权归 NopeCHA 开发团队所有。*
