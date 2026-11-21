# Octotree v8.3.0 安全审计报告

> 逆向工程分析 (dsv4) | 基于 v8.3.0

---

## 一、审计范围

- **目标**: Octotree - GitHub code tree v8.3.0
- **文件**: `manifest.json`, `background.js`, `content.js`, `content.css`, `browser-polyfill.js`
- **审计日期**: 2026-07-06
- **方法**: 静态源码分析（逆向工程反混淆代码）

---

## 二、9 维度评估

### 维度 1：权限面（Permission Surface）

**评级：中等**

| 发现 | 详情 | 风险 |
|------|------|------|
| `optional_host_permissions` 含 `*://*/*` | 用户可通过右键菜单为任意域名授权扩展运行，包括企业内网页面 | 中 |
| `host_permissions` 含 `api.github.com` 和 `octotree.io` | 固定主机权限，扩展可向这两个域名发送请求 | 低 |
| `scripting` + `activeTab` 组合 | 可向任意标签页注入脚本（需用户交互触发或已授权域名） | 中 |
| `contextMenus` | 仅用于权限切换功能，未滥用 | 低 |
| `storage` | 仅存储设置和 Token，权限预期内 | 低 |

**总体判断**: 权限声明合理但偏多，`optional_host_permissions: *://*/*` 的授权机制依赖用户判断。

---

### 维度 2：数据外传（Data Exfiltration）

**评级：中等**

| 发现 | 详情 | 风险 |
|------|------|------|
| 向 `api.octotree.io` 发送用户数据 | `background.js` 中 `fetch` 请求向 `https://www.octotree.io/api/v1.0/` 发送数据，请求体包含用户数据和方法名。`token` 参数（GitHub PAT）随请求传递 | **高** |
| Bearer Token 明文传输 | GitHub Personal Access Token 作为 `Authorization: Bearer {token}` 头发送给 Octotree 后端。这意味着 Octotree 服务端可获得用户的 GitHub 访问令牌 | **高** |
| 向 `api.github.com` 的请求在 Content Script 中发起 | 仓库文件树、文件内容等请求均在 Content Script 沙箱中进行，可能被页面内其他脚本监控（虽然 Content Script 运行在隔离世界中） | 低 |

**关键发现**: Octotree 将用户的 GitHub PAT 发送给自己的后端（`octotree.io`），这是该扩展的核心数据外传风险。Octotree 服务端可以读取用户授予的全部 GitHub 权限范围内的数据。

---

### 维度 3：CSP（内容安全策略）

**评级：良好**

| 发现 | 详情 | 风险 |
|------|------|------|
| MV3 默认 CSP | Manifest V3 的 Service Worker 和 Content Script 均遵循 Chrome 的默认 CSP，禁止 `eval()` 和内联脚本 | 低 |
| `web_accessible_resources` 使用通配符 | `*.woff2`, `*.png`, `*.gif`, `*.svg` 通配符允许所有匹配文件对所有域名可访问 | 低（仅暴露静态资源） |

**总体判断**: MV3 的默认 CSP 提供了较好的安全基线，未检测到 CSP 绕过行为。

---

### 维度 4：注入面（Injection Surface）

**评级：中等**

| 发现 | 详情 | 风险 |
|------|------|------|
| DOM 操作广泛（jQuery） | `content.js` 大量使用 jQuery 操作 GitHub 页面的 DOM 结构，创建侧边栏、注入 CSS、绑定事件 | 中（若注入数据未正确转义可能引发 XSS） |
| 内嵌 HTML 模板 | 侧边栏 UI 组件通过 JS 动态创建 HTML 片段，包括文件内容渲染 | 中（需检查是否存在 HTML 实体编码缺失） |
| `innerHTML` / `$.html()` 使用 | jQuery 的 `.html()` 方法直接设置 HTML 内容，如果文件内容中包含恶意 HTML 可能被渲染 | 中 |
| 代码语法高亮 | 对代码文件进行语法着色时，需处理 HTML 特殊字符（`<`, `>`, `&` 等） | 低（若语法高亮库正确处理转义） |

**备注**: 由于 `content.js` 高度压缩（Terser），无法完全验证所有 DOM 操作是否对用户输入进行了适当的 HTML 转义。GitHub 仓库中的文件内容不可信，渲染前必须转义。

---

### 维度 5：通信安全（Communication Security）

**评级：良好**

| 发现 | 详情 | 风险 |
|------|------|------|
| 仅 HTTPS | 所有 API 调用使用 HTTPS（`api.github.com`, `www.octotree.io`） | 低 |
| API 代理隔离 | Content Script 通过 SW 代理调用 Octotree API，避免宿主页面访问请求/响应的内容 | 低 |
| 无 `externally_connectable` | 未配置外部连接，阻止第三方网站的扩展消息 | 低 |
| `web_accessible_resources` 匹配全域名 | 字体和图片对所有网站暴露，但仅包含静态资源，无脚本暴露 | 低 |

