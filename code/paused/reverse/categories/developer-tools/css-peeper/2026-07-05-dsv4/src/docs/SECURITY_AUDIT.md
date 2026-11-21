# CSS Peeper 安全审计报告

> **审计对象**: CSS Peeper Chrome 扩展 v1.2.2 (MV3)
>
> **审计方法**: 源码静态分析 + Manifest 权限审查
>
> **审计日期**: 2026-07-05

---

## 一、执行摘要

CSS Peeper 作为 Chrome 扩展，**整体安全风险等级：中**。主要关注点集中在：
1. `webRequest` 权限的滥用风险
2. `externally_connectable` 配置暴露的外部通信面
3. `<all_urls>` content script 注入的潜在数据泄露
4. CSP sandbox 配置的特殊风险

所有风险均为**潜在风险**——因源码已被高度打包且缺少 source map，无法精准确认运行时代码行为，以下分析基于 Manifest 权限声明和静态代码片段推断。

---

## 二、权限清单与风险评估

### 2.1 高风险权限

| 权限 | 风险等级 | 风险描述 |
|------|----------|----------|
| **`webRequest`** | 高 | 可拦截和修改所有 HTTP/HTTPS 请求。如果 service worker 中存在恶意代码，可以读取请求头、请求体、响应数据，监控用户所有网络活动。 |
| **`host_permissions: ["http://*/*", "https://*/*"]`** | 高 | 扩展在所有网站上有完全的主机权限。结合 `content_scripts: <all_urls>`，三者叠加意味着扩展可以在用户访问的任意网页上执行任意 JS。 |
| **`scripting`** | 高 | 允许动态注入 JS/CSS 到任意页面，绕过 content_scripts 的静态声明限制。 |
| **`content_scripts: <all_urls> ×3`** | 高 | 三个 content script 注入到所有页面，每个都有完整的 DOM 访问和 `window.getComputedStyle` 调用权限，可读取页面所有内容。 |

### 2.2 中风险权限

| 权限 | 风险等级 | 风险描述 |
|------|----------|----------|
| **`externally_connectable`** | 中 | 允许 googletagmanager.com 和 csspeeper.com 向扩展发送消息。如果任一外部域名被攻破或劫持，攻击者可向扩展发送任意指令。 |
| **`unlimitedStorage`** | 中 | 无限存储空间，理论上可用于存储大量用户浏览数据。 |
| **`alarms`** | 低-中 | 定时任务，可被用于定期执行代码。 |

### 2.3 低风险权限

| 权限 | 风险等级 | 风险描述 |
|------|----------|----------|
| **`sidePanel`** | 低 | 标准 Side Panel API，无特殊风险。 |
| **`activeTab`** | 低 | 仅在用户主动点击扩展时生效，限制较多。 |
| **`tabs`** | 低 | 可读取 tab URL/标题，但无敏感信息直接暴露。 |
| **`storage`** | 低 | 标准存储 API。 |

---

## 三、externally_connectable 深度分析

### 3.1 配置

```json
"externally_connectable": {
  "matches": [
    "https://googletagmanager.com/*",
    "https://csspeeper.com/*"
  ]
}
```

### 3.2 风险向量

1. **Google Tag Manager (`googletagmanager.com`)**
   - 最可能的用途：Google Analytics 数据上报
   - 风险：如果 CSS Peeper 的作者在 GTM 中配置了自定义 HTML 标签，这些标签可以在 googletagmanager.com 上下文中执行 JS，并通过 `chrome.runtime.sendMessage` 向扩展发送消息
   - 严重度：**中** — 取决于 GTM 容器是否受攻击者控制

2. **CSS Peeper 官网 (`csspeeper.com`)**
   - 可能用途：许可证验证、账户同步
   - 风险：如果 csspeeper.com 域名过期被抢注，或网站存在 XSS 漏洞，攻击者可以与扩展通信
   - 严重度：**中**

### 3.3 建议

- 限制 `externally_connectable` 为最小路径，例如仅在特定路径下允许通信
- 对来自外部的消息实施严格的来源验证和内容校检
- 若仅需 Analytics，可考虑使用 `chrome.storage` 记录事件后由 SW 统一上报

---

## 四、CSP 配置分析

### 4.1 配置

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'",
  "sandbox": "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self'; child-src 'self'"
}
```

### 4.2 分析

| 策略 | 安全性 | 问题 |
|------|--------|------|
| `script-src 'self'` | 好 | 禁止内联脚本和 eval，限制严格 |
| `object-src 'self'` | 好 | 禁止外部插件/对象 |
| **Sandbox: `allow-scripts`** | 注意 | 沙盒页面允许执行脚本。如果沙盒页面加载了不受信任的内容，存在 XSS 风险 |
| **Sandbox: `allow-popups`** | 注意 | 允许弹出窗口，可能被用于钓鱼 |
| **Sandbox: `allow-modals`** | 注意 | 允许模态对话框，可能被用于欺骗用户 |
| **Sandbox: `allow-forms`** | 注意 | 允许表单提交，可能泄露数据到外部 |

### 4.3 沙盒页面用途推断

CSS Peeper 的 sandbox CSP 配置可能用于：
- 隔离执行的第三方组件（如颜色计算库、字体解析器）
- 渲染不受信任的用户生成内容
- 安全地执行需要放宽限制的特定逻辑

**如果 sandbox 页面实际未被使用**（静态分析未发现 sandbox HTML 文件），则是**冗余配置**，可移除降低攻击面。

---

## 五、Content Script 注入分析

### 5.1 注入配置

```json
"content_scripts": [
  {"matches": ["<all_urls>"], "js": ["sidebar-element-locator.*.js"]},
  {"matches": ["<all_urls>"], "js": ["csspeeper-inspector-tools.*.js"]},
  {"matches": ["<all_urls>"], "js": ["inspector.*.js"]}
]
```

三个脚本均注入到**所有页面** (`<all_urls>`)。

### 5.2 代码行为分析（基于静态提取）

从 `sidebar-element-locator.js` 提取的关键行为：

```javascript
// 注入覆盖层到页面 DOM
let container = document.createElement("div");
container.id = "csspeeper-extension-container";
container.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;isolation:isolate";
document.documentElement.appendChild(container);

