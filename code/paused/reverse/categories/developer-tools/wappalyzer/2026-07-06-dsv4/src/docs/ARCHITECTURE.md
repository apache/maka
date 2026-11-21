# Wappalyzer v6.12.3 架构文档

> Chrome 扩展 | Manifest V3 | `minimum_chrome_version: 121` | 手写纯 JavaScript (无 bundler)

---

## 1. 总体架构概述

Wappalyzer 是一个跨层级的 Chrome 扩展，用于识别网页所使用的技术栈。它采用**四层架构**，将页面信号采集、指纹匹配、数据持久化与 UI 展示分离到不同的 JavaScript 执行环境中：

| 层级 | 执行环境 | 职责 |
|------|----------|------|
| **Page Context** | 页面主世界 | JS 全局变量检测、DOM 属性遍历 (React fiber 等) |
| **Content Script** | 隔离世界 | 采集 cookies/meta/scripts/text/css，桥接 page-context 脚本 |
| **Service Worker** | 后台持久进程 | 指纹匹配引擎、结果缓存、webRequest 监听、Ping 上报 |
| **UI** | Popup / Options / Terms 页面 | 检测结果展示、设置管理、隐私条款 |

核心设计原则：

- **零依赖** — 所有 JavaScript 为手写代码，不依赖 webpack/parcel/vite/rspack 等 bundler
- **动态按需加载** — 技术指纹数据库按首字母分 27 个 JSON 文件 (a-z + `_`)，通过 `chrome.runtime.getURL()` 按需获取
- **隔离通信** — 三层 JS 执行环境之间通过 `window.postMessage` (主世界到 content script) 和 `chrome.runtime.sendMessage` (content script 到 Service Worker) 进行结构化通信
- **惰性分辨** — 采集与分析分离，先缓存原始信号，再批量匹配技术指纹；结果缓存 48 小时

---

## 2. 架构分层图

```
+=====================================================================+
|                        Page Context (主世界)                         |
|                                                                     |
|   js.js (53 行)              dom.js (72 行)                         |
|   - 遍历 window 全局变量      - 遍历 DOM 属性 (如 __reactFiber)       |
|   - 检测 JavaScript 对象指纹  - 检测前端框架渲染线索                   |
|                                                                     |
|   +-- window.postMessage ---> content.js (message event) ---------+  |
+=====================================================================+
        |                                            ^
        | 注入脚本 (chrome.scripting.executeScript)    | postMessage
        v                                            |
+=====================================================================+
|                     Content Script (隔离世界)                         |
|                                                                     |
|   content.js (906 行)                                               |
|   - 采集 cookies, meta, scripts, text, css                         |
|   - 注入 page-context 脚本 (js.js, dom.js)                          |
|   - 语言检测 (基于文本采样)                                           |
|   - 性能优化: yieldToMain() 分片执行                                   |
|                                                                     |
|   +-- chrome.runtime.sendMessage --> background (index.js) --------+|
+=====================================================================+
        |                                            ^
        | sendMessage                                 | sendMessage
        v                                            |
+=====================================================================+
|                      Service Worker (后台进程)                        |
|                                                                     |
|   background.html (12 行)                                           |
|   +-- <script> wappalyzer.js (752 行)                               |
|   +-- <script> utils.js (182 行)                                    |
|   +-- <script> index.js (2235 行) -- Driver                         |
|                                                                     |
|   核心模块:                                                           |
|   - Wappalyzer 引擎: analyze, resolve (implies/excludes)             |
|   - Driver: onContentLoad, analyzeJs, analyzeDom, refreshMetadata    |
|   - webRequest 监听: headers, scripts, xhr 实时分析                   |
|   - 结果缓存: chrome.storage.local (48 小时 TTL)                      |
|   - Ping 上报: ping.wappalyzer.com/v2/                              |
|                                                                     |
|   +-- chrome.cookies API                                            |
|   +-- chrome.tabs API                                               |
|   +-- chrome.webRequest API                                         |
+=====================================================================+
        |                                            ^
        | getOption / getTechnologies                 | open (popup)
        v                                            |
+=====================================================================+
|                          UI 层                                       |
|                                                                     |
|   popup.html  + popup.js (1074 行)   -- 检测结果展示 + Plus API Key  |
|   options.html + options.js (81 行)  -- 设置界面 (tracking 开关等)    |
|   terms.html  + terms.js (90 行)     -- 隐私条款                      |
|                                                                     |
|   css/styles.css (1055 行) -- BEM + CSS 变量, 暗色主题                  |
+=====================================================================+
```

