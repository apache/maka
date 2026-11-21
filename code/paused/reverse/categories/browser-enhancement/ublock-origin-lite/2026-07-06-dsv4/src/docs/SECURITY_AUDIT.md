# uBlock Origin Lite — 安全审计报告

> **版本:** 2026.628.2035 | **审计日期:** 2026-07-06 | **模型:** dsv4  
> **安全等级:** 🟢 低风险

---

## 一、审计总览

| 维度 | 评级 | 说明 |
|------|:----:|------|
| 权限面 | 🟡 | 广泛 host 权限 + userScripts 组合, 但使用合理 |
| 数据流 | 🟢 | 无外部数据外传, 所有网络请求仅获取过滤器列表 |
| CSP / 代码注入 | 🟢 | 无 eval/Function 动态执行; 安全 HTML 渲染 |
| 注入面 | 🟡 | userScripts MAIN world 注入需要严格审查 |
| 跨上下文通信 | 🟢 | 可信来源验证 + 消息类型白名单 |
| 存储安全 | 🟢 | 纯本地存储, 无 PII 收集 |
| 隐私 | 🟢 | 无遥测, 无分析, 无用户标识 |
| 依赖安全 | 🟢 | 少量知名第三方库, 内联嵌入 |
| 合规性 | 🟢 | GPL-3.0 开源, 知名作者, 活跃维护 |

**综合评级: 🟢 低风险** — uBlock Origin Lite 是由业界知名的内容拦截专家 Raymond Hill 开发的开源扩展, 架构清晰, 安全边界明确, 无数据外传, 无遥测, 无模糊代码。唯一的 risk surface 在于其强大的权限组合 (declarativeNetRequest + userScripts + host permissions) 赋予了拦截和修改 web 内容的能力 — 但这是该扩展的核心功能, 非滥用。

---

## 二、权限面审计

### 2.1 权限清单

| 权限 | API | 风险 | 评估 |
|------|-----|:----:|------|
| `activeTab` | 当前标签页脚本注入 | 🟢 | 仅在用户主动点击 picker/zapper 时使用, 不自动触发 |
| `alarms` | 定时器 | 🟢 | 仅用于调度过滤器列表更新, 最小间隔 5 分钟 |
| `declarativeNetRequest` | 网络请求拦截 | 🟡 | 核心功能, 规则集由开源社区审核 |
| `offscreen` | 离屏文档 | 🟢 | 仅用于过滤器编译 (DOM API 需求), 无用户内容 |
| `scripting` | 动态内容脚本注册 | 🟡 | 根据过滤模式在运行时注册/注销, 路径固定 |
| `storage` | 配置持久化 | 🟢 | 仅存储配置和缓存, 无 PII |
| `unlimitedStorage` | 大容量存储 | 🟢 | 缓存过滤器列表和 DNR 规则集 |
| `userScripts` | 页面主世界脚本注入 | 🟡 | Scriptlet 注入需要访问页面全局作用域, 需审查 |
| `<all_urls>` | 所有网站访问 | 🟡 | 仅在 complete 模式需要, 用户可选 |

### 2.2 权限授予模型

uBOL 采用了**渐进式权限**模型, 最小化不必要的权限:

- **安装时:** 无需 host 权限 (basic 模式可用)
- **首次使用时:** 仅当用户升级到 optimal/complete 模式时才请求 host 权限
- **按需授予:** 用户可在每个站点上独立选择过滤级别
- **权限撤销处理:** Service Worker 监听 `permissions.onRemoved`, 自动降级对应站点的过滤模式

### 2.3 权限组合风险评估

`declarativeNetRequest` + `userScripts` + `<all_urls>` 的组合理论上可以:
1. 拦截/重定向所有网络请求
2. 在所有页面中注入任意 JavaScript (MAIN world)
3. 读取/修改页面 DOM 和全局变量

**但这正是广告拦截器的设计意图。** 关键在于:
- 规则集由知名开源社区维护 (EasyList, EasyPrivacy, uBlock filters)
- 不加载远程动态代码 (MV3 禁止)
- 无外部数据外传路径
- 所有代码开源可审计

---

## 三、declarativeNetRequest 规则审计

### 3.1 规则集来源

