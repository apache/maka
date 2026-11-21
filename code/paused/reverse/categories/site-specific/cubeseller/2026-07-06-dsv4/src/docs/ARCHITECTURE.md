# CubeSeller (魔方卖家助手) 架构文档

> **版本**: 11.1.5 (2026-07 逆向工程分析)
> **扩展 ID**: ddicoofdkbcdkkeecgafcoabogcgicfp
> **构建产物**: Webpack + Vue 3.5.27 生产构建 (无 source map)

---

## 一、总体架构概览

CubeSeller 是一个 Chrome 扩展 (MV3)，用于从 65+ 个电商和内容平台的商品详情页批量提取图片、视频和评论图片。

架构采用 **配置驱动的可扩展规则引擎** + **Vue 3 SPA UI** + **Background Service Worker 代理**的三层设计。

```
┌─────────────────────────────────────────────────────────┐
│                   Chrome Extension                       │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Background   │  │ Content      │  │ Popup +       │ │
│  │ Service      │  │ Script       │  │ Extract Page  │ │
│  │ Worker       │  │ (ISOLATED)   │  │ (独立页面)    │ │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘ │
│         │                 │                   │         │
│  ┌──────┴────────┐  ┌────┴─────────┐   ┌─────┴───────┐ │
│  │ 规则引擎      │  │ 提取UI面板   │   │ Popup 控制  │ │
│  │ (65+平台配置) │  │ (Vue 3 +     │   │ +           │ │
│  │               │  │  JSZip)      │   │ Extract页面  │ │
│  │ API 代理      │  │              │   │ (Vue 3)     │ │
│  │ Cookie 管理   │  │ DOM 抓取     │   │             │ │
│  │ DNR 规则      │  │ 平台识别     │   │             │ │
│  └───────────────┘  └──────────────┘   └─────────────┘ │
│                                                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │ declarativeNetRequest (动态 Referer 规则)          │ │
│  │  - 为跨域图片请求伪造来源域名                       │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 二、模块分解

### 2.1 Background Service Worker

**文件**: `dist/background.js` (约 236KB, 单行 minified)

**职责**:
1. **提取规则注册表**: 内置 65+ 平台提取规则配置 (JSON 格式)，按 URL 匹配域名
2. **图片代理下载**: 通过 `imgFetch` 将跨域图片转为 base64，绕过 CORS 限制
3. **Referer 管理**: 通过 `declarativeNetRequest.updateDynamicRules` 动态设置 Referer/Origin 头
4. **Cookie 管理**: 通过 `chrome.cookies` API 读写各平台 Cookie
5. **XHR 代理**: 转发前端请求到目标平台，附加合适的 Referer 头
6. **下载管理**: 通过 `chrome.downloads` API 批量下载资源
7. **翻译/抠图队列**: 管理图片翻译和背景移除任务 (与 ushangtech.com 集成)

**消息处理 API (14 个类型)**:

| 消息类型 | 用途 | 使用权限 |
|---------|------|---------|
| `setReferers` | 动态设置 DNR 规则 (Referer/Origin 头) | `declarativeNetRequest` |
| `imgFetch` | 跨域图片抓取 (转 base64) | `host_permissions` |
| `download` | 触发文件下载 | `downloads` |
| `getCookies` | 读取指定域 Cookie | `cookies` |
| `setCookie` | 写入 Cookie | `cookies` |
| `makeXHRrequest` | GET 代理请求 (含 Referer) | `host_permissions` |
| `makeXHPostRrequest` | POST 代理请求 (含 Referer) | `host_permissions` |
| `addCutout`/`delCutout`/`getCutout` | 抠图任务队列管理 | `storage` |
| `addTranslate`/`delTranslate`/`getTranslate` | 翻译任务队列管理 | `storage` |
| `updateShowBtnFromBg` | 更新浮动按钮可见性 | — |

**规则引擎设计**:

每个平台配置包含:
- `reg`: URL 匹配正则 — 用于识别当前页面属于哪个平台
- `config`: JSON 字符串，定义提取逻辑
- `filters`: URL 参数过滤规则 — 用于清理图片 URL 中的不必要的查询参数

提取函数类型:
- `getImageBySelector`: 最常用的 CSS 选择器提取器
- `getImageBySelectorComment`: 评论图片提取
- `getImageBySelectorJsonp`: JSONP 接口提取
- 自定义函数: 特殊平台的专用提取逻辑

### 2.2 Content Script (ISOLATED World)

**核心文件**: `dist/content/extract.js` (约 785KB, minified)
**辅助文件**: `dist/content/message.js` (2.6KB), `dist/content/translate.js` (451B), `dist/content/windowDataMessage.js` (309B)
**样式**: `dist/content/extract.css` (约 12KB), `dist/content/message.css` (约 1KB)

**职责**:
1. **平台识别**: 根据 URL 匹配内置规则库中的平台配置
2. **DOM 元素抓取**: 使用 CSS 选择器提取页面中的商品主图、SKU 图、详情图、视频 URL
3. **提取结果 UI**: 注入 Vue 3 面板 (ISOLATED world) 展示提取结果
4. **批量操作**: 支持全选、反选、筛选、排序、重命名、打包下载 (JSZip)
5. **评论图片提取**: 翻页提取评论中的买家秀图片
6. **消息桥接**: 通过 `chrome.runtime.sendMessage` 与 background 通信，通过 `window.postMessage` 与 MAIN world 通信获取 `window` 对象上的数据

**注入时机**: `run_at: document_end`, 在所有页面 (`*://*/*`) 加载，但仅在匹配的平台页面上激活功能。

