# ChatLine v3.8.0 — 安全审计

**总体评分**: 7/10

## 关键发现

### 1. Google Drive OAuth2 (🟡 中)
- 硬编码的 OAuth Client ID: `945798922226-jve664u0ibs7lsji89kr8s7f9lsnilla.apps.googleusercontent.com`
- 使用 `identity` 权限进行 OAuth2 认证
- 数据存储在用户自己的 Google Drive `AITimeline_Backup` 文件夹

### 2. 代码沙箱 (🟡 中)
- 使用 Chrome Sandbox Pages 执行 JS/TS/SQL
- CSP 允许 `unsafe-eval` 和 `wasm-unsafe-eval`
- TypeScript 编译器加载自扩展包内

### 3. MAIN World 注入 (🟡 中)
- `fiber-bridge-chatgpt.js` 使用 `"world": "MAIN"` 
- 可直接访问 ChatGPT 的 React Fiber 内部状态
- 仅限 chatgpt.com 域名

### 4. 权限 (✅)
- `host_permissions` 已限定为 13 个 AI 平台
- `optional_permissions: identity` 需用户授权
- 无 `<all_urls>` 声明

### 5. 数据存储 (✅)
- `chrome.storage.local` + `chrome.storage.sync`
- 支持 Google Drive 云同步（用户主动触发）
- 所有数据本地优先
