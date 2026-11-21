# Shortkeys v5.0.1 — 安全审计报告

## 审计概要

| 维度 | 评级 | 说明 |
|------|------|------|
| 权限面 | 高风险 | 13 权限 + `*://*/*` host, 含 debugger/userScripts/management/browsingData |
| 数据流 | 中风险 | 数据仅本地存储, 但 `externally_connectable` 允许外部页面通信 |
| CSP | 中风险 | 允许外部 CDN 加载样式, `unsafe-inline` style |
| 注入面 | 高风险 | `innerHTML` 大量使用, `new Function()` 执行用户代码, `userScripts` MAIN world 注入 |
| 通信安全 | 中风险 | 外部可连接白名单有限, 但 `fetchUrl` 消息可代理任意 HTTP 请求 |
| 存储安全 | 低风险 | chrome.storage 加密存储, 无本地明文敏感信息 |
| 隐私 | 中风险 | 使用统计收集 (可关闭), URL 匹配处理 |
| 依赖安全 | 低风险 | 仅 Mousetrap.js 一个内联库, 无 npm 供应链风险 |
| 合规 | 待定 | 未发现隐私政策链接; 数据收集默认启用 |

## 1. 权限面分析

### 1.1 debugger 权限 (高风险)

**用途**: 完整页面截图 (通过 CDP `Page.captureScreenshot`)

**代码路径**: `background.js` 截图模块
```
debugger.attach({tabId}, "1.3") →
  Emulation.setDeviceMetricsOverride({height}) →
  Page.captureScreenshot →
  debugger.detach({tabId})
```

**风险评估**:
- debugger 权限是 Chrome 最高权限之一, 可完全控制标签页
- 使用后立即 detach, 不持续占用
- CDP 协议版本固定为 "1.3", 无动态版本选择
- **仅用于截图**, 无其他 CDP 命令调用
- 攻击面: 若快捷键配置被恶意修改, 攻击者理论上可添加更多 debugger 调用

**缓解建议**:
- 当前实现已遵循最小权限原则 (仅用必需的 CDP 方法)
- 建议在 attach/detach 间添加超时保护, 防止异常导致 debugger 未释放

### 1.2 userScripts 权限 (高风险)

**用途**: 在 MAIN world 执行用户自定义 JavaScript (`action=javascript`)

**代码路径**: `background.js` userScripts 模块
```
chrome.userScripts.register({
  id: "shortkeys-actions",
  matches: ["*://*/*"],
  world: "MAIN",
  js: [{code: "var handlers = {...}; ..."}]
})
```

**风险评估**:
- `userScripts` 允许在 MAIN world 执行任意代码, 可访问页面全部 JavaScript 上下文
- 脚本注入范围是 `*://*/*` (所有网站)
- 用户自定义 JavaScript 被包装在 `new Function()` 中执行
- 如果通过外部导入获得恶意快捷���配置, 攻击代码可在任意网站上执行

**安全措施**:
- 代码通过 `shortkeys_js_run` CustomEvent 桥接, Content Script 只传递 shortcutId
- 实际代码由 Service Worker 在注册时写入 userScript, 非运行时注入
- `new Function()` 包装限制了闭包访问, 仅能访问全局变量

**缓解建议**:
- 添加用户代码沙箱 (如 Web Worker 或 iframe sandbox)
- 导入配置时对 JavaScript 代码进行静态分析/警告
- 考虑添加 CSP nonce 限制

### 1.3 management 权限 (低风险)

**用途**: 启动已安装的 Chrome App (`openapp` 操作)

**风险评估**:
- 仅调用 `chrome.management.launchApp(appId)`, 不读取/修改扩展列表
- 需要用户提供 App ID (非自动发现)
- Chrome Apps 已逐步淘汰, 该功能使用场景有限

### 1.4 browsingData 权限 (中风险)

**用途**: 清除下载历史 (`cleardownloads` 操作)

**代码路径**:
```javascript
chrome.browsingData.remove({since: 0}, {downloads: true})
```

**风险评估**:
- **仅清除 downloads**, 不涉及 cookies/cache/passwords 等其他数据类型
- `since: 0` 表示清除全部历史 (不可恢复)
- 如果被误触发, 会丢失所有下载记录

**缓解建议**:
- 考虑添加确认提示 (当前无)
- 或限制清除时间范围

### 1.5 其他权限

