# Get CRX — 安全审计报告

## 审计范围

- 审计对象：Get CRX Chrome 扩展 v1.51
- 审计范围：`manifest.json`、`bg.js`
- 风险等级：**低**（无网络通信权限外的敏感操作）

---

## 发现清单

### 1. [中危] 全局可变状态导致文件名竞争

**位置**: `bg.js:8` — `var ExtName;`

**描述**: `ExtName` 是模块级可变变量，在 `getCRX()` 中写入，在 `onDeterminingFilename` 中读取。如果两次下载的时序交错，文件名会错配。

**影响**: 下载的文件以错误名称保存，造成用户困惑。不涉及数据泄露或安全问题。

**建议**: 使用 `Map<downloadId, extName>` 替代全局变量，在 `onDeterminingFilename` 中通过 `Item.id` 查找。

**利用难度**: 高（需要 Service Worker 在两次下载间不被终止，且用户快速操作）

---

### 2. [低危] 扩展名称净化不充分

**位置**: `bg.js:14,28` — `replace(/[&\/\\:"*<>|?]/g, '')`

**描述**: 只过滤了 Windows 文件系统非法字符。以下情况未处理：

| 边缘情况 | 后果 |
|----------|------|
| 扩展名为空（全部被过滤） | 文件名为 `.crx`，可能不可见 |
| 扩展名仅含空格 | 文件名为纯空格，难以定位 |
| 扩展名以 `.` 开头或结尾 | Windows 下可能导致隐藏文件 |
| 扩展名超长 (>255 字符) | 不同文件系统的行为不一致 |
| 扩展名包含 `CON`/`PRN`/`NUL` 等 Windows 保留名 | 可能导致保存失败 |

**影响**: 低 — Chrome Web Store 上的扩展名通常合法，且 `saveAs` 对话框允许用户手动修改文件名。

**建议**: 
1. 添加空值/纯空格回退逻辑
2. 截断过长名称
3. 检测 Windows 保留设备名

---

### 3. [低危] 扩展 ID 未校验格式

**位置**: `bg.js:15,29` — URL 字符串分割提取扩展 ID

**描述**: 扩展 ID 直接从 URL 路径段提取，未校验其是否为 32 字符小写字母（Chrome 扩展 ID 的标准格式 `[a-p]{32}`）。

**影响**: 如果 Web Store 页面 URL 结构发生变化（例如添加查询参数或路径段），可能提取到错误的值。但下载 URL 中的 `id` 参数由 Google 服务端校验，无效 ID 不会返回恶意 .crx 文件，只会返回错误。

**建议**: 使用正则 `/^[a-p]{32}$/` 校验提取到的扩展 ID。

---

### 4. [信息] navigator.userAgent 版本解析脆弱

**位置**: `bg.js:17,31` — `navigator.userAgent.split("Chrome/")[1].split(" ")[0]`

**描述**: 用字符串分割解析 Chrome 版本号。如果 User-Agent 格式改变（例如 Chrome 更名为其他品牌），将抛出 TypeError。

**影响**: 低 — User-Agent 格式极为稳定，且即使解析失败也只影响下载 URL 中 `prodversion` 参数（Google API 对此参数不严格要求）。

**建议**: 添加 try-catch 防护，或使用 `navigator.userAgentData` API（若可用）。

---

### 5. [信息] 主机权限与下载目标不匹配

**位置**: `manifest.json:17-20`

**描述**: 
- `host_permissions` 声明了 `chrome.google.com` 和 `chromewebstore.google.com`
- 实际下载请求发往 `clients2.google.com`（不在 `host_permissions` 中）

**解释**: 这是设计上正确的。`host_permissions` 用于允许 Service Worker 的 `fetch`/`XHR` 请求，而扩展使用的是 `chrome.downloads.download()` API——它不需要对下载目标的 `host_permissions`，因为下载由浏览器而非扩展直接发起。

**建议**: 无需修改。此差异属于正常设计。

---

### 6. [信息] 无内容安全策略声明

**描述**: `manifest.json` 中未声明 `content_security_policy`。

**解释**: MV3 Service Worker 默认具有严格的 CSP，且 Service Worker 无权访问 DOM，因此 XSS 攻击面极低。未显式声明 CSP 属于可接受的做法。

---

## 风险矩阵

| 发现 | 风险等级 | 可利用性 | 影响 | 修复优先级 |
|------|----------|----------|------|------------|
| 全局状态竞争 | 中危 | 高门槛 | 低影响 | P2 |
| 名称净化不充分 | 低危 | 低 | 低影响 | P3 |
| 扩展 ID 未校验 | 低危 | 极低 | 极低影响 | P4 |
| UA 解析脆弱 | 信息 | 极低 | 极低影响 | P4 |

## 总体评估

Get CRX 是一个功能简单、攻击面极小的扩展。不存在主流的 OWASP Top 10 类别漏洞。最大的工程问题是全局可变状态，但这更多是可靠性而非安全性问题。扩展没有网络通信、Cookie 访问、本地存储等能力，即使在最坏情况下被恶意利用，影响范围也仅限于触发畸形下载。
