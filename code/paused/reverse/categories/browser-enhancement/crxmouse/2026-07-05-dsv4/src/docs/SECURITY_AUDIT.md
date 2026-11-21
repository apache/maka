# crxMouse Chrome Gestures — 安全审计报告

> 逆向工程安全分析 | v7.0.5 | 2026-07-06

---

## 一、审计范围

本报告针对 crxMouse Chrome Gestures v7.0.5 的清单权限、内容脚本注入面、数据采集行为、外部通信和代码安全进行静态分析。

---

## 二、权限清单与风险评级

### 清单权限总览

| 权限 | 风险等级 | 风险说明 |
|------|---------|---------|
| `tabs` | **中** | 读写所有标签页 URL 和标题 |
| `storage` | **低** | 本地存储，标准权限 |
| `contextMenus` | **低** | 右键菜单，标准权限 |
| `webNavigation` | **中** | 监听所有页面导航事件（URL 变更） |
| `webRequest` | **高** | 拦截所有网络请求（含请求体和响应头） |
| `clipboardRead` | **高** | 读取系统剪贴板内容 |
| `clipboardWrite` | **高** | 写入系统剪贴板内容 |
| `bookmarks` | **中** | 读取/创建/修改书签 |
| `unlimitedStorage` | **低** | 无限制存储（用于光标主题等大资源） |
| `scripting` | **中** | 动态注入脚本 (MV3 替代 executeScript) |
| `sessions` | **中** | 读取/恢复浏览会话（含标签页 URL） |
| `alarms` | **低** | 定时任务，标准权限 |
| `downloads` (optional) | **中** | 下载文件（可选权限，用户可拒绝） |

### host_permissions

| 权限 | 风险等级 | 说明 |
|------|---------|------|
| `*://*/*` | **极高** | 所有 HTTP/HTTPS 页面（含内网地址） |
| `<all_urls>` | **极高** | 所有 URL scheme（含 file://, chrome://, edge:// 等特权页面） |

---

## 三、5 个 Content Script 注入面的安全分析

### 注入面总览