**内容脚本注入清单**:

| 脚本 | 匹配 | run_at | 用途 |
|------|------|--------|------|
| `extract.js` + `extract.css` | `*://*/*` | `document_end` | 主提取引擎 |
| `message.js` + `message.css` | `*://*/*` | `document_start` | 采集结果通知弹窗 |
| `translate.js` | `ushangtech.com/ec/transimage`, `ushangtech.com/ec/cutoutimage` | `document_end` | 图片翻译/抠图页通信桥 |
| `windowDataMessage.js` (WAR) | 按需注入 | — | window 数据提取桥 |

### 2.3 Popup 页面

**文件**: `dist/popup/popup.html` + `dist/popup/popup.js` (约 346KB) + `dist/popup/popup.css`

**职责**:
1. 扩展工具栏弹出窗口 UI (Vue 3 SPA)
2. 用户设置管理 (下载方式、命名规则、文件层级等)
3. 触发采集操作 (向当前 tab 发送指令)
4. 版本检查与更新提示
5. 登录状态显示

**技术栈**: Vue 3.5.27 + Element Plus Icons 2.3.2

### 2.4 Extract 独立页面

**文件**: `dist/extract/extract.html` + `dist/extract/extract.js` (约 682KB) + `dist/extract/extract.css`

**职责**:
1. 独立的结果展示页面 (在新标签页中打开)
2. 提取结果的可视化画廊展示
3. 图片预览、筛选、排序功能
4. 支持下载模式切换 (直接下载/打包下载)
5. 文件重命名

**技术栈**: Vue 3.5.27 + JSZip 3.10.1

### 2.5 辅助脚本

#### message.js (通知组件)
- 监听 `window.postMessage` 获取采集结果
- 显示成功/失败/登录提示弹窗
- 固定链接指向本地服务 `https://192.168.1.105:3100` (魔方卖家助手本地客户端)

#### translate.js (翻译/抠图桥)
- 监听来自 ushangtech.com 页面的翻译/抠图完成消息
- 通过 `chrome.runtime.sendMessage` 通知 background 清理任务队列

#### windowDataMessage.js (数据提取桥)
- 在 MAIN world 通过 `window.postMessage` 读取任意 `window` 对象属性
- 用于提取页面内置的数据 (如 `window.__INITIAL_STATE__`)
- 使用 `Reflect.ownKeys` 遍历属性路径

