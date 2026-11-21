# uBlock Origin Lite — 数据流文档

> **版本:** 2026.628.2035 | **逆向日期:** 2026-07-06 | **模型:** dsv4

---

## 一、整体数据流概览

```mermaid
flowchart TB
    subgraph Browser["浏览器"]
        Page["网页 (目标站点)"]
    end

    subgraph Extension["uBlock Origin Lite 扩展"]
        subgraph DNR["Declarative Net Request 引擎"]
            StaticRules["静态规则集 (60+ JSON)"]
            DynamicRules["动态规则 (allowAllRequests)"]
            SessionRules["会话规则 (TAB_ID_NONE)"]
        end

        subgraph SW["Service Worker (background.js)"]
            Config["rulesetConfig<br/>(local + session)"]
            Mode["filteringModeDetails<br/>(hostname → level)"]
            MsgRouter["消息路由 (onMessage)"]
            CSReg["Content Script 注册器<br/>(scripting-manager.js)"]
        end

        subgraph CS["Content Scripts (注入到页面)"]
            CS_Cosmetic["Cosmetic 过滤<br/>(css-specific, css-generic)"]
            CS_Tools["交互工具<br/>(picker, zapper, toolbar)"]
            CS_Popup["弹窗拦截<br/>(prevent-popup)"]
        end

        subgraph US["User Scripts (MAIN/ISOLATED)"]
            Scriptlets["Scriptlet 注入<br/>(js/resources/*.js)"]
        end

        subgraph Offscreen["Offscreen Document"]
            Compile["过滤器编译<br/>(compile-filters.js)"]
        end

        subgraph UI["UI 页面"]
            Popup["popup.html"]
            Dashboard["dashboard.html"]
            MatchedRules["matched-rules.html"]
        end
    end

    Page -->|"网络请求"| DNR
    DNR -->|"阻止/允许/重定向"| Page
    DNR -->|"setExtensionActionOptions<br/>拦截计数"| SW

    SW -->|"registerContentScripts()"| CSReg
    CSReg -->|"chrome.scripting API"| CS
    CS -->|"css-specific/insertCSS"| Page
    CS -->|"runtime.sendMessage"| MsgRouter

    SW -->|"registerUserScripts()"| US
    US -->|"userScripts API<br/>page world 注入"| Page

    SW -->|"创建/通信"| Offscreen
    Offscreen -->|"编译结果"| SW

    UI -->|"runtime.sendMessage"| MsgRouter
    MsgRouter -->|"BroadcastChannel('uBOL')"| UI
    MsgRouter -->|"配置更新"| Config
    MsgRouter -->|"模式变更"| Mode
```

---

## 二、核心数据流详解

### 2.1 启动流程 (Cold Start / Wakeup)

```mermaid
sequenceDiagram
    participant Browser as 浏览器
    participant SW as Service Worker
    participant SL as storage.local
    participant SS as storage.session
    participant DNR as DNR API
    participant Admin as managed storage

    Browser->>SW: 启动 Service Worker

    SW->>SS: sessionRead('rulesetConfig')
    alt session 中有数据 (wakeupRun)
        SS-->>SW: rulesetConfig
        Note over SW: process.wakeupRun = true<br/>跳过完整初始化
    else session 中无数据
        SW->>SL: localRead('rulesetConfig')
        alt local 中有数据 (cold start)
            SL-->>SW: rulesetConfig
            SW->>SS: sessionWrite('rulesetConfig', ...)
        else 首次安装 (firstRun)
            Note over SW: process.firstRun = true<br/>使用默认配置
            SW->>SS: sessionWrite('rulesetConfig', default)
            SW->>SL: localWrite('rulesetConfig', default)
        end
    end

    SW->>Admin: loadAdminConfig()
    Admin-->>SW: 企业策略覆盖

    alt 版本变更
        SW->>SW: patchDefaultRulesets()
        SW->>DNR: updateDynamicAndSessionRules()
        SW->>DNR: enableRulesets(enabledRulesets)
    else 同版本
        SW->>DNR: updateSessionRules()
        SW->>DNR: enableRulesets(enabledRulesets)
    end

    SW->>Browser: syncWithBrowserPermissions()
    Note over SW: 检查 host 权限变更<br/>调整过滤模式

    SW->>SW: registerContentScripts()
    SW->>SW: registerUserScripts()
    SW->>SW: updateUserRules()
```

