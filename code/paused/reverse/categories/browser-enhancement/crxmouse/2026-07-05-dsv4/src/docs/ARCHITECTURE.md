# crxMouse Chrome Gestures v7.0.5 — 架构文档

> 逆向工程分析文档 | Manifest V3 | 2026-07-06

---

## 一、扩展概览

crxMouse Chrome Gestures 是一款 Chrome 浏览器鼠标手势扩展，由 **WeKnowNet** 开发。完整名称 "crxMouse Chrome Gestures"（也称 "CrxMouse: Mouse Gestures"、"crxMouse Top Gestures"）。

**核心功能：**
- 鼠标手势 (Mouse Gestures)：按住右键/左键/中键拖动，匹配预定义轨迹执行操作
- 超级拖拽 (Super Drag)：拖拽链接/图片/文本到指定方向执行操作
- 滚轮手势 (Wheel Gestures)：按住鼠标键 + 滚轮执行操作
- 摇杆手势 (Rocker Gestures)：按住一个键 + 点击另一个键
- 自定义光标 (Custom Cursors)：100+ 内置光标主题 + 用户上传
- 平滑滚动 (Smooth Scroll)
- 标签列表 (Tab List)：滚轮切换标签页

**清单关键数据：**
- 版本：7.0.5
- Manifest：V3
- 文件总数：~403 个
- Webpack chunk：2 个 (130.js, 946.js)
- 语言包：14 个地区
- 光标主题：68 个目录
- Service Worker：1 个 (service_worker.js)
- Content Script：5 个独立注入点

---

## 二、5 个 Content Script 注入点 — 关键架构特征

这是本扩展最复杂的架构决策：在不同阶段注入 5 个独立的 content script，每个承担不同职责。

### 注入矩阵

| # | 脚本文件 | run_at | all_frames | match_about_blank | matches | 预加载 CSS/JS |
|---|---------|--------|-----------|-------------------|---------|--------------|
| 1 | `content.js` + `jquery-3.3.1.min.js` | `document_start` | `true` | — | `*://*/*` | `css/content.css` |
| 2 | `js/frame.js` | `document_end` | `true` | — | `*://*/*` | — |
| 3 | `contentEnd.js` | `document_end` | `true` | `true` | `<all_urls>` | — |
| 4 | `js/websiteHandler.js` | `document_start` | `true` | — | `https://crxmouse.com/*` | — |
| 5 | `contentStart.js` | `document_start` | `true` | `true` | `<all_urls>` | — |

### 各脚本职责分析

#### 1. content.js (document_start, 带 jQuery)
- **时机**：页面加载最早，在所有帧注入
- **加载内容**：
  - jQuery 3.3.1（提供 DOM 操作和事件处理基础）
  - `css/content.css`（手势轨迹显示样式）
- **职责**：
  - 注册鼠标事件监听器 (mousedown/mousemove/mouseup)
  - 手势轨迹绘制和方向识别
  - 超级拖拽功能（链接、图片、文本拖拽）
  - 手势 UI 渲染（轨迹线、方向指示器、动作名称显示）
  - 摇杆手势事件处理
  - 滚轮手势事件处理
  - 自定义光标渲染
  - VAST 广告检测模块 (RWf) 初始化
  - 反馈/分析管线 (XJZ, WwI) 初始化
- **体积**：~82KB，包含大量混淆后的手势识别和 UI 逻辑

#### 2. js/frame.js (document_end, 所有帧)
- **时机**：DOM 加载完成后
- **职责**：
  - iframe 内手势支持（与父窗口通信）
  - 链接点击事件监听 (`click`, `contextmenu`, `auxclick`)
  - 向 service worker 报告链接点击 URL
- **体积**：~1.2KB，非常轻量

#### 3. contentEnd.js (document_end, 含 about:blank)
- **时机**：DOM 加载完成后
- **关键特性**：`match_about_blank: true` — 这是唯一能注入 about:blank iframe 的脚本
- **职责**：
  - 包含 core-js polyfill（模块编号 t=34~9565 的完整 polyfill 运行时）
  - 包含一个 JSON 表达式解析/执行引擎 (jfq 模块)：支持复杂的条件判断、DOM 操作、数据提取
  - 包含 RWf 模块：(1) VAST XML 广告检测解析，(2) `pardon` 规则 — 从 XML 中提取结构化数据，(3) native 规则 — 直接匹配 Ad 元素
  - 包含 XJZ 模块：服务端下发的反馈/分析规则执行引擎（需 advanced features consent）
  - 包含 WwI 模块：私有反馈规则引擎（用户自愿数据采集）
  - `proconstantinator_key` 混淆常量加载 (lNV 模块)：核心服务端下发的混淆字符串表，所有模块依赖此表解码命令
- **体积**：~32KB

