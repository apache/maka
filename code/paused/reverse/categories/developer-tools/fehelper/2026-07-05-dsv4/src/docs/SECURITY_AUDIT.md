# FeHelper 安全审计文档

> 反向工程版本：dsv4 | 原始版本：v2026.7.3  
> 审计范围：Manifest V3 CSP 策略、内容脚本、沙箱隔离、消息通信、数据存储、第三方库

---

## 一、执行摘要

| 项目 | 状态 |
|------|------|
| 整体安全评级 | 中风险 |
| 关键问题数 | 4 |
| 建议改进数 | 7 |
| 需紧急修复 | 0 |

FeHelper 作为 30+ 工具的开发者工具箱，整体安全设计较为审慎。主要风险点集中在：(1) 沙箱 `unsafe-eval` 的使用、(2) 内容脚本 `evalCore` 在所有页面的代码执行能力、(3) 油猴脚本的 `eval()` 执行和 `postMessage` 通信。现有机制已提供有效隔离，但仍有改进空间。

---

## 二、CSP 策略审计

### 2.1 扩展页面

```
"extension_pages": "script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'self'"
```

| 检查项 | 状态 | 说明 |
|--------|------|------|
| script-src | `'self'` | 仅允许扩展内联脚本和本地文件，禁止外部脚本 |
| style-src | `'self' 'unsafe-inline'` | 允许内联样式（Vue.js 需要），风险可控 |
| object-src | `'self'` | 禁止外站 object/embed，防止 Flash 攻击 |
| 缺少 default-src | 警告 | 未设回退策略，建议显式声明 |
| 缺少 connect-src | 警告 | 未限制网络请求目标，虽然 fetch 受限于扩展权限 |

**评价**：扩展页 CSP 符合 MV3 最佳实践，`script-src 'self'` 有效防止 XSS 注入。

### 2.2 沙箱页面

```
"sandbox": "sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-eval'"
```

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 沙箱模式 | `sandbox` | 已启用，无法访问 chrome.* API，提供核心隔离 |
| script-src | `'self' 'unsafe-eval'` | 允许 eval，用于执行第三方开发工具脚本 |
| allow-forms | 已允许 | 沙箱内表单提交有风险，但来源受控 |
| allow-popups | 已允许 | 可能被用于打开钓鱼页面 |
| allow-modals | 已允许 | alert/confirm 可能在沙箱中显示误导信息 |
| allow-same-origin | 已禁止 | 无法访问同源 storage/cookie，增强隔离 |
| allow-top-navigation | 已禁止 | 无法导航顶层窗口 |

**评价**：沙箱 `unsafe-eval` 是第三方开发工具功能需求，风险集中于无法完全信任的第三方脚本。当前 `postMessage` + 无 `allow-same-origin` 的配置提供了合理隔离。

---

## 三、内容脚本安全审计

### 3.1 注入范围

```json
"content_scripts": [{
    "matches": ["http://*/*", "https://*/*", "file://*/*"],
    "exclude_globs": ["https://chrome.google.com/*"],
    "js": ["static/vendor/jquery/jquery-3.3.1.min.js", "static/vendor/evalCore.min.js"],
    "run_at": "document_idle",
    "all_frames": false
}]
```

| 检查项 | 状态 | 风险 |
|--------|------|------|
| 注入范围 | 所有 http/https/file 页面 | **高** - 全局注入 jQuery + evalCore |
| exclude_globs | 排除 Chrome Web Store | 低 - 保护了核心扩展页面 |
| all_frames | false | 不注入 iframe，减少攻击面 |
| run_at | document_idle | DOM 完全加载后，降低对页面渲染的影响 |

### 3.2 evalCore.min.js 审计

- **文件性质**：第三方 vendor 文件，支持页面内动态代码执行
- **风险等级**：高风险
- **问题**：在所有页面创建代码执行能力，任何利用 FeHelper 消息协议的恶意页面可能间接执行代码
- **当前缓解**：
  - 仅在接收到扩展消息时执行指定代码（非任意用户输入）
  - jQuery 版本为 3.3.1（存在已知 CVE，但扩展页直接使用扩展内版本，非全局注入）

### 3.3 工具内容脚本注入

部分工具（如 json-format）会注入额外的 content_script.js：

- **执行路径**：`DynamicToolRunner` → `injectTools.inject` → `chrome.scripting.executeScript`
- **触发条件**：页面 URL 通过 `isInjectableTabUrl()` 检查
- **风险评估**：低 - 仅在用户明确操作或页面符合注入条件时触发

