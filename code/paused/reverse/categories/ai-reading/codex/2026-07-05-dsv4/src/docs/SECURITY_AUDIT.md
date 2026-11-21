# Codex 扩展安全审计报告

> 基于 Codex v1.1.5 源码静态逆向分析
> 审计范围: manifest.json + background.js + content-scripts/codex.js
> 审计日期: 2026-07-06 | 级别: **高风险**

---

## 一、总体风险评级

| 维度 | 评级 | 说明 |
|------|------|------|
| 攻击面 | **严重** | 全部网站可被脚本注入 + 调试器控制 |
| 权限滥用风险 | **高** | debugger + nativeMessaging + <all_urls> |
| 数据外泄风险 | **高** | Native Messaging 可发送任意浏览器数据 |
| 供应链风险 | **中** | CDN 字体加载、Vite 构建依赖 |
| 本地攻击面 | **中** | localhost WebSocket/HTTP 开放连接 |
| CSP 安全性 | **中-低** | 允许 localhost 回环连接但限制 script-src |

---

## 二、权限逐项分析

### 2.1 debugger (最高风险)

**风险等级: CRITICAL**

`debugger` 权限允许扩展：
- 附加 Chrome DevTools Protocol 调试器到 **任意标签页** (`<all_urls>`)
- 执行 `Page.navigate` — 任意页面导航
- 执行 `Runtime.evaluate` — 在页面上下文执行任意 JavaScript
- 执行 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` — 模拟键盘鼠标输入
- 读取所有网络请求 (Network domain)
- 读取 DOM 快照 (DOM domain)
- 读取 Cookie、LocalStorage、SessionStorage

**源码证据**:
```javascript
// background.js 中实际使用的 CDP 命令
chrome.debugger.attach({tabId}, "1.3")
chrome.debugger.sendCommand({tabId}, "Target.getTargets", ...)
chrome.debugger.sendCommand({tabId}, "Emulation.setDeviceMetricsOverride", ...)
chrome.debugger.onEvent.addListener(...)
chrome.debugger.onDetach.addListener(...)
```

**威胁场景**:
1. 恶意 AI 指令 → 登录页面注入 JS 窃取密码
2. 恶意 AI 指令 → 银行页面修改转账金额
3. 恶意 AI 指令 → 企业内网页面读取机密数据
4. 原生 Host 被入侵 → 完全控制浏览器

**缓解现状**: 无。扩展信任原生 Host，且原生 Host 的有效性取决于系统级安全。

---

### 2.2 nativeMessaging (高风险)

**风险等级: HIGH**

`nativeMessaging` 权限是扩展与外部原生应用的唯一桥梁：

- Host: `com.openai.codexextension`
- 支持: `stdin/stdout` 流式 JSON 通信
- 可以实现: 文件系统访问、进程管理、网络请求绕过 CSP

**源码证据**:
```javascript
// NativeTransport 类
chrome.runtime.connectNative("com.openai.codexextension")
this.port.postMessage(json)
this.port.onMessage.addListener(...)
this.port.onDisconnect.addListener(...)
```

**威胁场景**:
1. 伪造 Native Host 注册 → 拦截/篡改通信
2. Host 二进制被替换 → 恶意载荷注入
3. Host 权限过大 → 本地系统提权

**缓解**: Chrome 通过注册表/manifest 验证 Host 路径，但二进制完整性无额外校验。

---

### 2.3 <all_urls> 主机权限 (高风险)

**风险等级: HIGH**

扩展可访问 **所有 HTTP/HTTPS/File URL 页面**：
- 注入内容脚本 (覆盖层 + Favicon 管理)
- 通过 CDP 读/写页面内容
- `chrome.scripting.executeScript()` 执行任意代码

**威胁场景**:
1. 私有页面 (如 `file:///C:/Users/xxx/`) 被 AI 访问
2. 企业内网页面 (如 `http://intranet/`) 数据外泄
3. 支付页面临时注入表单窃取脚本

---

### 2.4 scripting (高风险)

