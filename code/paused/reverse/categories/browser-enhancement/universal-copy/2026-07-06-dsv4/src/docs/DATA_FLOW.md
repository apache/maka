# DATA_FLOW.md — 网页万能复制 v1.0.28

## 数据流概览

扩展的数据流分为 4 个主要通道: **破解控制流**、**用户行为遥测流**、**配置持久化流**、**外部网络请求流**。所有数据流均以 Service Worker 为中枢。

## 1. 破解控制流 (核心功能)

这是扩展最主要的数据流,控制网页复制限制的启用与停用。

### 1.1 手动破解 (Popup 触发)

```
用户点击 Popup 开关
  → popup.js: chrome.runtime.sendMessage({ type: "confirmCopy", control: true/false })
  → background.js: onMessage handler
    ├── 提取当前 Tab URL 的域名 (O() 函数)
    ├── 发送遥测: I("crack", "button_crack", domain)
    ├── 更新白名单: M("on"/"off", tabId, domain)
    │   ├── "on" → 域名加入 storage hostList
    │   ├── 调用 L("on", tabId) → 切换图标为彩色
    │   └── chrome.tabs.sendMessage({ msg: "web_crack" })
    │       → content-script.js:
    │         ├── 检查是否为站点适配器页面 (j() 函数)
    │         ├── 是 → 直接返回 { webcopy_result: true }
    │         ├── 否 → 返回 { webcopy_result: false }
    │         └── background: 收到 false 后调用 scripting.executeScript 注入 normal.js
    │
    └── "off" → 域名从 storage hostList 移除
                ├── 调用 L("off", tabId) → 切换图标为灰色
                └── chrome.tabs.reload(tabId) → 刷新页面恢复限制
```

### 1.2 自动破解 (Tab 更新触发)

```
chrome.tabs.onUpdated (status === "complete")
  → 提取域名 (O() 函数)
  → 检查 storage.hostList 是否包含该域名
  ├── 包含 → M("on", tabId, domain) → 注入 normal.js
  └── 不包含 → B(tabId) → 向 Content Script 发送 { msg: "isCrack" }
      → content-script 返回 { isCrack: true/false }
      → 根据返回值设置图标状态
```

### 1.3 破解执行细节 (normal.js 注入后)

```
normal.js 执行:
  1. s() 函数:
     - 清除 window.onkeyup/onkeydown
     - 移除 body/html 的 user-select 样式
     - 移除 document 的所有事件监听 (oncopy, oncut, onpaste, onkeyup, etc.)
     - 注入全局 CSS: * { user-select: text !important; ... }
     - 在 document.documentElement 上以 capture 模式添加事件拦截器
  2. a() 函数:
     - 遍历所有 HTML 元素
     - 清除每个元素的事件监听和内联限制属性
     - 移除 unselectable 等属性
  3. 定时重新执行: setTimeout(o.init, [1234, 3243, 4980, 9877])
     - 防止动态加载内容重新添加限制
```

## 2. 用户行为遥测流 (Analytics)

### 2.1 事件发送通道

```
业务层 (Content/Popup/Background)
  → chrome.runtime.sendMessage({ action: "sendAli", type, control, lable })
  → background.js: I(type, control, lable)
    ├── 收集上下文:
    │   ├── chrome.storage.local.get(["ipInfo", "install_time", "uid"])
    │   ├── chrome.tabs.query({ active: true, currentWindow: true })
    │   └── 构造 LogEntry 对象 (extension_name, version, user_ip, uuid, ...)
    └── new SlsLogger(config).send(logEntry)
        ├── transString() → 扁平化对象值
        ├── storage.local.get(["arr"]) → 获取缓冲数组
        ├── arr.push(logEntry)
        ├── arr.length >= count(1)?
        │   ├── 是 → logSending(arr) → logger(arr)
        │   │   POST https://{project}.{host}/logstores/{logstore}/track
        │   │   Headers: x-log-apiversion, x-log-bodyrawsize, x-log-compresstype: lz4
        │   │   可选 LZ4 压缩
        │   └── 否 → 更新 storage.local.arr,设置 alarm 定时发送
```

### 2.2 遥测事件类型

| event_category | event_operate | 触发场景 |
|---------------|---------------|---------|
| `install` | `user_install` | 首次安装 |
| `update` | `user_update` | 扩展更新 |
| `crack` | `button_crack` | Popup 开关打开 |
| `crack` | `auto` | Tab 加载时自动破解 |
| `deleteUrl` | `crack_button_delete` | Popup 开关关闭 |
| `copy` | `button_copy` | 点击复制按钮 |
| `copy` | `button_all copy` | 点击全文复制 |
| `ext_to_pdf` | `copyBtn`/`inject` | PDF 推广点击 |
| `ext_to_ai` | `inject` | AI 助手推广点击 |
| `click` | `textBtn` | 点击 AI 悬浮按钮 |

### 2.3 SLS 配置

