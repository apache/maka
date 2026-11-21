# SECURITY_AUDIT.md -- 复制链接到剪贴板 v15.1.3

## 评估摘要

| 维度 | 等级 | 说明 |
|------|------|------|
| 权限面 | 低风险 | 7 必需权限均为合理用途; 1 可选权限 (notifications) 需用户批准 |
| 数据流 | 低风险 | 无网络请求, 无数据外传; 所有数据仅在本地处理 |
| CSP | 低风险 | 无内联脚本; 所有 JS 通过 `<script type="module">` 加载; DOMPurify + url-sanitizer 防御 XSS |
| 注入面 | 低风险 | 内容脚本仅读取 DOM 信息; innerHTML/eval/Function 均未使用; DOMPurify 净化用户属性输入 |
| 通信 | 低风险 | 仅使用 runtime.sendMessage 本地通信; 无 external messaging / native messaging |
| 存储 | 低风险 | 仅存储格式偏好和布尔选项; 无敏感数据; 无 PII |
| 隐私 | 低风险 | 无追踪/分析/遥测; 无第三方服务调用; 开源 (MPL-2.0) |
| 依赖 | 低风险 | 3 个知名第三方库 (webext-polyfill/DOMPurify/url-sanitizer); 均带 sourcemap |
| 合规 | 低风险 | 最小权限原则; 仅请求完成任务所必需的 API |

**总体安全等级: 低风险** -- 这是一个设计严谨的安全扩展。

---

## 1. 权限面分析

### 1.1 必需权限

| 权限 | 风险评估 | 分析 |
|------|----------|------|
| `activeTab` | 低 | 仅在用户主动交互时 (右键菜单/快捷键/工具栏点击) 访问当前标签页; 不持续监控 |
| `clipboardWrite` | 低 | 仅写入, 不读取剪贴板; 写入内容完全由扩展生成 (非外部来源) |
| `contextMenus` | 低 | 仅在 chrome 运行时注册菜单项; 不注入到页面 |
| `offscreen` | 低 | 仅在复制/净化时创建, 完成后立即关闭; 无持久化隐形文档 |
| `scripting` | 低 | 仅注入一个预定义的内容脚本 `js/context-info.js`, 通过 `files` 方式而非动态 `func`; 按需执行非持久化 |
| `storage` | 低 | 仅存储用户偏好; 无本地敏感数据 |
| `tabs` | 低 | 仅读取标签页标题/URL, 无标签页修改操作 |

### 1.2 可选权限

| 权限 | 风险评估 | 分析 |
|------|----------|------|
| `notifications` | 低 | 仅当用户在选项中勾选"复制时通知"时才请求; 仅创建临时通知 |

### 1.3 未请求但合理的缺失

- `host_permissions`: 无需 `<all_urls>`, 因为通过 `activeTab` 获取当前页面访问权
- `cookies` / `webRequest` / `history`: 未使用, 扩展不需要这些能力
- `clipboardRead`: 未使用, 扩展只写不读

---

## 2. 数据流安全

### 2.1 网络请求审计

```bash
# 搜索结果: 0 次 fetch / XMLHttpRequest 调用
# 扩展不发起任何网络请求
```

- 无 `fetch()`, `XMLHttpRequest`, `WebSocket` 调用
- 无 `<script src="external">` 外部资源加载
- 所有 JS/CSS/图片均为扩展捆内资源
- options.html 包含外部链接 (GitHub/PayPal), 但仅为 `<a href>` 超链接, 无自动请求

### 2.2 数据流向

```
页面 DOM → context-info.js (只读提取) → Service Worker (内存处理) → 剪贴板 (写入)
存储偏好 → chrome.storage (本地持久化) → Service Worker (读取配置)
```

全程数据不出浏览器。无远程服务器。

---

## 3. 注入面分析

### 3.1 XSS 防护