### 2.2 网络请求过滤流程

```mermaid
sequenceDiagram
    participant Page as 网页
    participant Chrome as Chrome 浏览器
    participant DNR as DNR 规则引擎
    participant SW as Service Worker
    participant Badge as 工具栏图标

    Page->>Chrome: 发起网络请求 (sub_frame, script, image...)
    Chrome->>DNR: 评估所有已启用规则

    alt 匹配 allowAllRequests (no-filtering 模式)
        DNR-->>Chrome: allow (放行)
    else 匹配 block/redirect 规则
        DNR-->>Chrome: block/redirect (拦截/重定向)
        DNR->>SW: setExtensionActionOptions<br/>(更新拦截计数)
        SW->>Badge: 显示拦截数目
    else 无匹配规则
        DNR-->>Chrome: allow (放行)
    end
```

**规则优先级体系:**
```
优先级从高到低:
1. TRUSTED_DIRECTIVE_PRIORITY (2,000,000) — 管理员强制规则
2. USER_RULES_PRIORITY (1,000,000)     — 用户自定义规则
3. STRICTBLOCK_PRIORITY (29)           — 严格拦截规则
4. 规则集内默认优先级 (1-28)             — 标准过滤规则
```

**规则类型:**
- **静态规则** (`dnr.updateStaticRules`): 打包在扩展内的预编译规则, 随扩展更新
- **动态规则** (`dnr.updateDynamicRules`): 运行时添加, 跨会话持久化 (allowAllRequests 豁免)
- **会话规则** (`dnr.updateSessionRules`): 运行时添加, 仅当前会话有效 (TAB_ID_NONE 豁免)
- **用户规则** (`updateUserRules`): 用户通过过滤器编辑器创建的自定义 DNR 规则

### 2.3 Cosmetic 过滤流程 (CSS 隐藏)

```mermaid
sequenceDiagram
    participant Page as 网页
    participant Chrome as Chrome
    participant SW as Service Worker
    participant CS as Content Script<br/>(css-specific / css-generic)
    participant SS as storage.session<br/>(CSS Cache)

    Note over SW: 启动时或配置变更时
    SW->>SW: registerContentScripts()
    SW->>Chrome: scripting.registerContentScripts([...])
    Note over Chrome: 注册 css-specific<br/>(matches: optimal+complete hostnames)<br/>注册 css-generic<br/>(matches: complete hostnames)

    Page->>Chrome: 页面加载 (匹配的 hostname)
    Chrome->>CS: 注入 content script (document_start/css-specific)
    CS->>SS: 读取缓存 (cache.css.{hostname})
    alt 缓存命中
        SS-->>CS: 预编译的 CSS selectors
    else 缓存未命中
        CS->>CS: 从注入数据中计算 selectors
        CS->>SS: 写入缓存 (带时间戳)
    end

    CS->>Page: insertCSS({ css: '#ad-banner { display:none !important }' })

    Note over Page: 广告元素被隐藏

    Chrome->>CS: document_idle (css-generic)
    CS->>Page: insertCSS(通用隐藏规则)
```

**CSS 注入优化:**
- `css-specific` (document_start): 针对特定站点的规则, 尽早注入以避免闪烁
- `css-generic` (document_idle): 通用规则, 延迟注入以优化性能
- `cache.css.*` 缓存: session storage 缓存, 上限 ~288 条目, LRU 淘汰

