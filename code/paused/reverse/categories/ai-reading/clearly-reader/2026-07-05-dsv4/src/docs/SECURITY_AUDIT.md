# Clearly Reader 安全审计文档

## 审计范围

- **目标**: Clearly Reader v4.7.0 Chrome 扩展
- **源码来源**: rspack 打包产物 + source maps (部分)
- **审计方法**: 静态分析 (manifest.json + bundle 代码 + 消息流)
- **日期**: 2026-07-06

---

## 一、权限分析

```json
"permissions": [
  "activeTab",      // 获取当前活动标签页信息
  "storage",         // 读写 chrome.storage.local
  "contextMenus",    // 创建右键菜单
  "commands"         // 注册键盘快捷键
],
"host_permissions": [
  "http://*/*",      // 所有 HTTP 页面
  "https://*/*"      // 所有 HTTPS 页面
]
```

### 风险评估

| 权限 | 风险等级 | 说明 |
|------|---------|------|
| `activeTab` | 低 | 仅在用户点击扩展时生效，不会持续监控 |
| `storage` | 低-中 | 可存储敏感数据(令牌)；数据未加密存储在本地 |
| `contextMenus` | 低 | 仅用于提供便捷操作入口 |
| `commands` | 低 | 仅注册 Alt+R 和 Alt+S 两个快捷键 |
| `http://*/*` | **高** | 可访问所有 HTTP 明文页面，存在中间人攻击风险 |
| `https://*/*` | 中-高 | 可访问所有 HTTPS 页面，可读取任意网页内容 |

### 权限膨胀问题

`web_accessible_resources` 配置为通配符 `["*"]`，意味着扩展的**所有文件**都可以被网页直接引用：

```json
"web_accessible_resources": [
  {
    "resources": ["*"],
    "matches": ["<all_urls>"]
  }
]
```

**风险**: 恶意网页可通过 `chrome.runtime.getURL()` 探测扩展内部文件，可能导致：
- 扩展指纹识别 (确定已安装的扩展)
- 资源探测与枚举
- 潜在的 XSS 攻击面扩大

**建议**: 仅暴露必需的文件 (如 iframe 加载所需的 HTML/JS/CSS)，使用精确的文件路径列表。

---

## 二、Content Script 安全分析

### 2.1 页面内容访问

Content Script 在 `document_end` 阶段注入所有 HTTP/HTTPS 页面 (`"run_at": "document_end"`)，拥有以下能力：

- **完整 DOM 访问**: 可读取页面所有内容、表单数据、Cookie (非 httpOnly)
- **页面内容提取**: 解析并提取文章正文、标题、图片 URL
- **DOM 操作**: 注入 iframe、高亮标记、修改页面样式

**风险**:
- 可能在用户不知情的情况下读取敏感页面内容 (银行、邮件、企业内部系统)
- 收集的数据通过 Message Bus 传递给 Service Worker，可能进一步发送到外部 API

### 2.2 iframe 注入

```css
/* content.css */
.clearly-enabled > :not(#clearly-root):not(#clearly-skim-root) ... {
  display: none !important;
}
```

iframes 使用 `z-index: 2147483647` 覆盖页面：

- `#clearly-container` (阅读器主界面): 占满全屏
- `#clearly-skim-frame` (速览面板): 右上角浮动

**风险**: 如果 iframe 内容来源被劫持或存在 XSS，攻击者可能展示钓鱼内容覆盖原页面。

### 2.3 消息通信安全

Content Script 使用 `window.postMessage` 与 iframe 通信，使用 `chrome.runtime.sendMessage` 与 Service Worker 通信。

**风险**:
- `postMessage` 不验证消息来源 (`event.origin`)，任意页面可以发送伪造消息给 Content Script
- 消息类型 (如 `clearly:background:update-settings`) 可能被恶意网页利用

**建议**: 对所有 `postMessage` 事件进行 `event.origin` 验证，拒绝来自非预期来源的消息。

---

