# EditThisCookie V3 安全审计

> 反向工程版本: dsv4 | 源版本: v3.0.5 | 日期: 2026-07-06

---

## 一、审计范围

本次审计基于 EditThisCookie V3 (v3.0.5) 的源代码静态分析。审计覆盖：Manifest 权限、Service Worker、Popup、DevTools Panel、Options Pages、第三方依赖。

## 二、权限风险评估

### 2.1 权限清单与风险

| 权限 | 风险等级 | 风险说明 |
|------|----------|----------|
| cookies | **高** | 可读写所有域名的所有 Cookie（含 HttpOnly），完全控制浏览器身份认证令牌 |
| \<all_urls\> | **高** | 可访问所有网站的 Cookie，结合 cookies 权限获得全域 Cookie 读写能力 |
| clipboardWrite | **中** | 可写入剪贴板，Cookie 数据可能泄露到系统剪贴板 |
| tabs | **中** | 可获取标签页 URL、刷新页面，可被用于追踪用户浏览行为 |
| storage + unlimitedStorage | **低** | 大量 Cookie 数据本地存储，虽不受配额限制但不会外传 |
| contextMenus | **低** | 仅注册右键菜单入口，无数据访问能力 |

### 2.2 权限组合放大效应

```
cookies + <all_urls> + tabs = 完全 Cookie 控制 + URL 可见性
cookies + clipboardWrite = Cookie 明文导出到不受保护的剪贴板
```

## 三、数据安全分析

### 3.1 数据存储

- **存储位置**: `chrome.storage.local` (扩展本地存储，不加密)
- **存储内容**: 用户偏好、Cookie 统计计数、拦截规则、只读保护规则
- **不存储内容**: Cookie 的具体值 (name, value, domain 等) **不会**被持久化到 storage 中
- **保护规则存储**: readOnly 规则中**包含** Cookie 的 domain, name, path, secure, storeId，用于匹配和恢复

**风险评估**:
- Cookie 值和敏感数据不会进入 storage，这是好的设计
- 但 readOnly 规则存储了部分 Cookie 元数据（不含 value），如果攻击者获取了 storage 访问权限，可以了解被保护的 Cookie 结构
- `chrome.storage.local` 本身不加密，其他扩展或恶意网站**无法**直接访问（Chrome 隔离机制保护）

### 3.2 数据传输

- **Popup → Background**: 无直接通信，Popup 直接调用 `chrome.cookies.*` API
- **DevTools Panel → Background**: 通过 `chrome.runtime.connect` 建立长连接，传输 Cookie 数据 (含 name, value, domain 等)
- **Background → DevTools Panel**: 返回 Cookie 完整数据
- **导出格式**: JSON (含完整 Cookie 数据)、Netscape、Semicolon Pairs、LPW

**风险评估**:
- DevTools 通道传输完整 Cookie 值，但仅在本地扩展内部通信，风险可控
- Cookie 导出到剪贴板 (`clipboardWrite`) 后，数据进入系统剪贴板，可能被其他进程读取——这是最大的数据泄露面

### 3.3 外部网络请求

**首次安装时**:
```javascript
if (oldVersion === undefined) {
    chrome.tabs.create({ url: 'https://editcookie.com/#start' });
}
```
- 首次安装时自动打开外部网站 (`editcookie.com`)
- 不传输任何用户数据

**结论**: 无自动数据外传行为。唯一的网络连接是用户手动点击帮助/支持链接。

## 四、代码安全分析

### 4.1 输入验证

| 输入点 | 验证方式 | 安全性 |
|--------|----------|--------|
| Cookie name (编辑) | `.replace(';', '').replace(',', '')` | **不充分** — 仅移除分号和逗号，未验证长度、编码 |
| Cookie value (编辑) | `.replace(';', '')` | **不充分** — 仅移除分号 |
| Cookie domain (编辑) | 无显式验证 | **不充分** — 依赖 Chrome API 内置验证 |
| Cookie 导入 (JSON) | `JSON.parse` + 基本字段检查 | **基础** — 依赖 `cookieForCreationFromFullCookie` 的字段映射 |
| URL 搜索输入 | 正则 `/^https?:\/\/.+$/` | **可接受** |
| Popup URL 参数 | `decodeURIComponent` | **可接受** (仅用于 tabId/incognito 读取) |

### 4.2 XSS 风险

**发现的模式**:
```javascript
// popup.js — 动态构建 DOM
$(`<p/>`).text(domainText).append($(`<b/>`).text(currentC.name));
```

- jQuery 的 `.text()` 方法会进行 HTML 转义，防止 XSS
- Cookie 值通过 `.val()` 设置而非 `.html()`，是安全做法

**但有风险的模式**:
```javascript
// popup.js — 错误消息拼接
error.html(error.html() + "<br> Also check <a href='...' target='_blank'>...</a>");

// popup.js — 直接操作 innerHTML
$(':first-child', titleText).css('color', 'green');
```

