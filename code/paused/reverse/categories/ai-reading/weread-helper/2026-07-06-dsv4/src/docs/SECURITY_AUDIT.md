# i微信读书 安全审计报告

## 审计范围

- **目标**: i微信读书 (WeRead Helper) v0.9.22 Chrome 扩展
- **Manifest 版本**: MV2
- **源码来源**: Webpack 打包产物 + Source Map (完整)
- **审计方法**: 静态分析 (manifest.json + 全部 JS 文件)
- **日期**: 2026-07-06

---

## 一、权限面分析

### 1.1 权限声明

```json
"permissions": [
  "webRequest",
  "webRequestBlocking",
  "*://weread.qq.com/*",
  "*://flomoapp.com/*",
  "*://api.notion.com/*",
  "*://open.feishu.cn/*",
  "*://*.tencent.com/*"
]
```

| 权限 | 风险等级 | 说明 |
|------|---------|------|
| `webRequest` | 中 | 可观察所有匹配 URL 的网络请求 |
| `webRequestBlocking` | **高** | 可**修改/阻塞**匹配 URL 的网络请求 |
| `*://weread.qq.com/*` | 低 | 微信读书主站，符合功能预期 |
| `*://flomoapp.com/*` | 中 | Flomo 笔记平台，可能是用户私人笔记 |
| `*://api.notion.com/*` | 中 | Notion API，可能涉及用户数据库内容 |
| `*://open.feishu.cn/*` | 中 | 飞书开放平台，用于企业协作 |
| `*://*.tencent.com/*` | **高** | **腾讯全系站点**，含腾讯云、QQ、微信等 |

### 1.2 权限膨胀评估

- `*://*.tencent.com/*` 权限远超功能所需（实际上 m.js 仅需 `cloud.tencent.com`），这是明显权限膨胀
- `webRequestBlocking` 用于移除 CSP 和注入 CORS 头，从技术上绕过了浏览器安全策略
- 无 `storage` 权限声明（实际使用 store2 = localStorage），不需要 Chrome Storage API

---

## 二、数据流安全分析

### 2.1 用户笔记数据外传路径

扩展会将用户微信读书笔记发送到以下外部服务：

| 目标 | 数据内容 | 触发方式 | 认证方式 |
|------|---------|---------|---------|
| Flomo | 划线文本 + 书名 | 用户点击划线按钮 | 用户输入的 API URL |
| Readwise | 全部笔记 + 书名/作者/封面 | 用户点击同步按钮 | 用户输入的 Token |
| Notion 代理 (`wx.redream.cn`) | 全部笔记 + 书籍元数据 + Notion Token | 用户点击同步按钮 | 用户 Token (经中转服务器) |
| Sentry | 错误上下文 + 用户行为 | 自动 (错误发生时) | 无 (硬编码 DSN) |

### 2.2 Notion 数据中转风险 (高危)

```javascript
// src/utils/index.js 中的 upsertPage 函数
var url = 'https://wx.redream.cn/weixin/ireader/notion/upsert/';
// ...
body: JSON.stringify({
  token: token,           // ← 用户的 Notion Integration Token
  databaseId: databaseId, // ← 用户的 Notion 数据库 ID
  data: { /* 全部书籍+笔记数据 */ }
})
```

**关键发现**: Notion 同步不直接调用 `api.notion.com`，而是通过作者服务器 `wx.redream.cn` 中转。这意味着：

1. **作者服务器可获取用户的 Notion Integration Token**（可读取/写入用户 Notion 数据库）
2. **作者服务器可获取全部微信读书笔记内容**
3. Token 明文传输（HTTPS 但服务端可解密）
4. 没有提供直接调用 Notion API 的选项（强制走中转）

**风险评分**: 8/10（高危）— Notion Token 泄露风险

### 2.3 webRequest CSP 绕过

```javascript
// background.js
const onHeadersReceived = function (details) {
  for (let i = 0; i < details.responseHeaders.length; i++) {
    if (details.responseHeaders[i].name.toLowerCase() === 'content-security-policy') {
      details.responseHeaders[i].value = ''  // ← 完全清空 CSP!
    }
    if (details.responseHeaders[i].name.toLowerCase() === 'access-control-allow-origin') {
      details.responseHeaders[i].value = '*'  // ← CORS 全开放
    }
  }
}
```

**风险分析**:

