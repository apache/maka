# 安全审计文档 — Material Icons for GitHub (dsv4)

## 1. 审计范围

本报告对 **Material Icons for GitHub v1.16.2** 进行逆向工程安全审计，重点关注以下维度：

- 权限模型与最小权限原则
- Content Script 注入面
- 消息通信安全
- 存储安全
- DOM 操作安全
- 第三方依赖
- web_accessible_resources 暴露面

## 2. Manifest 权限评估

### 2.1 声明的权限

| 权限 | 级别 | 评估 |
|------|------|------|
| `storage` | 低风险 | 标准权限。用于读写用户设置，不涉及敏感 API。 |
| `activeTab` | 低风险 | 仅在用户主动点击扩展图标时获取当前标签页访问权。 |
| `scripting` | 低风险 | MV3 标准权限，配合 `activeTab` 使用，允许注入脚本。 |
| `optional_host_permissions: *://*/*` | 中风险 | 可选权限，需要用户显式授权。允许用户在任意站点使用扩展。 |

**结论**: 权限遵循最小权限原则。`optional_host_permissions` 是合理的——扩展的核心用途就是在任意 Git 托管站点上工作，且该权限是**可选**的（需要用户在运行时主动授权）。

### 2.2 运行时权限请求分析

在源码中未发现通过 `permissions.request()` 强制请求权限的逻辑。扩展仅在 manifest 中声明可选权限，用户需要在站点上手动触发。

## 3. Content Script 安全分析

### 3.1 注入时机 (`run_at: "document_start"`)

**风险**: Content script 在 `document_start` 阶段注入，意味着它在页面 DOM 构建之前就运行。这允许扩展在页面脚本执行前介入，但也意味着扩展代码在页面 JS 上下文完全可用之前运行。

**评估**: 无实际安全风险。扩展仅查询 DOM 和注入 `<img>` 元素，不执行任何来自页面上下文的代码。

### 3.2 匹配模式 (`matches`)

```json
"matches": [
  "*://github.com/*",
  "*://bitbucket.org/*",
  "*://dev.azure.com/*",
  "*://*.visualstudio.com/*",
  "*://gitea.com/*",
  "*://gitlab.com/*",
  "*://gitee.com/*",
  "*://sourceforge.net/*",
  "*://codeberg.org/*",
  "*://tangled.org/*"
]
```

**评估**: 所有匹配模式都是 HTTPS（虽然声明为 `*://`），但扩展会在 10 个目标站点中自动激活。这 10 个站点均为知名 Git 托管平台，风险可控。

### 3.3 DOM 操作安全性

#### 3.3.1 `<img>` 元素创建

```javascript
// 来自 main.js 逆向
let img = document.createElement("img");
img.setAttribute("data-material-icons-extension", "icon");
img.setAttribute("data-material-icons-extension-iconname", iconName);
img.setAttribute("data-material-icons-extension-filename", fileName);
img.src = chrome.runtime.getURL(svgPath);
```

**安全分析**:
- `chrome.runtime.getURL()` 生成的是 `chrome-extension://` 协议的 URL，不能引用外部资源
- SVG 路径来自扩展内置的硬编码映射，不接受用户输入
- `iconName` 和 `fileName` 来自扩展内部的字符串映射，不直接使用页面内容

**结论**: 无 XSS 风险。图标名称仅来自扩展内部的映射表，不由页面内容控制。

#### 3.3.2 `innerHTML` / `eval` 使用

**未发现 `innerHTML` 或 `eval` 的使用**。所有 DOM 操作均通过 `createElement` / `setAttribute` / `replaceChild` / `prepend` 等安全 API 完成。

#### 3.3.3 用户自定义文件关联

源码支持 `fileIconBindings` 和 `folderIconBindings` 设置，允许用户自定义文件扩展名到图标的映射：

```javascript
files: {
  associations: {
    "*.custom": "myIcon"   // 用户输入
  }
}
```

**风险分析**: 用户输入的 `key`（如 `*.custom`）和 `value`（如 `myIcon`）仅用于查找图标名称。如果用户输入一个不存在于 `iconDefinitions` 中的图标名，`chrome.runtime.getURL()` 会生成一个无效的扩展资源 URL（图片加载失败），但不会产生安全后果。

**结论**: 低风险。仅导致显示错误（broken image），不会导致代码执行。

## 4. 消息通信安全

### 4.1 `chrome.runtime.onMessage` 监听

```javascript
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.cmd === "init") {
    // 重新初始化图标注入
  }
  if (request.cmd === "guessProvider") {
    // 返回站点名称
  }
});
```

**安全分析**:
- 未使用 `sender` 验证消息来源（无 `sender.id` 检查确认是否来自同扩展）
- 命令集有限（`init` 和 `guessProvider`），均为幂等操作
- 无敏感数据通过消息传输

