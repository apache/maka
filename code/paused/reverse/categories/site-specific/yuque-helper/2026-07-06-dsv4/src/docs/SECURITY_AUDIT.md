# SECURITY_AUDIT.md — yuque-helper v1.6.0

## 审计概览

| 维度 | 风险等级 | 说明 |
|------|----------|------|
| 权限面 | 高 | `<all_urls>` + `*://*/*` 覆盖所有网站 |
| 数据流 | 中 | 外部 API 调用 (Pexels)，内容脚本读写页面 |
| CSP | 中 | Manifest V2 无 sandbox CSP 限制 |
| 注入面 | 高 | 多处 `innerHTML` 使用 + content script 注入 |
| 通信 | 低 | Chrome 标准消息通道，未发现 WebSocket/open-port |
| 存储 | 低 | 仅使用 chrome.storage API，无敏感数据存储 |
| 隐私 | 中 | Pexels API Key 硬编码，content script 可读取所有网页 |
| 依赖 | 中 | 多版本第三方库内联，无法追踪 CVE |
| 合规 | 中 | 未发现恶意行为，但权限过度申请 |

---

## 1. 权限面审计

### 当前权限

```json
{
  "permissions": ["<all_urls>", "*://*/*", "storage", "notifications"]
}
```

### 分析

| 权限 | 必要性 | 风险 |
|------|--------|------|
| `<all_urls>` | content script 需要在 yuque.com 上运行 | 注入到所有网站，可读取任意页面 DOM、Cookie |
| `*://*/*` | 冗余（被 `<all_urls>` 覆盖） | 权限声明冗余，但无额外风险 |
| `storage` | 用户设置持久化 | 标准权限，低风险 |
| `notifications` | 操作反馈通知 | 标准权限，低风险 |

### 建议

- `<all_urls>` 应缩小到仅 `https://*.yuque.com/*`，但 content script 的"网页转存"功能需要读取任意页面，此为功能所需但需在安装说明中披露
- 移除冗余的 `*://*/*` 权限

---

## 2. 数据流审计

### 外部网络请求

| 端点 | 调用方 | 数据 | 加密 |
|------|--------|------|------|
| `api.pexels.com/v1/search` | popup.js | 搜索关键词 | HTTPS |
| `cdn.nlark.com/yuque/...` | popup.js, test.js | 无 (GET 图片) | HTTPS |
| `www.yuque.com/api/v2` | editor.js | 文档内容、用户 Cookie | HTTPS |

### 分析

- 所有外部请求均使用 HTTPS
- Pexels API Key 硬编码在 popup.js bundle 中，反编译即可提取，无安全防护
- 语雀 API 调用依赖浏览器 Cookie 自动认证，无 CSRF token 保护
- 未发现向第三方未知域发送数据的迹象

### 建议

- Pexels API Key 应从远程配置加载或由用户自行填写，而非硬编码
- 语雀 API 应使用 OAuth token 替代 Cookie 认证

---

## 3. 注入面审计

### 不安全 API 使用

通过代码扫描发现以下潜在危险调用：

| API | 文件 | 风险评估 |
|-----|------|----------|
| `innerHTML` | background.js, popup.js, options.js, editor.js, test.js | **高** — 可能来自 Vue v-html 或直接 DOM 操作 |
| `Function()` | background.js, popup.js, options.js, editor.js | **中** — 可能为 Vue/Webpack 运行时模板编译 |
| `eval()` 类似模式 | test.js | **中** — 内容脚本中的动态代码执行 |

### 分析

- Vue 2.6.12 在编译模板时使用 `new Function()`，这是 Vue 本身的设计行为，不是扩展特有风险
- `innerHTML` 在内容脚本中如果用于注入用户可控内容（如图片 URL、图片 alt），存在 XSS 风险
- 内容脚本在 `document_start` 运行，可在页面 JavaScript 执行前修改 DOM，此能力本身可被恶意利用

### 建议

- 在内容脚本中使用 `textContent` 代替 `innerHTML`
- 对于从 Pexels API 获取的图片 URL，应验证域名白名单
- 考虑迁移至 Manifest V3，利用更严格的 CSP

---

## 4. Content Script CSP 分析

作为 Manifest V2 扩展，content script 的 CSP 继承自宿主页面，扩展本身无独立沙箱。这意味着：

- 如果宿主页面 CSP 宽松，content script 可执行任意 JavaScript
- 扩展无法通过 CSP 限制 content script 的行为
- Manifest V3 将为 content script 提供独立的 CSP 沙箱