| 防护措施 | 实现 | 评价 |
|----------|------|------|
| DOMPurify | `lib/purify/purify.min.js` v3.x, 用于净化用户自定义 HTML 属性 | 业界标准库 |
| url-sanitizer | `lib/url/url-sanitizer-wo-dompurify.min.js`, 用于 URL 净化 | 专用库 |
| 属性净化 | `sanitize-attr.js` 中 DOMPurify 仅允许 `a` 标签、`target`/`class`/`rel` 属性; `onxxx` 事件被移除; `title` 在使用后移除 | 严格白名单 |
| DOM 序列化 | `dom-util.js` 中的 `serializeDomString` 使用 `DOMParser` + `XMLSerializer` + 命名空间重建, script 标签被丢弃 | 安全重建 |
| 无 innerHTML | 源码中未发现 `innerHTML` 直接赋值 | 安全 |
| 无 eval | 源码中未发现 `eval()` 或 `new Function()` 调用 | 安全 |

### 3.2 URL 注入防护

- `sanitizeURL()` 对 `data:` 协议 URL 委托到 offscreen document 中的 url-sanitizer 库处理
- `file:` 协议 URL 被显式允许 (`allow: ['data', 'file']`), 仅在用户浏览本地文件时可能触发
- 文本片段 (Text Fragments) `#:~:text=` 中用户选中文本经 `encodeURIComponent()` 编码后拼接

### 3.3 内容脚本安全

`js/context-info.js` 是一个 IIFE, 仅执行以下操作:
1. `window.getSelection()` -- 获取选中文本
2. `document.activeElement` -- 获取焦点元素
3. `node.closest('a')` -- 查找最近链接
4. `document.querySelector('link[rel=canonical]')` -- 读取 canonical URL
5. 返回一个纯对象

脚本不修改 DOM, 不创建新元素, 不监听事件, 执行完毕后立即退出。

### 3.4 用户输入处理

- options.html 中用户自定义 HTML 属性 (如 `class="foo" target="_blank"`) 经 DOMPurify 净化
- popup.html 中用户编辑内容在模板渲染前经过格式特定的字符转义 (HTML 实体/LaTeX 转义/Markdown 转义等)
- `window.prompt()` 输入仅在 offscreen document 中处理, 返回后经模板转义

---

## 4. 通信安全

### 4.1 消息传递

所有消息传递使用 `browser.runtime.sendMessage()` + `onMessage`:
- **无 `externally_connectable` 声明** -- 不接受来自网页的连接请求
- **无 `nativeMessaging`** -- 不与本地应用通信
- **消息处理均含类型检查** -- `extractClickedData` 验证 `isObjectNotEmpty(info)` && `isObjectNotEmpty(tab)`; `handleMsg` 验证 `isObjectNotEmpty(msg)`

### 4.2 消息类型汇总

| 消息 Key | 方向 | 载荷 | 用途 |
|----------|------|------|------|
| `getContextInfo` | popup→SW | `true` | 请求页面上下文信息 |
| `contextInfo` | SW→popup | `{contextInfo: {...}}` | 返回页面上下文 |
| `executeCopy` | popup/SW→offscreen | `{info, tab}` | 执行复制操作 |
| `notifyOnCopy` | offscreen→SW | formatTitle string | 触发通知 |
| `promptContent` | SW→offscreen | `[content, msg]` | 编辑提示 |
| `sanitizeAttributes` | SW→offscreen | attr string | HTML 属性净化 |
| `sanitizeURL` | SW→offscreen | `[url, opt]` | URL 净化 (data: 协议) |

---

## 5. 存储安全

### 5.1 存储内容

所有存储使用 `chrome.storage.local`, 内容类型:

| 类别 | 键前缀 | 值类型 | 示例 |
|------|--------|--------|------|
| 格式启用状态 | 16 个格式 ID | `{checked: bool, value: ''}` | `{HTMLHyper: {checked: true, value: ''}}` |
| 图标选择 | `buttonIcon*` | `{checked: bool, value: 'icon-color-32.png'}` | 图标文件名 |
| 布尔选项 | `includeTitle*`/`notifyOnCopy` 等 | `{checked: bool, value: ''}` | `{notifyOnCopy: {checked: true}}` |
| 文本属性 | `attributesHTML*` | `{checked: bool, value: 'class="foo"'}` | 用户自定义属性 |