| 权限 | 调用范围 | 风险 |
|------|----------|------|
| `tabs` | 查询/创建/更新/删除/移动 标签页 | 中 — 标准标签管理 |
| `sessions` | 恢复最近关闭的标签页 (仅 `maxResults:1`) | 低 |
| `bookmarks` | 按标题搜索/创建/删除书签 | 中 — 不可逆删除 |
| `downloads` | search (仅 completed) + show | 低 — 只读+显示 |
| `scripting` | executeScript (特定函数, 非字符串) | 中 — 使用函数引用非字符串 |
| `clipboardWrite` | 写入剪贴板 | 低 — 单向写入 |
| `clipboardRead` (optional) | 运行时请求权限 | 中 — 可读取敏感剪贴板内容 |
| `notifications` | 升级通知 + 按钮 | 低 |
| `host: *://*/*` | content script + userScript | 高 — 全站点访问 |

## 2. CSP 分析

**声明的 CSP**:
```
script-src 'self';
object-src 'self';
style-src 'self' 'unsafe-inline';
style-src-elem 'self' 'unsafe-inline' https://cdn.materialdesignicons.com https://cdn.jsdelivr.net;
```

**评估**:
- `script-src 'self'` — 严格限制, 仅允许扩展自身脚本, 良好
- 无 `script-src` unsafe-eval 声明, 但代码中使用 `new Function()` — 在 MV3 扩展中 `new Function()` 无需 CSP 声明 (扩展页面默认允许)
- `style-src 'unsafe-inline'` — 允许内联样式, 低风险 (非脚本)
- CDN 外部样式 — 依赖第三方 CDN (materialdesignicons, jsdelivr), 若 CDN 被入侵可能注入恶意 CSS (可窃取通过 CSS 属性选择器提取的表单数据)

**缓解建议**:
- 考虑将 Material Design Icons 的 CSS 打包进扩展, 消除 CDN 依赖
- 或使用 SRI (Subresource Integrity) 哈希

## 3. 注入面分析

### 3.1 innerHTML 使用

**位置**: 内建页面脚本 (`reader-mode`, `json-viewer` 等)

**风险**:
- `reader-mode`: 将 `article.innerHTML` 直接插入 `document.body.innerHTML` — 如果原页面包含恶意 HTML, 会被保留
- `json-viewer`: 将 `JSON.parse(document.body.innerText)` 的结果通过 `JSON.stringify` 后插入 innerHTML — 安全的序列化路径
- `cheat-sheet`: 使用 `textContent` 和手动 DOM 构建, 安全
- `link hints`: 使用 `textContent`, 安全

**评估**: 中等风险。`reader-mode` 操作保留了原始 HTML 内容, 可能保留恶意脚本标签 (虽然 MV3 内容脚本隔离了执行环境, 但通过 userScripts 桥接存在间接风险)

### 3.2 new Function() 执行

**位置**: `background.js` 宏执行模块 和 `content.js` JS 执行模块

```javascript
// 宏中的 JavaScript 步骤
c(i => new Function(i)(), [n])  // scripting.executeScript

// 用户快捷键 JavaScript
new Function(r)()  // 通过 userScripts 注入
```

**评估**: 这是 Shortkeys 核心功能, 但 `new Function()` 本质上是 `eval()` 的别名。攻击者若能修改快捷键配置 (如通过外部导入或存储投毒), 可在用户浏览器中执行任意代码。

### 3.3 书签 JavaScript URL 执行

**代码路径**: `openbookmark` 操作
```javascript
if (r.url.startsWith("javascript:")) {
  let e = decodeURIComponent(r.url.replace("javascript:", ""));
  c(n => document.dispatchEvent(new CustomEvent("shortkeys_js_run", {detail:n})), [e])
}
```

**评估**: 支持执行 bookmarklet (javascript: URL), 继承了浏览器书签的安全模型。bookmarklet 代码通过同样的 userScripts 桥接执行。

## 4. 通信安全

### 4.1 externally_connectable

**配置**:
```json
"externally_connectable": {
  "matches": ["https://shortkeys.app/*", "http://localhost/*"]
}
```

**评估**:
- 白名单限制严格: shortkeys.app (HTTPS) 和 localhost (仅开发)
- 接收的操作仅限于 `importShortcuts`, 必须包含有效的 shortcuts 数组
- 导入的数据会合并到现有快捷键配置中
- 风险: 恶意网站 (或 shortkeys.app 被入侵) 可推送恶意快捷键配置
- localhost 允许任意本地页面通信 (开发便利性 vs 安全风险)

### 4.2 fetchUrl 消息处理

**代码路径**: Service Worker 消息处理
```javascript
if (i === "fetchUrl") {
  return fetch(r.url).then(s => s.text()).then(s => n({text: s}))
}
```

**评估**:
- 允许内容脚本代理任意 HTTP 请求, 绕过页面 CORS 限制
- Service Worker 的 fetch 不受 CORS 限制, 可请求任意 URL
- 这实际上是一个 SSRF-like 代理: 内容脚本可让后台请求任意 URL 并返回文本
- 风险: 如果恶意网页能向扩展发送消息 (通过 externally_connectable), 可利用此代理发起请求