## 三、API 通信安全

### 3.1 外部 API 端点

| API | URL | 协议 | 数据内容 |
|-----|-----|------|---------|
| Clearly Reader API | `https://api.clearlyreader.com` | HTTPS | 用户数据、文章内容、AI 请求 |
| Google Translate | `https://translate.googleapis.com/translate_a/single` | HTTPS | 翻译文本片段 |
| 卸载回调 | `https://clearlyreader.com/r/uninstall?v=` | HTTPS | 版本信息(仅卸载时) |
| 开发环境 | `https://api.clearly.localhost` | HTTPS | 开发测试用 |

### 3.2 认证与令牌管理

扩展使用 JWT 令牌进行 API 认证：

- **访问令牌 (token)**: 短期有效的 JWT，用于 API 请求认证
- **刷新令牌 (refreshToken)**: 长期有效的令牌，用于获取新的访问令牌
- **存储位置**: `chrome.storage.local` (本地明文存储)
- **令牌刷新**: Service Worker 定时检查过期时间并自动刷新

**风险**:
- 令牌存储在 `chrome.storage.local` 中，**未加密**
- 其他具有 `storage` 权限的扩展可以读取这些令牌
- 本地恶意软件可以访问 Chrome 的存储文件
- 令牌通过 `chrome.runtime.sendMessage` 传递，可能被其他具有调试权限的扩展拦截

### 3.3 数据传输

- 翻译请求将用户选中的文本发送到 Google Translate API
- AI 功能 (摘要、助手) 将文章内容发送到 Clearly Reader API
- 反馈功能可能包含页面 URL 和截图

**风险**: 用户可能在不知情的情况下将敏感或机密内容发送到第三方服务器。

---

## 四、数据隐私

### 4.1 收集的数据类型

基于代码分析，扩展可能收集以下数据：

| 数据类型 | 用途 | 存储位置 | 是否发送到外部 |
|---------|------|---------|--------------|
| 页面内容 (文章正文) | 阅读器渲染 | 本地内存 | AI 摘要时发送 |
| 页面 URL | 自动打开匹配、历史 | chrome.storage.local | 不确定 |
| 用户设置 (主题/字体) | 偏好持久化 | chrome.storage.local | 否 |
| 认证令牌 | API 认证 | chrome.storage.local | 每次 API 请求 |
| 用户信息 (ID/邮箱/计划) | 账户管理 | chrome.storage.local | 认证时 |
| 翻译文本 | 翻译服务 | 本地内存 | 发送到 Google Translate |
| 使用统计 (skimUsedCount) | 功能使用计数 | chrome.storage.local | 不确定 |
| 反馈内容 | 用户反馈 | 无本地存储 | 发送到 Clearly Reader API |

### 4.2 隐私设置

扩展提供隐私设置 (`PrivacySettings`)，允许用户控制：
- `analyticsEnabled`: 是否发送匿名使用统计
- `historyEnabled`: 是否存储阅读历史
- `cacheEnabled`: 是否缓存文章内容

---

## 五、潜在漏洞与攻击面

### 5.1 高危

| 漏洞 | 描述 | 影响 |
|------|------|------|
| `web_accessible_resources: ["*"]` | 所有扩展文件可被网页访问 | 指纹识别、资源探测 |
| 令牌明文存储 | JWT 令牌无加密存储在 chrome.storage.local | 令牌泄露风险 |
| `postMessage` 无来源验证 | Content Script 不验证消息 origin | 消息伪造攻击 |

### 5.2 中危

| 漏洞 | 描述 | 影响 |
|------|------|------|
| `http://*/*` host 权限 | Content Script 注入 HTTP 明文页面 | 中间人可注入恶意内容到阅读器 |
| 文章内容发送到外部 API | AI 功能将页面全部正文发送到 clearlyreader.com | 敏感数据泄露 |
| 跨扩展存储访问 | 其他具有 storage 权限的扩展可读取令牌 | 令牌窃取 |
| 消息广播无限制 | chrome.runtime.sendMessage 响应未限制接收方 | 信息泄露 |