### 2.4 Scriptlet 注入流程

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant Offscreen as Offscreen Document
    participant Chrome as Chrome
    participant Page as 网页
    participant US as User Script (MAIN world)

    Note over SW: 配置变更触发
    SW->>Offscreen: 创建 offscreen document
    Offscreen->>Offscreen: 编译过滤器列表
    Offscreen-->>SW: compileFilters:result<br/>(scriptlets JSON)

    SW->>Chrome: userScripts.register([...])
    Note over Chrome: 注册到指定 hostname<br/>world: MAIN 或 ISOLATED

    Page->>Chrome: 页面加载 (匹配的 hostname)
    Chrome->>US: 注入 scriptlet (MAIN world)
    Note over US: 访问页面全局作用域<br/>拦截/修改 JS API

    alt Scriptlet 类型: set-constant
        US->>Page: Object.defineProperty(window, 'apiKey', ...)
    alt Scriptlet 类型: json-prune
        US->>Page: JSON.parse = modifiedParse
    alt Scriptlet 类型: prevent-fetch
        US->>Page: window.fetch = blockedFetch
    end
```

**Scriptlet 安全隔离:**
- **MAIN world:** 脚本可与页面 JS 交互 (继承 `userScripts` 权限), 用于需要修改页面全局对象的 scriptlet
- **ISOLATED world:** 脚本与页面 JS 隔离 (标准 content script 沙箱), 用于不需要访问页面全局的 scriptlet
- 根据 `scriptlet-details.json` 中每个规则集的 `world` 属性决定注入到哪个 world

### 2.5 过滤模式切换流程 (用户交互)

```mermaid
sequenceDiagram
    participant User as 用户
    participant Popup as popup.html
    participant SW as Service Worker
    participant Mode as mode-manager.js
    participant CSReg as scripting-manager.js
    participant USReg as compiled-filters.js
    participant Tab as 浏览器标签页

    User->>Popup: 拖动过滤模式滑块
    Popup->>SW: runtime.sendMessage({<br/>  what: 'setFilteringMode',<br/>  hostname: 'example.com',<br/>  level: 2 (OPTIMAL)<br/>})

    SW->>SW: await isFullyInitialized
    SW->>Mode: getFilteringMode('example.com')
    Mode-->>SW: beforeLevel (当前模式)

    SW->>Mode: setFilteringMode('example.com', 2)
    Mode->>Mode: applyFilteringMode(hostname, level)
    Note over Mode: 更新 hostname 集合<br/>(none/basic/optimal/complete)
    Mode->>Mode: writeFilteringModeDetails()
    Mode->>Mode: filteringModesToDNR() — 更新 DNR allowAll 规则
    Mode-->>SW: afterLevel (新模式)

    SW->>CSReg: registerContentScripts()
    CSReg->>CSReg: 根据新模式重建 content script 注册表
    Note over CSReg: 先 unregister 所有, 再 register 新的

    SW->>USReg: registerUserScripts()
    USReg->>USReg: 根据新模式更新 userScript 注册

    alt 模式变更且需要 host 权限
        SW->>Popup: 返回需要权限请求
        Popup->>User: 显示权限请求对话框
        User->>Popup: 确认授权
        Popup->>SW: setPendingFilteringMode + permissions.request()
        SW->>SW: onPermissionGrantedThruExtension()
        alt autoReload 启用
            SW->>Tab: tabs.reload(tabId)
        end
    end
```

### 2.6 Element Picker / Zapper 工作流

```mermaid
sequenceDiagram
    participant User as 用户
    participant Page as 网页
    participant CS as Content Script<br/>(tool-overlay + picker/zapper)
    participant SW as Service Worker
    participant CM as filter-manager.js

    User->>SW: 点击工具栏按钮 → enter-picker-mode
    SW->>Page: scripting.executeScript(<br/>  ['tool-overlay.js', 'picker.js'])

    CS->>Page: 注入选择器覆盖层 UI

    User->>Page: 悬停/点击页面元素
    Page->>CS: 识别被选元素的 CSS selector

    User->>CS: 确认创建过滤规则
    CS->>SW: runtime.sendMessage({<br/>  what: 'addCustomFilters',<br/>  hostname: 'example.com',<br/>  selectors: ['##.ad-banner']<br/>})

    SW->>CM: addCustomFilters(hostname, selectors)
    CM->>CM: 存储到 local storage

    alt selector 是普通 CSS
        SW->>SW: registerContentScripts()
    alt selector 是 scriptlet ('+js(...)')
        SW->>SW: updateCompiledFilters()
        SW->>SW: registerUserScripts()
    end

    SW-->>CS: 返回成功

    Note over Page: 被选元素立即被隐藏