#### 4. js/websiteHandler.js (crxmouse.com ONLY)
- **时机**：仅在 crxmouse.com 域下
- **职责**：
  - 处理 crxmouse 官方网站的安装引导流程
  - 屏幕事件映射 (Screen 1~6 对应 onboarding 流程)
  - GA 事件转发到 service worker
  - 扩展版本号通信
- **安全影响**：该脚本独享 crxmouse.com 权限，但无法触及用户数据
- **体积**：~1.8KB

#### 5. contentStart.js (document_start, 含 about:blank)
- **时机**：最早的注入脚本
- **职责**：
  - **MpiUO 模块系统引导**：自定义的模块注册/依赖解析/异步初始化系统
  - `eventPriority.js` 动态注入：通过 `chrome.runtime.getURL` 加载，1 秒超时保护
  - `kBx` 模块：手势反馈事件缓冲队列（`mouse-gestures-feedback` 事件），限制 64 条
  - `kJoHB` 模块：模块生命周期管理器，实现拓扑排序的延迟初始化
- **体积**：~1.8KB
- **注意**：该脚本跳过 `window.parent !== window && location 非 http` 的情况（about:blank iframe 中不加载核心模块）

---

## 三、Service Worker 架构 (service_worker.js)

**体积**：~274KB，是最大的单个文件。

### 核心模块结构

```
service_worker.js
├── core-js polyfills (t=34~9565)        // ~60 个核心模块
├── jfq 模块 (JSON 表达式引擎)           // 命令执行核心
├── lNV 模块 (proconstantinator_key)     // 混淆常量表
├── zYg 模块 (存储管理)
├── oIP 模块 (GA 分析)
├── MNe 模块 (配置管理)
├── gId 模块 (options.html 逻辑)         // ~400KB 的 optionsExt.js 在此内联
├── rHj 模块 (popup.html 逻辑)
├── VGg 模块 (后台主控)
├── Qem 模块 (标签页管理)
├── hRq 模块 (热门手势 — 服务端下发)
├── SZl 模块 (滚动配置)
├── LUW 模块 (消息路由)
├── XCG 模块 (webRequest 监听)
├── JSL 模块 (自定义光标管理)
├── ANJ 模块 (拖拽配置)
├── GIk 模块 (手势配置)
├── iTa 模块 (rocket/摇杆配置)
├── wZg 模块 (webNavigation 监听)
├── CCO 模块 (bookmarks 集成)
├── Kpr 模块 (sessions 集成)
├── AnK 模块 (contextMenus 管理)
├── HVp 模块 (alarms 管理)
└── pWT 模块 (clipboard 操作)
```

### 消息总线

Service worker 作为中央路由器（hub），通过 `chrome.runtime.onMessage` 处理来自所有 content script、popup、options 页面的消息：

| 消息方向 | 用途 |
|---------|------|
| content script -> SW | 链接点击、VAST 检测结果、反馈事件、配置查询 |
| popup -> SW | 手势编辑、光标选择、开关切换 |
| options -> SW | 配置保存、导入导出、重置 |
| SW -> content script | 手势规则下发、配置更新通知 |
| SW -> 外部 API | 热门手势拉取、GA 事件上报、用户反馈 |

---

## 四、MpiUO 自定义模块系统

`contentStart.js` 实现了一个轻量级的模块注册和依赖管理系统：

### 工作原理
1. 所有模块注册到全局 `self.MpiUO` 对象上
2. 每个模块有 `init` 函数（构造函数）、`deps` 依赖列表、`ready` 状态
3. `kJoHB` 协调器按拓扑顺序调用 `init`，处理异步依赖
4. 指数退避重试机制：1ms -> 2ms -> 4ms -> ... -> 最大 100000ms

### 已识别模块

| 模块名 | 位置 | 职责 |
|--------|------|------|
| `kBx` | contentStart.js | 反馈事件缓冲队列（64 条上限） |
| `kJoHB` | contentStart.js | 模块生命周期协调器 |
| `lNV` | contentEnd.js | 混淆常量表 (proconstantinator_key) |
| `jfq` | contentEnd.js | JSON 表达式执行引擎 |
| `RWf` | contentEnd.js | VAST 广告检测 + 结构化数据提取 |
| `XJZ` | contentEnd.js | 高级反馈规则引擎 |
| `WwI` | contentEnd.js | 私有反馈规则引擎 |

### 依赖图

```
lNV (混淆常量表)
 ├── jfq (JSON 引擎) ──> 依赖 lNV
 │    ├── RWf (广告检测) ──> 依赖 jfq, lNV
 │    ├── XJZ (高级反馈) ──> 依赖 jfq, zYg, lNV
 │    └── WwI (私有反馈) ──> 依赖 jfq, zYg, lNV
 └── zYg (存储)
```

---

## 五、Webpack 分块

### 130.js — Options 页面的消息提示组件
- 暴露 `Msgbox` React 组件（版本号保存后提示）
- 独立的 webpack chunk，按需加载
- 代码：一个函数返回条件渲染的 `<div id="msgbox">`

