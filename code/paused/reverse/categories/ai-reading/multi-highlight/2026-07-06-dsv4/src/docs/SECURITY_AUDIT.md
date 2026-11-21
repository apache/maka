# Multi Highlight 安全审计文档

## 审计范围

- **目标**: Multi Highlight v2.11.1 Chrome 扩展
- **源码来源**: 原生 JavaScript 源代码（无打包/无混淆）
- **审计方法**: 静态代码分析 (manifest.json + 全部 4 个 JS 源文件 + jQuery 插件)
- **日期**: 2026-07-06

---

## 一、权限分析

```json
"permissions": [
  "activeTab",      // 获取当前活动标签页信息
  "storage",         // 读写 chrome.storage.local
  "contextMenus",    // 创建右键菜单
  "scripting"        // 动态注入脚本 (getPagesSource.js)
],
"host_permissions": [
  "https://*/*",     // 所有 HTTPS 页面
  "http://*/*"       // 所有 HTTP 页面
]
```

### 风险评估

| 权限 | 风险等级 | 说明 |
|------|---------|------|
| `activeTab` | 低 | 仅在用户点击扩展图标时激活，不会持续监控 |
| `storage` | 低 | 仅存储关键词列表和设置，无敏感数据 |
| `contextMenus` | 低 | 仅注册"添加/移除关键词"两个菜单项 |
| `scripting` | 低 | 仅注入 getPagesSource.js 获取页面可见文本 |
| `http://*/*` | 中 | 可访问 HTTP 明文页面，存在中间人注入风险 |
| `https://*/*` | 中 | 可访问所有 HTTPS 页面，可读取任意网页 DOM |

### 最小权限原则检查

| 权限 | 是否必要 | 意见 |
|------|---------|------|
| `activeTab` | 是 | 获取当前标签页 ID 和基本信息 |
| `storage` | 是 | 持久化设置和关键词列表 |
| `contextMenus` | 是 | 右键添/删关键词功能 |
| `scripting` | 是 | 关键词可用性检查需要注入脚本 |
| `http://*/*` | 可选 | 大部分现代网站使用 HTTPS；如不需要在 HTTP 页面使用，可移除 |
| `https://*/*` | 是 | 核心功能需要，但建议考虑收缩到用户主动激活 |

**结论**: 权限声明总体合理，无过度声明。`http://*/*` 建议评估是否必要。

---

## 二、Content Script 安全分析

### 2.1 页面内容访问

Content Script (`content-action.js`) 在 `document_end` 阶段注入所有 HTTP/HTTPS 页面以及 `file://*/*` 本地文件：

```json
"content_scripts": [{
  "matches": ["<all_urls>", "file://*/*"],
  "js": ["jquery/jquery.js", "jquery/jquery.highlight.js", "content-action.js"],
  "css": ["highlight.css"],
  "run_at": "document_end"
}]
```

**风险点**:

1. **完整 DOM 访问**: Content Script 可读取页面所有文本内容（用于 MutationObserver 监控和高亮匹配）
2. **DOM 修改**: 对匹配关键词注入 `<span>` 元素，修改 DOM 结构
3. **file:// 协议访问**: 扩展到本地 HTML 文件的能力，可能读取本地敏感文件内容

**影响评估**: 数据仅用于本地高亮，不发送到外部。但 `file://*/*` 匹配可能读取本地文件系统中的敏感内容。

**建议**: 考虑移除 `file://*/*` 匹配，或使用 `activeTab` 权限并通过 `chrome.scripting` 按需注入。

### 2.2 jQuery 注入

Content Script 注入了完整 jQuery 库 (~87KB) 到每个页面：

- jQuery 会向页面的 `window` 对象添加 `$` 和 `jQuery` 全局变量
- 可能与页面自身的 jQuery 版本冲突
- 使用 `noConflict()` 模式可以减少冲突风险

**当前风险**: 低。常见行为，但可能影响页面正常功能。

### 2.3 MutationObserver 性能影响

Content Script 的 MutationObserver 监听所有 `document.body` 下的 `childList`、`subtree` 和 `characterData` 变化。在高频 DOM 更新的页面（如实时协作编辑器、股票行情页面），可能造成：

- 频繁的完整 DOM 遍历（`hl_refresh` 重建所有高亮）
- jQuery 选择器在高亮 DOM 上重复执行
- 性能下降

**缓解措施**（已实现）: 高亮操作期间 `observer.disconnect()` 断开监听，完成后重新连接，避免递归触发。

---

## 三、数据存储安全

### 3.1 存储内容审查

扩展仅使用 `chrome.storage.local` 存储以下数据：

