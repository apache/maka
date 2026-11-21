# Chrome Font Super Enhancer — 安全审计报告

## 审计范围

- 目标: Chrome Font Super Enhancer v2.25 (Manifest V3)
- 源码: 18 个文件（JS / HTML / CSS / JSON / 图片）
- 日期: 2026-07-05
- 方法: 静态源码分析（手动逆向）

---

## 一、权限分析

### 清单声明的权限

| 权限 | 类型 | 风险等级 | 说明 |
|------|------|---------|------|
| `storage` | API 访问 | 🟢 低 | 读取/写入扩展专属存储，无法访问其他扩展数据 |
| `activeTab` | API 访问 | 🟡 中 | 可获取用户点击扩展图标时的标签页信息（URL、标题等） |

### 隐式权限（通过 content_scripts）

| 配置项 | 值 | 风险等级 | 说明 |
|--------|-----|---------|------|
| `matches` | `<all_urls>` | 🟡 中 | 注入到所有 HTTP/HTTPS/FTP 页面 |
| `run_at` | `document_end` | 🟢 低 | DOM 构建完成后注入，不阻塞页面加载 |
| `all_frames` | `true` | 🟡 中 | 注入到所有 iframe，包括跨域子框架 |

### 权限评估

扩展未申请任何高风险权限（如 `cookies`、`webRequest`、`tabs` 完整权限、`<all_urls>` 主机权限中的敏感权限项）。`activeTab` 仅在用户主动点击时生效，无法在后台静默收集标签页数据。`all_frames` 的注入范围较广，但 content script 仅做样式修改，未进行网络通信或数据外传。

---

## 二、代码安全分析

### 2.1 数据外泄风险 — 🟢 无风险

- **无网络请求**: content.js、popup.js、options.js、manage.js、service-worker.js 均未发起任何 `fetch`、`XMLHttpRequest`、`WebSocket` 或 `navigator.sendBeacon` 调用
- **无远程代码加载**: 所有脚本均为本地文件，未从 CDN 或外部 URL 加载
- **无数据收集**: 未向任何外部服务器发送用户数据、浏览历史或页面内容

### 2.2 存储安全 — 🟢 低风险

- 所有数据存储在 `chrome.storage.sync` 和 `chrome.storage.local`
- 存储内容仅限于用户偏好设置（字体厚度、开关状态、排除域名列表、解锁码）
- 未存储敏感信息（密码、Token、Cookie、个人信息）
- `chrome.storage.sync` 会跨设备同步，但内容不敏感

### 2.3 DOM 操作安全 — 🟢 低风险

- content.js 仅操作 `style` 属性（`text-shadow`、`-webkit-text-stroke`、`letter-spacing`）
- 不创建或修改 innerHTML（无 XSS 注入点）
- 使用 `WeakMap` / `WeakSet` 进行元素跟踪，不在 DOM 上设置 `data-*` 属性
- 未监听键盘事件或表单输入

### 2.4 解锁码机制 — 🟡 注意

- 解锁码通过字符串混淆生成：
  ```javascript
  const getuc = () =>
    "Contexts binary-o Stage100 parameter 80040000 unzipped Append Async"
      .split(' ')
      .reduceRight((t, w, i) => t + w[7 - i], '');
  // 结果: "Apz4m1-s"
  ```
- **强度评估**: 混淆而非加密。任何能读取源码的人（包括从 Chrome Web Store 下载 CRX 并解包）都可以通过静态分析还原解锁码，但普通用户无法从 UI 层猜测
- **无服务端验证**: 解锁码完全在客户端验证，无需网络请求
- **影响**: 解锁码保护的是捐赠墙移除功能，不涉及任何敏感操作或数据

### 2.5 输入验证 — 🟢 完善

**manage.js 域名规范化**:
```javascript
function normalizeDomain(raw) {
  // 1. 去首尾空格
  // 2. 转小写
  // 3. 去除协议前缀 (http://, https://)
  // 4. 去除路径部分
  // 5. 去除端口号
  // 6. 长度校验 (≤253)
  // 7. 正则校验: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
}
```

- 阻止了注入恶意域名、空白域名、超长域名
- 不校验 IP 地址和 IDN 域名（以 "xn--" 开头的 Punycode 会被正则拒绝）

**数值输入验证**:
- 厚度值限制 0-9
- 字间距限制 0-20
- 使用 `isNaN` 和范围检查

**解锁码输入**: 限制 15 字符，设置 `autocomplete="off"` 和 `spellcheck="false"`

### 2.6 跨站脚本 (XSS) — 🟢 无风险

- `manage.js` 使用 `tdName.textContent = domain` 渲染域名（`textContent` 自动转义，非 `innerHTML`）
- 所有 UI 使用 `addEventListener` 绑定事件，无内联事件处理器中的动态代码执行风险
- 无 `eval()`、`new Function()` 或 `setTimeout` 字符串参数

### 2.7 消息通信 — 🟢 安全

- 仅有一个消息类型：`{type: "popupOpened"}` 从 popup.js 发往 service-worker.js
- 消息不包含任何页面内容、用户数据或 DOM 信息
- service-worker.js 未使用 `sendResponse` 返回数据

### 2.8 窗口管理 — 🟢 低风险

- `manageWindowId` 存储在 `chrome.storage.local`
- service-worker.js 监听 `windows.onRemoved` 清理，防止死引用
- 管理窗口创建前检查已有窗口是否存在，实现单例模式
- 弹出窗口类型为 `popup`，限制了交互能力

---

## 三、隐私合规评估

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 网络请求 | 无 | 离线可用，无任何外部通信 |
| 用户数据收集 | 无 | 不收集、不存储、不上传任何用户数据 |
| 第三方服务 | 仅有 PayPal 链接 | popup 中的捐赠链接指向外部 PayPal，用户主动点击才会跳转 |
| Cookie / 追踪 | 无 | 无追踪机制 |
| 远程代码执行 | 无 | 所有代码本地打包 |
| 浏览器历史记录访问 | 仅 activeTab | 仅在用户点击图标时获取当前标签页 URL（用于域名排除功能） |

---

## 四、发现总结

### 安全评级: 🟢 低风险

| 类别 | 等级 | 发现数 |
|------|------|--------|
| 高危 | 🔴 | 0 |
| 中危 | 🟡 | 0 |
| 低危 | 🔵 | 0 |
| 注意 | 📝 | 1 |

### 唯一关注点

**解锁码混淆强度不足** (📝 注意)

- **描述**: 解锁码 `"Apz4m1-s"` 通过客户端字符串混淆生成，静态分析可轻易还原
- **影响**: 用户可绕过捐赠获取高级功能（字间距调整、域名排除管理）
- **风险**: 低。解锁功能仅涉及 UI 增强，不暴露任何隐私或安全敏感操作
- **建议**: 如需真正保护捐赠功能，可引入服务端验证。但鉴于功能性质，当前方案可接受

### 总体结论

Chrome Font Super Enhancer 是一款安全的浏览器扩展。它仅需最小权限集（storage + activeTab），不进行任何网络通信或数据收集，所有操作均在本地完成。代码使用标准的 Chrome Extension API，无不安全的编码模式（无 eval、无 innerHTML 注入、无外部脚本加载）。唯一的"安全"功能——解锁码保护——性质上更接近防盗版而非安全防护，其薄弱性不影响用户数据和隐私。
