# ARCHITECTURE.md — 网页万能复制 v1.0.28

## 概述

"网页万能复制" (Universal Copy - Enable Copy) 是一款 Manifest V3 Chrome 扩展,核心功能是解除网页上的复制限制(禁止右键、禁止选择、禁止复制、禁止粘贴)。采用 **Service Worker + Content Script + Popup** 的经典 MV3 三层架构,使用 Vue 2 构建 Popup UI,通过 `clipboard.js` 库实现剪贴板操作,并集成阿里云 SLS 日志系统进行遥测分析。

## 架构分层

```
manifest.json (MV3 入口)
├── Service Worker (js/background.js) — 控制中心
│   ├── 生命周期管理 (onInstalled)
│   ├── 消息路由 (onMessage)
│   ├── Tab 状态监听 (onUpdated)
│   ├── 域名白名单管理
│   ├── Analytics/遥测 (阿里云 SLS)
│   ├── User-Agent 伪装 (declarativeNetRequest)
│   └── 防篡改检测
├── Content Script (js/content-script.js) — 页面注入层
│   ├── clipboard.js (剪贴板操作)
│   ├── 站点适配器 (百度文库/Docin/道客巴巴)
│   ├── UI 组件 (复制按钮/AI 推广/PDF 推广)
│   └── 破解逻辑调度
├── Normal Script (js/normal.js) — 通用破解引擎
│   └── DOM 事件清除 + CSS 注入
├── DocText Script (js/docText.js) — 道客巴巴文本提取
│   └── 通过动态属性路径读取页面数据
├── Popup (Vue 2 + Element UI) — 弹出窗口
│   ├── 主开关 (启用/禁用破解)
│   ├── 域名管理入口
│   └── 状态展示
├── Options Page (jQuery + Bootstrap) — 选项页
│   └── 域名白名单 CRUD
├── AllCopy Page (Vue 2) — 全文复制页
│   └── 从背景页读取缓存文本并展示
└── NewTab Page — 推广落地页
    └── iframe 加载 extensiondock.com
```

## 文件结构

```text
dist/
├── manifest.json              # MV3 清单
├── popup.html                 # Popup 入口 (Vue)
├── options.html               # 选项页入口 (jQuery)
├── ac_options.html            # 高级选项 (Vue)
├── allcopy.html               # 全文复制页 (Vue)
├── newtab.html                # 新标签页 (推广)
├── favicon.ico                # 站点图标
├── js/
│   ├── background.js          # Service Worker (~500KB 打包)
│   ├── content-script.js      # 内容脚本 (~600KB 打包)
│   ├── normal.js              # 通用破解脚本 (~3KB)
│   ├── docText.js             # 道客巴巴文本提取 (~1KB)
│   ├── pdf-script.js          # PDF 页面脚本 (~550KB, 含 jQuery)
│   ├── popup.2d386fe7.js      # Popup Vue 应用
│   ├── chunk-vendors.aa19afcc.js  # Vue/Element 公共库
│   ├── options.449de6ae.js    # 选项页 jQuery 逻辑
│   ├── allcopy.c1296cbc.js    # 全文复制 Vue 应用
│   ├── ac_options.75fabac0.js # 高级选项 Vue 应用
│   └── newtab.ee3c1b7d.js    # 新标签页逻辑
├── css/
│   ├── inject.css             # 注入页面样式
│   ├── webcopy.css            # 通用样式 (Popup/Options)
│   ├── bootstrap.css          # Bootstrap 3
│   ├── popup.9dc2af0a.css     # Popup Vue 样式
│   ├── chunk-vendors.fe07b5fd.css  # Element UI 样式
│   ├── ac_options.b911402f.css  # 高级选项样式
│   ├── pdf-bar.css            # PDF 工具栏样式
│   └── newtab.css             # 新标签页样式
├── img/                       # 图标与图片资源 (10 个)
├── fonts/                     # 字体文件 (6 个)
└── _locales/                  # 50 种语言的 i18n 翻译
```

## 核心模块分析

### 1. Service Worker (`js/background.js`)

**技术栈**: Webpack 打包,包含 browser-polyfill、uuid 生成、lz4 压缩、阿里云 SLS SDK

**核心职责**:
- **安装/更新生命周期**: 生成 UUID、记录安装时间、获取 IP 地理位置、发送安装/更新事件到 SLS、打开欢迎页
- **消息路由**: 处理来自 Popup 和 Content Script 的消息
  - `confirmCopy`: 确认破解状态变更,发送 Analytics
  - `doc88`: 代理请求道客巴巴 JS 资源,提取文本路径
  - `sendAli`: 转发事件到 SLS 遥测
  - `isNormalCrack`/`cmd`: 状态查询
  - `saveUseCount`: 评分计数