---

## 四、沙箱隔离审计

### 4.1 三方开发工具机制

```javascript
// dynamic/sandbox.js
window.addEventListener("message", function(e){
    if (e.data.type === "fh-dynamic-render") {
        document.write(payload.html);
        payload.js.forEach(function(code){
            Function("window","document","globalThis","self", String(code || ""))(
                window, document, window, window
            );
        });
    }
});
```

| 检查项 | 状态 |
|--------|------|
| HTML 注入 | `document.write` - 已通过 CSP 限制来源 |
| JS 执行 | `new Function()` - 在 sandbox 隔离上下文中执行 |
| chrome.* API 访问 | 不可用（沙箱限制） |
| 错误处理 | 捕获并显示友好错误页面 |

**评价**：沙箱隔离有效，`unsafe-eval` 的使用是第三方工具功能需求。`document.write` 在沙箱上下文中不会影响扩展页。风险可控。

### 4.2 postMessage 验证

- 沙箱接收消息：检查 `e.data.type === "fh-dynamic-render"` - 模式匹配验证存在
- **缺失**：未验证 `e.origin`（在沙箱中通常不影响，因为沙箱无相同 origin）
- **建议**：添加 origin 白名单检查作为纵深防御

---

## 五、油猴脚本安全审计

### 5.1 脚本执行

```javascript
// monkey.js: 用户脚本通过 eval() 在 MAIN world 注入
function buildFinalCode(script) {
    return script.mScript; // 直接拼接到 IIFE 中
}
// 注入方式：
chrome.scripting.executeScript({
    func: function(code) { (0, eval)(code); },
    args: [finalCode],
    world: "MAIN",
});
```

| 检查项 | 状态 |
|--------|------|
| 脚本来源 | 用户自行编写，存储在 chrome.storage.local |
| 执行方式 | `eval()` 在 MAIN world |
| 隔离机制 | 先尝试 MAIN world，失败降级到 ISOLATED world |
| @require 加载 | 通过 ISOLATED world 桥接 proxy fetch，有限 URL 白名单 |

### 5.2 权限模型

```javascript
// 模拟 GM_* API
const GM_setValue = function(k, v) {
    localStorage.setItem(__FH_GM_PREFIX + k, JSON.stringify(v));
};
const GM_xmlhttpRequest = function(details) {
    fetch(details.url, { ... });
};
```

| 检查项 | 状态 |
|--------|------|
| 值存储 | localStorage（同源隔离） |
| 网络请求 | fetch 通过 proxy（绕过页面 CSP） |
| 通知 | Web Notification API |
| 剪贴板 | navigator.clipboard.writeText |

### 5.3 通信桥接

油猴脚本日志和 @require 通过 `window.postMessage` 在 MAIN 和 ISOLATED worlds 间通信：

- **日志流**：MAIN → `postMessage` → ISOLATED bridge → `chrome.runtime.sendMessage` → SW → storage
- **@require 代理**：MAIN → `postMessage` → ISOLATED bridge → `chrome.runtime.sendMessage` → SW → fetch → 回调
- **验证**：ISOLATED bridge 检查 `__fh_monkey_log` / `__fh_monkey_require` 标志
- **风险**：任何页面脚本都能发送伪造日志，但不会执行代码

---

## 六、消息通信安全

### 6.1 消息类型验证

所有消息通过 `type` 字段分发，SW `onMessage` handler 基于 `r.type` 进行 switch-case 匹配：

- 未识别类型被忽略（不执行）
- `fh-dynamic-any-thing` 的 `thing` 字段无额外签名验证
- 消息来源：通过 `chrome.runtime.sendMessage` 的 `sender` 参数获取 tab/origin 信息，但未进行二次验证

### 6.2 跨扩展通信风险

- **未声明 `externally_connectable`**：外部网站无法连接扩展
- **消息仅限扩展内部**：`chrome.runtime.sendMessage` 仅在扩展内各组件间使用

---

## 七、数据存储安全

| 存储位置 | 数据类型 | 风险 |
|----------|----------|------|
| chrome.storage.local | 工具安装状态、用户设置、油猴脚本 | 低 - Chrome 扩展沙箱 |
| chrome.storage.session | 工具间内容传递 | 低 - 临时 + 会话级 |
| localStorage | 油猴 GM 值、夜间模式 | 低 - 同源隔离 |
| IndexedDB | 未使用 | N/A |