**缓解建议**:
- 限制 fetchUrl 仅允许内容脚本发起 (检查 sender 来源)
- 或完全移除此功能, 改用其他方式实现需求

### 4.3 内容脚本消息验证

内容脚本通过 `runtime.sendMessage` 与后台通信, 接收的操作直接路由到命令分发器执行。当前无消息签名或来源验证 (Chrome 自身提供 sender 验证, 但代码中未检查)。

## 5. 存储安全

**存储位置**: `chrome.storage.sync` + `chrome.storage.local`

**存储内容**:
- 快捷键配置 (JSON): 键位绑定、操作类型、参数
- 分组设置 (JSON): activateOn/deactivateOn URL 模式
- 使用统计: 快捷键使用次数、日期

**评估**:
- 无明文密码、Token 或 API Key 存储
- Chrome 存储自动加密 (基于 OS 用户登录凭据)
- 同步到 Google 账户的数据受 Google 云端加密保护
- 风险: 如果快捷键配置中包含用户自定义 JavaScript (action=javascript), 这些代码会通过 sync 跨设备同步, 可能导致恶意代码传播

## 6. 隐私分析

### 6.1 使用统计

- 默认**启用** (`usageEnabled` 默认为 true 除非显式设为 false)
- 收集: 快捷键 ID + 使用次数 + 时间戳
- 保留 90 天每日统计数据
- **仅本地存储**, 不上传云端 (storage.local)
- 无 Google Analytics 或第三方遥测

### 6.2 URL 匹配

- 快捷键过滤使用当前页面 URL 进行站点匹配 (glob/regex)
- URL **不会**被存储或发送到外部
- `gototab` 操作使用 URL 模式匹配标签页, 仅本地查询

### 6.3 页面内容访问

- `searchgoogle/youtube/wikipedia/github` 操作读取用户选中的文本并构造搜索 URL
- 选中文本**不会**被存储或发送到 Shortkeys 服务器
- 按键监听 (`keydown/keypress/keyup`) 仅用于快捷键匹配, 不记录按键内容

### 6.4 通知

- 仅在扩展升级时显示一次通知 (指向设置页)
- 不发送营销或推广通知

## 7. 依赖安全

| 依赖 | 来源 | 版本 | 已知漏洞 |
|------|------|------|----------|
| Mousetrap.js | 内联代码 (修改版) | 未知 | 原始库最后一个 release 为 2016 年 (v1.6.5), 长期未维护 |
| Material Design Icons | CDN (cdn.materialdesignicons.com 7.4.47) | 7.4.47 | 无已知漏洞 (仅 CSS/字体) |
| Material Design Icons | CDN (cdn.jsdelivr.net @mdi/font@7) | 7.x | 同上 |

**评估**:
- Mousetrap.js 是唯一的功能性依赖, 已内联到代码中
- 无 npm 依赖, 无供应链攻击面
- Mousetrap.js 自 2016 年未更新, 但功能简单 (键盘事件处理), 代码体积小, 易于审计
- CDN 依赖仅用于图标字体, 功能降级影响有限

## 8. 合规评估

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 隐私政策 | 缺失 | 未在扩展描述或设置页中发现隐私政策链接 |
| 数据收集声明 | 部分 | 使用统计默认启用, 但未明确告知用户 |
| GDPR 合规 | 部分 | 数据仅本地存储, 但 sync 涉及 Google 云端 |
| 儿童数据 | 无特殊处理 | - |
| 安全披露 | 缺失 | 未发现安全联系方式或漏洞报告渠道 |

## 9. 总体风险评级: 中-高

### 优点
- 数据仅本地存储, 无外部服务器通信 (除 CDN 和下载文件时的 fetch)
- CSP 严格限制 script-src
- 使用 chrome.storage 加密存储, 无明文敏感数据
- `externally_connectable` 白名单严格

### 需关注
- **debugger** 权限使用后立即释放, 符合最小权限原则
- **userScripts** 是核心功能所需, 但默认注入所有网站
- **fetchUrl** 消息处理本质上是无限制的 HTTP 代理
- **innerHTML** 在 reader-mode 等操作中存在残留 HTML 风险
- **new Function()** 是功能必需, 但代码审查和导入验证不足
- 内建页面脚本经过明显设计, 未发现恶意代码模式

### 建议
1. 添加 fetchUrl 请求的调用者验证
2. reader-mode 操作中使用 DOMPurify 清洗 HTML
3. 导入快捷键配置时对 JavaScript 代码进行风险提示
4. 为 debugger 操作添加超时锁防止未释放
5. 将 CDN 资源本地化以减少外部依赖
6. 添加隐私政策链接
7. 使用统计默认禁用或首次安装时明确询问