```

### 2.7 规则集数据流 (导入/启用/禁用)

```mermaid
sequenceDiagram
    participant User as 用户
    participant Dash as dashboard.html
    participant SW as Service Worker
    participant RM as ruleset-manager.js
    participant DNR as DNR API
    participant Fetch as fetch (远程)

    User->>Dash: 启用/禁用规则集
    Dash->>SW: applyRulesets({<br/>  enabledRulesets: [...],<br/>  toRemove: [...]<br/>})

    SW->>RM: enableRulesets(enabledRulesets)
    RM->>DNR: dnr.updateEnabledRulesets(...)
    Note over DNR: 更新静态规则集启用状态

    RM-->>SW: { stockUpdated, importedUpdated, enabledRulesets }

    alt stockUpdated (静态规则集变更)
        SW->>SW: saveRulesetConfig()
        SW->>SW: registerContentScripts()
    end

    alt importedUpdated (导入列表变更)
        SW->>SW: saveRulesetConfig()
        SW->>SW: updateCompiledFilters()
        SW->>Offscreen: 创建 offscreen document
        Offscreen->>Fetch: 拉取远程过滤器列表
        Fetch-->>Offscreen: 过滤器文本
        Offscreen->>Offscreen: 编译为 DNR 规则 + scriptlets
        Offscreen-->>SW: 编译结果
        SW->>SW: registerUserScripts()
        SW->>SW: updateUserRules()
    end

    SW->>SW: broadcastMessage({ enabledRulesets })

    Note over Dash: UI 更新以反映新状态
```

---

## 三、存储数据流

### 3.1 双存储策略

```
         ┌─────────────────────┐
         │  storage.local       │ ← 持久化 (跨浏览器会话)
         │  (永久配置、过滤器)    │
         └──────┬──────────────┘
                │ 读取/写入
         ┌──────▼──────────────┐
         │  storage.session     │ ← 会话级 (跨 Service Worker 唤醒)
         │  (CSS 缓存、配置缓存)  │
         └─────────────────────┘
```

**存储键读写模式:**

| 键 | local | session | 读频率 | 写频率 | 用途 |
|----|:-----:|:-------:|:------:|:------:|------|
| `rulesetConfig` | 持久 | 缓存 | 高 | 低 | 扩展配置 |
| `filteringModeDetails` | 持久 | 缓存 | 高 | 中 | 过滤模式主机名映射 |
| `customFilters` | 持久 | — | 低 | 低 | 用户自定义过滤规则 |
| `importedLists` | 持久 | — | 低 | 低 | 导入的第三方列表 |
| `permissions.hostnames` | 持久 | — | 低 | 低 | 已授予的主机权限 |
| `cache.css.*` | — | 缓存 | 高 | 高 | 编译后的 CSS 选择器 |
| `admin.*` | 缓存 | 缓存 | 低 | 极低 | 企业策略缓存 |
| `goodStart` | 持久 | — | 极低 | 极低 | 启动健康哨兵 |

### 3.2 CSS 缓存数据流

```
写入路径:
  Content Script → 计算 selectors → sessionWrite('cache.css.{hostname}', {t: now, ...})
  
读取路径:
  Content Script → sessionRead('cache.css.{hostname}') → 命中直接使用
                                                      → 未命中重新计算

淘汰策略:
  Service Worker → sessionKeys() → 筛选 'cache.css.*' 
                 → 按时间戳 t 排序 → 删除最旧的条目
                 → 触发: 超过 256 (低水位) 条目时
                 → 淘汰至 256 以下