- 移除 CSP 后，被拦截域名的页面失去 XSS 防护
- `Access-Control-Allow-Origin: *` 配合空 CSP 使得这些域名对所有来源开放
- 拦截范围包含 `flomoapp.com`、`api.notion.com`、`open.feishu.cn`，这些域名的安全策略均被破坏
- 拦截范围不含 `weread.qq.com` 本身？（实际包含 `*://weread.qq.com/*`）

**风险评分**: 7/10（高危）— 系统性削弱浏览器安全防护

---

## 三、硬编码凭据分析 (高危)

### 3.1 飞书 API 凭据 (硬编码)

```javascript
// background.js + src/utils/doc.js (两处重复)
const APP_ID = 'cli_a16bec5c4fb8500d'
const APP_SECRET = 'wUZ4m4ePbgfZS2WuOH6SCcMk83cIkShP'
```

- 飞书 App ID 和 App Secret **明文硬编码**在扩展中
- 任何安装扩展的用户均可通过开发者工具读取
- 凭据可被用于调用飞书开放平台 API（获取 tenant_access_token、创建文档等）
- **该凭据被泄露在 Chrome Web Store 公开分发版本中**

### 3.2 Sentry DSN (硬编码)

```javascript
// src/utils/sentry.js
dsn: 'https://76da9b65bb4540a0aee77342f5400fc9@o1228425.ingest.sentry.io/6374181'
```

- Sentry DSN 可被用于发送虚假错误事件到作者的 Sentry 项目
- 如果 Sentry 开启了 Performance Monitoring，可能泄露用户行为数据

### 3.3 百度统计 ID (硬编码)

```javascript
// i.js
hm.src = 'https://hm.baidu.com/hm.js?cda23766027f4145f8a9d2087788759e'
```

- 百度统计追踪用户行为（划线、同步、导出等操作均上报 `_trackEvent`）
- 未征得用户同意即进行行为追踪
- 百度的隐私政策可能不符合某些地区的合规要求

### 3.4 CPS 推广 Key (硬编码)

```javascript
// m.js
const tenKey = '1d358d18a7a17b4a6df8d67a62fd3d3d'   // 腾讯云
const aliKey = 'okjhlpr5'                              // 阿里云
```

- 用户访问腾讯云/阿里云时自动注入推广参数
- 用户的所有购买行为可能都计入作者佣金

---

## 四、CSP 与注入面

### 4.1 Content Script 注入方式

```javascript
// contentScript.js — document_start 阶段注入
function injectCustomJs (jsPath) {
  const temp = document.createElement('script')
  temp.setAttribute('type', 'text/javascript')
  temp.src = chrome.runtime.getURL(jsPath)
  document.head.insertAdjacentElement('afterbegin', temp)
}
```

- `web_accessible_resources` 暴露了 i.js、plugin.js 和所有字体文件
- 恶意网页理论上可通过 `fetch(chrome.runtime.getURL('plugin.js'))` 探测扩展是否存在

### 4.2 Function.prototype 劫持

```javascript
// i.js
Function.prototype.apply = (function (orig) {
  return function () {
    if (arguments?.[0]?.[t]) { /* getTextFromObjs */
      if (!o.r) {
        o.r = arguments[0]
        const show = o.r[s] /* showSelectionToolBar */
        if (show&&!show.p) {
          show.p = true
          o.r[s] = function (...arg) {
            const event = new CustomEvent('textselect', { detail: arg[0] })
            document.dispatchEvent(event)
            // ...
          }
        }
      }
    }
    return orig.call(this, ...arguments)
  }
}(Function.prototype.apply))
```

- 劫持 `Function.prototype.apply` 这种全局方法会影响页面所有 JS 执行
- 如果劫持逻辑出错或与微信读书更新不兼容，可能导致页面功能异常
- 代码使用字符串混淆 (`reverse().join()`)，目的可能是绕过 Chrome Web Store 审核

---

## 五、通信安全

### 5.1 Content Script <-> Page 通信

- 通过 `CustomEvent('textselect')` 在 DOM 上派发事件
- 事件数据包含完整选中文对象 (html/text/offset 等)
- 任何页面脚本可以监听并截获这些事件

### 5.2 跨域 API 调用