---

## 3. 模块职责表

### 3.1 JavaScript 模块

| 文件 | 行数 | 执行环境 | 职责 | 关键导出/函数 |
|------|------|----------|------|-------------|
| `js/wappalyzer.js` | 752 | Service Worker | 核心匹配引擎 | `setTechnologies()`, `setCategories()`, `analyze()`, `analyzeOneToOne()`, `analyzeOneToMany()`, `analyzeManyToMany()`, `resolve()`, `resolveImplies()`, `resolveExcludes()`, `resolveVersion()`, `getTechnologiesByTypes()` |
| `js/index.js` | 2235 | Service Worker | 主驱动逻辑 (Driver) | `onContentLoad()`, `analyzeJs()`, `analyzeDom()`, `refreshMetadata()`, `detectTechnology()`, Ping 上报调度, webRequest 监听器, 缓存管理 |
| `js/content.js` | 906 | Content Script | 页面信号采集器 | 采集 cookies/meta/scripts/text/css, 脚本注入, 语言检测, `yieldToMain()` 性能优化 |
| `js/popup.js` | 1074 | Popup 页面 | 弹窗 UI | 检测结果渲染、技术分类展示、Plus API Key 管理 |
| `js/utils.js` | 182 | Service Worker | 通用工具库 | `agent()`, `promisify()`, `getOption()`, `setOption()`, `open()`, `close()`, `globEscape()`, `normalizeError()`, `isMissingTabError()` |
| `js/options.js` | 81 | Options 页面 | 选项页逻辑 | tracking 设置管理 |
| `js/terms.js` | 90 | Terms 页面 | 隐私条款页 | 静态内容渲染 |
| `js/background.js` | 5 | Service Worker | SW 入口 | 仅 `importScripts()` 加载三个核心脚本 |
| `js/js.js` | 52 | Page Context | 全局变量检测 | 遍历 `window` 对象, 暴露 `window.__wappalyzer` 接口 |
| `js/dom.js` | 71 | Page Context | DOM 属性检测 | 遍历 DOM 节点属性, 检测 React fiber (`__reactFiber` 等) |

### 3.2 HTML 页面

| 文件 | 行数 | 说明 |
|------|------|------|
| `html/background.html` | 12 | Service Worker 加载页，通过 `<script>` 标签同步加载 wappalyzer.js, utils.js, index.js |
| `html/popup.html` | 229 | 弹窗界面，包含技术分类筛选、搜索框、技术列表、Plus 订阅入口 |
| `html/options.html` | 55 | 选项界面，包含 tracking (匿名上报) 开关 |
| `html/terms.html` | 38 | 隐私条款页面 |

### 3.3 数据文件

| 文件 | 大小 | 说明 |
|------|------|------|
| `manifest.json` | — | MV3 清单，权限声明，入口配置 |
| `categories.json` | — | 108 个技术分类 (如 CMS, Analytics, CDN 等) |
| `groups.json` | — | 17 个技术分组 (如 Sales, Marketing, Security 等) |
| `schema.json` | — | 1 个设置属性: `tracking` (boolean) |
| `technologies/*.json` | ~2.88 MB | 27 个技术指纹文件 (a-z + `_`), 按首字母分片 |
| `_locales/` | 34 种语言 | 国际化消息文件 (含 `zh_CN`, `zh_TW`) |

### 3.4 静态资源

| 目录/文件 | 说明 |
|-----------|------|
| `css/styles.css` (1055 行) | 全局样式，BEM 命名 + CSS 自定义属性，支持 `prefers-color-scheme: dark` |
| `images/icon_*.png` | 扩展图标，8 种尺寸 (16/19/32/38/64/128/256/512/1024) |
| `images/logo-*.svg` | Logo 图形 |
| `images/icons/` | 技术图标库 (SVG/PNG) |

---

## 4. 技术栈检测引擎原理

### 4.1 指纹模式语法

每条技术定义包含一个或多个 `pattern`，格式为：

```
regex\\;version:\\1
regex\\;confidence:50\\;version:\\1
```

- **regex**: JavaScript RegExp 字符串
- **version**: 版本提取模式，`\\1` 引用正则捕获组
- **confidence**: 置信度 (0-100)，多个匹配累加，上限 100

