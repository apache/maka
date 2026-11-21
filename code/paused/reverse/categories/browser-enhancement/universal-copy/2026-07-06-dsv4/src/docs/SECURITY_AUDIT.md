# SECURITY_AUDIT.md — 网页万能复制 v1.0.28

## 审计摘要

| 维度 | 风险等级 | 说明 |
|------|---------|------|
| 数据隐私 | HIGH | 收集用户 IP、地理位置、浏览行为并发送至第三方服务器 |
| 远程代码执行 | MEDIUM | 通过 `scripting.executeScript` 动态注入 JS,但来源限于扩展内置文件 |
| 供应链安全 | MEDIUM | 使用多个第三方 CDN/API 域名,存在被劫持风险 |
| 权限滥用 | HIGH | 拥有所有 HTTP/HTTPS 页面的注入权限,实际仅需复制相关页面 |
| 数据泄露 | MEDIUM | 向外部发送当前浏览 URL,未做脱敏处理 |
| 篡改检测 | INFORMATION | 内置防篡改检测但仅用于弹窗提醒,不阻止执行 |

---

## 详细审计

### 1. 数据隐私

#### 1.1 数据收集清单

扩展在安装和使用过程中收集以下用户数据:

| 数据项 | 收集时机 | 存储位置 | 发送目标 |
|--------|---------|---------|---------|
| UUID (用户标识) | 安装时生成 | `chrome.storage.local` | 阿里云 SLS + uninstall URL |
| 公网 IP 地址 | 安装时 | `chrome.storage.local` | 阿里云 SLS |
| 国家/地区 | 安装时 | `chrome.storage.local` | 阿里云 SLS |
| 城市 | 安装时 | `chrome.storage.local` | 阿里云 SLS |
| 操作系统 | 每次事件 | 不持久化 | 阿里云 SLS |
| 浏览器类型 (Chrome/Edge) | 每次事件 | 不持久化 | 阿里云 SLS |
| 当前页面 URL | 每次破解/复制 | 不持久化 | 阿里云 SLS |
| 扩展安装类型 | 安装时 | `chrome.storage.local` | 不发送 |
| 扩展版本号 | 每次事件 | 不持久化 | 阿里云 SLS + uninstall URL |
| 用户语言 | 每次事件 | `chrome.storage.local` | 阿里云 SLS |

#### 1.2 遥测服务 (阿里云 SLS)

- **终端**: `https://hawkeye-us.us-west-1.log.aliyuncs.com/logstores/webcopy/track`
- **压缩**: 可选 LZ4 压缩
- **协议**: HTTP POST,自定义 header `x-log-apiversion`, `x-log-bodyrawsize`
- **频率**: 每条事件立即发送 (count=1),或通过 alarm 定时发送
- **缓冲**: 事件先写入 `chrome.storage.local.arr`,达到阈值后批量发送

#### 1.3 IP 定位

安装时请求以下两个服务获取 IP 地理位置:
- `https://ipinfo.io/json` (优先)
- `http://ip-api.com/json/` (备用,明文 HTTP)

**风险**: 备用 API 使用明文 HTTP,可被中间人攻击篡改。

### 2. 权限审计

#### 2.1 权限清单

```json
{
  "permissions": [
    "tabs",
    "storage",
    "scripting",
    "declarativeNetRequestWithHostAccess"
  ],
  "host_permissions": [
    "http://*/*",
    "https://*/*"
  ]
}
```

#### 2.2 权限风险评估

| 权限 | 声明范围 | 实际使用 | 风险 |
|------|---------|---------|------|
| `tabs` | Tab 实例全访问 | 仅读取 URL 和发送消息 | 中 — 可获取所有 Tab 信息 |
| `storage` | 本地无限存储 | 白名单/配置/遥测缓冲 | 低 |
| `scripting` | 动态注入任意页面 | 仅注入 extension 内置 JS | 中 — 理论上可注入任意代码 |
| `declarativeNetRequestWithHostAccess` | 修改所有请求头 | 仅修改匹配 `seo=google&extension=webcopy` 的请求 | 低 |
| `host: http/https all` | 所有网页注入 CS | 所有页面注入 content-script | 高 — 可读取任意网页内容 |

**关键发现**: `host_permissions` 覆盖所有 HTTP/HTTPS 页面,远超实际功能需求。扩展可读取任何网页的 DOM,包括银行、邮箱等敏感页面。虽然 manifest 使用 `exclude_matches` 排除了 `.pdf` 页面,但 PDF 文件仍可通过 `web_accessible_resources` 的 `<all_urls>` 策略被访问。

### 3. 外部通信安全

#### 3.1 外部域名清单