---

## 三、平台覆盖清单

### 3.1 电商平台 (中国)
1688、淘宝、天猫、京东、拼多多、苏宁易购、唯品会、考拉海购、小红书、必要、有赞、青创网、搜款网、爱搜鞋、飞猪、携程旅行

### 3.2 电商平台 (国际)
Alibaba、Aliexpress、Shopee、Lazada、Wish、Shein、Temu、Etsy、Coupang、Qoo10、DHgate、Farfetch、kidsfootlocker、Ifixit Store、Trgomania、中国制造/Made In China、Amazon (亚马逊中国)

### 3.3 社交媒体与内容
微信公众平台、微博、DouYin (抖音)、Instagram、Pinterest、今日头条、Bilibili、豆瓣、堆糖、POCO 图片、CNU 视觉联盟、图虫

### 3.4 搜索引擎与图片服务
Google、Bing 图片、百度图片、Yandex

### 3.5 数字漫画/阅读
腾讯动漫、动漫之家、Pixiv、东立电子书城、咚漫漫画、toomics、toptoon、lezhinus、onimanga、1kkk、mangabz、云展网、名师联智库、道客巴巴、hathitrust、邮来邮网

### 3.6 旅行与酒店
Agoda、Airbnb、缤客 (Booking)

### 3.7 其他
黑光图库

---

## 四、资源清单

### 4.1 静态资源 (`assets/`)
- `logo/logo_x16.png` / `logo_x48.png` / `logo_x128.png` — 扩展图标 (3 种尺寸)
- `images/collect.svg` — 采集按钮图标
- `images/comment.svg` — 评论图标
- `images/detail.svg` — 详情图标
- `images/icon.png` — 通用图标

### 4.2 本地化 (`_locales/`)
- `en/` — 英文
- `zh/` — 简体中文
- `zh_CN/` — 简体中文 (备选)

### 4.3 第三方库 (嵌入在 JS bundle 中)
| 库 | 版本 | 用途 |
|---|------|------|
| Vue 3 | 3.5.27 | UI 框架 (runtime-dom + shared) |
| JSZip | 3.10.1 | ZIP 打包下载 (content/extract.js + extract/extract.js 中均含) |
| Element Plus Icons | 2.3.2 | 图标组件库 |
| regenerator-runtime | — | async/await 转译运行时 |

---

## 五、权限分析

| 权限 | 用途 | 风险等级 |
|------|------|---------|
| `scripting` | 动态注入脚本 (如 windowDataMessage.js 桥) | 中 |
| `activeTab` | 获取当前活动标签页信息 | 低 |
| `downloads` | 批量下载图片/视频 | 中 |
| `declarativeNetRequest` | 动态修改请求头 (Referer/Origin) | 中 |
| `storage` | 保存用户设置和提取规则 | 低 |
| `cookies` | 读写电商平台 Cookie (保持登录态) | 高 |
| `unlimitedStorage` | 大量本地规则/图片缓存存储 | 低-中 |
| `*://*/*` (host_permissions) | 在所有网站注入内容脚本和发送请求 | 高 |

---

## 六、安全边界

- **Content Script 隔离**: 使用 ISOLATED world，JavaScript 执行环境与页面隔离
- **MAIN world 桥接**: `windowDataMessage.js` 通过 `window.postMessage` 安全获取页面数据，不直接操作页面 JS
- **CSP**: 未声明 CSP，extension_pages 使用浏览器默认 CSP
- **WAR**: `extract.js`, `extract.css`, `windowDataMessage.js` 声明为 Web Accessible Resources，匹配 `*://*/*`
- **本地服务依赖**: 消息通知链接指向 `https://192.168.1.105:3100`，表明依赖本地桌面客户端 (魔方卖家助手)
- **Cookie 权限**: `cookies` 权限 + `*://*/*` 意味着可以读取任何网站的 Cookie，这是最大的安全关注点