| 规则集 | 来源 | 默认启用 | 用途 |
|--------|------|:-------:|------|
| ublock-filters | uBlock Origin 项目 | Y | 通用广告/跟踪拦截 |
| easylist | EasyList 社区 | Y | 标准广告拦截 |
| easyprivacy | EasyPrivacy 社区 | Y | 隐私/跟踪保护 |
| pgl | Peter Lowe's List | Y | 广告/跟踪服务器 |
| ublock-badware | uBlock Origin 项目 | Y | 恶意软件/钓鱼域名 |
| urlhaus-full | URLhaus 项目 | Y | 恶意软件分发站点 |
| 50+ 其他 | 各地区/语言社区 | N | 区域性规则/反骚扰 |

### 3.2 DNR 规则安全检查

**静态规则集 (安全):**
- 打包在扩展内的 JSON 文件, 随 Chrome Web Store 审核
- 不含动态代码 (仅 URL 模式和 CSS 选择器)
- 规则更新需要扩展版本更新

**动态规则 (安全):**
- 仅由以下来源创建:
  - `filteringModesToDNR()` — 根据用户过滤模式创建 allowAllRequests 豁免
  - `updateRegexRules()` — 从经过 `dnr.isRegexSupported()` 验证的正则创建
  - `updateUserRules()` — 仅在开发者模式下, 由用户手动编写
- 正则规则经过 Chrome 内置的 RE2 引擎验证, 防止 ReDoS

**会话规则 (安全):**
- 仅创建 strict-block 规则 (从静态规则集加载)
- 不过滤任何敏感数据

**规则优先级体系 (防止绕过):**
```
TRUSTED_DIRECTIVE_PRIORITY (1,100,000) — 最高, 仅管理员策略
USER_RULES_PRIORITY (1,000,000) — 用户自定义规则
STRICTBLOCK_PRIORITY (29) — 严格拦截
默认优先级 (1-28) — 标准过滤规则
```

### 3.3 redirect 规则审计

筛选后确认:
- `redirect` 目标仅限于扩展内置的 web_accessible_resources (noop 脚本/图片/媒体)
- 无重定向到外部 URL 的规则
- redirect 资源的 `use_dynamic_url` 防止固定 URL 被外部利用
- noop 资源经过审查: `noop.js` (空函数), `noop.txt` (1 字节), `noop.css` (空 CSS) 等

---

## 四、userScripts 权限审计

### 4.1 Scriptlet 注入架构

uBOL 通过 `userScripts` API 将 scriptlet 注入到页面的 **MAIN world**, 这使得脚本能够访问页面的全局 JavaScript 作用域。

**注册流程:**
```
compiled-filters.js::registerUserScripts()
  → browser.userScripts.unregister() (清除旧脚本)
  → browser.userScripts.register([...]) (注册新脚本)
    → matches: hostname 匹配的所有站点
    → excludeMatches: none mode 的站点
    → world: "MAIN" (需要访问页面全局)
    → runAt: "document_start"
    → matchOriginAsFallback: true
```

### 4.2 Scriptlet 功能清单与安全评估

Scriptlet 分为两个来源:
1. **规则集中包含的 scriptlet** — 由 filter list 作者编写, 目标是特定的广告/跟踪行为
2. **用户自定义 scriptlet** — 用户通过元素选择器或沙箱编辑器创建

**关键 scriptlet 功能与影响:**

| Scriptlet | 功能 | 安全影响 |
|-----------|------|:------:|
| `set-constant` | 覆盖 JS 全局变量 / 对象属性 | 🟡 可修改页面逻辑 |
| `prevent-fetch` | 拦截 fetch() 返回假响应 | 🟡 可干扰页面网络通信 |
| `prevent-xhr` | 拦截 XMLHttpRequest | 🟡 同上 |
| `prevent-addEventListener` | 阻止事件监听器注册 | 🟢 不影响页面数据 |
| `prevent-setTimeout` | 阻止定时器 | 🟢 不影响页面数据 |
| `json-prune` | 从 JSON 响应中删除属性 | 🟡 修改网络响应 |
| `json-edit` | 修改 JSON 响应 | 🟡 同上 |
| `noeval-if` | 阻止特定 eval() 调用 | 🟢 防御性功能 |
| `prevent-innerHTML` | 阻止 innerHTML 写入 | 🟢 防御性功能 |
| `cookie` (trusted) | 读取/修改/删除 cookie | 🟡 涉及认证令牌 |
| `localstorage` (trusted) | 操作 localStorage | 🟡 可修改持久化数据 |
| `prevent-navigation` | 阻止页面导航 | 🟢 不影响数据 |