### 4.2 检测类型与匹配策略

Wappalyzer 引擎将检测类型与匹配策略做了一一映射：

| 检测类型 | 匹配策略 | 数据特征 | 说明 |
|----------|----------|----------|------|
| `url` | `analyzeOneToOne` | 单值 | URL 地址匹配 |
| `text` | `analyzeOneToOne` | 单值 | 页面文本内容匹配 |
| `css` | `analyzeOneToOne` | 单值 | CSS 路径/内容匹配 |
| `scripts` | `analyzeOneToOne` | 单值 | `<script>` 标签匹配 |
| `xhr` | `analyzeOneToOne` | 单值 | XHR/Fetch 请求 URL 匹配 |
| `robots` | `analyzeOneToOne` | 单值 | robots.txt 内容匹配 |
| `certIssuer` | `analyzeOneToOne` | 单值 | SSL 证书签发者匹配 |
| `scriptSrc` | `analyzeOneToMany` | 多值 | 多个 script src 对单个技术模式 |
| `cookies` | `analyzeManyToMany` | 键值对 | Cookie 名称与值匹配 |
| `headers` | `analyzeManyToMany` | 键值对 | HTTP 响应头匹配 |
| `meta` | `analyzeManyToMany` | 键值对 | `<meta>` 标签 name/content 匹配 |
| `dns` | `analyzeManyToMany` | 键值对 | DNS 记录匹配 |
| `probe` | `analyzeManyToMany` | 键值对 | 主动探测请求匹配 |
| `js` | `analyzeManyToMany` | 键值对 | JavaScript 全局变量名/值匹配 |
| `dom` | `analyzeManyToMany` | 键值对 | DOM 属性名/值匹配 |

### 4.3 分析流程

```
technologies JSON 加载
       |
       v
setTechnologies(data)
  - 解析每个技术的 patterns (含 regex 编译)
  - 缓存技术类型索引 (getTechnologiesByTypes)
       |
       v
Driver.onContentLoad(tabId, url, signals)
  - signals 包含: cookies, meta, scripts, text, css, html 等
       |
       v
Wappalyzer.analyze(items, technologies)
  - 遍历所有相关技术
  - 对每种检测类型调用对应的分析策略 (oo/om/mm)
  - 收集所有匹配项 (detections)
       |
       v
Wappalyzer.resolve(detections)
  1. 合并重复检测 (同技术多次匹配 → 置信度累加, 上限 100)
  2. resolveVersion() — 从匹配中提取版本号, 规范化
  3. resolveExcludes() — 移除互斥技术
  4. resolveImplies() — 推导隐含技术 (级联, 直到无新增)
       |
       v
Driver 缓存结果 (chrome.storage.local, TTL 48h)
       |
       v
Ping 上报 (去重后发送到 ping.wappalyzer.com/v2/)
```

### 4.4 关系解析机制

**`resolveImplies` (自动推导)**

当技术 A 被检测到时，如果其 `implies` 字段声明了技术 B、C，则自动将 B 和 C 加入结果。这是一个级联过程：B 的 `implies` 会再次触发，直到没有新增技术为止。

**`resolveExcludes` (互斥排除)**

当技术 A 的 `excludes` 字段声明了技术 B，且 B 也在当前检测结果中时，B 被移除。处理顺序按检测到的顺序。

### 4.5 JS 与 DOM 检测的两阶段策略

JS 和 DOM 检测并非在首次页面加载时完成，而是采用两阶段策略以捕获异步注入的内容：

1. **第一阶段** (页面加载时): content.js 注入 `js.js` 和 `dom.js`，收集当前全局变量和 DOM 状态
2. **第二阶段** (5 秒延迟): Driver 通过 `setTimeout` 再次执行 JS 检测，捕获异步加载的脚本注入的全局变量 (如 GTM、分析脚本等)

此外，每次**页面刷新**时，content.js 调用 `refreshMetadata()` 重新采集 meta/cookies/scripts 等元数据，确保页面动态导航时检测仍然准确。

### 4.6 webRequest 持续监听

Driver 通过 `chrome.webRequest` API 持续监听网络请求，实现三类实时分析：

- **headers**: 监听 `onHeadersReceived`，分析 HTTP 响应头
- **scripts**: 监听 `onCompleted`，获取外部脚本并分析其内容
- **xhr**: 拦截 XMLHttpRequest/fetch 并分析请求 URL