---

## 5. 存储安全

| 存储区域 | 内容 | 敏感度 |
|----------|------|--------|
| `chrome.storage.sync` | 用户名、知识库路径、UI 设置 | **低** |
| `chrome.storage.local` | 编辑器缓存内容 | **低** |

### 分析

- 未存储密码、token、API Key 等敏感信息
- 用户名和知识库路径为低敏感信息
- Manifest V2 的 storage 无加密，但存在用户设备本地
- 如果用户开启 Chrome 同步，设置会同步到 Google 账户

### 建议

- 无明显安全风险，当前设计合理

---

## 6. 通信安全

扩展内部通信全部通过 Chrome 标准 API：

```javascript
// 消息通道均在内部分
chrome.runtime.sendMessage()   // content script -> background
chrome.tabs.sendMessage()      // background/popup -> content script
```

- 未发现 `chrome.runtime.connect` 长连接，无端口泄漏风险
- 未发现 `window.postMessage` 与外部页面的通信
- 消息均为内部扩展组件之间传递，外部页面无法伪造

---

## 7. 隐私审计

### 数据收集评估

| 数据类型 | 是否收集 | 去向 |
|----------|----------|------|
| 浏览历史 | 否 | — |
| 网页内容 | 是 (用户主动触发"网页转存") | 语雀 API |
| 搜索关键词 (Pexels) | 是 (用户主动触发) | Pexels API |
| 用户身份 | 是 (语雀 Cookie) | 语雀 API |
| 设备标识 | 否 | — |

### 分析

- 扩展仅在用户主动触发时发送数据，无静默上报
- content script 虽然注入所有页面 (`document_start`)，但从代码分析未提取或上传未授权数据
- "网页转存"功能会将当前页面内容发送到语雀，应让用户明确知晓

### 建议

- 安装页面应明确说明"网页转存"功能会读取并上传当前页面内容
- Pexels 搜索应提示用户数据将发送到第三方

---

## 8. 依赖供应链审计

| 依赖 | 版本 | 安全状态 |
|------|------|----------|
| Vue.js | 2.6.12 | 已知 CVE-2024-21488 (template injection)，建议 >= 2.7.0 |
| Element UI | unknown | 已停止维护 (2023)，建议迁移至 Element Plus |
| jQuery | unknown | 内联于 bundle，版本未知，存在已知 XSS 风险 |
| d3.js | 6.3.0 | 无已知严重 CVE |
| markmap-lib | 0.11.1 | 较旧版本，建议更新 |
| Prism.js | unknown | 版本未知 |
| KaTeX | unknown | 版本未知 |
| CodeMirror | unknown | 版本未知 |
| marked | unknown | 版本未知 |
| core-js | unknown | 版本未知 |

### 分析

- 所有依赖均内联在 Webpack bundle 中，无外部 CDN 加载（标记图页面中的 d3/markmap 除外，但也已本地化）
- 依赖版本无法独立更新，需整体重建 bundle
- Element UI 已于 2023 年停止维护，存在未修复漏洞风险
- Vue 2.6.12 的模板注入漏洞（CVE-2024-21488）在 content script 场景下可被利用

### 建议

- 标记图页面的 d3.js、markmap 应校验 SRI hash
- 考虑迁移至 Vue 2.7+ 或 Vue 3
- 用 Element Plus 替换已停维的 Element UI

---

## 9. 合规评估

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 隐私政策 | 缺失 | 未在扩展中包含隐私政策 |
| 数据最小化 | 部分 | `<all_urls>` 权限过度申请 |
| 用户同意 | 部分 | 无明确的数据收集 opt-in |
| 安全传输 | 合规 | 所有外部请求使用 HTTPS |
| 代码混淆 | 非恶意 | 仅 Webpack 打包，非故意混淆 |

---

## 审计总结

**整体风险等级: 中**

**主要发现:**

1. **高**: `<all_urls>` 权限过度，应缩小到语雀相关域名
2. **高**: 多处 `innerHTML` 使用，存在 XSS 潜在入口
3. **中**: Pexels API Key 硬编码，反编译即可提取
4. **中**: Vue 2.6.12 存在已知 CVE，应升级
5. **中**: Element UI 已停维，长期安全性无保障
6. **低**: 存储和通信设计合理，无隐私数据泄漏风险

**未发现恶意行为迹象。** 扩展功能与描述一致，无静默数据收集、无广告注入、无明显追踪器。