```

### 3.3 管理员配置覆盖流

```mermaid
flowchart LR
    Admin[管理员策略<br/>storage.managed] -->|adminReadEx| Cache[admin.* 缓存<br/>(session + local)]
    Cache -->|变更检测 (JSON diff)| Debounce[127ms 防抖]
    Debounce -->|defaultFiltering| Mode[覆盖默认过滤模式]
    Debounce -->|rulesets| RM[覆盖规则集启用/禁用]
    Debounce -->|noFiltering| Mode2[添加不拦截域名]
    Debounce -->|strictBlockMode| SW[设置严格拦截]
    Debounce -->|popupBlockMode| SW2[设置弹窗拦截]
    Debounce -->|showBlockedCount| Badge[设置徽标显示]
    Debounce -->|disabledFeatures| UI[隐藏 UI 功能]
```

---

## 四、消息通信协议

### 4.1 Service Worker 消息接口 (完整)

| 消息类型 (what) | 方向 | 关键参数 | 返回值 |
|---|---|---|---|
| `insertCSS` | CS→SW | `css`, `tabId`, `frameId` | void |
| `removeCSS` | CS→SW | `css`, `tabId`, `frameId` | void |
| `injectCSSProceduralAPI` | CS→SW | `tabId`, `frameId` | void |
| `toggleToolbarIcon` | CS→SW | `tabId` | void |
| `startCustomFilters` | CS→SW | `tabId`, `frameId` | void |
| `terminateCustomFilters` | CS→SW | `tabId`, `frameId` | void |
| `injectCustomFilters` | CS→SW | `tabId`, `frameId`, `hostname` | void |
| `applyRulesets` | UI→SW | `enabledRulesets[]`, `toRemove[]` | void |
| `getDefaultConfig` | UI→SW | — | DefaultConfig |
| `getCurrentConfig` | UI→SW | — | RulesetConfig |
| `getOptionsPageData` | UI→SW | — | OptionsPageData |
| `popupPanelData` | UI→SW | `hostname` | PopupPanelData |
| `getFilteringMode` | UI→SW | `hostname` | FilteringLevel |
| `setFilteringMode` | UI→SW | `hostname`, `level` | FilteringLevel |
| `setDefaultFilteringMode` | UI→SW | `level` | FilteringLevel |
| `getFilteringModeDetails` | UI→SW | — | FilteringModeDetails |
| `setFilteringModeDetails` | UI→SW | `modes` | FilteringModeDetails |
| `addCustomFilters` | UI/CS→SW | `hostname`, `selectors[]` | void |
| `removeCustomFilters` | UI→SW | `hostname`, `selectors[]` | void |
| `removeAllCustomFilters` | UI→SW | `hostname` | void |
| `getAllCustomFilters` | UI→SW | — | CustomFiltersMap |
| `getSandboxFilters` | UI→SW | — | string |
| `setSandboxFilters` | UI→SW | `text` | void |
| `importFilterList` | UI→SW | `url` | void |
| `getImportedLists` | UI→SW | — | ImportedList[] |
| `updateImportedLists` | UI→SW | — | number |
| `getMatchedRules` | UI→SW | `tabId` | MatchedRule[] |
| `getAllDynamicRules` | UI→SW | — | DNRRule[] |
| `getAllSessionRules` | UI→SW | — | DNRRule[] |
| `getEffectiveUserRules` | UI→SW | — | DNRRule[] |
| `updateUserDnrRules` | UI→SW | — | void |
| `hasBroadHostPermissions` | UI→SW | — | boolean |
| `setAutoReload` | UI→SW | `state` | void |
| `setShowBlockedCount` | UI→SW | `state` | void |
| `setStrictBlockMode` | UI→SW | `state` | void |
| `setPopupBlockMode` | UI→SW | `state` | void |
| `setDeveloperMode` | UI→SW | `state` | boolean |
| `gotoURL` | UI→SW | `url`, `type` | void |
| `excludeFromStrictBlock` | UI→SW | `hostname`, `permanent` | void |
| `showMatchedRules` | UI→SW | `tabId` | void |
| `getRegisteredContentScripts` | UI→SW | — | string[] |
| `getConsoleOutput` | UI→SW | — | string |
| `pruneCSSCache` | UI→SW | — | void |
| `keepAlive` | UI→SW | — | void |

### 4.2 BroadcastChannel 事件

```
Channel: 'uBOL'

