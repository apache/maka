# ContextSearch web-ext 安全审计报告

> 审计版本: v1.48.4.13 | 审计日期: 2026-07-05
> 审计范围: 源码静态分析，不含动态运行时验证

## 一、权限面评估

### 1.1 已声明权限

| 权限 | 风险等级 | 说明 |
|------|----------|------|
| `activeTab` | 低 | 仅在用户交互时获取当前标签页访问权 |
| `contextMenus` | 低 | 右键菜单 API，无直接安全风险 |
| `storage` | 低 | 本地存储，数据不出浏览器 |
| `tabs` | 中 | 可读取/修改标签页 URL 和状态 |
| `unlimitedStorage` | 低 | 允许无限本地存储 |
| `webNavigation` | 中 | 可获取所有 frame 信息，监控导航事件 |
| `scripting` | 高 | 可在任意页面执行脚本 (`executeScript`) |
| `userScripts` | 高 | 可在页面 MAIN world 注册持久化用户脚本 |
| `sidePanel` | 低 | 侧边栏 API |
| `host_permissions: <all_urls>` | 高 | 可访问所有网站的内容 |
| `bookmarks` (可选) | 中 | 读取用户书签 |
| `clipboardWrite/Read` (可选) | 中 | 读写剪贴板 |
| `nativeMessaging` (可选) | 高 | 调用本地原生程序 |
| `downloads` (可选) | 中 | 下载文件 |

### 1.2 权限必要性评估

| 权限 | 必要性 | 说明 |
|------|--------|------|
| `scripting` + `<all_urls>` | 核心功能必须 | 页面注入、右键菜单搜索依赖 |
| `userScripts` | 核心功能必须 | 执行用户自定义搜索脚本 (searchCode) |
| `webNavigation` | 功能增强 | 检测 iframe 注入、高亮域名跟踪 |
| `nativeMessaging` | 可选功能 | 外部程序调用，需额外安装 Native Host |
| `clipboardRead` | 边缘功能 | 仅 `CopyPaste.templateUsesClipboard` 使用 |

## 二、代码注入风险

### 2.1 Content Script 注入 (中等风险)

`init_content.js` 通过 `run_at: document_start` + `all_frames: true` + `<all_urls>` 在所有页面尽早注入。

**风险点**:
- 注入范围过大（all_urls + all_frames），虽通过 `mousedown` 事件延迟触发主逻辑，但 Shadow DOM 创建在每次注入都会执行
- `about:blank` iframe 直接注入（Zimbra 兼容修复），可能导致意外注入

**缓解措施**:
```javascript
// inject.js 通过 isAllowedURL 检查 URL 是否在 blockList 中
function isAllowedURL(_url) {
    // 检查 hostname 精确匹配
    // 检查正则匹配
    // 检查通配符匹配
}
```

### 2.2 用户脚本执行 (高风险)

`searchCode` 字段允许用户定义在搜索结果页面执行的 JavaScript 代码。

```javascript
// background.js executeUserScript()
// Chrome: browser.userScripts.execute() in USER_SCRIPT world
// Firefox: browser.scripting.executeScript() in MAIN world + pre-registered scripts
```

**风险点**:
- `searchCode` 在页面 MAIN world 执行，具有完全页面访问权限
- Blob URL 模式 (`scriptsUseBlobs`) 绕过 CSP: 将代码包装为 Blob URL 然后 `<script src=blobURL>`
- 没有代码内容审计机制
- `postScript` (外部程序后处理脚本) 同样具有完全权限