### 5.3 低危

| 漏洞 | 描述 | 影响 |
|------|------|------|
| 扩展图标枚举 | 多状态图标可被外部网页探测 | 安装检测 |
| iframe z-index 冲突 | 固定 z-index: 2147483647 | 与其他扩展的 UI 冲突 |
| 调试日志残留 | Logger 类默认开启，prefix 信息泄漏 | 信息泄露 |
| 版本号暴露 | 卸载 URL 包含版本参数 | 版本跟踪 |

---

## 六、安全加固建议

### 6.1 立即修复 (高优先级)

1. **收紧 `web_accessible_resources`**:
   ```json
   "web_accessible_resources": [{
     "resources": ["app.bundle.js", "skim.bundle.js", "content.css"],
     "matches": ["<all_urls>"]
   }]
   ```

2. **加密存储敏感数据**:
   - 使用 `chrome.storage.session` (内存存储) 存储令牌
   - 或使用 Web Crypto API 对令牌进行加密后再存储到 `chrome.storage.local`

3. **验证 postMessage 来源**:
   ```javascript
   window.addEventListener('message', (event) => {
     if (event.origin !== window.location.origin) return;
     // 处理消息
   });
   ```

### 6.2 短期改进 (中优先级)

4. **移除 `http://*/*` 权限**: 仅在明确需要 HTTP 明文页面的场景保留
5. **API 请求数据最小化**: AI 摘要仅发送文章摘要而非全文
6. **分离令牌存储**: 将 `token` 和 `refreshToken` 分开存储，使用不同的安全级别

### 6.3 长期改进 (低优先级)

7. **实现 Content Security Policy (CSP)**: 在 manifest 中声明严格的 CSP
8. **添加审计日志**: 记录所有 API 调用，供用户审查
9. **实现请求签名**: 对关键 API 请求进行 HMAC 签名，防止篡改
10. **定期令牌轮换**: 缩短令牌有效期，实现更频繁的自动刷新

---

## 七、依赖安全

### 已识别的第三方库

| 库 | 版本 | 来源 | 已知漏洞 |
|----|------|------|---------|
| `marked` (ESM) | 未知 | npm | 需确认版本后查询 CVE |
| `browser-or-node` | 未知 | npm | 工具库，风险较低 |
| React (JSX) | 未知 | 推断 | 需确认版本 |
| Remix Icon | 未知 | 本地文件 | 图标库，风险较低 |

**注意**: 由于是打包产物，无法直接确认各依赖的精确版本。建议从 source map 中提取 `node_modules` 路径信息来定位版本。

---

## 八、合规性考量

### 8.1 Chrome Web Store 政策

- 扩展收集的用户数据需要明确的隐私政策说明
- AI 功能将内容发送到第三方服务器的行为需要用户知情同意
- 卸载 URL (`https://clearlyreader.com/r/uninstall`) 收集卸载数据需符合数据最小化原则

### 8.2 GDPR/CCPA

- 翻译功能将用户文本发送到 Google Translate (Google 服务器)
- AI 功能将文章内容发送到 Clearly Reader API
- 扩展收集页面 URL 可能包含个人信息 (如 URL 参数中的 token)
- 需要向用户提供数据导出和删除机制

---

## 九、总结

Clearly Reader 作为一款浏览器扩展，其安全态势总体属于**中等风险**水平。主要风险点集中在：

1. **过宽的权限配置** (`web_accessible_resources: ["*"]` 和 `http://*/*`)
2. **敏感的令牌存储方式** (明文存储在 chrome.storage.local)
3. **不安全的跨上下文通信** (postMessage 无来源验证)
4. **AI 功能导致的数据外传** (文章全文发送到外部 API)

对于普通使用场景 (阅读公开网页文章)，风险可控。但不建议在包含敏感信息的页面 (企业内网、银行、医疗) 使用该扩展。
