# JSON Viewer Pro 安全审计报告

> 逆向工程分析 (dsv4) | 基于 v1.0.6

---

## 一、审计范围

- **目标**: JSON Viewer Pro Chrome 扩展 v1.0.6
- **文件**: `manifest.json`, `js/background.js`, `js/contentScript.js`, `js/main.js`, `js/options.js`
- **审计日期**: 2026-07-05
- **方法**: 静态源码分析（逆向工程反混淆代码）

---

## 二、发现清单

### 2.1 【中危】自定义 CSS 直接注入页面 —— `textContent` 赋值无过滤

**位置**: `js/contentScript.js` 第 118 行

```javascript
document.getElementById('custom-css').textContent = options.css || '';
```

**详情**: 用户可在设置页编写任意自定义 CSS，内容脚本在渲染 JSON 查看器时直接将 `options.css` 值赋给 `<style>` 标签的 `textContent`。由于 `textContent` 不会执行脚本，XSS 风险较低，但恶意 CSS 可造成页面布局破坏、信息窃取（如通过 CSS `background: url(...)` 外泄数据）、或利用 `@import` 发起外部请求。

**风险等级**: 中危（需用户主动在设置页输入恶意 CSS 或选项被篡改）

**建议**: 
- 对 CSS 内容做 `@import` / `url()` 过滤
- 限制 CSS 最大长度
- 考虑使用 CSS `sanitizer` 库

---

### 2.2 【低危】`innerHTML` 直接赋值 —— 设置页 URL 列表渲染

**位置**: `js/options.js` URL 列表渲染逻辑

```javascript
n.innerHTML = s  // s 包含用户输入的 URL
```

**详情**: 设置页渲染已保存的 URL 过滤列表时使用了 `innerHTML`。虽然 URL 输入经过了正则验证 (`/^(http:\/\/www\.|https:\/\/www\.|http:\/\/|https:\/\/)?[a-z0-9]+.../`)，但正则并不严格且对已存储的 URL 没有再次编码，存在存储型 XSS 的潜在风险。

**风险等级**: 低危（攻击面限于设置页自身，不涉及宿主页面）

**建议**:
- 使用 `textContent` 替代 `innerHTML` 渲染 URL 文本
- 或在赋值前对 URL 进行 HTML 实体编码

---

### 2.3 【低危】`location.hash` 触发下载逻辑

**位置**: `js/contentScript.js` 第 199 行

```javascript
case 'rb_download_json':
    location.hash = 'downloadJSON=true';
    break;
```

**详情**: 右键菜单"Download JSON"通过修改 `location.hash` 来触发下载，然后由 `main.js` 响应 `hashchange` 事件执行下载。攻击者如果在 URL 中预设 `#downloadJSON=true`，可能在页面加载时即触发下载逻辑。具体影响取决于 `main.js` 中下载处理函数的实现。

**风险等级**: 低危

**建议**: 取消对 `hashchange` 的依赖，改用自定义事件或 `window.postMessage` 传递下载指令。

---

### 2.4 【信息】`host_permissions: *://*/*` 与 `file:///*` 支持

**位置**: `manifest.json` 第 19-30 行

```json
"matches": [
    "http://*/*",
    "https://*/*",
    "ftp://*/*",
    "file:///*",
    "*://*/*"
]
```

**详情**: 扩展匹配所有 URL 协议，包括 `file:///`。这意味着用户打开本地 JSON 文件时扩展也会注入内容脚本。虽然 `file:///*` 的匹配需要用户在 `chrome://extensions` 中手动开启"允许访问文件网址"，但开启后本地文件内容会被扩展读取。

`*://*/*` 与 `http://*/*`, `https://*/*` 存在冗余。

**风险等级**: 信息（功能设计使然，非漏洞）

**建议**: 
- 移除冗余的 `*://*/*` 匹配模式（被 `http://*/*` 和 `https://*/*` 覆盖）
- 在隐私说明中注明 `file:///*` 权限的用途

---

### 2.5 【信息】`web_accessible_resources` 暴露 main.js 到宿主页面

**位置**: `manifest.json` 第 37-50 行

```json
"web_accessible_resources": [
    {
        "resources": ["/js/main.js", "/css/style.css", ...],
        "matches": ["*://*/*", "ftp://*/*", "file:///*"]
    }
]
```

**详情**: `main.js`（~954KB，包含完整 React 应用）对所有网站可访问，宿主页面可通过 `<script src="chrome-extension://...">` 加载该脚本。虽然 MV3 的 `web_accessible_resources` 限制为仅匹配的站点可加载，但 `matches` 使用了通配模式。

**风险等级**: 信息（功能设计使然，MV3 已通过 `matches` 限定范围）

**建议**: 确认 `matches` 范围是否可进一步收窄。

---

### 2.6 【信息】内嵌第三方库版本

**位置**: `js/main.js`, `js/options.js`

通过代码特征识别出以下内嵌库：

| 库 | 识别特征 | 潜在风险 |
|---|---------|---------|
| React 18 (production) | `react.production.min.js` 注释 | 截止 2026-07 可能有过期 CVE |
| CodeMirror 6 | `class p { lineAt(t) { ... } }` | 截止 2026-07 可能有过期 CVE |

**风险等级**: 信息（需定期更新依赖）

**建议**: 通过 `npm audit` 或 SCA 工具检查已知漏洞。

---

### 2.7 【信息】`document_start` 注入时机

**位置**: `manifest.json` 第 29 行

```json
"run_at": "document_start"
```

**详情**: 内容脚本在 `document_start` 阶段即注入（DOM 构建之前）。这确保扩展能在页面渲染前拦截 JSON 内容，但也意味着脚本执行时机非常早，可能影响页面自身的加载性能。

**风险等级**: 信息

---

## 三、未发现的高危问题

以下常见扩展安全问题经审查后**未发现**：

- [x] 无 `eval()` 或 `new Function()` 动态代码执行
- [x] 无向外部服务器发送用户数据的网络请求（`main.js` 中未发现 `fetch`/`XMLHttpRequest` 外发逻辑）
- [x] 无 `chrome.cookies` / `chrome.webRequest` 敏感权限申请
- [x] 无 `externally_connectable` 配置（不接受外部消息）

> **注意**: 由于 `main.js` 和 `options.js` 为打包压缩产物（Terser 混淆），部分逻辑可能被掩盖。上述审计基于可读源码（`background.js`, `contentScript.js`）和反混淆代码片段。

---

## 四、整体评估

| 维度 | 评级 | 说明 |
|------|------|------|
| 权限最小化 | 良好 | 仅申请 `contextMenus` + `storage`，无过度权限 |
| XSS 防护 | 一般 | 自定义 CSS 直接注入，存在信息泄露风险 |
| CSP 遵从 | 良好 | MV3 禁用了 inline script |
| 数据外发 | 安全 | 未发现有外发用户数据的行为 |
| 第三方依赖 | 需关注 | React 18 / CodeMirror 6 内嵌，版本需跟踪 |

**综合评级**: 低风险。扩展整体安全设计合理，无远程代码执行、无数据窃取行为。主要关注点为自定义 CSS 注入和选项页 XSS。

---

## 五、外部链接

扩展设置页包含以下外部链接：

- `https://www.paypal.com/donate?hosted_button_id=VQLQGCRJAAF3L` (PayPal 捐赠)
- `https://addonise.com/extensions` (作者其他扩展)

这两个链接为静态 HTML `<a>` 标签，无动态构造，不存在 open redirect 风险。
