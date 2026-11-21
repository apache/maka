# Automa v1.30.01 — 安全审计报告

> 本报告基于对 Automa v1.30.01 Chrome 扩展 Webpack bundle 的静态分析编写。
> 分析方法：代码模式扫描、权限面分析、数据流追踪、第三方库审计。
> 审计日期：2026-07-06

---

## 总览

| 维度 | 等级 | 说明 |
|------|------|------|
| 权限面 | 严重 | 拥有 11 项权限 + `<all_urls>` 主机权限 |
| 数据外传 | 高 | 多重数据通道 (Supabase, fetch(), debugger CDP) |
| CSP (内容安全策略) | 中 | sandbox 页面无 CSP，其他页面依赖默认 CSP |
| 注入面 | 严重 | `new Function()` 多处使用，用户 JS 执行，动态脚本注入 |
| 通信安全 | 中 | 扩展内部消息无加密/验证层 |
| 存储安全 | 中 | Session token 存储在 localStorage + chrome.storage |
| 隐私 | 高 | 可捕获任意网站的 DOM/网络/用户操作 |
| 依赖风险 | 低 | 使用主流成熟库，但版本固定于构建时 |
| 合规性 | 中 | 部分功能边界模糊，需关注 Chrome Web Store 策略 |

---

## 一、权限面分析

### 1.1 权限清单与风险评估

| # | 权限 | 能力 | 滥用风险 | 缓解措施 |
|---|------|------|----------|----------|
| 1 | `<all_urls>` | 访问所有网站内容 | 可窃取任意网站敏感数据 | 通过 `activeTab` 限制部分场景 |
| 2 | `debugger` | Chrome DevTools Protocol 全部功能 | 可拦截/修改网络请求、注入 JS、读取所有数据 | 仅通过 offscreen 代理触发 |
| 3 | `proxy` | 设置浏览器代理 | 可实施中间人攻击、重定向所有流量 | settings API 需用户感知 |
| 4 | `tabs` | 创建/关闭/查询/注入标签页 | 可静默在任意标签页执行代码 | 通过内容脚本 + sendMessage |
| 5 | `scripting` | 动态脚本注入 | 任意页面上执行代码 | API 调用受 background 控制 |
| 6 | `storage` + `unlimitedStorage` | 无限本地存储 | 可存储大量窃取数据 | 本地沙箱隔离 |
| 7 | `webNavigation` | 监听所有导航事件 | 可追踪用户完整浏览历史 | 仅在触发器匹配时使用 |
| 8 | `alarms` | 定时任务 | 可持续后台运行恶意代码 | 受 idle 超时限制 (MV3) |
| 9 | `activeTab` | 当前标签页访问 | 作为 `<all_urls>` 的补充 | 用户操作 gating |
| 10 | `offscreen` | 创建 Offscreen Document | DOM API + debugger 宿主 | 无直接用户交互 |
| 11 | `cookies` (可选) | 读写 Cookie | 窃取认证 token | 仅按需请求 |
| 12 | `downloads` (可选) | 下载管理 | 静默下载恶意文件 | 用户可见 |
| 13 | `contextMenus` (可选) | 右键菜单 | 钓鱼入口 | 用户触发 |
| 14 | `clipboardRead` (可选) | 读取剪贴板 | 窃取密码等剪贴板内容 | 仅按需请求 |
| 15 | `notifications` (可选) | 系统通知 | 鱼叉式钓鱼 | 用户可控 |

### 1.2 关键发现

**F-001: debugger 权限是最危险的能力**
- `chrome.debugger` 授予对任意标签页的完整 CDP 控制权，包括 Network、DOM、Runtime 域
- 可用于：拦截/修改 HTTP 请求 (Network.requestIntercepted)、注入任意 JS (Runtime.evaluate)、读取密码字段 (DOM.getDocument)
- Automa 仅通过 Offscreen Document 代理使用此权限，限制了直接的 background 访问，但未限制 CDP 命令类型

**F-002: `<all_urls>` + `all_frames: true` 全页面注入**
- content_scripts 配置为 `matches: ["<all_urls>"]`, `all_frames: true`, `match_about_blank: true`, `run_at: "document_start"`
- 意味着 content script 注入到用户访问的**每一个**页面、**每一个** iframe（包括 about:blank）
- 包括银行页面、企业内部系统、邮件等敏感环境