```javascript
// 完整的 CSP 绕过
const blobCode = (c, s) => `
    (() => {
        const blob = new Blob([\`CS_searchTerms = searchTerms = "${s}";${c}\`], {type: "text/javascript"});
        let script = document.createElement('script');
        script.src = URL.createObjectURL(blob);
        document.getElementsByTagName('head')[0].appendChild(script);
    })();
`;
```

**风险评级**: 高。这是设计意图，但缺少沙箱隔离。

### 2.3 外部程序调用 (高风险)

```javascript
// background.js executeExternalProgram()
let msg = {
    path: path,           // 命令行模板 (用户可自定义)
    cwd: node.cwd,        // 工作目录
    return_stdout: ...,   // 是否返回标准输出
    downloadURL: ...,     // 下载 URL
    downloadFolder: ...   // 下载目录
};
browser.runtime.sendNativeMessage("contextsearch_webext", msg);
```

**风险点**:
- `path` 由用户自定义，可包含任意命令，通过 `{searchTerms}` 注入
- 搜索词未经过滤直接拼接到命令行
- 命令注入示例：搜索词 `"; rm -rf /; echo "` 可能导致灾难

```javascript
// opensearch.js replaceOpenSearchParams 中的搜索词替换
// searchTerms 通过 encodeURIComponent 编码放入 URL，但命令行路径不编码
let path = await replaceOpenSearchParams({
    template: node.path,       // 直接替换 {searchTerms}
    searchterms: searchTerms,  // 原始搜索词
    url: info.tab.url
});
```

**风险评级**: 高。需要命令行参数转义。

## 三、数据安全

### 3.1 存储安全

| 存储 | 内容 | 敏感性 |
|------|------|--------|
| `storage.local` | userOptions (搜索引擎 URL 模板、搜索词历史、书签脚本代码) | 中 |
| `storage.session` | lastSearch (最近搜索词)、clipboard (剪贴板内容) | 中 |

- `storage.local` 中的 `searchBarHistory` 存储明文搜索历史
- `storage.session` 中的 `clipboard` 存储剪贴板内容用于 `{clipboard}` 模板

**风险点**: 搜索历史以明文存储，无加密。

### 3.2 跨源请求

```javascript
// background.js "fetchURI" handler
case "fetchURI":
    return fetch(message.url)
        .then(response => response.blob())
        .then(blob => {
            let reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.readAsDataURL(blob);
        });
```

**风险点**: `fetch` 调用接受消息传来的 URL，虽有 Service Worker 隔离，但可被滥用为开放代理。恶意页面（通过 content script 通信）可利用此接口请求任意 URL 并将结果返回。

**风险评级**: 中。缺乏 URL 白名单或来源验证。

### 3.3 图标缓存

`cacheIcons()` 将搜索引擎图标以 Base64 存储在 `userOptions.iconCache` 中。图标从搜索引擎网站拉取，如果搜索引擎的 favicon URL 被恶意利用，可能泄露信息。

## 四、消息通信安全

### 4.1 消息路由

```javascript
// background.js notify() - 中央消息路由器
// 接收来自 content script / popup / options 的消息
// 通过 message.action 进行 switch-case 分发
```

**风险点**:
- `sender.tab` 可来自任意标签页，对于某些消息缺少来源验证
- `action` 没有白名单校验，可能触发未预期的代码路径
- `saveUserOptions` 接受任意来源的 userOptions，缺少数据校验

**实际缓解**: 扩展自身的页面 (popup/options/sidebar) 通过 `browser.runtime.sendMessage` 发送，无法被外部页面伪造；content script 只能从注入页面发送。但 `message.source` 仅用于日志追踪。

### 4.2 表单数据到搜索引擎转换

```javascript
case "dataToSearchEngine":
    return dataToSearchEngine(message.formdata);
```

`dataToSearchEngine` 直接使用来自 content script 的表单数据构建搜索引擎对象，如果 content script 被恶意页面篡改（理论场景），可能注入恶意搜索引擎 URL。

## 五、节点树安全

### 5.1 序列化/反序列化

```javascript
// searchEngineManager.js
userOptions.nodeTree = JSON.parse(JSON.stringify(rootElement.node));
```

节点树通过 JSON 序列化往返。如果 `searchCode`、`postScript` 等字段包含恶意代码，在序列化/反序列化后依然保留。这是设计意图但值得注意。

### 5.2 导入安全

```javascript
// import_export.js: importSettings
// 从文件导入 JSON，直接合并到 userOptions
```

**风险点**: 导入的 JSON 未经过完整验证，`searchCode` / `postScript` 等字段可包含任意 JS 代码。攻击者可构造恶意 JSON 诱导用户导入。

**缓解**: `updateUserOptionsObject` 进行类型检查 (`typeof obj[key] !== typeof obj2[key]`)，但代码内容不检查。

## 六、CSP 和 Web 可访问资源

### 6.1 Web Accessible Resources

```json
"web_accessible_resources": [{
    "resources": [
        "/quickmenu.html", "/addContextSearchEngine.html",
        "/searchbar.html", "/findbar.html", "/pagetiles.html",
        "/blank.html", "/inject_widgets.css", "/inject_sidebar.css",
        "icons/search.svg", "icons/crossmark.svg", ...
    ],
    "matches": ["<all_urls>"]
}]
```

**风险点**: 所有 HTML 资源对所有网站开放。恶意页面可以 iframe 这些资源并尝试通过 postMessage 进行交互。

**缓解**: iframe 页面通过 `browser.runtime.sendMessage` 与 Service Worker 通信，该 API 对外部页面不可用。但 iframe 内的 UI 状态可能被外部 postMessage 干扰。

### 6.2 内联脚本

popup/quickmenu/options HTML 中使用 `<script src=...>` 标签加载脚本。这是 MV3 允许的（扩展页面有宽松的 CSP），安全风险较低。

## 七、依赖安全

| 库 | 版本 | 用途 |
|----|------|------|
| `browser-polyfill.min.js` | (webextension-polyfill) | 统一 Chrome/Firefox API |
| `encoding-indexes.js` + `encoding.min.js` | (encoding.js) | 非 UTF-8 字符集编码 |
| `mark.es6.min.js` | (mark.js) | 页面文本高亮 |

建议: 确认这些库来自可信来源，定期检查更新。

## 八、风险总结

| 风险项 | 等级 | 类别 | 建议 |
|--------|------|------|------|
| searchCode 在 MAIN world 执行 | 高 | 设计特性 | 文档警告用户仅导入可信配置 |
| Blob URL CSP 绕过 | 高 | 实现方式 | 可考虑改用 `scripting.executeScript` in ISOLATED world |
| 外部程序命令注入 | 高 | 缺少转义 | 对搜索词进行 Shell 转义 |
| fetchURI 开放代理 | 中 | 缺少验证 | 添加 URL 白名单或限制来源 |
| searchCode 导入无验证 | 中 | 缺少审计 | 导入时展示代码摘要供用户确认 |
| 剪贴板 session 存储 | 中 | 数据泄露 | 存储后设置过期时间 |
| 搜索历史明文存储 | 低 | 隐私 | 为用户提供加密选项 |

## 九、总体评估

ContextSearch web-ext 是一款功能丰富的搜索引擎集成工具。其核心风险来自 **用户自定义脚本执行** 和 **外部程序调用** 两个设计特性，这些特性是其高级功能的基础，但同时也引入了最大的攻击面。建议用户仅从可信来源导入配置，谨慎使用外部程序调用功能。

扩展本身未发现明显恶意代码或后门，代码风格一致，功能边界清晰。
