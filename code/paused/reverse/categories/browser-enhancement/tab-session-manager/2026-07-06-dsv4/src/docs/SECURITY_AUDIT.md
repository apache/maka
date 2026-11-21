# Tab Session Manager v7.3.0 — 安全审计

## 审计摘要

| 维度 | 等级 | 说明 |
|------|------|------|
| 权限面 | 中 | 7 个必需权限 + 2 个可选，权限范围合理但有改善空间 |
| 数据流 | 低风险 | 数据仅本地存储，云端同步为用户主动选择 |
| CSP | 低风险 | 无 content_security_policy 声明，默认 MV3 严格 CSP |
| 注入面 | 中 | 使用 innerHTML/insertAdjacentHTML，但输入来自内部数据 |
| 通信 | 低风险 | 仅扩展内部通信，无外部消息监听 |
| 存储 | 低风险 | 会话数据存 IndexedDB，OAuth 令牌存 storage.local |
| 隐私 | 中 | 收集所有标签页 URL 和标题，上传至 Google Drive (可选) |
| 依赖 | 低风险 | 依赖均为知名开源库，版本较旧但无已知严重漏洞 |
| 合规 | 低风险 | 有隐私政策链接，Google Drive 使用 OAuth 2.0 |

---

## 一、权限面分析

### 1.1 必需权限

| 权限 | 是否必要 | 风险 | 分析 |
|------|----------|------|------|
| `storage` | 是 | 低 | 存储用户设置，插件核心功能需要 |
| `unlimitedStorage` | 是 | 低 | 大量会话数据超出 10MB 限制，合理需求 |
| `tabs` | 是 | 中 | 可读取所有标签页 URL 和标题，核心功能必需但面广 |
| `downloads` | 是 | 低 | 会话备份/导出需要 |
| `identity` | 是 | 中 | 仅用于 Google OAuth，未滥用 |
| `alarms` | 是 | 低 | 定时自动保存需要 |
| `offscreen` | 是 | 低 | MV3 下载处理的合理替代方案 |

### 1.2 可选权限

| 权限 | 风险评估 |
|------|----------|
| `tabGroups` | 低风险，用户主动开启，仅读取/恢复标签组结构 |
| `https://www.googleapis.com/*` (host) | 中风险，但限定于 Google API 域名，仅用于 Drive 和 OAuth |

### 1.3 权限对比同类扩展

与 Session Buddy、OneTab 等同类扩展相比，Tab Session Manager 的权限声明属于标准范围。`identity` 权限为可选功能（云端同步），不启用则不会请求。

---

## 二、数据流安全

### 2.1 数据外传分析

**结论：无数据外传至非用户授权的第三方。**

- Google Drive API 调用仅在用户主动启用"云端同步"后发生
- OAuth token 仅用于 `https://www.googleapis.com/` 域名
- 无分析/统计 SDK，无第三方遥测
- Patreon/PayPal 按钮仅提供跳转链接，不传输数据

### 2.2 网络请求清单

| 端点 | 用途 | 触发条件 |
|------|------|----------|
| `https://accounts.google.com/o/oauth2/v2/auth` | Google OAuth 授权 | 用户点击 Sign In |
| `https://oauth2.googleapis.com/token` | 令牌交换/刷新 | OAuth 流程 |
| `https://www.googleapis.com/drive/v3/files` | Drive 文件操作 | 云端同步 |
| `https://www.googleapis.com/upload/drive/v3/files` | Drive 文件上传 | 云端同步 |
| `https://www.googleapis.com/oauth2/v1/userinfo` | 获取用户邮箱 | 登录后显示 |
| `https://oauth2.googleapis.com/revoke` | 撤销令牌 | 用户登出时 |

### 2.3 数据流向图

```
用户标签页数据 (URL/标题/favicon)
         │
         ▼
  Service Worker (内存) ───── IndexedDB (持久化)
         │
         │ (用户启用云端同步后)
         ▼
  Google Drive (appfolder 作用域)
```

---

## 三、CSP 与代码注入

### 3.1 Content Security Policy

manifest.json 未声明 `content_security_policy`，MV3 默认使用严格 CSP：
- 禁止 inline script
- 禁止 `eval()` 及类似函数
- 禁止远程脚本加载

**实际观察**：代码中出现的 `eval` 和 `Function()` 来自 webextension-polyfill 内部实现（非直接 eval 调用），在 Webpack bundle 上下文中运行，与页面隔离。

### 3.2 代码注入风险

| 位置 | API | 输入来源 | 风险 |
|------|-----|----------|------|
| `replaced.js` | `insertAdjacentHTML` | URL 查询参数 (`g.favIconUrl`) | **中** — 已做 HTML 转义 (`&<>"'` 替换为实体) |
| `replaced.js` | `innerText` | URL 查询参数 (`g.title`) | 低 — `innerText` 自动转义 |
| `popup.js` | `innerHTML` (React) | 会话数据 (标签标题等) | **中** — React 的 `dangerouslySetInnerHTML` 可能被使用 |
| `options.js` | `innerHTML` (React) | 用户设置描述 | 低 — 设置值经过 chrome.storage 序列化 |

**缓解措施**：
- replaced.js 中的 favIconUrl 已做 HTML 实体转义：`replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")`
- React 默认使用 JSX 自动转义，仅在显式使用 `dangerouslySetInnerHTML` 时有风险

### 3.3 `eval` 和 `Function()` 使用分析