**F-003: 12 个可选权限中的 7 个为高风险**
- cookies + clipboardRead + downloads + proxy + contextMenus 组合可用于完整的会话劫持 + 数据外传链

---

## 二、数据外传分析

### 2.1 数据出口点

| 出口 | 数据 | 触发条件 | 检测难度 |
|------|------|----------|----------|
| **Supabase (supabase.co)** | 工作流数据、认证 token、团队数据 | 用户使用团队功能时 | 低 (已知域名) |
| **automa.site / vercel.app** | 工作流导入/导出 | 用户访问这些网站时 | 低 (已知域名) |
| **fetch() (用户工作流中)** | 任意数据 (用户 Block 定义) | 用户工作流执行时 | 高 (用户自定义) |
| **debugger CDP** | 完整页面数据 | 使用 debugger 相关 Block 时 | 高 (CDP 协议) |
| **chrome.storage.local** | 本地持久化，无法直接网络外传 | N/A | N/A |
| **webService DOM 事件** | 工作流数据通过 DOM 事件发送 | automa.site 页面监听时 | 低 (仅限于授权域名) |

### 2.2 关键发现

**F-004: 用户自定义 fetch() 调用不可审计**
- 工作流中的 HTTP Request Block 允许用户向任意 URL 发送任意数据
- 这符合 "浏览器自动化" 的合法用途，但也意味着恶意工作流可以将 DOM 提取数据发送到外部服务器
- 扩展本身无法区分合法数据提取与数据窃取

**F-005: Supabase 服务端无本地验证**
- webService 直接使用 localStorage 中的 `supabase.auth.token` 进行认证
- Chrome 扩展本地存储受其他扩展隔离保护，但同一设备上的恶意软件可访问 localStorage
- 未发现对 Supabase 响应的完整性验证

**F-006: IndexedDB 冗余存储**
- webService 在 IndexedDB (`automa/1/store`) 中存储了一份工作流数据的副本
- 增加了数据泄漏面（另一个存储位置需要清理）

---

## 三、CSP (内容安全策略) 分析

### 3.1 各入口点 CSP 状态

manifest.json 未声明 `content_security_policy` 字段，因此使用 MV3 默认 CSP（不允许 `unsafe-eval` 和 `unsafe-inline`），但有一个例外：

| 入口点 | CSP 状态 | eval 可用 | 说明 |
|--------|---------|-----------|------|
| popup.html | MV3 默认 | 否 | `script-src 'self'` |
| newtab.html | MV3 默认 | 否 | `script-src 'self'` |
| params.html | MV3 默认 | 否 | `script-src 'self'` |
| execute.html | MV3 默认 | 否 | `script-src 'self'` |
| offscreen.html | MV3 默认 | 否 | `script-src 'self'` |
| **sandbox.html** | **Sandbox CSP（无限制）** | **是** | `sandbox allow-scripts`（见下） |
| 普通网页 (content script) | 页面 CSP | 否 | 受页面 CSP + world 隔离 (MV3) |

### 3.2 关键发现

**F-007: Sandbox 页面绕过所有 CSP**
- manifest.json 声明 `"sandbox": {"pages": ["/sandbox.html"]}` — 此页面被排除在扩展 CSP 之外
- sandbox 页面内部大量使用 `new Function()` 执行动态代码
- 这是合法设计（用户编写的 JS Block 需要动态执行），但**任何可以访问 sandbox iframe 的上下文都可以注入代码**
- 触发路径：Dashboard (newtab.html) → iframe → sandbox.html → new Function()
- 触发路径：Offscreen (offscreen.html) → iframe → sandbox.html → new Function()

**F-008: 无任何 CSP 强化措施**
- manifest 中无显式 CSP 声明 — 完全依赖默认值
- 未使用 `content_security_policy.extension_pages` 进一步限制
- offscreen.html (执行用户代码的前沿) 使用默认 CSP，增加了 XSS 风险
- contentScript 在 MAIN world 执行 (未使用 `world: "ISOLATED"`，但从代码模式看使用 MAIN world 以便访问页面 window 对象)

---

## 四、注入面分析

### 4.1 代码注入点汇总