**风险等级: HIGH**

`chrome.scripting.executeScript()` 允许在任意页面动态执行脚本，且不通过内容脚本注册。

---

### 2.5 tabs + tabGroups + sessions (中高风险)

**风险等级: MEDIUM-HIGH**

- 读取所有标签页 URL/标题/Favicon
- 创建、关闭、分组标签页
- 恢复 `sessions` (可能包含敏感浏览历史)
- 标签租约机制可阻止用户手动操作

---

### 2.6 downloads + downloads.ui (中风险)

**风险等级: MEDIUM**

- 监控所有下载 (URL、文件名、进度)
- `downloads.ui` 控制下载 UI 可见性

---

### 2.7 history + bookmarks + topSites (中风险)

**风险等级: MEDIUM**

- 读取完整浏览历史 (`chrome.history.search`)
- 读取/修改书签
- 读取常用网站 (`topSites`)

**源码证据**: `chrome.history.search` 已实际调用；`bookmarks` 和 `topSites` 权限声明但未在 background.js 中发现直接调用痕迹。

---

### 2.8 notifications + alarms (低风险)

**风险等级: LOW**

- `notifications`: 声明但未发现调用
- `alarms`: 用于心跳和重连，属于基础设施

---

## 三、通信安全分析

### 3.1 Native Messaging 通道

| 属性 | 值 |
|------|-----|
| 加密 | 无 (进程间 stdin/stdout) |
| 认证 | 无 (依赖系统级 Host 注册) |
| 完整性 | 无 (JSON 消息无签名) |
| 重放保护 | 无 |

**风险**: 同一台机器上的其他进程理论上可以连接到 Native Host (取决于 Host 实现)。

### 3.2 WebSocket/HTTP localhost 通道

**CSP 声明**:
```
connect-src: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*
```

**风险**:
- localhost **所有端口** 开放 (通配符 `:*`)
- **无 WSS** (加密 WebSocket) 要求
- **无 HTTPS** 要求
- 本地其他应用可监听同端口进行中间人攻击

**源码证据**: `ensureCodexAppServer` 函数名称暗示扩展会主动尝试连接本地服务。

### 3.3 内容脚本通信

- 使用 `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`
- Chrome 内部消息通道，加密传输
- 消息内容为明文 JSON

---

## 四、CSP 策略分析

```
script-src  'self'
object-src  'none'
connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*
font-src    'self' https://cdn.openai.com
```

| 指令 | 评价 |
|------|------|
| `script-src 'self'` | 安全，禁止内联脚本和远程脚本 |
| `object-src 'none'` | 安全，禁止 Flash/Java 插件 |
| `connect-src` | **过于宽松** — localhost 通配符 (`:*`) 所有端口 |
| `font-src` | 接受 — `cdn.openai.com` 特定域名加载字体 |
| 缺失 `style-src` | 允许内联样式 (Tailwind 需要) |
| 缺失 `img-src` | 无限制 |

---

## 五、数据隐私分析

### 5.1 可被 AI 访问的浏览器数据

| 数据类型 | 访问方式 | 数据量 |
|---------|---------|--------|
| 浏览历史 | `chrome.history.search` | 完整历史 |
| 标签页状态 | `chrome.tabs.query` | 所有打开的页面 URL/标题 |
| 书签 | `chrome.bookmarks.*` | 完整书签树 |
| 下载记录 | `chrome.downloads.onCreated/onChanged` | 实时监控 |
| 页面内容 | CDP DOM/Runtime 域 | 任意页面完整 DOM |
| Cookies | CDP Network 域 | 所有域名 Cookies |
| 输入内容 | CDP Input 域 | 键盘输入事件 |
| 截图 | CDP Page.captureScreenshot | 页面视觉内容 |
| 密码字段 | CDP DOM + Input | 即使 type=password 也可读取 |

### 5.2 数据流向

```
用户浏览器数据 → Background SW → Native Host → AI 云端/本地模型
```