### 946.js — 未确认用途
- 小体积 (1.2KB)
- 可能是 popup 或 options 的辅助 chunk

两个 chunk 都使用 `self.webpackChunkcrx_mouse_chrome` 全局数组注册。

---

## 六、双设计系统 (Design Orchestrator)

扩展同时维护两套 UI 设计系统：

| 设计 | 入口 | 样式 | 加载器 |
|------|------|------|--------|
| Classic (旧版) | `#crx_root` / `#crx_options_root` | `popup/popup.css`, `css/chrome.css`, `css/options.css` | `designOrchestrator.js` |
| Redesign (新版) | `#crx_redesign_root` / `#crx_options_redesign_root` | 内联 React 样式 | `designOrchestrator.js` |

`designOrchestrator.js` 根据配置决定渲染哪个版本。每个页面有对应的 orchestrator：
- `popupOrchestrator.js` → 加载 `popup.js` 或 `popupRedesign.js`
- `optionsOrchestrator.js` → 加载 `optionsExt.js` 或 `optionsRedesign.js`

---

## 七、自定义光标系统

- **内置主题**：68 个目录，位于 `image/cursors/`，每目录包含一个 `.png` 光标图像
- **用户自定义**：通过 options.html 上传 (48x48px PNG, 最大 20KB)
- **缩放支持**：可调整光标大小 (cursor size)
- **动态注入**：content script 通过 CSS `cursor` 属性替换页面光标
- **主题命名举例**：`Cat_paw`、`Katana`、`Axe`、`Bubble_tea`、`Capibara`、`Hotdog`、`Joystick` 等

---

## 八、i18n 国际化

14 个语言包目录 (`_locales/`):
`da`, `de`, `en`, `fi`, `fr`, `hi`, `ja`, `ko`, `nl`, `no`, `sv`, `tr`, `zh_CN`, `zh_TW`

英文语言包 (`en/messages.json`) 包含 ~330 个翻译键，覆盖：
- 手势动作描述 (G_*, L_*, I_*, T_* 前缀)
- 选项页面 UI
- 弹出窗口 UI
- 错误/警告消息
- 引导流程 (onboarding)

---

## 九、依赖库

| 库 | 路径 | 用途 |
|----|------|------|
| jQuery 3.3.1 | `js/jquery-3.3.1.min.js` | DOM 操作、事件处理 (content script) |
| jQuery base64 | `js/jquery.base64.js` | Base64 编解码 |
| Select2 | `lib/select2/select2.min.{css,js}` | 下拉选择增强 (options 页面) |
| ua-parser | `js/uaparser.js` | User-Agent 解析 |
| core-js 3.47.0 | 内联在 service_worker.js 和 contentEnd.js | Polyfill 运行时 |

---

## 十、目录结构

```
crxmouse-chrome™-手势-source-code/
├── manifest.json               # MV3 manifest
├── service_worker.js           # 274KB — 后台主逻辑
├── content.js                  # 82KB — 主内容脚本 (document_start)
├── contentStart.js             # 1.8KB — 模块系统启动器
├── contentEnd.js               # 32KB — JSON 引擎 + 反馈管道
├── options.html / optionsExt.js / optionsRedesign.js  # 设置页面
├── popup.html / popup.js / popupRedesign.js           # 弹出窗口
├── popup.css / popup/popup.css
├── 130.js / 946.js             # Webpack chunk
├── js/
│   ├── jquery-3.3.1.min.js     # jQuery
│   ├── jquery.base64.js
│   ├── frame.js                # iframe content script
│   ├── websiteHandler.js       # crxmouse.com content script
│   ├── eventPriority.js        # 事件优先级（动态注入）
│   ├── designOrchestrator.js   # 双设计系统加载器
│   ├── popupOrchestrator.js
│   ├── optionsOrchestrator.js
│   ├── analyticsEventMap.js
│   ├── color.js
│   ├── notifi.js
│   ├── optionPlus.js
│   └── uaparser.js
├── css/                        # 样式文件
│   ├── content.css
│   ├── chrome.css
│   ├── chrome2.css
│   └── options.css
├── fonts/
│   └── PixelColeco.otf
├── html/
│   └── notifi.html             # 通知页面
├── image/
│   ├── badges/                 # 扩展图标
│   ├── cursors/                # 68 个光标主题目录
│   ├── popupGestures/          # 弹出窗口手势图标
│   ├── rating/                 # 评分图标
│   └── redesign/               # 新版设计素材
├── lib/
│   └── select2/                # Select2 库
├── popup/
│   ├── popup.css
│   └── icon.svg
└── _locales/                   # 14 个语言包
    ├── en/messages.json        # 英文 (~330 键)
    ├── zh_CN/messages.json     # 简体中文
    └── ...
```