消息类型:
  { enabledRulesets: string[] }       — 规则集启用状态变更
  { autoReload: boolean }             — 自动重载设置变更
  { showBlockedCount: boolean }       — 徽标显示设置变更
  { strictBlockMode: boolean }        — 严格拦截模式变更
  { popupBlockMode: boolean }         — 弹窗拦截模式变更
  { developerMode: boolean }          — 开发者模式变更
  { defaultFilteringMode: number }    — 默认过滤模式变更
  { filteringModeDetails: object }    — 过滤模式详情变更
  { hasOmnipotence: boolean }         — 广泛权限状态变更
```

### 4.3 Offscreen Document 消息协议

```
Channel: runtime.onMessage (同 Service Worker 消息通道)

消息类型:
  compileFilters:getResourceTypes    — Offscreen → SW: 获取 DNR ResourceType 枚举
  compileFilters:getUserList         — Offscreen → SW: 获取用户自定义过滤器
  compileFilters:getEnabledImportedLists — Offscreen → SW: 获取启用的导入列表
  compileFilters:result              — Offscreen → SW: 返回编译结果
  compileFilters:getImportedListData — Offscreen → SW: 获取导入列表编译数据
```

---

## 五、URL Skip (跟踪参数剥离) 流程

```mermaid
sequenceDiagram
    participant Page as 网页
    participant DNR as DNR 引擎
    participant Ruleset as urlskip 规则集

    Page->>DNR: 导航请求 (带跟踪参数)
    Note over DNR: URL: https://example.com/page?utm_source=twitter&fbclid=xxx

    DNR->>Ruleset: 匹配 urlskip 规则
    Ruleset-->>DNR: redirect.transform { queryTransform: removeParams }

    DNR->>Page: 302 重定向到清理后的 URL
    Note over DNR: 清理后: https://example.com/page
```

URL skip 规则通过 DNR 的 `redirect.transform` 动作实现, 规则集存储在 `rulesets/urlskip/` 目录, 在 Session 启动时通过 `updateSessionRules()` 注册。

---

## 六、错误恢复与弹性

### 6.1 Service Worker 崩溃恢复

```
start() 失败
  → 检查 process.wakeupRun (是否是唤醒运行)
  → 是: 放弃 (避免重启循环)
  → 否: 检查 local.goodStart
    → goodStart === false: 上次重启失败, 放弃
    → goodStart !== false: 写入 false, runtime.reload()
```

### 6.2 权限撤销处理

```
permissions.onRemoved 触发
  → onPermissionsRemoved()
  → syncWithBrowserPermissions()
    → 如果没有广泛权限但默认模式 > BASIC
      → 降级默认模式到 BASIC
    → 移除不再授权的 hostname 的高级过滤模式
    → 重新注册 content scripts
```

### 6.3 DNR 规则集 ID 冲突处理

`enableRulesets()` 中处理扩展更新后规则集 ID 变化: `patchDefaultRulesets()` 检测过时规则集并替换为新的等价规则集。

---

## 七、性能优化策略

| 策略 | 实现 | 效果 |
|------|------|------|
| CSS 选择器会话缓存 | `cache.css.*` in session storage | 避免重复计算选择器 |
| 惰性初始化 | `isFullyInitialized` 门控 | 事件到达时已完成初始化 |
| 防抖批处理 | 127ms debounce in admin.js | 减少管理员配置变更的重复处理 |
| DNR 规则 diff 比较 | `deepCompare` before update | 避免无变化的 DNR 规则更新 |
| LRU CSS 缓存淘汰 | 256/288 水位线 | 控制 session storage 占用 |
| 串行化异步突变 | `pendingOp = pendingOp.then(...)` | 防止配置读写的竞态条件 |
| BroadcastChannel 广播 | 替代逐个 sendMessage | 减少 N-to-1 消息传递开销 |