| # | 脚本 | 注入范围 | 安全风险 |
|---|------|---------|---------|
| 1 | `content.js` + jQuery | 所有 HTTP/HTTPS 页面，所有帧，document_start | **极高** — 可读写任何网页 DOM、拦截用户输入 |
| 2 | `js/frame.js` | 所有 HTTP/HTTPS 页面，所有帧，document_end | **高** — 监听所有链接点击并上报 |
| 3 | `contentEnd.js` | `<all_urls>` (含 file://)，所有帧，含 about:blank | **极高** — 可达 chrome:// 等特权页面，含完整 JSON 表达式引擎 |
| 4 | `js/websiteHandler.js` | 仅 crxmouse.com | **低** — 域限制 |
| 5 | `contentStart.js` | `<all_urls>` (含 file://)，所有帧，含 about:blank，document_start | **高** — 模块系统引导，动态加载外部脚本 |

### 关键风险点

#### 风险 1: contentEnd.js 可达特权页面
- `match_about_blank: true` + `<all_urls>` 组合意味着脚本可注入 `chrome://`, `edge://`, `file://` 等特权页面的 about:blank iframe
- 该脚本包含完整的 JSON 表达式执行引擎 (jfq)，可执行任意 DOM 操作
- **威胁**：若服务端下发的规则被劫持，攻击者可在特权上下文中执行任意代码

#### 风险 2: 动态脚本注入
- `contentStart.js` 通过 `chrome.runtime.getURL("js/eventPriority.js")` 动态注入脚本
- 创建 `<script>` 元素附加到 `document.documentElement`
- 若 `eventPriority.js` 被篡改（供应链攻击），影响所有页面
- **缓解**：该文件在扩展包内，非远程加载，但仍需完整性校验

#### 风险 3: 5 个 content script 的累加权限
- 5 个脚本可协同操作：contentStart.js 提供模块系统，contentEnd.js 提供命令引擎，content.js 提供 DOM 操作
- 三者组合实现了一个完整的服务端驱动的规则引擎
- 规则的来源是 `chrome.storage.local` 中的 `proconstantinator_key` 和服务端下发的 JSON 规则

#### 风险 4: frame.js 全局监听所有链接点击
```javascript
document.body.addEventListener("click", function(e) {
    e.target.href && chrome.runtime.sendMessage({href: e.target.href})
})
document.body.addEventListener("contextmenu", ...)
document.body.addEventListener("auxclick", ...)
```
- 所有用户点击链接的 URL 都被发送到 service worker
- 包括内网地址、带 token 的 URL、私有链接

---

## 四、webRequest 权限风险

### 能力
- 监听所有网络请求（含请求 URL、方法、头部）
- 可读取响应头
- 可用于 VAST 广告检测

### 风险
- **全流量可见**：扩展理论上可收集用户访问的所有 URL
- **敏感数据泄漏**：若服务端代码存在漏洞，可泄漏认证 token、会话 cookie、内网地址
- **HTTPS 中间无保护**：虽然 Chrome 限制修改 HTTPS 请求，但读取是完全允许的

### 使用场景分析
该权限主要用于：
1. VAST 广告检测（读取 XML 响应中的广告数据）
2. 分析/反馈管道（XJZ, WwI 模块）
3. 热门手势推荐的数据采集

---

## 五、clipboardRead / clipboardWrite 风险

### 风险场景
- `clipboardRead`：扩展可读取用户剪贴板中的任何内容（密码、密钥、私钥、信用卡号等）
- `clipboardWrite`：扩展可写入任意内容到剪贴板（替换用户复制的加密货币地址等）
- 配合手势操作，用户可能在不知情的情况下触发剪贴板操作

### 使用场景
- 手势 "复制 URL" / "复制标题" / "复制链接文本"
- 手势 "从剪贴板打开 URL"
- 手势 "复制标题和 URL 为链接格式"

---

## 六、bookmarks 权限风险

### 能力
- 读取用户全部书签（含书签文件夹结构和 URL）
- 创建新书签
- 修改现有书签
- 书签可作为浏览习惯指纹

### 使用场景
- 手势 "添加书签"
- 手势 "打开书签管理器"

---

## 七、数据采集与隐私分析

### 采集的数据类型

| 数据类型 | 采集模块 | 条件 | 去向 |
|---------|---------|------|------|
| 访问的 URL (域名) | XJZ, WwI, webNavigation | advanced features consent | crxmouse 服务器 |
| 网络请求 URL | webRequest | advanced features consent | crxmouse 服务器 |
| 广告数据 (VAST XML) | RWf | advanced features consent | crxmouse 服务器 |
| 手势使用统计 | XJZ | advanced features consent | Google Analytics + crxmouse |
| 链接点击 URL | frame.js | 始终 | service worker (内存) |
| AI 请求/响应 (含附件和图片) | Privacy Policy 声明 | advanced features consent | crxmouse 服务器 |
| GUID | XJZ.jnCB() | 始终 | chrome.storage.local |

### 同意机制

扩展使用双层同意：
1. **安装时**：显示 opt-in modal (v2_welcome_title / v2_consent_title)，需用户点击 "Agree & Continue"
2. **设置中**：可随时 opt-out，但 "advanced features" 将停止工作

### Privacy Policy 分析 (来自 i18n)

```
"This extension needs to process your network traffic information, including 
the domains (i.e., URLs) you visit, the advertisements that you view and your 
AI requests and responses (including attachments and images)"

"We also collaborate with affiliated companies to deliver certain services, 
meaning your Browsing Activity Data will be sent to them. These affiliates 
might use this data for market intelligence and may disclose it to their 
customers as part of their services."
```

- 明确声明采集网络流量信息（域名 + 广告 + AI 请求响应）
- 数据分享给关联公司用于市场情报
- 关联公司可向客户披露数据
- 这是**高度敏感的数据共享模型**，远超典型浏览器扩展的隐私范围

---

## 八、外部通信审计

### 外部域名

| 域名 | 用途 | 上下文 |
|------|------|--------|
| `crxmouse.com` | 热门手势 API、反馈上报、官方页面 | SW + websiteHandler |
| `fonts.googleapis.com` | Google Fonts (Arimo, Inter, Mulish, Catamaran) | popup.html + options.html |
| `fonts.gstatic.com` | Google Fonts CDN | popup.html + options.html |
| `google.com` (GA) | Google Analytics 事件上报 | SW (oIP 模块) |

### 风险
- Google Fonts 在 popup 和 options 页面加载 — 这是**远程代码加载**，`fonts.googleapis.com` 返回的 CSS 在扩展上下文中执行
- options.html 链接到 `accounts.google.com` (Chrome Sync 登录引导)
- 热门手势 API 返回的数据直接用于 service worker，若 API 被劫持可注入恶意规则

---

## 九、Obfuscation 与反分析

### 混淆技术

1. **字符串混淆 (proconstantinator_key)**：
   - 核心字符串（命令名称、操作符、属性名）全部替换为数字索引
   - 实际字符串存储在 `chrome.storage.local.proconstantinator_key` 中
   - 索引映射在运行时动态加载，具有指数退避重试机制
   - 有效阻止静态分析

2. **变量名混淆**：
   - 所有函数和变量使用无意义短名称 (e.g., `XGEf`, `jAWp`, `hjDg`, `bCoq`)
   - 类方法名和属性名混淆

3. **模块系统混淆**：
   - `MpiUO` 全局命名空间下的模块使用短名称 (e.g., `kBx`, `jfq`, `lNV`)
   - Webpack 模块 ID 使用数字 (e.g., `r(4901)`, `t.exports`)

4. **core-js 内联**：
   - service_worker.js 和 contentEnd.js 中嵌入了完整的 core-js 3.47.0 polyfill
   - 增加代码体积 (~100KB+ 每个)，增加逆向难度

---

## 十、代码注入风险汇总

| 注入点 | 方式 | 风险等级 | 说明 |
|--------|------|---------|------|
| `eventPriority.js` | `chrome.runtime.getURL` + DOM 注入 | **中** | 本地文件，但若包被篡改则全页面受影响 |
| Google Fonts CSS | `<link>` 远程加载 | **中** | 远程 CSS 可能在扩展上下文中执行 JS (via CSS injection) |
| 热门手势 API | JSON 响应解析为规则 | **高** | 服务端规则未经验证直接执行 |
| `proconstantinator_key` | chrome.storage 读取 | **中** | 静态存储，但控制所有命令的语义 |

---

## 十一、总体风险评估

### 风险矩阵

| 维度 | 评级 | 说明 |
|------|------|------|
| 权限范围 | **极高** | webRequest + clipboard + bookmarks + all_urls 是 Chrome 扩展最高权限组合之一 |
| Content Script 注入面 | **极高** | 5 个脚本、所有帧、about:blank、document_start |
| 数据采集 | **极高** | 全流量 URL + 广告 + AI 请求响应，数据分享给第三方 |
| 供应链 | **中** | 本地打包，但 Google Fonts 是远程依赖 |
| 代码透明度 | **低** | 深度混淆，无法简单审计 |
| 服务端依赖 | **高** | 核心逻辑（规则、常量表）依赖服务端下发 |

### 关键建议

1. **如非必要，卸载扩展** — 权限组合极高且数据共享范围广
2. 如必须使用，**拒绝 advanced features consent** 以最小化数据采集
3. 在 chrome://extensions 中限制站点访问为 "On specific sites" 而非 "On all sites"
4. 定期检查 `chrome.storage.local` 中的数据以监控写入行为
5. 该扩展不适合在安全敏感环境（企业内网、金融、政府、医疗）中使用