### 4.3 Trusted Scriptlets 保护

uBOL 区分普通 scriptlet 和 **trusted scriptlets**:

```javascript
// 来自 make-scriptlets.js
if ( meta.requiresTrust && trustedSource !== true ) {
    return; // 拒绝注册
}
```

**Trusted scriptlets** (需要 `requiresTrust = true`):
- `cookie.js` — cookie 操作 (需要信任, 涉及认证信息)
- `localstorage.js` — localStorage 操作
- `trusted-set-constant.js` — 强大的 set-constant 变体
- `trusted-replace-argument.js` — 参数替换变体

这些 scriptlet 只能来自内置的 "可信" 规则集 (ublock filters, easyprivacy 等), **用户自定义的过滤器和导入的外部列表无权使用**。

### 4.4 Scriptlet 注入的安全性控制

1. **Hostname 筛选:** Scriptlet 仅在匹配的 hostname 上注入, 由 `scriptlet-details.json` 定义
2. **过滤模式门控:** 在 none 模式下不注入 scriptlet
3. **信任链:** trusted scriptlet 仅来自内置规则集
4. **代码完整性:** 所有 scriptlet 函数体打包在扩展内, 无远程代码加载
5. **运行限制:** Scriptlet 在页面 DOM 的 document_start 阶段执行, 不可访问扩展 API

---

## 五、CSP 与代码注入审计

### 5.1 代码注入检查

扫描关键注入模式:

| 模式 | 检测结果 | 评估 |
|------|----------|:--:|
| `eval()` | 无使用 | 🟢 |
| `new Function()` | 无使用 | 🟢 |
| `innerHTML` | 仅在严格控制的上下文中使用 (dashboard/popup HTML 模板) | 🟢 |
| `document.write()` | 无使用 | 🟢 |
| `setTimeout(string)` | 无使用 (仅函数参数) | 🟢 |
| `setInterval(string)` | 无使用 | 🟢 |

### 5.2 HTML 安全检查

**i18n.js 的安全渲染:**
- `safeTemplateToDOM()` 使用 DOMParser 进行 HTML 解析
- 仅允许白名单标签: `<a>`, `<b>`, `<code>`, `<em>`, `<i>`, `<span>`, `<u>`
- 所有其他标签被剥离
- 不执行 `<script>` 标签 (DOMParser 的安全特性)

**Content Security Policy:**
- 扩展页面受 Chrome 扩展 CSP 保护 (不允许 inline script)
- 所有 JS 通过 `<script type="module" src="...">` 加载
- CSS 主题切换通过 `prefers-color-scheme` 媒体查询和 CSS 类, 不涉及 JS 注入

---

## 六、跨上下文通信审计

### 6.1 消息信任模型

```
sender.origin === extensionOrigin (可信)
  → 可修改配置、过滤模式、规则集
  → 可读取所有存储数据

sender.origin !== extensionOrigin (不可信)
  → 仅可: insertCSS/removeCSS (注入到自己的页面)
  → 仅可: toggleToolbarIcon (工具栏图标)
  → 仅可: startCustomFilters/terminateCustomFilters/injectCustomFilters (元素选择器)
```

### 6.2 BroadcastChannel 安全

- Channel: `'uBOL'`
- 仅用于扩展内部跨上下文状态同步
- 不包含敏感数据 (仅配置标志和规则集 ID)
- 不传输用户数据或浏览历史

### 6.3 Offscreen Document 通信

- 仅限 `compileFilters:` 前缀的消息
- Offscreen 文档仅请求过滤器数据, 不接收用户数据
- 有 60 秒超时限制

---

## 七、存储安全审计

### 7.1 存储数据分类

| 数据类型 | 存储位置 | PII | 评估 |
|----------|----------|:---:|:----:|
| 扩展配置 | local + session | N | 无用户标识 |
| 过滤模式 | local + session | N | hostname 映射, 非浏览历史 |
| 自定义过滤器 | local | N | 用户创建的 CSS 规则 |
| CSS 缓存 | session (local 在旧版) | N | 预编译的 CSS 选择器 |
| 导入列表 | local | N | 过滤器列表 URL |
| 管理员策略缓存 | session + local | N | 企业配置副本 |
| 启动哨兵 | local | N | 仅 boolean 标志 |
| DNR 用户规则 | local | N | 用户自定义的 DNR 规则 |