**所有数据最终离开浏览器进程到达 Native Host**，Native Host 的网络行为不受扩展 CSP 限制。

---

## 六、Favicon 注入风险

### 6.1 SVG 合成安全性

内容脚本通过以下方式替换 Favicon:
```
data:image/svg+xml,<svg>...原 favicon + 徽章叠加...</svg>
```

**XSS 风险**: 
- 原 `faviconUrl` 通过 `replaceAll("&", "&amp;")` 等转义后插入 `<image href="..."/>`
- 转义覆盖了 `&`, `"`, `<`, `>` 四个字符
- 使用 `encodeURIComponent` 包裹整个 SVG (但 `data:` URI 内的 SVG 不依赖 HTML 解析)

**结论**: 转义措施基本有效，但最安全的做法是避免在 SVG 中嵌入用户可控 URL 字符串。

---

## 七、Shadow DOM 隔离评估

Agent Cursor Overlay 使用:
```javascript
element.attachShadow({mode: "closed"})
```

| 属性 | 评价 |
|------|------|
| 样式隔离 | 有效 — Shadow DOM 内的样式不影响页面 |
| 脚本访问 | `mode: "closed"` 阻止 `element.shadowRoot` 访问 |
| DOM 持久性 | MutationObserver 监控 + 自动重新注入 |
| 事件隔离 | `pointer-events: none` 防止交互干扰 |

**已知局限**: 页面可以通过 `Element.prototype.attachShadow` 猴子补丁检测/阻止 Shadow DOM 创建，但这对安全模型影响有限。

---

## 八、Service Worker 持久性

### 8.1 保活机制

- `chrome.alarms` 定期触发心跳 (`client-heartbeat-alarm`)
- `chrome.alarms` 定期触发重连 (`native-transport-reconnect`)
- Native Host 消息唤醒休眠的 Service Worker

### 8.2 SW 终止风险

- 30 秒无活动后 SW 可能被终止
- 终止时丢失内存状态 (变量、连接)
- 重新启动需要重新建立 Native 连接

**缓解**: `chrome.storage.session` 存储关键会话状态以在重启时恢复。

---

## 九、建议安全加固

### 9.1 高优先级

1. **限制 connect-src 端口范围** — 将 `:*` 替换为具体端口号
2. **强制 WSS** — 要求 WebSocket Secure 连接
3. **Native Host 消息签名** — 添加 HMAC/Ed25519 消息认证
4. **CDP 命令白名单** — 限制可执行的 CDP 方法集合
5. **敏感页面保护** — 检测并拒绝在已知敏感域名 (银行、邮箱、内网) 执行自动化

### 9.2 中优先级

6. **权限最小化** — 评估并移除未使用的 `bookmarks`、`topSites`、`notifications` 权限
7. **Favicon 完整性** — 考虑 CSP hash 验证 data: URI
8. **内容脚本签名** — 页面可验证注入脚本的完整性

### 9.3 低优先级

9. **日志记录** — 添加自动化操作审计日志
10. **用户可见指示器** — 当 debugger 附加时始终显示 UI 提示

---

## 十、已知安全边界

此扩展的安全模型 **根本上依赖以下假设**:

1. **Native Host 二进制是可信的** — 由 OpenAI 签名分发
2. **用户系统未被入侵** — 没有其他进程伪造 Native Host 注册
3. **AI 模型行为可控** — AI 不会生成恶意浏览器操作指令
4. **localhost 端口安全** — 本地网络不会被其他应用监听

**如果以上假设被打破，攻击者可通过此扩展完全控制用户浏览器。**

---

## 十一、审计方法论

- **静态分析**: 直接读取 minified JS 源码 (background.js ~145KB)
- **清单分析**: manifest.json 权限 + CSP + 资源声明
- **模式识别**: 正则匹配 API 调用 + 字符串常量 + 类/函数名
- **内容脚本分析**: WXT 框架注入逻辑 + Shadow DOM + Canvas 动画
- **限制说明**: 未进行动态运行时分析 (如 Frida 插桩或流量抓包)