| 注入点 | 位置 | 方法 | 风险 |
|--------|------|------|------|
| sandbox.bundle.js | sandbox.html | `new Function("return " + e.__value)()` | 高 — 用户 JS 执行 |
| execute.bundle.js | execute.html | `new Function()` | 高 — JS Block 执行 |
| webService.bundle.js | webService CS | `new Function("return " + e.__value)()` | 高 — 消息内容反序列化时动态求值 |
| contentScript.bundle.js | content script | `new Function()` (多处) | 高 — DOM 操作表达式求值 |
| recordWorkflow.bundle.js | recorder UI | `new Function()` (多处) | 高 — 用户选择器表达式 |
| params.bundle.js | params page | `new Function()` (多处) | 高 — Block 参数求值 |
| contentScript.bundle.js | content script | `.innerHTML` (多处) | 中 — DOM 渲染 |

### 4.2 关键发现

**F-009: 函数序列化/反序列化存在任意代码执行风险**
- 跨上下文消息传递使用自定义序列化格式将函数转为 `{__type:"function", __value: "functionString"}`：
  ```javascript
  function serializeFunc(e) {
    if ("function" == typeof e) return { __type: "function", __value: e.toString() };
    // ...
  }
  function deserializeFunc(e) {
    if ("function" === e.__type) return new Function("return " + e.__value)();
    // ...
  }
  ```
- **严重问题**: 反序列化使用 `new Function()` 没有任何验证，恶意字符串可通过消息通道传入并执行
- 影响面：所有通过 `BrowserAPI` 消息代理传递的函数参数
- 但攻击者需要先入侵扩展内部消息通道，这在正常场景下需要另一个恶意扩展或已控制 content script

**F-010: Content script 通过 innerHTML 直接渲染 HTML**
- contentScript 多处使用 `.innerHTML` 设置 DOM 内容
- 如果 HTML 内容来自工作流参数或页面提取的数据，可能被恶意利用
- 典型场景：XSS — 用户在工作流中填入恶意 HTML → Block 执行时 innerHTML 渲染 → XSS 执行

**F-011: Content script 在 MAIN world 执行**
- 从代码中 `window.addEventListener`, `document.body` 等模式推断，content script 访问了页面的 window 对象
- MV3 的 `world: "MAIN"` 意味着 content script 可以修改页面 JS 环境，但也会暴露给页面 JS
- 页面 JS 可以检测/干扰 content script 的行为（反自动化检测）

---

## 五、通信安全分析

### 5.1 内部消息通道

| 通道 | 协议 | 加密 | 验证 | 风险 |
|------|------|------|------|------|
| Background ↔ ContentScript | `runtime.sendMessage` / `tabs.sendMessage` | Chrome 内部 | 无应用层验证 | 低 — Chrome 隔离 |
| Background ↔ Offscreen | `runtime.sendMessage` | Chrome 内部 | 无应用层验证 | 低 — Chrome 隔离 |
| Background ↔ Popup/Dashboard | `runtime.sendMessage` | Chrome 内部 | 无应用层验证 | 低 — Chrome 隔离 |
| Dashboard/Offscreen → Sandbox | `postMessage` (iframe) | 无 | 无 origin 检查 | 中 — iframe 内 |
| WebService ↔ automa.site | DOM CustomEvent | 无 | 仅域名限制 | 中 — 依赖正确 manifest 匹配 |
| WebService → Supabase | HTTPS | TLS | OAuth token | 低 |

### 5.2 关键发现

**F-012: iframe postMessage 缺乏 origin 验证**
- Dashboard (newtab.html) 和 Offscreen (offscreen.html) 都通过 iframe 嵌入 sandbox.html
- 从代码模式看，postMessage 通信未进行严格的 origin 检查
- 如果 sandbox iframe 被导航到恶意页面，postMessage 监听器可能被利用

**F-013: WebService 自定义事件未加密**
- `__automa-ext__` 自定义事件在页面 DOM 中可见
- 任何在 automa.site 页面上运行的 JS 都可以发送/监听这些事件
- 事件中包含完整的工作流数据

---

## 六、存储安全分析

### 6.1 本地存储审查