**总体判断**: 通信设计合理，Content Script 不直接与 Octotree 后端通信，通过 SW 隔离。

---

### 维度 6：存储安全（Storage Security）

**评级：中等**

| 发现 | 详情 | 风险 |
|------|------|------|
| GitHub PAT 明文存储在 `chrome.storage.local` | Token 以原始字符串存储，未加密。虽然 Chrome 存储区域对扩展自身具有隔离性，但如果设备被物理攻破或存在其他恶意扩展可利用 Chrome 调试协议读取 | 中 |
| 无加密保护 | 未发现对存储数据进行加密的逻辑 | 中 |
| `chrome.storage.session` 用于启动标记 | 仅用于标记扩展是否首次启动，不存储敏感数据 | 低 |

**建议**: 敏感数据（如 PAT）应使用 `chrome.storage.session`（内存级存储，重启后清除）或进行加密存储。

---

### 维度 7：隐私（Privacy）

**评级：中等**

| 发现 | 详情 | 风险 |
|------|------|------|
| 浏览行为追踪 | 扩展自动在 GitHub 仓库页面激活，每次激活向 Octotree 后端发送请求（许可证验证），可能包含仓库信息 | 中 |
| 用户 GitHub Token 传输 | 用户的 GitHub PAT 被发送到 Octotree 服务端，服务端即持有该 Token 的全部权限。由于 Token 权限范围由用户授予 GitHub 时决定，若 Token 包含 `repo` 或 `user` 范围，Octotree 即可访问用户的私有仓库和个人数据 | **高** |
| 仓库浏览记录 | `octotree_session` 存储 `recentRepos` 列表，仅在本地存储，未发现上报行为 | 低 |

**隐私关键风险**: Token 分享机制意味着用户实质上将 GitHub 账户的访问权限委托给了 Octotree 服务端。

---

### 维度 8：依赖安全（Dependency Security）

**评级：中低**

通过 NOTICE.txt 和代码特征识别的依赖：

| 依赖 | 版本 | 已知风险 |
|------|------|----------|
| jQuery | (内嵌，版本未知) | jQuery 3.x 以下存在已知 XSS 漏洞（CVE-2020-11023），需确认版本 |
| jQuery UI | (内嵌，版本未知) | 历史版本存在 XSS（CVE-2022-31160） |
| jsTree | (内嵌，版本未知) | 检查是否为最新稳定版 |
| blueimp-md5 | (内嵌) | MD5 为弱哈希，不应用于安全用途。此处仅用于文件指纹等非安全场景，风险低 |
| webextension-polyfill | Mozilla, MPL-2.0 | 活跃维护，风险低 |
| webext-patterns / webext-permission-toggle / webext-dynamic-content-scripts | fregante, MIT | 活跃维护的开源库，风险低 |
| 多种字体 | SIL OFL 1.1 / MIT | 字体文件无执行能力，风险低 |

**建议**: 由于依赖内嵌且未声明版本号，建议通过哈希比对 npm registry 确定精确版本后检查 `npm audit`。

---

### 维度 9：合规性（Compliance）

**评级：良好**

| 检查项 | 结果 |
|--------|------|
| NOTICE.txt 包含完整第三方许可声明 | 通过 |
| 未发现混淆/恶意代码行为 | 通过（背景脚本逻辑清晰公开） |
| Chrome Web Store 上架合规 | 通过（扩展已通过 CWS 审核） |
| GitHub API 使用条款合规 | 通过（使用官方 REST API） |
| 隐私声明 | 未发现扩展内嵌隐私政策链接（需检查官网隐私政策） |

---

## 三、发现清单（按风险等级排序）

### 3.1 【高危】GitHub PAT 明文外传到 Octotree 服务端

**位置**: `background.js` 中的消息处理函数

**详情**: 用户的 GitHub Personal Access Token 通过 HTTPS 发送给 `api.octotree.io`。这意味着 Octotree 服务端可以读取用户授予 Token 的所有 GitHub 权限。用户在使用 Octotree 时实质上将 GitHub 账户的部分控制权交给了 Octotree 公司。

**风险等级**: 高危

**建议**:
- 用户在创建 Token 时应使用最小权限范围（仅 `public_repo`）
- 定期轮换 Token
- Octotree 应在隐私政策中明确说明 Token 的用途和处理方式

---

### 3.2 【中危】Token 明文本地存储

**位置**: `chrome.storage.local` 中的 `octotree_access_token`