| 域名 | 通信内容 | HTTPS | 风险评估 |
|------|---------|-------|---------|
| `us-west-1.log.aliyuncs.com` | 遥测数据 (含 URL/IP) | 是 | 数据泄漏风险 |
| `twiclips.com` | 卸载 URL, 远程配置 | 是 | 供应链风险 |
| `extensiondock.com` | 欢迎页, 新标签页 | 是 | 供应链风险 |
| `ipinfo.io` | IP 查询 | 是 | 隐私风险 |
| `ip-api.com` | IP 查询 (备用) | **否 (HTTP)** | 中间人攻击风险 |
| `static.doc88.com` | 代理提取文本路径 | 是 | 低 |
| `chrome.google.com` | 推广链接 | 是 | 低 |
| `apps.microsoftedge.microsoft.com` | 推广链接 | 是 | 低 |

#### 3.2 内容安全策略 (CSP)

manifest.json 中未声明 `content_security_policy`。MV3 默认使用较严格的 CSP,但外部域名 iframe (`extensiondock.com`) 以及多个 fetch 目标不受限制。

### 4. 代码注入分析

#### 4.1 动态脚本注入

```javascript
// background.js — 通过 scripting API 注入
chrome.scripting.executeScript({
  target: { tabId: e, allFrames: true },
  files: ["js/normal.js"]
});

// content-script.js — 通过 DOM 注入 docText.js
var e = document.createElement("script");
e.src = chrome.runtime.getURL("js/docText.js");
document.head.appendChild(e);
```

**风险**: 两种注入方式均使用扩展内置文件,非远程代码。`docText.js` 的 DOM 注入使其运行在页面上下文中,可访问页面 JS 变量 (用于道客巴巴文本提取)。

#### 4.2 User-Agent 篡改

```javascript
chrome.declarativeNetRequest.updateDynamicRules({
  addRules: [{
    action: {
      type: "modifyHeaders",
      requestHeaders: [{
        header: "User-Agent",
        operation: "set",
        value: "Baiduspider" 或 "bingbot"
      }]
    },
    condition: {
      urlFilter: "seo=google&extension=webcopy",
      resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"]
    }
  }]
});
```

**风险**: 仅对包含特定 URL 参数的请求生效,不会被常规浏览触发。

### 5. 防篡改机制

扩展内置了防篡改检测逻辑:

```javascript
// H() 函数
if (Date.now() - updateTime > 1296000000  // 超过 15 天
    && installType == "normal"             // 非开发版
    && chrome.runtime.id != OFFICIAL_ID)  // 非官方 ID
{
  P = false;  // 允许显示篡改警告
}
```

**分析**:
- **检测条件**: 安装类型为 "normal" 且扩展 ID 不匹配官方 ID 且安装已超过 15 天
- **触发行为**: 仅弹窗警告用户,不阻止功能执行
- **绕过方式**: 修改 `installType` 为 "development" 即可完全绕过
- **安全价值**: 低 — 更像反盗版措施而非安全防护

### 6. 评分/推广弹窗

扩展内置评分弹窗和跨扩展推广逻辑:

```javascript
// _() 函数 — 每复制 2 次触发一次弹窗 (最多 10 次)
if (copyTimes >= 2) {
  $(".webcopyMask").show();  // 显示评分弹窗
  storage.local.set({ copyTimes: 0, alertTimes += 1 });
}
```

弹窗内容:
- 评分引导 (跳转 Chrome Web Store)
- AI 助手推广 (跳转另一个扩展 `hcmiiaachajoiijecmakkhlcpagafklj`)
- 与文档聊天 (PDF 相关扩展推广 `hdofgklnkhhehjblblcdfohmplcebaeg`)

### 7. 存储安全

| 存储项 | 敏感度 | 加密 | 清理方式 |
|--------|--------|------|---------|
| uid (UUID) | 中 (用户追踪) | 否 | 卸载时自动清除 |
| ipInfo (IP/地址) | 高 | 否 | 卸载时自动清除 |
| hostList (域名) | 低 | 否 | 卸载时自动清除 |
| arr (日志缓冲) | 中 | 否 | 卸载时自动清除 |
| allcopy (页面文本) | 高 (可能含敏感内容) | 否 | 卸载时自动清除 |

`chrome.storage.local` 为明文存储,任何拥有 `storage` 权限的扩展和开发者工具可读取。

### 8. 改进建议

1. **最小权限原则**: 将 `host_permissions` 从 `http://*/*` / `https://*/*` 改为仅在用户交互时请求 (`activeTab`),或使用用户指定的域名列表
2. **遥测合规**: 在隐私政策中明确数据收集范围,提供 opt-out 选项
3. **HTTPS 强制**: 将 `ip-api.com` 备用 IP 查询改为 HTTPS
4. **存储加密**: 对 UUID、IP 等标识信息进行哈希处理,减少可追踪性
5. **CSP 强化**: 添加 `content_security_policy` 限制外部连接域名
6. **日志脱敏**: 不应向第三方发送完整 URL (可能包含 token/session 信息)
7. **评分弹窗限制**: 当前每 2 次复制弹窗 1 次,频率过高,影响用户体验
8. **篡改检测强化**: 防篡改机制应阻止执行而非仅弹窗,需与 CSP 和签名验证配合