**潜在问题**：`chrome.storage.local` 中存储油猴脚本代码。如果用户安装的脚本包含恶意代码，会在下一个匹配页面自动注入执行。这是油猴工具类扩展的固有风险，FeHelper 未做脚本代码审查或签名验证。

---

## 八、网络请求安全

| 端点 | 方法 | 数据 | 风险 |
|------|------|------|------|
| `https://fehelper.com/static/js/hotfix.json` | GET | 热修复配置 | 中 - 热修复 JS/CSS 可被中间人修改 |
| `https://img.shields.io/chrome-web-store/v/...` | GET | 版本检测 | 低 - 仅读取版本号 |
| CWS `requestUpdateCheck` | Chrome API | 更新 | 低 - Chrome 原生 |
| 统计上报 | sendMessage | 使用数据 | 低 - 需用户主动操作触发 |
| 油猴 @require | proxy fetch | 依赖脚本 | 中 - 依赖 tampermonkey @require 白名单 |

**热修复风险**：`hotfix.json` 获取的 JS 代码通过 `new Function()` 执行（限 50KB），若 `fehelper.com` 被攻击或中间人攻击，可导致扩展页代码注入。但该代码在扩展页 CSP 约束下运行，仍受 `script-src 'self'` 限制。

---

## 九、第三方库审计

| 库 | 版本 | 已知漏洞 | 风险 |
|----|------|----------|------|
| jQuery | 3.3.1 | CVE-2020-11022/CVE-2020-11023 (XSS) | 低 - 扩展页受 CSP 保护 |
| Vue.js | 2.x | CVE-2024-47814 (SSR XSS) | 低 - 仅客户端渲染 |
| CodeMirror | 5.x | 无严重已知漏洞 | 低 |
| js-beautify | 内联 | 仅格式化，无网络访问 | 低 |
| UglifyJS3 | 内联 | 仅压缩，无网络访问 | 低 |
| ZXing | 内联 | 仅二维码解码 | 低 |
| Marked.js | 内联 | CVE 可能存在（Markdown XSS） | 低 - 输出到扩展页 DOM |

---

## 十、隐私审计

| 检查项 | 状态 |
|--------|------|
| 用户数据收集 | 使用统计（可关闭：FORBID_STATISTICS） |
| 页面内容访问 | 通过 content_script（host_permissions 声明） |
| 浏览器历史访问 | 未声明 `history` 权限 |
| 剪贴板静默读取 | 未声明 `clipboardRead` 权限 |
| 用户标识 | clientInfo 上报含设备信息（语言、时区、屏幕、网络类型） |
| 数据传输加密 | 所有网络请求使用 HTTPS |

---

## 十一、改进建议

### 高优先级

1. **沙箱 postMessage origin 验证**：在 `sandbox.js` 中验证 `e.origin` 来源，防止未授权消息
2. **content_script 注入范围缩小**：`exclude_globs` 增加敏感网站列表（网银、政府网站等）

### 中优先级

3. **热修复签名验证**：对 `hotfix.json` 内容增加数字签名或完整性 hash 验证
4. **油猴脚本安全警告**：安装/启用油猴脚本时显示安全提示
5. **external_connectable**：显式声明，防止外部网站通信（默认禁用已满足）

### 低优先级

6. **CSP 补充**：扩展页增加 `default-src 'self'` 和 `connect-src` 声明
7. **第三方库更新**：jQuery 3.3.1 → 3.7.x（需评估兼容性）
8. **油猴 @require 域名白名单**：当前实现已有白名单机制，建议增加 GUI 配置界面

---

## 十二、总结

FeHelper v2026.7.3 的安全设计在 Chrome 扩展 MV3 框架下属于合理水平：

- **CSP 策略**：扩展页严格 `script-src 'self'`，沙箱使用 `unsafe-eval` 但通过 MV3 sandbox 机制隔离
- **权限最小化**：不使用 `clipboardRead`、`history` 等敏感权限，不声明 `externally_connectable`
- **沙箱隔离**：第三方开发工具在 sandbox 页中执行，无 chrome.* API 访问
- **用户控制**：统计上报可关闭，工具按需安装，UI 模式可选 Lite/Omni
- **主要风险面**：全局 content_script 注入（evalCore）、油猴脚本用户代码执行、热修复机制未经签名验证

建议用户仅从 Chrome Web Store 安装、避免使用来源不明的第三方开发工具、启用 `FORBID_STATISTICS` 以关闭使用统计上报。