- 所有第三方 API 调用均通过 `fetch()` 直接发起
- Flomo API URL 存储在 localStorage (`flomoApi`)，如果页面存在 XSS 可被读取
- Readwise/Notion Token 存储在 localStorage (store2)，同样存在 XSS 泄露风险

### 5.3 无输入验证

`flomoApi` 从 localStorage 读取后直接用于 fetch URL，无任何 URL 验证：
```javascript
var url = localStorage.getItem('flomoApi');
if (!url) return;
return fetch(url, { /* ... */ })
```

用户如果被诱导输入恶意 URL，可能导致数据发送到攻击者服务器。

---

## 六、存储安全

| 存储方式 | 数据 | 加密 | 风险 |
|---------|------|------|------|
| localStorage (store2, ns:iwr) | 全部设置 (主题/纸张/字体) | 无 | - |
| localStorage | Flomo API URL | 无 | 可被 XSS 读取 |
| localStorage (store2, ns:iwr) | Readwise Token | 无 | **明文存储 API Token** |
| localStorage (store2, ns:iwr) | Notion Token + Page ID | 无 | **明文存储 API Token** |
| localStorage (store2, ns:iwr) | 书签卡片设置 | 无 | - |

- 所有敏感数据明文存储在 localStorage，无加密
- 如果微信读书页面存在 XSS，所有 Token 可被窃取
- Token 的作用域：Readwise Token 可操作全部笔记，Notion Token 可操作整个数据库

---

## 七、隐私分析

### 7.1 数据收集

| 数据 | 收集方 | 目的 |
|------|--------|------|
| 划线文本 | Flomo / Readwise / Notion代理 / Sentry | 用户主动同步 |
| 全部笔记 | Readwise / Notion代理 | 用户主动同步 |
| 书籍元数据 | Readwise / Notion代理 | 同步上下文 |
| 用户行为事件 | 百度统计 | 产品分析 |
| JS 错误 | Sentry | 错误监控 |
| 页面交互 | 百度统计 (_trackEvent) | 点击分析 |

### 7.2 合规问题

- 无隐私政策链接
- 无用户数据收集告知
- 无退出追踪的选项
- 百度统计的 `_hmt` 收集行为未经用户同意

---

## 八、依赖安全

| 依赖 | 已知风险 |
|------|---------|
| @sentry/browser 6.x | DSN 硬编码在代码中，可被滥用 |
| html2canvas 1.x | `allowTaint: true` 允许绘制跨域图片，可能绕过同源策略 |
| store2 2.x | 纯 localStorage 封装，无加密 |
| turndown 7.x | HTML→Markdown，XSS 风险 (输入来自微信读书DOM) |

---

## 九、合规与总体评估

### 9.1 核心风险汇总

| 风险 | 等级 | 说明 |
|------|------|------|
| 硬编码 API 凭据 (飞书) | **严重** | App ID/Secret 在公开分发版本中泄露 |
| Notion Token 经第三方服务器中转 | **高危** | 用户 Notion Token 经过作者服务器 |
| CSP 完全移除 | **高危** | 被拦截域名失去 XSS 防护 |
| API Token 明文存储 | **高危** | Flomo/Readwise/Notion Token 明文在 localStorage |
| 无 Flomo URL 验证 | 中危 | 可能被诱导输入恶意 URL |
| 权限膨胀 | 中危 | *.tencent.com 远超功能所需 |
| Function.prototype 劫持 | 中危 | 可能影响页面稳定性 |
| 百度统计追踪 | 中危 | 未经用户同意的行为追踪 |
| Source Map 暴露源码 | 低危 | 源码完整可见 (plugin.js.map) |

### 9.2 总体评分

**安全评分: 3.5/10（低安全水平）**

主要扣分项：硬编码凭据泄露、Notion Token 中转风险、CSP 系统性移除、明文 Token 存储。

### 9.3 改进建议

1. **立即修复**: 飞书 App Secret 不应硬编码在客户端代码中，应通过服务端代理调用
2. **高优先级**: Notion 同步应直接调用 `api.notion.com`，不应经第三方服务器中转
3. **高优先级**: 缩小 CSP 移除范围，仅移除必要的指令而非清空全部
4. **高优先级**: Token 加密存储 (如使用 WebCrypto API)
5. **中优先级**: 权限声明应缩小到实际需要的域名
6. **中优先级**: 添加隐私政策和使用告知
7. **低优先级**: 生产构建应移除 Source Map 和 HMR 热更新文件