### 5.2 风险评估

- 无密码/Token/API Key/PII 存储
- 无加密需求 (所有数据为用户界面偏好)
- `managed` 存储区未使用 (无企业策略)

---

## 6. 隐私审计

### 6.1 数据收集

- **无遥测/分析/追踪代码**: 源码中未发现 Google Analytics、Firebase、Mixpanel 等 SDK
- **无第三方请求**: 所有资源为扩展本地文件
- **无用户标识**: 不生成/存储/传输任何用户 ID

### 6.2 浏览器访问范围

- 仅在用户明确操作时读取标签页 URL/标题
- 不扫描/枚举用户浏览历史
- 不读取 cookie、localStorage 或其他站点数据

---

## 7. 依赖审计

| 库 | 版本 | 用途 | 风险 | 分析 |
|----|------|------|------|------|
| webext-polyfill | 0.12.0 | 跨浏览器 API 兼容 | 低 | Mozilla 官方项目, 活跃维护 |
| DOMPurify | 3.x (min) | HTML 净化 | 低 | 业界标准 XSS 防护库, 通过钩子配置 |
| url-sanitizer | 1.x (min) | URL 净化 | 低 | 同一作者 (asamuzaK) 维护, 无 DOM 依赖版本 |

- 所有第三方库均在 `lib/` 下本地捆内, 不通过 CDN 加载
- 每个库附带 LICENSE + package.json 声明
- Source map 文件 (.map) 可供审计

---

## 8. 代码质量安全

### 8.1 各模块安全检查

| 模块 | 检查项 | 结果 |
|------|--------|------|
| `format.js:createLinkText()` | 7 种格式的字符转义 | 通过: HTML 实体/LaTeX 转义/Markdown 括号转义等均覆盖 |
| `sanitize-attr.js:sanitizeAttributes()` | DOMPurify 配置 | 通过: ALLOWED_TAGS=['a'] 白名单, 强制移除 title |
| `dom-util.js:setAttributeNS()` | href/src 协议白名单 | 通过: 仅允许 https? 协议的 URL |
| `dom-util.js:createElement()` | script 标签 | 通过: `localName === 'script'` 返回 null, 不创建元素 |
| `common.js:encodeUrlSpecialChar()` | URL 编码 | 通过: 对所有 URL 组件 (path/query/fragment) 执行编码 |
| `browser.js:executeScriptToTab()` | 内容脚本注入 | 通过: 仅通过 `files` 参数注入预定义脚本, 不支持 `func` 参数在非测试路径 |

### 8.2 已知安全增强建议

1. **Text Fragment 编码**: `#:~:text=` 后的文本使用 `encodeURIComponent()`, 但建议额外验证选中文本不含换行/控制字符
2. **剪贴板 MIME 白名单**: `Clip` 类的 `#supportedMimeTypes` 限制可写入的 MIME 类型, 有效防止恶意 MIME 注入
3. **data: URL 处理**: data: 协议 URL 经由 offscreen document 中 url-sanitizer 处理, 而非跳过净化

---

## 9. 总结

该扩展遵循最小权限原则、纵深防御和输入净化安全设计。核心安全特性:

- **纵深 URL 净化**: url-sanitizer 库 + DOMPurify 双重验证
- **零网络通信**: 所有数据处理在浏览器本地完成
- **严格输入净化**: 用户属性经 DOMPurify, 格式内容经格式特定转义, URL 经专用库净化
- **无持久化隐形文档**: offscreen document 用完即关
- **内容脚本最小化**: 仅 95 行代码, 只读操作, 执行完立即退出

未发现安全漏洞、隐私泄露风险或恶意行为模式。