// Hook Node.prototype.removeChild (防止页面代码清除扩展元素)
var original = Node.prototype.removeChild;
Node.prototype.removeChild = function(child) {
  try {
    return original.call(this, child);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError" && "remove" in child) {
      return child.remove(), child;
    }
    throw error;
  }
};
```

### 5.3 风险点

1. **DOM 污染**: 扩展在页面注入 `csspeeper-extension-container` 容器，改变页面 DOM 结构。虽然使用了 `isolation: isolate` 创建层叠上下文隔离，但仍可能影响某些依赖 DOM 结构的页面逻辑。

2. **原型修改**: Hook `Node.prototype.removeChild` 是侵入性操作，虽然目的是防护，但改变了 Web API 标准行为，可能与页面脚本产生交互冲突。

3. **全页面访问**: `<all_urls>` 意味着 content script 可以访问用户的所有浏览页面代码和用户输入。

---

## 六、webRequest 权限深度分析

### 6.1 可能的合法用途

- **Google Fonts 检测**: 检测页面加载的 Google Fonts 请求，用于排版分析
- **Analytics**: 上报使用数据到 csspeeper.com
- **许可证验证**: 定期检查 Pro 许可证状态

### 6.2 滥用风险

`webRequest` 权限如果被滥用，攻击者可以：
- 拦截所有 HTTP/HTTPS 请求，读取请求/响应头
- 重定向请求到恶意服务器
- 监控用户浏览历史
- 注入或修改页面资源

### 6.3 建议

- 如果仅用于 Google Fonts 检测，可改用 `webRequest.onCompleted` 只读监听
- 如果仅用于自用域名通信，使用 `host_permissions` 限定域名即可
- 考虑添加 `declarativeNetRequest` 替代 `webRequest`（MV3 推荐）

---

## 七、数据隐私评估

### 7.1 可能采集的数据（基于功能推断）

| 数据类型 | 可能性 | 用途推断 |
|----------|--------|----------|
| 浏览页面的 CSS 样式 | 高 | 核心功能，提取计算样式 |
| 浏览页面的 DOM 结构 | 高 | 元素选择器路径、class/ID |
| 页面 URL | 高 | 关联检查结果到页面 |
| 用户操作行为 | 中 | 通过 GTM 上报 Analytics |
| 字体使用数据 | 中 | 排版分析 + 可能的统计 |
| 颜色数据 | 中 | 调色板分析 + 可能的统计 |
| 个人身份信息 | 低 | 无直接收集 PII 的迹象 |

### 7.2 数据出口

通过 `externally_connectable` 配置，数据可能流向：

1. **Google Tag Manager** (`googletagmanager.com`) — 可能包含匿名化分析数据
2. **CSS Peeper 官网** (`csspeeper.com`) — 可能包含许可证、账户、同步数据

---

## 八、安全改善建议 (优先级排序)

### P0 — 立即修复

1. **审查 webRequest 权限必要性**: 确认是否仅用于特定域名；若不需拦截所有请求，改用 `declarativeNetRequest` 或缩小域名范围
2. **审查 externally_connectable**: 确认 googletagmanager.com 的必要性；对来自外部域名的消息做严格的 origin 验证

### P1 — 建议修复

3. **移除或使用 sandbox 页面**: 如果 sandbox CSP 配置对应的页面未被使用，应移除该 CSP 条目
4. **限制 content_scripts 匹配**:考虑使用 `activeTab` + `scripting.executeScript` 按需注入，而非全 `<all_urls>`
5. **移除 Node.prototype 修改**: 改为更安全的方式保护扩展元素（如 MutationObserver）

### P2 — 优化建议

6. **添加消息来源验证**: 在 service worker 的消息路由中添加 `sender.origin` 验证
7. **减少权限范围**: `unlimitedStorage` 若无大量数据存储需求可移除以降低风险面
8. **提供隐私政策**: 扩展的 Chrome Web Store 页应明确说明数据收集范围

---

## 九、声明

- 本审计基于 Manifest v1.2.2 的静态分析
- 所有 JS 代码经过 Parcel 高度打包，无法进行完整的代码审计
- `externally_connectable` 配置的 `googletagmanager.com/*` 是最值得关注的外部攻击面
- 未发现明确的恶意代码签名，但 `webRequest` + `<all_urls>` + `scripting` 组合是能力极强的权限组合，应持续审查