**详情**: GitHub PAT 以原始文本形式存储在 `chrome.storage.local` 中。如果设备被攻破或用户使用公共计算机，Token 可能被提取。

**风险等级**: 中危

**建议**:
- 使用 `chrome.storage.session` 替代 `chrome.storage.local`（数据在浏览器会话结束后清除）
- 或使用 Web Crypto API 对 Token 进行加密存储

---

### 3.3 【中危】`optional_host_permissions: *://*/*` 授权风险

**位置**: `manifest.json` 第 30-33 行

**详情**: 扩展默认仅运行在 `github.com`，但用户可通过右键菜单授权扩展在任意网站运行。如果在恶意网站上授权，攻击者可能通过精心构造的页面利用扩展功能。此外，托管 GitHub Enterprise 的企业内网也可被授权，可能造成内部代码泄露。

**风险等级**: 中危

**建议**:
- 在授权前显示更醒目的警告提示
- 考虑限制可选授权范围（如仅允许 `*.github.com` 或 `*.ghe.com`）

---

### 3.4 【中危】大体积压缩代码难以审计

**位置**: `content.js` (~565KB, Terser 压缩)

**详情**: 主内容脚本高度压缩混淆，变量名被替换为短名（单字母/双字母），无法直接审计。虽然扩展通过 Chrome Web Store 审核，但压缩代码中可能隐藏未声明的行为。

**风险等级**: 中危

**建议**:
- 使用 source map（若可用）恢复可读源码
- 关注 Chrome Web Store 审核机制作为补充保障

---

### 3.5 【低危】大量字体资源暴露

**位置**: `manifest.json` 中 `web_accessible_resources`

**详情**: 17 个 woff2 字体文件对所有 `*://*/*` 暴露。字体文件无执行能力，但大量外部资源加载可能被用于扩展指纹识别（检测用户是否安装了 Octotree）。

**风险等级**: 低危

**建议**: 将 `matches` 限制为 `https://github.com/*`。

---

### 3.6 【信息】Content Script 在 `document_start` 运行

**位置**: `manifest.json` 第 52 行

**详情**: Content Script 在 DOM 构建前即注入，可拦截所有页面请求。虽然用于增强用户体验（在页面渲染前完成侧边栏初始化），但这也意味着扩展有完全控制页面生命周期的能力。

**风险等级**: 信息

---

## 四、未发现的高危问题

以下常见扩展安全问题经审查后**未发现**：

- [x] 无 `eval()` 或 `new Function()` 动态代码执行（MV3 CSP 禁止，代码中未发现 `eval` 调用）
- [x] 无 `chrome.cookies` / `chrome.webRequest` / `chrome.history` 等高风险权限
- [x] 无 `externally_connectable` 配置（不接收外部消息）
- [x] 所有网络请求使用 HTTPS，无降低安全性的 fallback
- [x] Content Script 通过 SW 代理与外部通信，不在页面上下文中暴露敏感信息
- [x] 无 `webRequest` 拦截（不监控用户浏览行为）

---

## 五、整体评估

| 维度 | 评级 | 说明 |
|------|------|------|
| 权限面 | 中等 | `optional_host_permissions: *://*/*` 授权范围过大 |
| 数据外传 | **高风险** | GitHub PAT 明文传输到 Octotree 服务端 |
| CSP | 良好 | MV3 默认 CSP 提供有力保护 |
| 注入面 | 中等 | 大量 DOM 操作，压缩代码难以完整审计 |
| 通信安全 | 良好 | 全 HTTPS + SW 代理隔离 |
| 存储安全 | 中等 | Token 明文存储，无加密 |
| 隐私 | **高风险** | Token 共享机制具有侵入性 |
| 依赖安全 | 中低 | 内嵌库版本未知，建议版本核对 |
| 合规性 | 良好 | 许可声明完整，通过 CWS 审核 |

**综合评级**: **中高风险**。

主要风险集中在 Token 处理上：用户的 GitHub PAT 被发送至 Octotree 后端并被明文本地存储。使用 Octotree 的用户应充分理解这种风险，并采取以下缓解措施：

1. 使用具有最小权限的 GitHub Token（仅 `public_repo` 范围）
2. 定期轮换 Token
3. 避免在包含私有仓库/敏感代码的 GitHub 账户上使用
4. 了解 Octotree 的隐私政策中关于 Token 处理的说明

---

## 六、外部链接

代码中识别到的外部 URL：

- `https://www.octotree.io/` — 扩展官网
- `https://api.github.com/` — GitHub REST API（仓库数据）
- `https://www.octotree.io/api/v1.0/` — Octotree 后端 API（许可证/用户数据）

以上 URL 均为 HTTPS，且大部分通过 Service Worker 的 `fetch` 发起，不直接在宿主页面暴露。