这些监听允许检测到 `document_idle` 之后才出现的网络信号 (如 SPA 的动态 API 调用、延迟加载的脚本等)。

---

## 5. 技术决策记录 (ADR)

### ADR-01: 选择纯 JavaScript 而非 Bundler

- **状态**: 已采纳
- **日期**: 项目早期 (持续至今)
- **背景**: Chrome 扩展场景下，模块数量和体积均有限，且需要利用 Chrome 内置的脚本加载机制
- **决策**: 不使用 webpack/parcel/vite/rspack 等打包工具，所有 JavaScript 为手写代码
- **后果**:
  - 优点: 零构建步骤，调试时可直接查看原始代码；Service Worker 通过 `importScripts()` 同步加载，避免异步模块加载的时序问题
  - 缺点: 无 Tree Shaking，需手动管理依赖顺序；无 TypeScript 类型检查

### ADR-02: 技术指纹按首字母分片

- **状态**: 已采纳
- **日期**: 项目早期 (持续至今)
- **背景**: 技术指纹数据库包含数千条技术定义，单文件体积过大 (> 2.8 MB)
- **决策**: 按首字母拆分为 27 个 JSON 文件 (a-z + `_`)，按需通过 `chrome.runtime.getURL()` 动态加载
- **后果**:
  - 优点: Service Worker 启动时无需加载全部数据；首次分析时仅加载相关字母表文件
  - 缺点: 文件名与首字母强绑定，新增技术需编辑对应文件

### ADR-03: 两阶段 JS/DOM 检测

- **状态**: 已采纳
- **日期**: v6.x 系列
- **背景**: 单页应用 (SPA) 和异步脚本 (GTM 等) 在 `document_idle` 时尚未注入全局变量
- **决策**: 引入 5 秒延迟的二次 JS 扫描 (`setTimeout`)，捕获延迟注入的全局变量
- **后果**:
  - 优点: 显著提升对现代 SPA 框架的检测准确率
  - 缺点: 增加 5 秒的最长检测等待时间

### ADR-04: Ping 上报去重机制

- **状态**: 已采纳
- **日期**: v6.x 系列
- **背景**: 同一技术栈可能在短时间内被多次检测并上报
- **决策**: 使用 `hostnameIgnoreList` 排除本地/开发域名，并在 Ping 前对同类技术栈进行去重 (基于 hostname 缓存，`maxHostnames = 100`)
- **后果**:
  - 优点: 减少无效上报，降低服务端压力；用户隐私保护 (排除开发环境)
  - 限制: `maxPingUrls = 25`, `maxPingTechnologies = 25` 限制单次上报数据量

### ADR-05: 使用 `chrome.scripting.executeScript` 的 `world: 'MAIN'` 替代内联脚本

- **状态**: 已采纳 (MV3 迁移时)
- **日期**: v6.x MV3 迁移
- **背景**: MV3 禁止 `eval` 和内联脚本，需要新的方式在主世界执行代码
- **决策**: 通过 content.js 使用 `chrome.scripting.executeScript` 动态注入 `js.js` 和 `dom.js` (声明在 `web_accessible_resources` 中)
- **后果**:
  - 优点: 符合 MV3 CSP 限制；主世界代码与扩展代码通过 postMessage 解耦
  - 缺点: 注入有性能开销；需要在 manifest 中声明可访问资源

### ADR-06: Content Script 性能优化 — yieldToMain()

- **状态**: 已采纳
- **日期**: v6.10+ (估计)
- **背景**: content.js 需处理大量 DOM 文本和脚本标签，可能导致主线程阻塞
- **决策**: 实现 `yieldToMain()` 函数，优先使用 `scheduler.yield()` API，降级使用 `setTimeout(0)`
- **后果**:
  - 优点: 避免长任务阻塞用户交互
  - 缺点: 增加采集延迟

---

## 6. 权限清单

### 6.1 必需权限

| 权限 | API | 用途 |
|------|-----|------|
| `cookies` | `chrome.cookies` | 读取页面 Cookie，匹配技术指纹 (如 `_ga` → Google Analytics) |
| `storage` | `chrome.storage.local` | 持久化检测结果缓存、用户设置 (tracking 开关) |
| `tabs` | `chrome.tabs` | 获取活动标签页 URL，管理标签分析与缓存 |
| `webRequest` | `chrome.webRequest` | 监听 HTTP 响应头、外部脚本、XHR 请求进行实时分析 |