**结论:** uBlock Origin Lite 不在任何存储中保存可识别的用户数据。

### 7.2 企业托管存储

`managed_storage.json` 定义的企业策略 schema 允许管理员:
- 强制默认过滤模式
- 强制启用/禁用特定规则集
- 指定不进行过滤的域名
- 禁用特定 UI 功能

这些策略通过 `admin.js` 加载, 在用户配置之上覆盖, 但**不影响用户隐私**。

---

## 八、隐私审计

### 8.1 网络请求分析

| 请求目的 | 目标 | 用户数据 |
|----------|------|:------:|
| 获取过滤器列表 | 远程 filter list URL (仅导入列表) | N |
| 获取规则集详情 | 扩展内置文件 (无网络) | N/A |
| 获取 scriptlet 详情 | 扩展内置文件 (无网络) | N/A |
| 严格拦截规则 | 扩展内置文件 (无网络) | N/A |

**无遥测, 无分析, 无唯一标识符。**

### 8.2 数据外传检测

- `fetch()` 仅用于加载过滤器列表 JSON 文件
- 无 `XMLHttpRequest` 到外部服务器 (除过滤器列表更新)
- 无 `navigator.sendBeacon()`
- 无 `<img>` pixel 跟踪
- 无 WebSocket 连接
- 所有网络请求都是声明式的 (DNR rules), 不是程序化的

---

## 九、依赖安全审计

### 9.1 第三方库

| 库 | 许可证 | 用途 | 风险 |
|----|--------|------|:--:|
| CodeMirror 6 | MIT | 仪表盘代码编辑器 | 🟢 |
| CSS Tree | MIT | CSS 选择器解析 | 🟢 |
| Regex Analyzer | MIT | 正则分析优化 | 🟢 |
| S14E Serializer | MIT | 数据序列化 | 🟢 |
| Punycode.js | MIT | 国际化域名 | 🟢 |

所有第三方库都是知名开源项目, 直接嵌入扩展包中 (无 CDN 加载), 版本固定。

### 9.2 web_accessible_resources 审计

35 个 web accessible resources 分为两类:
1. **Noop 文件:** 空脚本、空 CSS、1 像素图片 — 用于替代广告脚本, 无功能
2. **Neutralized 脚本:** 知名广告/分析库的伪造版本 (google-analytics, fingerprint2, googlesyndication 等) — 返回无害的空实现或拒绝操作

这些资源通过 `use_dynamic_url: true` 防止被外部网站直接引用。

---

## 十、合规性

- **许可证:** GPL-3.0 (开源, 可审计)
- **作者:** Raymond Hill (gorhill), uBlock Origin 原作者, 业界信誉极高
- **GitHub:** 15K+ Stars, 活跃维护
- **Chrome Web Store:** Featured badge, 官方审核通过
- **Manifest V3:** 完全合规, 不使用已弃用的 API

---

## 十一、发现与建议

### 11.1 无高危发现

审计未发现任何高危安全漏洞。代码质量高, 架构安全, 无隐私风险。

### 11.2 需注意项

1. **`userScripts` MAIN world 注入:** 这是功能必需的, 但用户应了解 scriptlet 有能力修改页面全局 JavaScript 行为。uBOL 通过 trusted scriptlet 机制和编译时校验来限制权限过大。

2. **导入的第三方过滤器列表:** 用户导入自定义过滤器列表 URL 时, 该列表的内容不受 uBOL 控制。不过, 导入的列表在编译阶段经过与内置规则集相同的安全检查 (正则验证、trust 检查)。

3. **开发者模式下的 user DNR 规则:** 用户自行编写的 DNR 规则可能包含错误或低效的正则, 但仅影响用户自己的浏览器。

### 11.3 安全最佳实践确认

- [x] 无远程代码执行 (MV3 禁止)
- [x] 消息来源验证 (origin check)
- [x] 无 eval / new Function
- [x] HTML 模板安全白名单渲染
- [x] 无用户数据外传
- [x] 无遥测或分析
- [x] 可信 scriptlet 保护
- [x] DNR 规则优先级防绕过
- [x] 正则 RE2 验证防 ReDoS
- [x] 开源可审计 (GPL-3.0)