代码中包含 `eval` 关键字匹配，但经过分析：
- `eval` 出现在 webextension-polyfill 的 `api-metadata.json` 处理中（`devtools.inspectedWindow.eval` 是 API 名称声明，非实际 eval 调用）
- `Function(` 来自 lodash 的模板函数实现，在 Webpack 编译后保留了 `Function` 构造函数调用 — 这是一个潜在关注点，但 lodash 的 `template()` 仅在内部使用，不暴露用户输入

---

## 四、通信安全

### 4.1 消息传递

- 所有消息通过 `browser.runtime.sendMessage()` 在扩展内部传递
- 未注册 `runtime.onMessageExternal`，不接受外部扩展消息
- 消息类型使用字符串标识，无混淆

### 4.2 身份验证 (OAuth 2.0)

```
OAuth 流程:
1. browser.identity.launchWebAuthFlow() → Google 授权页面
2. 获取 authorization_code
3. POST oauth2/v4/token → 交换 access_token + refresh_token
4. refresh_token 加密存储到 chrome.storage.local
5. access_token 过期时使用 refresh_token 刷新
```

- 使用 `chrome.identity` API（浏览器原生管理）而非自定义 OAuth 实现
- Token 存储在 `chrome.storage.local`（扩展专属，其他扩展不可访问）
- 使用 `drive.appfolder` 作用域，仅访问应用专属文件夹

---

## 五、存储安全

### 5.1 会话数据 (IndexedDB)

- 数据库名：`sessions`
- 存储内容：所有标签页 URL + 标题 + favicon
- 访问控制：仅扩展自身可访问（同源策略）
- 数据加密：**未加密**（明文存储所有浏览数据）

**风险**：任何能访问本地文件系统的攻击者可以读取全部浏览历史（通过 IndexedDB 文件）。

### 5.2 设置数据 (chrome.storage.local)

- 存储内容：用户偏好设置 + OAuth refresh_token
- OAuth token 加密存储：代码中有加密逻辑（具体加密算法待验证）
- 存储键名：`settings`

### 5.3 隐私窗口

- 默认不保存隐私窗口标签页 (`ifSavePrivateWindow: false`)
- 用户可选择开启

---

## 六、隐私影响评估

### 6.1 数据收集范围

| 收集数据 | 存储位置 | 持续时间 |
|----------|----------|----------|
| 所有标签页 URL | IndexedDB | 用户手动删除前永久保存 |
| 所有标签页标题 | IndexedDB | 同上 |
| 所有 favicon URL | IndexedDB | 同上 |
| 窗口状态和布局 | IndexedDB | 同上 |
| Google 账号邮箱 | chrome.storage.local | 用户登出前 |
| 设备名称 (可选) | IndexedDB (tags) | 同上 |

### 6.2 第三方共享

- Google Drive：仅在用户主动启用云端同步后发生
- 无其他第三方共享
- 有隐私政策声明 (`privacyPolicyLabel` in messages.json)

### 6.3 用户控制

用户可以：
- 管理所有保存的会话（查看、删除、导出）
- 控制云端同步开关
- 选择不同步自动保存的会话
- 控制是否保存隐私窗口
- 配置忽略 URL 列表（排除敏感网站）
- 从 Google 账号登出并撤销 OAuth 令牌

---

## 七、依赖安全

### 7.1 第三方库清单

| 库 | 版本 | 许可 | 已知漏洞 |
|----|------|------|----------|
| React | 16.13.1 | MIT | 有已知安全公告 (CVE-2021-24033 等)，但影响特定使用场景 |
| ReactDOM | 16.13.1 | MIT | 同 React |
| lodash | 4.x | MIT | lodash 4.17.21 修复了原型污染 (CVE-2020-8203)，此版本较安全 |
| moment.js | 2.x | MIT | 已停维，但无严重漏洞 |
| webextension-polyfill | 最新 | MPL-2.0 | 浏览器 API 封装，无已知漏洞 |
| base64-js | 1.x | MIT | 编码库，无已知漏洞 |
| buffer | 6.x | MIT | Node.js buffer polyfill，无已知漏洞 |

### 7.2 建议

- React 16.13.1 已是 3 年前的版本，建议升级到 React 18（但作为打包扩展，实际影响有限）
- moment.js 已停维，建议迁移到 date-fns 或 dayjs

---

## 八、改进建议

| 优先级 | 建议 | 理由 |
|--------|------|------|
| 高 | 对 IndexedDB 中的会话数据加密 | 明文存储浏览历史，本地攻击者可读取 |
| 高 | 验证 favicon URL 的 `insertAdjacentHTML` 使用 | 虽有 HTML 转义，但 favicon URL 来自标签页数据，理论受控 |
| 中 | 升级 React 到 18.x | React 16 已知漏洞，Webpack 打包可替换 |
| 中 | 替换 moment.js 为 dayjs 或 date-fns | moment.js 已停维，体积大 |
| 低 | 添加 CSP `default-src 'self'` 声明 | 显式而非依赖默认值 |
| 低 | 对 OAuth refresh_token 使用 IndexedDB 而非 storage.local | storage.local 可能被同步到 Chrome 账号 |

---

## 九、总体评价

Tab Session Manager v7.3.0 整体安全水平属于**同类 Chrome 扩展中的中上水平**。作为会话管理器，它必须访问标签页数据（URL/标题），这是功能需求而非过度采集。

主要安全优势：
- 无第三方遥测/分析
- OAuth 2.0 云端同步由用户主动控制
- 隐私窗口默认不跟踪
- 未使用 `content_scripts`（减少注入面）

主要改进空间：
- 本地数据加密
- 依赖版本更新