| 存储位置 | 数据 | 加密 | 访问控制 |
|----------|------|------|----------|
| `chrome.storage.local` | 工作流、日志、变量、session | 否 (明文) | Chrome 扩展沙箱隔离 |
| `IndexedDB (automa/1)` | 工作流数据副本 | 否 (明文) | 同一扩展上下文 |
| `localStorage` (webService) | `supabase.auth.token` | 否 (明文) | 页面级隔离 |

### 6.2 关键发现

**F-014: Session token 存储在 localStorage**
- Supabase 认证 token 存储在 `localStorage["supabase.auth.token"]`
- 在 webService content script 上下文中，localStorage 是页面级存储 (automa.site 域名)
- Token 在 storage.local 中也有备份 (`session`, `sessionToken` 键)
- Token 包含 `provider_token` (Google OAuth access token) 和 `provider_refresh_token`

**F-015: 工作流数据包含敏感信息时未加密**
- 工作流可能包含用户输入的 API key、密码、Cookie 等 (作为 Block 参数)
- 这些数据明文存储在 `chrome.storage.local` 中
- Chrome 扩展存储不加密，但受操作系统用户沙箱保护

---

## 七、隐私分析

### 7.1 数据收集范围

| 数据类型 | 如何获取 | 是否可能 | 用户感知 |
|----------|----------|----------|----------|
| 浏览历史 | `webNavigation` 事件 + `tabs` API | 是 | 否 (后台静默) |
| 页面内容 | Content script + debugger DOM 域 | 是 | 否 |
| 表单输入 | Content script value 读取 | 是 | 否 |
| 网络请求 | debugger Network 域 | 是 | 否 |
| 认证 Cookie | cookies API (可选权限) | 是 | 否 |
| 剪贴板内容 | clipboardRead (可选权限) | 是 | 否 |
| 屏幕截图 | captureVisibleTab / debugger Page.captureScreenshot | 是 | 部分 (截图有 UI 指示) |
| Google OAuth token | Supabase 集成 (webService) | 是 | 否 (自动同步) |

### 7.2 关键发现

**F-016: 完整用户行为追踪能力**
- 组合 `webNavigation` (导航监听) + `tabs` (标签页状态) + `debugger` (CDP 全部域) = 完整的用户行为监控
- 这是浏览器自动化工具的固有功能，但恶意工作流可利用此能力进行隐蔽监控
- 用户无法从 UI 层面区分合法自动化与恶意监控

**F-017: Google OAuth token 静默同步**
- webService 组件检测 localStorage 中的 `supabase.auth.token`
- 自动将 Google OAuth token 同步到 `chrome.storage.local`
- 用户无明确同意步骤（自动触发于 `app-mounted` 事件）

---

## 八、依赖风险分析

### 8.1 第三方库审计

| 库 | 版本 | 已知 CVE | 供应链风险 |
|----|------|----------|------------|
| **Vue 3.4.38** | 3.4.38 | 无公开已知 | 低 |
| **Webpack** | 5.x (构建时) | 构建工具，运行时无风险 | N/A |
| **webextension-polyfill** | 0.x | 无公开已知 | 低 |
| **lodash** | 4.x (推断) | CVE 多但多为原型污染 (lodash.defaultsDeep 等) | 低 — 需确认使用模式 |
| **dayjs** | 1.x (推断) | 无公开已知 | 低 |
| **idb** | 7.x (推断) | 无公开已知 | 低 |
| **dot-object** | 2.x (推断) | 可能的原型污染 (CVE-2021-25941) | 中 — dot-object 的 set 方法可能存在原型污染 |
| **Supabase SDK** | 未知 | 无公开已知 | 低 |

### 8.2 关键发现

**F-018: dot-object 原型污染风险**
- `dot-object` (版本 2.x) 的 `set()` 方法在特定版本中存在原型污染漏洞 (CVE-2021-25941)
- Automa 中 `dot-object` 用于浏览器 API 抽象层的属性路径访问 (`m().set(BrowserAPI, path, value)`)
- 如果攻击者能控制路径字符串 (如 `__proto__.polluted`)，可能导致全局对象污染
- 但从现有代码模式看，路径字符串来自 `apiRegistry` 常量数组，攻击面较小