```javascript
{
  host: "us-west-1.log.aliyuncs.com",
  project: "hawkeye-us",
  logstore: "webcopy",
  time: 0.05,   // 50ms 发送间隔 (但 alarm 使用秒级)
  count: 1       // 每条事件立即发送
}
```

## 3. 配置持久化流

### 3.1 Storage 读写模式

```
chrome.storage.local (无限制存储)
├── hostList: string[]        — 域名白名单 (Background 读写)
├── updateTime: number        — 白名单更新时间 (Background 读写)
├── uid: string               — 用户 UUID (安装时生成,只读)
├── install_time: string      — 安装时间戳 (安装时写入,只读)
├── installType: string       — 安装类型 (安装时写入,只读)
├── ipInfo: IpInfo            — IP 地理位置 (安装时获取,只读)
├── copyTimes: number         — 复制计数 (Content Script 读写)
├── alertTimes: number        — 弹窗计数 (Content Script 读写)
├── arr: LogEntry[]           — 日志缓冲 (Background 读写)
├── rate_dialog: object       — 评分对话框状态 (Background 读写)
├── menuList: MenuItem[]      — 书签菜单 (安装时初始化)
├── isShowAiLogo: boolean     — AI logo 显示控制
├── isShowPdfLogo: boolean    — PDF logo 显示控制
└── allcopy: string           — 全文复制缓存
```

## 4. 外部网络请求流

### 4.1 请求清单

| 目的 | URL | 方法 | 发起方 | 频率 |
|------|-----|------|--------|------|
| IP 地理位置 | `https://ipinfo.io/json` | GET | Background (安装时) | 一次性 |
| IP 地理位置 (备用) | `http://ip-api.com/json/` | GET | Background (安装时) | 一次性 |
| 遥测日志 | `https://hawkeye-us.us-west-1.log.aliyuncs.com/logstores/webcopy/track` | POST | Background | 每次事件 |
| 远程配置 | `https://twiclips.com/user/api-chrome-extension/get-remote-config` | GET | Background | - |
| SEO 绕过 | `{原URL}?seo=google&extension=webcopy` | GET | Content Script | 按需 |
| 道客巴巴 JS | `https://static.doc88.com/resources/js/modules/main-v2.min.js` | GET | Background (代理) | 按需 |
| 欢迎页 | `https://extensiondock.com/crx/welcome?name=webcopy` | - | Background (安装时) | 一次性 |
| 新标签页 | `https://extensiondock.com/newtab/newtab.html` | GET | newtab.html (iframe) | 每次新标签 |
| 卸载 URL | `https://twiclips.com/twitch-download/question?extension=webcopy&uuid=...` | - | Background (安装时注册) | - |

### 4.2 SEO 绕过请求详情

百度文库等站点对直接请求进行反爬检测。扩展通过以下机制绕过:

1. `chrome.declarativeNetRequest.updateDynamicRules`: 注册规则
   - 匹配 URL 包含 `seo=google&extension=webcopy`
   - 将 `User-Agent` 请求头替换为 `Baiduspider` 或 `bingbot` (随机选择)
2. Content Script 构造 SEO URL: `location.href + "?seo=google&extension=webcopy"`
3. fetch 该 URL 获取未被反爬的完整 HTML
4. `DOMParser` 解析 HTML,通过 `querySelector` 提取目标内容

### 4.3 卸载追踪

```javascript
chrome.runtime.setUninstallURL(
  "https://twiclips.com/twitch-download/question" +
  "?extension=webcopy&uuid={uid}&browser=chrome&version={version}&install_time={time}"
)
```

## 5. 防篡改数据流

```
安装时:
  chrome.management.getSelf(t => storage.local.set({ installType: t.installType }))
  
运行时 (每次破解):
  H() 函数检查:
    ├── 当前时间 - updateTime > 15 天 (1296000000ms)
    ├── installType === "normal" (非开发/侧载)
    └── chrome.runtime.id !== "hmlmncgagbkggdfpklpmhjcmbjadpkdo"
    → 设置 P = false (允许显示篡改警告)
    
用户选中复制超 15 次 + P === false:
  → L("", callback) 弹出警告框
  → 提示用户从官方商店重新下载
  → 提供跳转按钮
```

## 6. 跨模块通信矩阵

| 发送方 | 接收方 | 方法 | 消息类型 |
|--------|--------|------|---------|
| Popup | Background | `runtime.sendMessage` | `confirmCopy` |
| Content Script | Background | `runtime.sendMessage` | `sendAli`, `doc88`, `saveUseCount`, `isNormalCrack`, `confirmCopy` |
| Background | Content Script | `tabs.sendMessage` | `isCrack`, `web_crack` |
| Background | Content Script (注入) | `scripting.executeScript` | 注入 `normal.js` |
| Content Script (normal.js) | Background | `runtime.sendMessage` | `isNormalCrack` |
| AllCopy 页 | Background | `runtime.sendMessage` | `jmpEx` (跳转触发) |