| 存储 Key | 数据类型 | 敏感度 |
|----------|---------|--------|
| `settings` | 搜索设置、颜色配置、关键词列表 | 低 - 用户偏好 |
| `popupConfig` | Popup 窗口尺寸 | 低 - UI 配置 |
| `multi-highlight_{tabId}` | 标签页关键词列表 | 低 - 用户输入的关键词 |

### 3.2 无敏感数据

经过完整代码审计，确认扩展**不收集、不存储、不传输**以下任一类敏感数据：

- 无用户身份信息（无账号系统）
- 无认证令牌（无 API 调用）
- 无浏览历史记录
- 无页面 URL 收集
- 无表单数据
- 无 Cookie 访问
- 无密码字段访问

### 3.3 存储容量

关键词列表按标签页独立存储。大量关键词（如每个标签页 1000+ 个关键词）和大量标签页（如 100+ 个标签页）可能导致 `chrome.storage.local` 达到配额上限（通常为 10MB）。风险低，实际使用中不太可能达到此限制。

---

## 四、网络通信安全

### 4.1 外部网络请求审计

通过对所有 JS 源文件的全文搜索：

| 搜索模式 | 结果 |
|----------|------|
| `fetch(` | 未发现 |
| `XMLHttpRequest` | 未发现 |
| `$.ajax` / `$.get` / `$.post` | 未发现 |
| `websocket` | 未发现 |
| `chrome.runtime.sendMessage` | 仅用于本地扩展内部通信 |
| `chrome.tabs.sendMessage` | 仅用于本地扩展内部通信 |

**结论**: 扩展**完全不发起任何外部网络请求**。所有操作均在本地完成。

### 4.2 无数据外传

- 无 API 端点调用
- 无遥测/分析上报
- 无第三方域名访问
- 无 Google Analytics 等追踪代码

这是该扩展最突出的安全优势。

---

## 五、消息通信安全

### 5.1 扩展内部通信

扩展使用 `chrome.runtime.sendMessage` 和 `chrome.tabs.sendMessage` 进行内部通信。这些 API 仅限于同一扩展的组件之间通信，不受外部网页干扰。

**风险**: 低。Chrome 扩展 API 自动隔离不同扩展的通信。

### 5.2 Popup Port 连接

Popup 通过 `chrome.runtime.connect({name: "popup_{tabId}"})` 与 Service Worker 建立长连接，用于检测 Popup 关闭事件：

```javascript
chrome.runtime.onConnect.addListener(function(port) {
    if (port.name.startsWith("popup_")) {
        port.onDisconnect.addListener(function(port) {
            // ... 刷新高亮
        });
    }
});
```

**风险**: 低。Port 名称包含 tabId，但仅用于内部识别，无安全影响。

---

## 六、代码注入风险

### 6.1 innerHTML / eval 审查

| 搜索模式 | 文件 | 结果 |
|----------|------|------|
| `innerHTML` | popup.js | `$('#kw-list>.keywords').remove(); $(html).appendTo($('#kw-list'))` - 使用 jQuery `.appendTo()`，内容来自受控的关键词字符串 |
| `eval(` | 全部 JS | 未发现 |
| `Function(` | 全部 JS | 未发现 |
| `document.write` | 全部 JS | 未发现 |

### 6.2 关键词注入 XSS

Popup 中关键词标签的构建方式：

```javascript
function build_keywords_list(inputKws) {
    var html = inputKws.map(kw => `<span class="keywords">${kw.kwStr}</span>`).join("");
    $('#kw-list>.keywords').remove();
    $(html).appendTo($('#kw-list'));
}
```

**风险分析**: 关键词 (`kw.kwStr`) 直接插入 HTML 字符串，如果用户输入包含 `<script>alert('xss')</script>` 这样的内容，会被 jQuery 作为 HTML 解析。

**实际影响**: 
- jQuery 的 `.appendTo()` 会将 HTML 字符串通过 `innerHTML` 机制插入 DOM
- 恶意关键词可能触发 Content Security Policy 违规（如果有 CSP）
- 由于 Popup 运行在扩展的隔离上下文中，XSS 影响有限
- 关键词显示在 Popup 页面（扩展页面），不显示在目标网页中

**风险等级**: 低。扩展页面具有更高的安全隔离，且关键词来自用户自身输入。

**建议**: 使用 `textContent` 或 jQuery 的 `.text()` 构建关键词标签，对 `kwStr` 中的 HTML 特殊字符进行转义。

### 6.3 getPagesSource.js 注入

`chrome.scripting.executeScript` 注入 `getPagesSource.js` 到目标页面，该脚本将 `document.body.innerText` 发送回 Popup。

**风险**: 低。仅提取纯文本内容，不执行动态代码。但如果页面有大量文本（如长篇文档），`innerText` 可能产生较大的消息体。

