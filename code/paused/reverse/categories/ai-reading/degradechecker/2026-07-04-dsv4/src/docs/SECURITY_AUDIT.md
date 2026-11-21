# ChatGPT Degrade Checker v2.4.6 — 安全审计

**审计日期**: 2026-07-04
**总体评分**: 5/10

---

## 主要发现

### 1. 页面上下文注入 (🟡 中)

`fetch_script.js` 被注入到 chatgpt.com 的页面上下文中，可以：
- 拦截所有 fetch/XHR 请求
- 读取 API 响应内容（包括模型名、账号信息）
- 修改全局 window 对象

**风险**: 若 chatgpt.com 存在 XSS，注入脚本可被利用。

### 2. localStorage 存储 (🟢 低)

数据仅存储在 `localStorage` 中，不经过网络。但也不受 `unlimitedStorage` 保护。

### 3. 外部链接 (🟡 中)

- `upchatgpt.cn` — GPT 升级指南（推广链接）
- `ponskey.com` — 聊天导入预览（第三方服务）

### 4. 无数据外传 (✅)

未发现向后端发送用户数据的行为。所有统计仅本地存储。

### 5. 无 CSP 声明 (🟡 中)

manifest.json 未声明 `content_security_policy`。
