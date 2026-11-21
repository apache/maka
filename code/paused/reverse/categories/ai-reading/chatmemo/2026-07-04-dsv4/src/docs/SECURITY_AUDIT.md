# Chat Memo v1.3.3 — 安全审计

**审计日期**: 2026-07-04
**审计对象**: Chat Memo v1.3.3 (Chat-Memo)
**总体评分**: 7/10

---

## 安全检查清单

| 检查项 | 风险等级 | 结果 | 详情 |
|--------|----------|------|------|
| 数据外传 | 🟡 中 | ⚠️ 有分析上报 | 匿名统计发至 Cloudflare Worker |
| 敏感信息泄露 | 🟢 低 | ✅ 无 | 未发现 token/password 硬编码 |
| 第三方域名 | 🟡 中 | ⚠️ 2 个外部域名 | 官方更新 + 分析端点 |
| 代码注入 | 🟢 低 | ✅ 无 | 未使用 eval/innerHTML 风险模式 |
| 权限过度 | 🔴 高 | ❌ 过度 | `<all_urls>` 权限过大 |
| 隐私追踪 | 🟡 中 | ⚠️ 匿名统计 | 有 UUID + 事件追踪 |

---

## 详细发现

### 1. 权限过度 (🔴 高)

**manifest.json**:
```json
{
  "host_permissions": ["<all_urls>"],
  "permissions": ["storage", "unlimitedStorage", "tabs", "downloads", "alarms"]
}
```

**问题**:
- `host_permissions: ["<all_urls>"]` 允许访问所有网站
- `tabs` 权限可读取所有标签页 URL
- 实际只需 8 个 AI 平台的 host_permissions

**建议**: 将 `host_permissions` 限定为具体平台域名：
```json
"host_permissions": [
  "https://chatgpt.com/*",
  "https://claude.ai/*",
  "https://chat.deepseek.com/*",
  ...
]
```

### 2. 匿名统计 (🟡 中)

**端点**: `https://chatmemo-analytics.kylis.workers.dev`
**发送数据**: UUID、事件类型、平台、消息数、字符数、版本号
**去重**: 支持客户端去重 (`_dedupKey`)
**发送策略**: 1 分钟防抖批量上报

**评估**: 数据不包含聊天内容，仅含使用统计。风险较低但用户不知情。

### 3. 数据存储安全 (✅)

- ✅ 所有聊天数据仅存 IndexedDB（本地）
- ✅ 导出文件仅本地生成，不经过服务器
- ✅ `unlimitedStorage` 防止浏览器自动清理

### 4. 代码安全 (✅)

- ✅ 无 `eval()` 或 `Function()` 动态执行
- ✅ 无 `innerHTML` 直接插入用户内容
- ✅ 使用 `importScripts` 加载 JSZip（信任本地副本）

### 5. 更新检查 (🟡 低)

**首次安装**: 打开 `https://chatmemo.ai/welcome`
**版本更新**: 打开 `https://chatmemo.ai/updates`
**评估**: 打开官方页面属于正常行为，风险低。

---

## 建议

1. **限制 host_permissions**：仅声明 8 个 AI 平台域名
2. **添加隐私声明**：在 popup 中告知用户分析数据收集
3. **提供 opt-out**：允许用户关闭匿名统计
4. **添加 CSP**：manifest 中声明 Content Security Policy