---

## 七、依赖安全

### 7.1 第三方库

| 库 | 版本 | 风险 |
|----|------|------|
| jQuery | v3.x (压缩版) | 低 - 使用压缩版，来源为 Chrome Web Store 发布包，非 npm |
| jQuery Highlight | 修改版 (基于 Bartek Szopka highlight v3) | 低 - 修改仅涉及 unhighlight 的 flatten 方法 |
| jQuery Inactivity | v1.3.2 (压缩版) | 低 - 简单的事件超时工具库 |

### 7.2 已知问题

- jQuery 版本未明确标注（压缩版），无法直接检查 CVE
- jQuery v3.x 已知存在少量低危漏洞，但对本扩展的影响有限（扩展不使用 `$.ajax()` 等方法）
- 第三方库随扩展打包分发，不通过 npm 安装，依赖审查依赖 Chrome Web Store 审核

---

## 八、Content Security Policy

Manifest 中未声明 `content_security_policy`，使用 Chrome MV3 默认 CSP：

```
script-src 'self'; object-src 'self'
```

**当前状态**: 
- 扩展无内联脚本（popup.html 通过 `<script src>` 加载 JS）
- 无 eval()、无远程脚本加载
- 默认 CSP 足够保护扩展页面

---

## 九、合规性考量

### 9.1 Chrome Web Store 政策

- 扩展功能透明（关键词高亮），用户主动输入关键词
- 无需隐私政策（不收集用户数据）
- 无用户数据外传
- `host_permissions` 声明与功能匹配

### 9.2 GDPR

- 不收集个人数据
- 不传输数据到第三方
- 所有数据存储在用户本地
- 无需数据导出/删除机制

**结论**: 符合 GDPR 要求。

---

## 十、潜在漏洞与攻击面总结

### 高危

**无**。未发现高危安全漏洞。

### 中危

| 漏洞 | 描述 | 影响 |
|------|------|------|
| `file://*/*` 注入范围 | Content Script 会注入到本地 HTML 文件 | 可能读取本地文件内容 |
| 关键词 HTML 注入 | 关键词标签构建时未转义 HTML | 扩展 Popup 内潜在 XSS（影响有限） |
| `http://*/*` host 权限 | 明文 HTTP 页面可能被中间人注入恶意内容 | 中间人可影响 Content Script 行为 |

### 低危

| 漏洞 | 描述 | 影响 |
|------|------|------|
| jQuery 全局污染 | Content Script 向页面注入 `$` 和 `jQuery` | 可能与页面自身 jQuery 版本冲突 |
| MutationObserver 性能 | 高频 DOM 变化时频繁重建高亮 | 性能下降 |
| Badge 信息泄露 | 红色 "!" badge 可能泄露扩展安装信息 | 指纹识别（影响可忽略） |
| 无输入长度限制 | textarea 无最大长度限制 | 大量关键词可能导致性能问题 |
| 调试 console.log | 多处 console.log 保留在生产代码中 | 开发者调试信息可被 DevTools 查看 |

---

## 十一、安全加固建议

### 短期改进

1. **对关键词 HTML 转义**: 在 `build_keywords_list()` 中使用 `textContent` 或转义 HTML 特殊字符
2. **移除 `file://*/*`**: 如无本地文件高亮需求，建议移除该匹配规则
3. **移除调试日志**: 清除生产代码中的 console.log 语句（background.js: 85, 112; content-action.js: 28, 57 等多处）
4. **限制输入长度**: 为 textarea 添加 `maxlength` 属性，防止极端输入

### 中期改进

5. **收缩 `http://*/*` 权限**: 评估是否仅需要 `https://*/*`
6. **使用 jQuery noConflict**: Content Script 加载 jQuery 后调用 `$.noConflict(true)` 避免全局污染
7. **MutationObserver 节流**: 添加 debounce 机制，避免高频 DOM 变化时的高亮重建

### 长期改进

8. **迁移到原生 DOM API**: 移除 jQuery 依赖，减小注入体积，避免版本冲突
9. **使用 `chrome.scripting.executeScript` 动态注入**: 替代 `content_scripts` 声明式注入，实现按需注入
10. **添加 CSP**: 显式声明 `content_security_policy` 加强安全

---

## 十二、总体评价

Multi Highlight 的安全态势为 **低风险**。

**优点**:
- 完全无网络通信，所有数据本地处理
- 不收集任何用户数据
- 无第三方追踪
- 代码简洁可审计（无打包混淆）
- 权限使用相对克制

**主要关注点**:
- Content Script 注入范围过宽（包括 `file://`）
- 关键词 HTML 构建未转义
- jQuery 全局变量污染

对于日常使用场景（在公开网页上高亮关键词），安全性良好。