**F-019: lodash deep-merge 在所有工作流合并中使用**
- 团队工作流合并 (`N()(a, n)`) 使用 lodash merge
- 如果工作流 JSON 包含 `__proto__` 或 `constructor.prototype` 等键，可能存在原型污染
- 但从 drawflow 数据结构推断，数据键基本可控

---

## 九、合规性分析

### 9.1 Chrome Web Store 策略符合性

| 策略 | 状态 | 说明 |
|------|------|------|
| 最小权限原则 | 不符合 | 11 项权限 + `<all_urls>` 超出典型浏览器自动化需求 |
| 单用途原则 | 符合 | 专注于浏览器自动化 |
| 用户数据透明 | 部分符合 | 隐私政策需明确说明数据收集范围 |
| 远程代码执行 | 边界 | 工作流中用户编写的 JS 属于用户代码，但 `new Function()` 模式可被视为远程代码执行 |
| 敏感权限使用说明 | 需确认 | debugger/proxy 权限的使用场景需要在 CWS 描述中明确说明 |

### 9.2 关键发现

**F-020: `new Function()` 可能违反 CWS 远程代码执行政策**
- Chrome Web Store 禁止扩展加载/执行来自远程服务器的代码
- Automa 使用 `new Function()` 执行用户编写的 JS Block 内容 — 这些内容是**工作流定义的一部分**，存储在本地
- 但 webService content script 通过 `new Function()` 反序列化从 automa.site 接收的函数数据：
  ```javascript
  // 来自 automa.site 页面事件的函数数据
  event.detail.data → deserializeFunc → new Function()
  ```
- **这构成了远程代码执行**：代码源是 automa.site 网页（远程源），通过 CustomEvent 传入，经 `new Function()` 在扩展上下文中执行
- 虽然 source 仅限于 `matches` 中的域名 (automa.site/vercel.app/localhost)，但这仍是风险

**F-021: 用户数据隐私声明缺失**
- 在代码中未发现隐私声明引导或数据收集告知机制
- 工作流可能在用户不知情的情况下收集浏览数据并通过 HTTP 发送
- 严重依赖用户自行判断工作流安全性

---

## 十、风险汇总与建议

### 风险矩阵

| ID | 风险 | 严重程度 | 可被利用 |
|----|------|----------|----------|
| F-001 | debugger 权限全部 CDP 域可用 | 严重 | 是 |
| F-002 | 全页面 + 全 frame content script 注入 | 高 | 是 |
| F-004 | 用户自定义 fetch 不可审计 | 高 | 是 |
| F-007 | Sandbox 绕过所有 CSP | 高 | 是 |
| F-009 | new Function() 反序列化任意代码执行 | 高 | 条件性 |
| F-010 | innerHTML XSS 风险 | 中 | 是 |
| F-012 | iframe postMessage 缺乏 origin 验证 | 中 | 条件性 |
| F-017 | Google OAuth token 静默同步 | 中 | 否 |
| F-018 | dot-object 原型污染 | 中 | 否 |
| F-020 | new Function() 远程代码执行 | 高 | 是 |

### 缓解建议 (对用户)

1. **仅安装受信任的工作流**: 工作流可以包含任意 JS 代码，仅从可信来源导入
2. **审查工作流权限**: 在 Dashboard 中检查每个工作流的触发器类型和 Block 组成
3. **限制敏感页面使用**: 避免在银行/邮箱等敏感网站运行自动化
4. **定期清理存储**: 在 `chrome.storage.local` 中清理不必要的工作流和日志数据
5. **禁用不需要的触发器**: 在 `chrome://extensions` 中管理 Automa 的站点访问权限

### 缓解建议 (对开发者)

1. **CSP 强化**: 在 manifest.json 中显式声明更严格的 CSP
2. **Sandbox 通信验证**: 为所有 iframe postMessage 添加 origin 检查
3. **innerHTML 安全**: 使用 DOMPurify 或等效库清理 HTML 后再插入
4. **函数反序列化限制**: 限制 `new Function()` 反序列化的来源 (仅限 `chrome-extension://` 内部消息)
5. **Token 存储加密**: 对 session token 使用 `chrome.storage.session` (MV3) 或加密存储
6. **权限降级**: 考虑使用 `activeTab` + 用户手势 gating 替代 `<all_urls>` 的全局注入
7. **工作流签名**: 对导入的工作流进行来源验证和完整性检查
