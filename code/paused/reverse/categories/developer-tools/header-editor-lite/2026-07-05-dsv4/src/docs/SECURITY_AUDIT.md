# Header Editor Lite - 安全审计文档 (SECURITY_AUDIT.md)

## 审计范围

- 目标: Header Editor Lite v5.2.12 (Chrome Extension MV3)
- 审计日期: 2026-07-05
- 方法: 静态代码逆向分析
- 审计者: Claude (AI 辅助)

## 审计摘要

**总体风险评级: 中等**

该扩展具备全局 HTTP 流量拦截和修改能力，权限范围广泛。代码总体质量较好，但存在若干需要关注的潜在风险点。

## 权限分析

### 已声明的权限

| 权限 | 风险等级 | 分析 |
|------|----------|------|
| `*://*/*` (host_permissions) | **高** | 可访问所有 HTTP/HTTPS 流量，包括敏感站点 |
| `declarativeNetRequest` | **高** | 可拦截、重定向、修改所有 HTTP 请求和响应头 |
| `debugger` | **高** | 可访问 Chrome DevTools Protocol，读取和修改响应体 |
| `tabs` | 中 | 访问标签页信息 |
| `storage` | 中 | 存储规则和设置 |
| `unlimitedStorage` | 中 | 无限制的存储空间 |

### 权限合理性

- `declarativeNetRequest` + `debugger`: 扩展核心功能所必需，用于修改 HTTP 头部和响应体
- `*://*/*`: 功能需要作用于所有网站，但缺少细粒度的用户授权机制
- `unlimitedStorage`: 大量规则存储合理需要
- `tabs`: 创建新标签页打开帮助/反馈页面，跳转时使用

## 潜在安全问题

### 1. 自定义函数执行 (代码注入风险) -- 已禁用

**严重程度: 信息** (Lite 版本未启用)

在 Lite 版本中，`isFunction` 支持被禁用（UI 层面设 `disabled: true`），但在 `background.js` 中仍保留了自定义函数的执行逻辑：

```javascript
// background.js - response body modifier
if(t.isFunction){
    let e = t._func(a, {...n, browser:"chrome"});
    "string" == typeof e && (a = e)
}
```

如果此功能被意外启用或通过直接修改 IndexedDB 注入代码，攻击者可能执行任意 JavaScript。**当前风险很低，因为 Lite 版本的 UI 禁止了此功能，但代码路径仍然存在。**

**建议**:
- 在后台 `_func` 执行前增加守卫检查
- 考虑使用沙箱化执行环境
- 完整评估是否需要在 Lite 版本保留此代码路径

### 2. 规则导入缺乏输入验证

**严重程度: 中**

JSON 文件导入和 URL 下载规则的验证较薄弱：

```javascript
// options.js - handleImport
V.load(".json").then(e => {
    try {
        this.importRef.current.show(JSON.parse(e))
    } catch(e) {
        d.FN.error(e.message)
    }
})
```

```javascript
// options.js - handleDownload
let e = await (0, y.lC)({url: this.state.downloadUrl})
this.importRef.current.show(JSON.parse(e))
```

**风险**:
- 导入的 JSON 未做 schema 验证
- `condition.regex` 字段接受的任意正则表达式字符串可能导致 ReDoS
- URL 下载没有域名白名单限制
- 导入的规则 `to` (重定向目标) 字段可以是任意 URL (包括 `javascript:` 或 `data:`)

**建议**:
- 实现 JSON schema 验证
- 对正则表达式进行安全审计 (检测 ReDoS 模式)
- URL 下载增加来源验证或白名单
- 对重定向目标 URL 进行协议检查

### 3. chrome.debugger 权限使用

**严重程度: 中**

扩展使用 `chrome.debugger` API 和 CDP `Fetch` 域来修改响应体：

```javascript
// background.js - enableFetch
await rl.sendCommand({tabId: e}, "Fetch.enable", {
    patterns: [
        {urlPattern: "http://*", requestStage: this.stage},
        {urlPattern: "https://*", requestStage: this.stage}
    ]
})
```

- 调试器附加到所有标签页 (包括安全页面)
- `Fetch.fulfillRequest` 可以完全替换响应体，可能用于注入内容
- 用户可以看到 "Header Editor is debugging this tab" 的黄色警告条，但这可能被忽视

**建议**:
- 考虑对敏感域名 (银行、政府等) 提供排除选项
- 更好的用户通知机制

### 4. 存储中的数据未加密

**严重程度: 低**

规则数据存储在 IndexedDB 和 chrome.storage.sync 中，均为明文：

- 云备份同步到用户的所有 Chrome 实例
- 如果 Chrome 同步密码被攻破，攻击者可以读取所有规则
- 规则中的 header 值可能包含敏感信息 (如 API tokens、认证头)

**建议**:
- 文档中警告用户不要在规则中存储敏感凭证
- 考虑对 `Authorization`、`Cookie` 等敏感 header 的存储进行加密

### 5. 对 `chrome.google.com/webstore` 的硬编码排除

**严重程度: 低** (但有侧信道风险)

```javascript
// background.js - b() 函数: 检查 URL 是否应被处理
function b(e) {
    return !e || (
        0 === e.indexOf("http") ||
        0 === e.indexOf("file") ||
        0 === e.indexOf("ftp")
    ) && 0 !== e.indexOf("https://chrome.google.com/webstore")
}
```

扩展硬编码排除了 Chrome Web Store 的 URL。这是安全措施，防止恶意规则禁用扩展本身。但此逻辑不可配置，且只排除了 Web Store。攻击者如果能够向扩展注入规则，可以用它来阻止用户访问除 Web Store 外的任何安全站点。

**建议**:
- 增加更多内置的安全排除列表
- 允许用户自定义排除域名

### 6. 第三方规则下载

**严重程度: 低**

选项页面支持从任意 URL 下载规则 JSON：

```javascript
let e = await (0, y.lC)({url: this.state.downloadUrl})
```

- 使用 `fetch()` API
- 下载历史存储在 chrome.storage.local
- 没有 URL 白名单验证

**建议**:
- 添加"信任的来源"白名单
- 下载前显示规则预览，让用户确认

### 7. 消息传递安全性

**严重程度: 低**

扩展使用 `runtime.sendMessage` 进行 UI↔后台通信：

- 所有消息通过标准 Chrome API 传递，不涉及外部通信
- 没有暴露 `externally_connectable` 配置，外部网页无法发送消息
- `runtime.sendMessage` 仅对扩展内部页面开放

**评估**: 通过 Chrome 内部 API 的消息传递是安全的。无需额外措施。

## 安全优势

1. **MV3 架构**: 使用 Service Worker 而非持久后台页面，减少内存常驻攻击面
2. **内容安全策略**: 扩展页面使用 webpack 打包，默认不依赖外部脚本
3. **无外部连接**: 扩展未声明 `externally_connectable`，外部网页无法注入消息
4. **Web Store 硬编码保护**: 避免规则意外阻止扩展管理
5. **云备份分片大小限制**: 防止 sync storage 配额溢出

## 总体建议

| 优先级 | 建议 |
|--------|------|
| **高** | 实现 JSON 导入的完整 schema 验证 |
| **高** | 对正则表达式进行 ReDoS 检测 |
| **中** | 重定向目标 URL 协议检查 (禁止 javascript:、data:) |
| **中** | URL 下载域名白名单 |
| **中** | 敏感 header 值的存储加密 |
| **低** | 文档中说明安全最佳实践 |
| **低** | 考虑在 Lite 版本完全移除自定义函数代码路径 |