### 6.2 主机权限

| 权限 | 范围 | 用途 |
|------|------|------|
| `http://*/*` | 所有 HTTP 源 | Content Script 注入、webRequest 监听 |
| `https://*/*` | 所有 HTTPS 源 | Content Script 注入、webRequest 监听 |

### 6.3 可选权限

| 权限 | API | 用途 |
|------|-----|------|
| `downloads` | `chrome.downloads` | 导出检测结果 (用户触发) |

### 6.4 内容安全策略

```json
{
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```

- 仅允许加载扩展自身的脚本
- 禁止所有 `object-src` (插件/ActiveX 等)
- MV3 默认禁止 `eval` 和内联脚本

### 6.5 web_accessible_resources

| 资源 | 可访问范围 | 用途 |
|------|-----------|------|
| `js/js.js` | `http://*/*`, `https://*/*` | 主世界 JavaScript 全局变量检测 |
| `js/dom.js` | `http://*/*`, `https://*/*` | 主世界 DOM 属性遍历检测 |

---

## 7. 文件大小统计表

### 7.1 JavaScript 源文件

| 文件 | 行数 | 估计大小 | 说明 |
|------|------|----------|------|
| `js/index.js` | 2,235 | ~85 KB | 主驱动逻辑 (最大模块) |
| `js/popup.js` | 1,074 | ~40 KB | 弹窗 UI |
| `js/content.js` | 906 | ~35 KB | Content Script 采集器 |
| `js/wappalyzer.js` | 752 | ~28 KB | 核心匹配引擎 |
| `js/utils.js` | 182 | ~6 KB | 工具库 |
| `js/terms.js` | 90 | ~3 KB | 隐私条款 |
| `js/options.js` | 81 | ~2.5 KB | 选项页 |
| `js/dom.js` | 71 | ~2 KB | DOM 属性检测 |
| `js/js.js` | 52 | ~1.5 KB | 全局变量检测 |
| `js/background.js` | 5 | ~150 B | SW 入口 |
| **总计** | **5,448** | **~203 KB** | 10 个 JS 文件 |

### 7.2 HTML 页面

| 文件 | 行数 | 估计大小 |
|------|------|----------|
| `html/popup.html` | 229 | ~10 KB |
| `html/options.html` | 55 | ~2 KB |
| `html/terms.html` | 38 | ~1.5 KB |
| `html/background.html` | 12 | ~400 B |
| **总计** | **334** | **~14 KB** |

### 7.3 样式

| 文件 | 行数 | 估计大小 | 说明 |
|------|------|----------|------|
| `css/styles.css` | 1,055 | ~25 KB | BEM + CSS 变量，暗色主题支持 |

### 7.4 数据文件

| 文件/目录 | 大小 | 说明 |
|-----------|------|------|
| `technologies/*.json` (27 文件) | ~2.88 MB | 技术指纹数据库 (最大文件: `s.json` ~338 KB, `c.json` ~240 KB, `a.json` ~229 KB) |
| `_locales/` (34 种语言) | — | 国际化消息文件 |
| `categories.json` | — | 108 个技术分类 |
| `groups.json` | — | 17 个技术分组 |
| `schema.json` | — | 1 个设置属性 |

### 7.5 扩展包总体

| 指标 | 值 |
|------|-----|
| JS 文件总行数 | ~5,448 |
| 技术指纹数据 | ~2.88 MB (27 个 JSON) |
| 支持语言 | 34 种 (含 `zh_CN`, `zh_TW`) |
| 技术分类 | 108 个 |
| 技术分组 | 17 个 |

---

## 8. 数据流图