- 错误消息中包含外部链接的硬编码 HTML（低风险，因为 href 是硬编码的）
- 未发现将用户输入的 Cookie 值直接注入 HTML 的情况

**结论**: XSS 防护整体良好，Cookie 数据通过安全 API 渲染。

### 4.3 原型污染

```javascript
// data.js
Object.defineProperty(Object.prototype, 'watch', { ... });
Object.defineProperty(Object.prototype, 'unwatch', { ... });
```

**严重程度: 中等**

- 向 `Object.prototype` 添加 `watch` 和 `unwatch` 方法
- 影响所有对象，可能与页面内其他脚本冲突
- 在 MV3 service worker 的隔离环境中风险降低，但在注入到页面的 content script 场景中风险升高
- 当前代码未使用 content scripts，此风险在 service worker 中可控

### 4.4 剪贴板操作

```javascript
// utils.js
function copyToClipboard(text) {
    var copyDiv = document.createElement('textarea');
    document.body.appendChild(copyDiv);
    $(copyDiv).text(text);
    copyDiv.focus();
    copyDiv.select();
    document.execCommand('copy');
    document.body.removeChild(copyDiv);
}
```

- 使用已废弃的 `document.execCommand('copy')`（Chrome 仍支持）
- 未检查剪贴板写入是否成功
- Cookie 明文写入系统剪贴板后，无法控制数据去向
- 建议: 迁移到 `navigator.clipboard.writeText()` (需要 focus 的页面上下文)

## 五、Cookie 操作安全

### 5.1 Secure Cookie 降级风险

```javascript
// cookie_helpers.js
function buildUrl(domain, path, searchUrl) {
    var secure = searchUrl.indexOf('https://') === 0;
    return 'http' + (secure ? 's' : '') + '://' + domain + path;
}
```

- URL 协议从搜索 URL 继承，而非从 Cookie 自身的 `secure` 属性
- 在编辑 Cookie 时可能错误地将 https-only cookie 的 URL 构建为 http

### 5.2 SameSite=None 无 Secure 校验

```javascript
// popup.js — formCookieData
if (sameSite === 'no_restriction' && !secure) {
    $('#error-message').text(_getMessage('Error_No_Restriction'));
    return; // 阻止提交
}
```

- **正面**: 阻止了 SameSite=None 但不带 Secure 的组合（Chrome 要求此组合无效）
- 这是正确的校验逻辑

### 5.3 Cookie 恢复机制 (ReadOnly 保护)

```javascript
// background.js
chrome.cookies.get({ url, name, storeId }, function(currentCookie) {
    if (compareCookies(currentCookie, currentRORule)) return;
    var newCookie = cookieForCreationFromFullCookie(currentRORule);
    chrome.cookies.set(newCookie);
});
```

**风险评估**:
- ReadOnly 规则中存储的 Cookie 值若已过期，会自动用旧值恢复
- 服务端可能已变更 Cookie 值，但扩展会用旧值覆盖——设计意图如此
- 恢复逻辑无法区分"用户手动删除"和"网站/浏览器自动清理"

## 六、第三方依赖风险

| 依赖 | 版本 | 已知漏洞 | 风险 |
|------|------|----------|------|
| jQuery | 3.3.1 | CVE-2020-11023 (XSS) | **中等** — 特定条件下存在 XSS |
| jQuery UI | 1.12.1 | CVE-2021-41182 (XSS) | **中等** — dialog closeText 选项 XSS |
| jQuery tablesorter | (unknown) | 未审计 | **低** — 仅在 DevTools panel 使用 |
| jQuery jeditable | (unknown) | 未审计 | **低** |
| jQuery Uniform | (unknown) | 未审计 | **低** |

**建议**:
- 升级 jQuery 到 3.5.0+ (修复 CVE-2020-11023)
- 升级 jQuery UI 到 1.13.0+ (修复 CVE-2021-41182)

## 七、安全建议摘要

### 高优先级

1. **剪贴板安全**: 迁移至 `navigator.clipboard.writeText()`，并在写入后添加可见提示
2. **Cookie 值校验**: 对用户输入的 Cookie name/value 增加字符白名单验证
3. **jQuery 升级**: 升级至 3.5.0+ / jQuery UI 1.13.0+

### 中优先级

4. **Secure URL 构建**: 从 Cookie 对象的 secure 属性决定 URL 协议，而非从搜索 URL 继承
5. **原型污染**: 移除 `Object.prototype.watch`，改用 Proxy 或手动 setter
6. **导出数据加密**: 考虑在导出前对敏感 Cookie 值脱敏或加密

### 低优先级

7. **首次安装页面**: 自动打开外部网站可被滥用，建议改为用户可选
8. **复制反馈**: 导出成功/失败的状态反馈可更明确
