# CubeSeller 安全审计报告

> **审计范围**: v11.1.5 生产构建产物 (manifest.json + dist/* + _locales/*)
> **审计方法**: 静态分析 (无 source map, JS 为 minified 产物)
> **审计级别**: 架构审计 + 权限风险评估 + 数据流追踪 + 合规性分析
> **重点关切**: cookies 权限、`*://*/*` 范围、电商平台数据采集合规性

---

## 一、总体风险评级

| 维度 | 等级 | 说明 |
|------|------|------|
| 权限使用 | **高** | 7 个权限 + 全站 host_permissions, cookies 权限为高危 |
| 数据外泄风险 | **中** | 图片数据经 Background 转发, 未发现向第三方上报, 但存在本地客户端连接 |
| 请求伪造 | **中** | DNR 规则动态修改 Referer/Origin 头伪装来源 |
| Cookie 安全 | **高** | cookies 权限 + `*://*/*` 可读取任意网站 Cookie |
| CSP 安全 | **低** | 未声明 CSP, extension_pages 无限制 |
| Content Script 注入范围 | **高** | `*://*/*` 全站注入, 覆盖所有页面 |
| 电商平台合规 | **高** | Cookie 读写 + 全站注入 + 数据采集, 存在合规风险 |
| 供应链风险 | **低-中** | 使用 Vue 3.5.27 + JSZip 3.10.1, 均为知名开源项目但无法验证构建完整性 |

---

## 二、权限清单逐项审核

### 2.1 `cookies` — 高危

**声明**: `"cookies"` + `"host_permissions": ["*://*/*"]`

**影响范围**: 可读取和设置任意 URL 下的所有 Cookie (包括 HttpOnly Cookie)

**已确认使用**:
- `getCookies`: 读取平台 Cookie 以维持登录态
- `setCookie`: 写入 Cookie (登录后保存)

**风险评估**:
- **最高风险**: `cookies` + `*://*/*` 组合意味着此扩展可以读取用户在任何网站的 Cookie, 包括银行、邮箱、社交媒体的 Session Token
- **HttpOnly Cookie 泄露风险**: Chrome 扩展的 `chrome.cookies` API 可以读取 HttpOnly Cookie (这是设计行为), 本无法被页面 JavaScript 读取的敏感 Token 可被此扩展获取
- **无法验证范围限制**: 由于代码为 minified 产物, 无法静态验证 `getCookies` 是否仅访问电商平台域名, 还是可被任意调用
- **本地客户端风险**: 如果 Cookie 数据被传递到本地客户端 (`192.168.1.105:3100`), 则可能将用户凭据暴露到扩展沙箱之外

**改进建议**:
1. 将 `host_permissions` 缩小到具体电商平台域名, 而非 `*://*/*`
2. 在不使用 Cookie 权限时将其移除, 仅在需要时通过 `optional_permissions` 请求
3. 如果只读不需要写, 移除 `setCookie` 的调用

### 2.2 `host_permissions: *://*/*` — 高危

**影响范围**: 扩展可在任意 URL 下运行 Content Script, 发起跨域请求, 读写 Cookie

**已确认使用**:
- Content Script 注入到所有页面 (`*://*/*`)
- Background 向任意 URL 发起 `fetch()` 请求
- Cookie 读写覆盖所有域名

**风险评估**:
- 虽然大多数页面不匹配平台规则, Content Script 仍然加载并执行, 消耗资源
- 任何网站都可能触发 Content Script 中的代码路径, 增加了攻击面
- 匹配 `*://*/*` 的 Web Accessible Resources 使任何网站都可以加载扩展资源

**改进建议**:
1. 将 Content Script 的 `matches` 从 `*://*/*` 改为具体电商平台域名列表
2. 将 `host_permissions` 缩小到实际需要的域名

### 2.3 `declarativeNetRequest` — 中危

**已确认使用**:
- 动态添加/删除 Referer/Origin 头的修改规则
- 用于使跨域图片请求看起来像同源请求

**风险评估**:
- 动态规则的控制消息 (`setReferers`) 来自 Content Script, 如果 Content Script 被恶意页面利用, 可能设置任意 Referer 头
- Referer 伪装本质上是在绕过服务端的防盗链/CSRF 保护
- 规则 ID 和内容由 Content Script 传入, 缺少服务端验证

**改进建议**:
1. 在 Background 中硬编码 Referer 目标域名, 不接受来自 Content Script 的任意 Referer 值
2. 限制 DNR 规则仅匹配电商 CDN 域名, 而非任意域名

### 2.4 `downloads` — 中危

**已确认使用**:
- 批量下载图片和视频文件

**风险评估**:
- Content Script 可传递任意 URL 给 `download` 消息, 可能触发恶意文件下载
- 无文件类型白名单验证

**改进建议**:
1. 在下载前验证文件扩展名 (仅允许图片/视频格式)
2. 限制下载来源域名为已知 CDN

### 2.5 `scripting` — 中危

**已确认使用**:
- 动态注入 `windowDataMessage.js` 到页面 MAIN world

**风险评估**:
- `windowDataMessage.js` 运行在 MAIN world, 可访问页面所有 JavaScript 对象
- 但该脚本仅读取指定的属性路径并通过 `postMessage` 回传, 功能单一

**改进建议**:
1. 考虑使用 `content_scripts` 声明式注入替代 `scripting.executeScript`, 消除动态注入的能力

### 2.6 `storage` + `unlimitedStorage` — 低-中危

**已确认使用**:
- `storage`: 保存用户设置、提取规则配置
- `unlimitedStorage`: 可能用于缓存大量图片数据

**风险评估**:
- `unlimitedStorage` 使扩展可以无限制写入数据, 可能被滥用填充用户磁盘
- 存储内容为用户配置和规则, 本身不含敏感凭据 (但应注意是否存储了 Cookie 值)

**改进建议**:
1. 审查存储中是否保存了 Cookie 或 Token 值
2. 如不需要无限存储, 移除 `unlimitedStorage`

### 2.7 `activeTab` — 低危

**已确认使用**:
- 获取当前活动标签页的 URL 和信息

**风险评估**:
- 标准权限, 仅在用户点击扩展图标时生效
- 风险可控

---

## 三、Content Script 安全分析

### 3.1 注入范围

Content Script 注入到 **所有 URL** (`*://*/*`), 这是最大的攻击面:

```
匹配范围: *://*/*
  ├── 电商平台 (1688, taobao, tmall, jd, ...)
  ├── 社交媒体 (weibo, instagram, pinterest, ...)
  ├── 搜索引擎 (google, bing, baidu, ...)
  ├── 银行/支付网站
  ├── 邮箱服务
  ├── 企业内部系统
  └── ... 所有其他网站
```

**虽然扩展仅在匹配平台规则的页面上激活功能**, 但 Content Script 的代码仍然在每个页面加载并执行, 包括:
- 消息监听器注册
- 平台识别逻辑 (URL → 正则匹配)
- DOM 观察器初始化

### 3.2 Message.js 通知组件

`content/message.js` 在所有页面创建 DOM 元素用于通知, 包含一个硬编码的本地服务链接:

```javascript
this.successHtml = '...<a href="https://192.168.1.105:3100/#/product/merchandise">查看已采集商品</a>'
this.loginHtml = '...<a href="https://192.168.1.105:3100/#/login">登录</a>'
```

**风险**:
- 硬编码的本地 IP 地址 (`192.168.1.105`) 暴露了内部网络拓扑信息
- 如果本地客户端存在漏洞, 可能被利用
- HTTPS 自签名证书问题: 本地服务使用 HTTPS (`3100` 端口) 但证书信任存疑

### 3.3 windowDataMessage.js (MAIN World 注入)

此脚本通过 `window.postMessage` 在 MAIN world 和 ISOLATED world 之间传递 `window` 对象上的数据。

**已确认操作**:
- 接收 `ext_gwd_EC_16931258` 消息类型
- 遍历 `paths` 数组, 通过 `Reflect.ownKeys` 安全读取属性
- 通过 `postMessage` 将结果返回

**安全评估**:
- 使用 `Reflect.ownKeys` 而非直接属性访问, 避免触发 getter 陷阱, 这是一种良好的防御做法
- 处理了 `[Symbol]` 语法, 用于访问 Symbol-keyed 属性
- **风险**: 它可以读取 `window` 对象上的任意属性, 包括敏感数据

### 3.4 Web Accessible Resources

```json
"web_accessible_resources": [{
  "resources": ["content/extract.js", "extract/extract.css", "content/windowDataMessage.js"],
  "matches": ["*://*/*"]
}]
```

**风险**:
- WAR 匹配 `*://*/*`, 任意网站都可以通过 URL 加载这些资源
- `content/extract.js` (785KB) 包含了完整的 Vue 3 和 JSZip 库, 可被外部网站利用
- `windowDataMessage.js` 可被恶意网站加载, 绕过 Content Script 隔离直接向 MAIN world 注入代码

**改进建议**:
1. 将 WAR `matches` 缩小到电商平台域名
2. `windowDataMessage.js` 不应作为 WAR 暴露, 应仅通过 `scripting.executeScript` 注入

---

## 四、Cookie 安全深度分析

### 4.1 权限组合的极端风险

```
cookies 权限 + host_permissions: *://*/* = 读取任意网站任意 Cookie
```

这个组合在 Chrome Web Store 审核中属于最高的敏感权限等级, 原因如下:

1. **HttpOnly Cookie 可读**: `chrome.cookies.getAll({})` 可以获取包括 HttpOnly 在内的所有 Cookie, 这意味着即使网站正确设置了 HttpOnly 标志保护 Session Token, 此扩展仍然可以读取它
2. **Secure Cookie 可读**: 同样, Secure 标志对扩展不构成保护
3. **SameSite Cookie 可读**: SameSite 策略对扩展 API 不生效

### 4.2 Cookie 数据流向

```
用户浏览器 Cookie
  → chrome.cookies.get() [Background Worker]
    → 返回给 Content Script [通过 sendResponse]
      → 可能传递给本地客户端 [192.168.1.105:3100]
```

**风险评估**:
- Cookie 数据离开了浏览器的安全沙箱
- 如果本地客户端被攻破, 或存在中间人攻击 (本地 HTTPS 自签名), Cookie 可被窃取
- 无法静态验证 Cookie 数据是否仅用于电商平台登录, 还是被收集上报

### 4.3 合规风险

- **GDPR**: Cookie 属于个人数据, 在未明确告知用户的情况下读取 Cookie 可能违反 GDPR
- **中国个人信息保护法**: Cookie 中的登录凭据属于个人信息, 收集和处理需要明确告知用户并获得同意
- **Chrome Web Store 政策**: cookies 权限 + `*://*/*` host 的扩展需要提供充分的隐私说明和理由

---

## 五、电商平台数据采集合规性分析

### 5.1 平台服务条款审视

CubeSeller 的核心功能是从电商平台商品详情页批量提取图片、视频和评论内容。这涉及以下法律和政策问题:

| 关切领域 | 风险 | 说明 |
|---------|------|------|
| 版权侵权 | **高** | 商品图片和视频通常受版权保护, 批量下载可能构成侵权 |
| 平台服务条款 | **高** | 多数电商平台禁止自动化抓取 (如淘宝、1688 禁止爬虫) |
| 反爬措施绕过 | **中** | DNR 规则伪造 Referer 属于绕过反爬机制 |
| 用户生成内容 (UGC) | **中** | 提取评论图片涉及其他用户的 UGC 版权 |
| 商业用途 | **高** | 如果采集的图片用于商业目的 (如一件代发铺货), 风险显著提高 |

### 5.2 Referer 伪造的法律风险

通过 `declarativeNetRequest` 修改 Referer/Origin 头使请求伪装为同源, 本质上是:

1. **绕过 CDN 防盗链**: 多数电商图片 CDN 使用 Referer 检查来防止外站盗链, DNR 规则通过伪造 Referer 绕过了这一保护
2. **违反计算机信息系统安全**: 在中国法律框架下, 故意绕过网站安全措施 (包括 Referer 检查) 可能构成 "非法获取计算机信息系统数据"
3. **与 robots.txt 无关**: 这是 HTTP 头级别的绕过, robots.txt 不覆盖此行为

### 5.3 Cookie 使用合规

- 扩展使用 `chrome.cookies` 读取平台 Cookie 以维持登录态进行图片下载
- 如果此登录态是用户主动登录的, 属于用户的自主行为
- 但如果扩展在用户不知情的情况下复制 Cookie 到本地客户端, 则存在合规问题

### 5.4 建议

1. **在扩展描述中明确说明**: 扩展会读取 Cookie 以维持登录态, 会发送请求到哪些域名, 图片数据是否会被本地客户端处理
2. **提供隐私政策链接**: 在 Chrome Web Store 页面和扩展内提供隐私政策
3. **限制数据使用范围**: 明确承诺不将 Cookie 或图片数据发送到第三方
4. **获取用户明确同意**: 首次使用时弹窗告知用户数据收集范围并获取同意

---

## 六、网络通信审计

### 6.1 外部通信目标

| 目标 | 协议 | 用途 | 风险 |
|------|------|------|------|
| 各电商平台 CDN | HTTPS | 图片下载 | 低 (业务必须) |
| 各电商平台 API | HTTPS | 商品数据获取 (XHR 代理) | 中 (可能传输凭据) |
| ushangtech.com | HTTPS | 图片翻译/抠图 | 中 (图片数据上传到第三方) |
| 192.168.1.105:3100 | HTTPS | 本地客户端 (链接跳转) | 高 (内网 IP 硬编码) |
| google.com (update) | HTTPS | 扩展更新检查 | 低 |

### 6.2 第三方服务: ushangtech.com

- 翻译功能: 用户选中的图片被发送到 `ushangtech.com/ec/transimage` 进行 OCR 翻译
- 抠图功能: 图片发送到 `ushangtech.com/ec/cutoutimage` 进行背景移除
- **合规关切**: 图片数据被上传到第三方服务器, 用户可能不知情

### 6.3 本地客户端连接

硬编码的本地服务地址 `https://192.168.1.105:3100` 说明存在配套的桌面应用程序 "魔方卖家助手":
- 该客户端可能与 Chrome 扩展进行更深度的集成 (如 WebSocket 通信)
- HTTPS 自签名证书在本地环境可能被忽略, 存在中间人风险
- `192.168.1.105` 是硬编码的 C 类私有地址, 不同用户的网络环境可能不同

---

## 七、CSP 分析

### 7.1 当前状态

manifest.json 中**未声明 `content_security_policy`**, 这意味着:
- Extension pages (popup.html, extract.html) 使用 Chrome 默认的宽松 CSP
- Content Script 不受 CSP 限制 (Chrome 设计行为)
- 内联脚本和 `eval()` 理论上被允许 (MV3 默认 CSP: `script-src 'self'; object-src 'self'`)

### 7.2 风险

- Extension pages 的安全完全依赖 Vue 3 框架自身的安全保证
- 如果 popup 或 extract 页面加载了外部资源, 可能被 XSS 攻击

---

## 八、威胁模型

### 8.1 攻击面

| 攻击向量 | 可行性 | 影响 | 详情 |
|---------|--------|------|------|
| 恶意网页利用 Content Script | **中** | 高 | Content Script 注入 `*://*/*`, 恶意页面可构造消息触发未预期的行为 |
| Cookie 窃取 | **中** | 极高 | 如果 Content Script 或本地客户端存在漏洞, 可窃取用户所有 Cookie |
| XSS 通过提取的图片数据 | **低** | 中 | SVG 图片可能包含恶意脚本 |
| DNR 规则投毒 | **低** | 中 | 恶意 Content Script 可设置任意 Referer, 可能被用于 CSRF 攻击 |
| 供应链: 恶意 npm 包 | **中** | 高 | Vue 3.5.27 / JSZip 3.10.1 的构建产物无法验证完整性 |
| 本地客户端漏洞利用 | **中** | 高 | 如果 192.168.1.105:3100 的服务存在漏洞, 可能被局域网攻击者利用 |

### 8.2 信任边界

```
┌─ 不可信区域 ──────────────────────────────────┐
│ 电商平台页面 JavaScript (MAIN world)             │
│ 电商平台 API 响应                                │
│ 用户配置 (chrome.storage)                        │
│ 本地网络 (192.168.1.105)                        │
└────────────────────────────────────────────────┘
                    │
            ┌───────┴───────┐
            │ Content Script │ ← 信任边界: 解析数据, 渲染 UI
            └───────┬───────┘
                    │ chrome.runtime.sendMessage
            ┌───────┴───────┐
            │   Background   │ ← 信任边界: 发起网络请求, 管理 Cookie
            └───────┬───────┘
                    │
            ┌───────┴───────┐
            │ chrome.cookies │ ← 系统 API: 读取全部 Cookie
            │ chrome.downloads│
            └───────────────┘
```

---

## 九、改进建议总结

### 9.1 高优先级 (建议在发布前修复)

1. **缩小 host_permissions**: 从 `*://*/*` 改为具体的电商平台域名白名单
2. **移除或限制 cookies 权限**: 如仅需维持登录态, 考虑使用 `optional_host_permissions` 让用户选择
3. **DNR 规则硬编码**: 在 Background 中验证 Referer 目标域名, 不接受 Content Script 传入的任意值
4. **WAR matches 缩小**: 从 `*://*/*` 改为具体电商域名
5. **移除硬编码内网 IP**: 使用可配置的服务器地址

### 9.2 中优先级

6. **添加 CSP 声明**: 为 extension_pages 添加 `"script-src 'self'; object-src 'self'"`
7. **添加隐私政策**: 在扩展中说明数据收集和使用方式
8. **Cookie 使用最小化**: 仅在必要时读取 Cookie, 不在 storage 中持久化 Cookie 值
9. **审核 ushangtech.com 数据传输**: 确认翻译/抠图功能是否向用户告知数据上传

### 9.3 低优先级

10. **文件下载白名单**: 限制下载文件类型为图片/视频格式
11. **extract.js 拆分**: 将 WAR 中的 785KB 文件拆分为更小的功能模块
12. **外部连接清单**: 在 manifest 中声明 `externally_connectable` 限制跨扩展通信
13. **定期安全审查**: 由于使用了第三方库 (Vue, JSZip), 应定期检查 CVE 并更新依赖

---

## 十、审计局限性

1. **静态分析限制**: JS 文件均为 webpack minified 产物, 无 source map, 无法进行完整代码审查
2. **动态行为未验证**: 基于模式匹配和 API 调用点分析, 未在真实浏览器中运行验证
3. **本地客户端未知**: 无法审计 `192.168.1.105:3100` 上的桌面客户端代码
4. **规则配置完整性**: 提取规则配置以 JSON 字符串嵌入 background.js, 解析后的平台数量 (65+) 可能不完整
5. **版本锁定**: 审计基于 v11.1.5, 更高版本可能引入新的安全风险