**风险**: 同一设备上的其他扩展理论上可以通过 `chrome.runtime.sendMessage(extensionId, ...)` 向此扩展发送消息。但后果仅限于重新渲染图标或查询站点名称，不涉及数据泄露或权限提升。

**建议**: 添加 `sender.id === chrome.runtime.id` 验证（防御性措施，当前风险极低）。

### 4.2 无外部消息监听

未注册 `onMessageExternal`，无法接收来自网站或外部客户端的消息。

## 5. 存储安全

### 5.1 `chrome.storage.sync`

- 存储键格式: `${hostname}:${settingKey}`
- 值类型: `string`、`boolean`、`object` (JSON)
- 无敏感信息存储（仅 UI 偏好设置）

**安全分析**: `chrome.storage.sync` 的数据会同步到用户的 Google 账户。虽然不涉及敏感数据，但设置数据会离开用户设备同步到云端。

**建议**: 可考虑对不需要跨设备同步的设置使用 `chrome.storage.local`。

### 5.2 自定义站点配置

用户可以通过 `customProviders` 设置自定义站点的选择器配置：

```javascript
{
  "mygitea.example.com": {
    "selectors": { "row": "...", "filename": "...", "icon": "..." }
  }
}
```

**风险**: 选择器字符串由用户提供，用于 `querySelectorAll()`。理论上如果用户输入恶意的复杂选择器，可能导致性能问题（ReDoS），但不会导致 XSS（`querySelectorAll` 不支持脚本执行）。

**结论**: 低风险。仅可能导致浏览器卡顿，不会导致代码执行。

## 6. Web Accessible Resources 安全

### 6.1 声明

```json
"web_accessible_resources": [
  {
    "resources": ["*.svg"],
    "matches": ["*://github.com/*", ..., "*://*/*"]
  }
]
```

**安全分析**:
- 仅暴露 SVG 图标文件
- SVG 文件均为静态矢量图形，不含脚本
- 通配符 `*://*/*` 匹配在所有站点可用（配合 `optional_host_permissions`）
- 即使恶意网站尝试通过 URL 访问这些 SVG 文件，也仅能获取图标数据

**风险**: SVG 文件可以被任意网站通过 `<img>` 标签引用（资源盗链），但实际影响为零——这些是 Material Design 图标，不存在授权问题。

**结论**: 无风险。但要确认所有 SVG 文件中不含有 `<script>` 标签。

### 6.2 SVG 文件内容验证

抽查了多个 SVG 图标文件，确认其为标准 Material Design SVG 路径数据，不含任何脚本标签或外部引用。

## 7. 第三方依赖

### 7.1 webextension-polyfill

`main.js` 中内联了完整的 `webextension-polyfill` 库（Mozilla 维护，广泛使用）。

- **来源**: 内联到打包产物中
- **版本**: 无法从打包产物中直接确认
- **已知漏洞**: 无公开 CVE（webextension-polyfill 是 API 适配层，攻击面极小）

### 7.2 其他依赖

由于 `main.js` 被高度打包压缩，无法逐一识别所有 npm 依赖。从代码模式推断：
- 可能使用 `deepmerge` 或类似的深度合并工具函数（`j()` 函数）

## 8. Content Security Policy

扩展未在 `manifest.json` 中显式声明 `content_security_policy`。在 MV3 中，默认 CSP 为：

```
script-src 'self'; object-src 'self'
```

此 CSP 对 content script 无效（content script 运行在页面上下文中），但对 options page 和 popup 有效。由于 options/settings-popup 的 JS 文件均来自扩展自身（`options.js`、`settings-popup.js`），默认 CSP 足够。

## 9. 综合评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 权限模型 | 优秀 | 遵循最小权限，optional_host_permissions 设计合理 |
| XSS 防护 | 优秀 | 无 innerHTML/eval，DOM 操作使用安全 API |
| 消息安全 | 良好 | 命令集有限，缺少 sender 验证（低风险） |
| 存储安全 | 良好 | 无敏感数据存储，storage.sync 可能过于宽泛 |
| 资源暴露 | 良好 | 仅 SVG 文件暴露，无脚本资源暴露 |
| 供应链安全 | 一般 | 打包产物难以审计，依赖版本不可见 |

### 总体结论

**此扩展的安全风险较低。** 作为纯 UI 增强型扩展，它不处理用户数据、不发起网络请求、不使用 `innerHTML`、不执行页面提供的代码。主要注意的是消息通信缺少 sender 验证（纯防御性建议）和打包产物缺乏供应链可见性。

### 改进建议（优先级低）

1. 添加 `chrome.runtime.onMessage` 的 `sender.id` 验证
2. 将非跨设备设置迁移到 `chrome.storage.local`
3. 考虑提供未压缩/可审计的源码版本