```
+------------------+     +------------------+     +------------------+
|    Web 页面       |     |   Content Script  |     |  Service Worker  |
|                  |     |                  |     |                  |
| 1. 页面加载       | --> | 2. 采集信号       | --> | 3. 加载技术指纹   |
|    DOM 渲染       |     |   - cookies      |     |   - 读取 localStorage|
|    脚本执行        |     |   - meta         |     |   - fetch JSON    |
|                  |     |   - scripts      |     |                  |
|                  |     |   - text (截断)   |     | 4. 匹配分析       |
|                  |     |   - css          |     |   - analyze()    |
|                  |     |                  |     |   - resolve()    |
|                  |     | 5. 注入执行       |     |                  |
| +-- js.js <------+-----+                  |     | 6. 缓存结果       |
| |  window 遍历    |     |                  |     |   - chrome.storage|
| +-- dom.js <------+-----+                  |     |   - TTL 48h     |
| |  __reactFiber   |     |                  |     |                  |
| |  等属性检测     |     |                  |     | 7. Ping 上报      |
| +---------------+      |                  |     |   - ping.wappalyzer|
|                         |                  |     |     .com/v2/    |
| 8. 异步脚本加载        | 9. 5s 后二次 JS  | --> |                  |
|   (GTM/Analytics)      |    扫描          |     | 10. 结果推送      |
|                         |                  |     |   - sendMessage  |
|                         |                  |     |     to popup    |
+------------------+     +------------------+     +--------+---------+
                                                            |
                                                            v
                                                   +------------------+
                                                   |   Popup UI        |
                                                   |                  |
                                                   | 11. 渲染技术列表   |
                                                   | 12. 分类筛选       |
                                                   | 13. 版本显示       |
                                                   | 14. Plus API Key  |
                                                   +------------------+
```

---

## 9. 关键常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `expiry` | 48 小时 | 检测结果缓存 TTL |
| `maxHostnames` | 100 | 最大缓存域名数 |
| `maxPingUrls` | 25 | 单次 Ping 最大 URL 数 |
| `maxPingTechnologies` | 25 | 单次 Ping 最大技术数 |
| `maxExternalScriptChars` | 100,000 | 外部脚本最大分析字符数 |
| `persistDebounce` | 1,000 ms | 持久化防抖间隔 |
| `MAX_TEXT_LENGTH` | 25,000 | 页面文本最大采集长度 |
| `MAX_INLINE_SCRIPT_COUNT` | 50 | 最大内联脚本采集数 |
| `MAX_INLINE_SCRIPT_CHARS` | 200,000 | 内联脚本最大采集字符数 |
| `MAX_DOM_TEXT_LENGTH` | 1,000,000 | DOM 文本最大采集长度 |
| `MAX_TECH_DETECTIONS` | 50 | 单页面最大技术检测数 |
| JS 扫描延迟 | 5,000 ms | 二次 JS 检测延迟 |

---

## 10. 国际化

扩展通过 Chrome i18n API (`chrome.i18n.getMessage`) 支持 34 种语言，每种语言对应 `_locales/{locale}/messages.json`。支持的语言包括：

`ar` (阿拉伯语), `bg` (保加利亚语), `ca` (加泰罗尼亚语), `cs` (捷克语), `da` (丹麦语), `de` (德语), `el` (希腊语), `en` (英语 - 默认), `es` (西班牙语), `fi` (芬兰语), `fr` (法语), `gr` (希腊语别名), `he` (希伯来语), `hr` (克罗地亚语), `hu` (匈牙利语), `id` (印尼语), `it` (意大利语), `ja` (日语), `ko` (韩语), `nl` (荷兰语), `no` (挪威语), `pl` (波兰语), `pt` (葡萄牙语), `pt_BR` (巴西葡萄牙语), `ro` (罗马尼亚语), `ru` (俄语), `sk` (斯洛伐克语), `sv` (瑞典语), `th` (泰语), `tr` (土耳其语), `uk` (乌克兰语), `vi` (越南语), `zh_CN` (简体中文), `zh_TW` (繁体中文)

---

## 11. 安全与隐私设计

- **匿名上报**: Ping 上报不包含用户身份信息，仅发送技术栈名称和版本
- **域名过滤**: `hostnameIgnoreList` 和 `transientHostnameIgnoreList` 排除本地开发、内部测试、知名网站域名
- **用户控制**: Options 页面提供 `tracking` 开关，允许用户禁用匿名上报
- **CSP 限制**: 仅允许 `script-src 'self'`，防止 XSS 注入
- **无 eval**: MV3 迁移后不再使用 `eval` 或内联脚本
- **数据最小化**: Content Script 截断文本 (`MAX_TEXT_LENGTH = 25000`)、限制脚本数量 (`MAX_INLINE_SCRIPT_COUNT = 50`)

---

*文档基于 Wappalyzer v6.12.3 源代码分析生成 | 生成日期: 2026-07-06*