- **Tab 监听** (`tabs.onUpdated`): 页面加载完成时检查域名是否在白名单中,自动触发破解
- **域名白名单**: 存储于 `chrome.storage.local`,支持自动和手动两种触发方式
- **declarativeNetRequest**: 对 SEO 爬虫请求动态修改 User-Agent,模拟 Baiduspider/bingbot 以绕过反爬
- **图标状态管理**: 根据当前 Tab 破解状态切换图标 (彩色/灰色)
- **防篡改检测**: 检查扩展 ID 是否匹配官方 ID `hmlmncgagbkggdfpklpmhjcmbjadpkdo`

### 2. Content Script (`js/content-script.js`)

**技术栈**: Webpack 打包,包含 clipboard.js 2.x、jQuery 3.6.0

**核心职责**:
- **剪贴板操作**: 基于 clipboard.js 实现文本复制到系统剪贴板,监听 `mouseup` 事件获取选中文本
- **站点适配器系统**:
  - `baidu_wenku`: 百度文库 — 注入 CSS 隐藏付费遮罩,添加"复制全文"按钮
  - `docin`: 豆丁网 — 注入固定定位按钮
  - `doc88`: 道客巴巴 — 通过动态脚本注入 (`docText.js`) 提取页面内嵌数据
- **破解状态管理** (`N()` 函数): 首次触发时初始化破解环境
- **UI 注入**:
  - 右键/选中复制浮动按钮 (`#copy-group`)
  - AI 助手推广悬浮 logo (`myAliLogo`)
  - PDF 聊天推广工具条 (`pdflogobar`)
  - 评分弹窗 (`webcopyAlertBox`)
  - 篡改警告弹窗 (`L()` 函数)
- **遥测埋点**: `I()` 函数向 Background 发送用户行为事件

### 3. Normal Script (`js/normal.js`)

**技术栈**: 纯 JS (Webpack 打包),框架无关

**核心职责**:
- 清除 DOM 复制限制事件: `oncopy`, `oncut`, `onpaste`, `oncontextmenu`, `onselectstart`, `onkeydown`, `onkeyup`, `ondragstart`, `onmousemove`, `onmousedown`, `onmouseup`
- 注入全局 CSS: `user-select: text !important; -webkit-user-select: text !important;`
- 移除 HTML 元素 `unselectable` 等属性
- 在 Capture 阶段拦截事件,阻止页面原始事件处理
- 定时重新执行 (1.2s/3.2s/5.0s/9.9s) 以对抗动态加载内容的限制恢复

### 4. Popup UI

**技术栈**: Vue 2 + Element UI

**职责**:
- 主开关: 切换当前页面破解状态 (调用 `chrome.runtime.sendMessage`)
- 当前域名展示
- 域名列表快速入口 (跳转 Options 页)
- 操作反馈提示 (成功/失败/无需破解)

### 5. 其他页面

- **Options 页**: jQuery + Bootstrap,域名白名单的增删管理
- **ac_options.html**: Vue 版本的高级选项页
- **AllCopy 页**: Vue 版本,展示从背景页获取的全文复制结果
- **NewTab 页**: 推广落地页,iframe 加载外部站点

## 权限使用分析

| 权限 | 用途 | 风险等级 |
|------|------|---------|
| `tabs` | 监听 Tab 更新自动破解;获取当前页面 URL | 中 |
| `storage` | 存储白名单/UUID/遥测缓冲/配置 | 低 |
| `scripting` | 动态注入 `normal.js` 到未预注册页面 | 高 |
| `declarativeNetRequestWithHostAccess` | 修改 SEO 请求 User-Agent | 中 |
| `host: http/https all` | Content Script 注入所有页面 | 高 |

## 依赖库

| 库 | 版本 | 用途 | 所在文件 |
|----|------|------|---------|
| clipboard.js | 2.x | 剪贴板操作 | content-script.js (内嵌) |
| jQuery | 3.6.0 | DOM 操作 | content-script.js, options.html (内嵌) |
| bootstrap | 3.x | UI 框架 | options.html, popup.html |
| Element UI | 2.x | Vue UI 组件 | popup (Vue) |
| Vue | 2.x | Popup 框架 | popup, ac_options, allcopy |
| webextension-polyfill | 0.x | 浏览器兼容 | background.js (内嵌) |
| uuid | - | UUID 生成 | background.js (内嵌) |
| lz4 | - | 日志压缩 | background.js (内嵌) |
| clipboard.js | 2.x | 剪贴板操作 | content-script.js |
| jQuery | 3.6.0 | DOM 操作 | content-script.js, pdf-script.js |
| xxhashjs | - | 哈希校验 | background.js (内嵌) |
