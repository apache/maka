# EditThisCookie V3 数据流文档

> 反向工程版本: dsv4 | 源版本: v3.0.5 | 日期: 2026-07-06

---

## 一、存储层数据流

### 1.1 初始化与数据同步

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant DataJS as data.js
    participant CSL as chrome.storage.local
    participant UI as Popup/Panel/Options

    SW->>DataJS: startData(callback)
    DataJS->>CSL: storage.get(keys)
    CSL-->>DataJS: 返回全部 preferences + data
    DataJS->>DataJS: 构造 preferences 对象 (watch)
    DataJS->>DataJS: 构造 data 对象 (watch)
    DataJS->>CSL: storage.set(未同步数据)
    DataJS-->>SW: { data, preferences }

    UI->>DataJS: startData(callback)
    DataJS-->>UI: { data, preferences }

    Note over DataJS,CSL: 属性变更时 watch 回调触发<br/>异步写入 chrome.storage.local

    UI->>DataJS: data.nCookiesCreated++
    DataJS->>CSL: storage.set('data_nCookiesCreated', newValue)
    CSL-->>SW: storage.onChanged 事件
    SW->>SW: callback({ data, preferences })
```

### 1.2 跨上下文同步

```mermaid
sequenceDiagram
    participant Popup
    participant CSL as chrome.storage.local
    participant SW as Service Worker
    participant Panel as DevTools Panel

    Popup->>CSL: preferences.copyCookiesType = 'json'
    CSL->>SW: onChanged: options_copyCookiesType
    SW->>SW: 更新本地 preferences 引用
    CSL->>Panel: onChanged: options_copyCookiesType
    Panel->>Panel: 更新本地 preferences 引用
```

## 二、Popup Cookie 管理数据流

```mermaid
flowchart TD
    A[用户打开 Popup] --> B{URL 参数?}
    B -->|有 url 参数| C[解析 URL 参数<br/>获取 tabId/incognito]
    B -->|无 url 参数| D[chrome.tabs.query<br/>获取当前标签页]
    C --> E[doSearch]
    D --> E

    E --> F[构建 Filter 对象<br/>通过 URL 或 domain]
    F --> G[chrome.cookies.getAllCookieStores]
    G --> H[chrome.cookies.getAll<br/>带 storeId + filter]
    H --> I[filteredCookies 列表]
    I --> J[createAccordionList<br/>jQuery UI Accordion 渲染]
    J --> K[setEvents 绑定事件]

    K --> L{用户操作}
    L -->|修改 Cookie| M[submit All<br/>deleteCookie + chrome.cookies.set]
    L -->|新建 Cookie| N[submitNew<br/>chrome.cookies.set]
    L -->|导入 Cookie| O[importCookies<br/>JSON parse + chrome.cookies.set]
    L -->|删除 Cookie| P[deleteCookie<br/>chrome.cookies.remove]
    L -->|导出 Cookie| Q[copyToClipboard<br/>cookiesToString 格式化]
    L -->|标记 Cookie| R[addBlockRule<br/>写入 filters + 删除匹配 Cookie]
    L -->|保护 Cookie| S[switchReadOnlyRule<br/>写入 readOnly 列表]
    L -->|过滤全部| T[deleteAll<br/>批量 chrome.cookies.remove]

    M --> U[chrome.tabs.reload<br/>如果 refreshAfterSubmit]
```

## 三、Service Worker 后台数据流

```mermaid
flowchart TD
    A[Service Worker 启动] --> B[startData]
    B --> C[设置圣诞图标]
    C --> D[注册 cookie.onChanged 监听]

    D --> E{cookie.onChanged 事件}
    E -->|cause = expired/evicted| F[跳过]
    E -->|其他原因| G{检查只读规则}

    G -->|匹配 readOnly| H{cookie 被删除?}
    H -->|是| I[chrome.cookies.get<br/>检查是否已恢复]
    I -->|未恢复| J[chrome.cookies.set<br/>恢复受保护 Cookie]
    J --> K[data.nCookiesProtected++]
    H -->|否| F

    G -->|未匹配| L{cookie 被创建?}
    L -->|是| M{匹配 block filter?}
    M -->|是| N[chrome.cookies.remove<br/>删除被拦截 Cookie]
    N --> O[data.nCookiesFlagged++]
    M -->|否| P{超过最大存活时间?}
    P -->|是| Q[chrome.cookies.set<br/>缩短过期时间]
    Q --> R[data.nCookiesShortened++]
    P -->|否| F

    F --> D
```

## 四、DevTools Panel 数据流

```mermaid
sequenceDiagram
    participant DT as DevTools Page
    participant SW as Service Worker
    participant Panel as Panel (panel.js)
    participant CSL as chrome.cookies API

    DT->>SW: chrome.runtime.connect(name: "devtools-page")
    SW->>SW: onConnect 注册 listener

    Panel->>SW: postMessage({ action: "getall", tabId })
    SW->>CSL: chrome.cookies.getAll({ url: tab.url })
    CSL-->>SW: Cookie[]
    SW->>Panel: postMessage({ action: "getall", url, cks })
    Panel->>Panel: createTable 渲染

    Panel->>Panel: 用户编辑 Cookie (tablesorter + jeditable)
    Panel->>SW: postMessage({ action: "submitCookie", cookie, origName })
    SW->>CSL: chrome.cookies.remove (按 origName)
    SW->>CSL: chrome.cookies.set (新值)
    SW->>Panel: postMessage({ action: "refresh" })
    Panel->>Panel: location.reload()
```

## 五、选项页面数据流

```mermaid
flowchart TD
    A[options_main_page.html] --> B[options_main_page.js]
    B --> C[storage.get('option_panel')]
    C --> D{option_panel 值?}
    D -->|null/undefined| E[跳转 support.html]
    D -->|user_preferences| F[跳转 user_preferences.html]
    D -->|block_rules| G[跳转 block_rules.html]
    D -->|readonly_rules| H[跳转 readonly_rules.html]
    D -->|?page=xxx URL 参数| I[跳转 xxx.html]

    F --> J[user_preferences.js]
    J --> K[startData + 绑定 UI -> preferences 双向同步]

    G --> L[block_rules.js]
    L --> M[data.filters 列表渲染<br/>addBlockRule / deleteBlockRule]

    H --> N[readonly_rules.js]
    N --> O[data.readOnly 列表渲染<br/>switchReadOnlyRule / deleteReadOnlyRule]
```

## 六、Cookie 过滤/拦截数据流

```mermaid
flowchart LR
    A[用户添加 Block Rule] --> B[addBlockRule(data, rule)]
    B --> C[检查是否重复]
    C -->|不重复| D[data.filters.push(rule)]
    D --> E[chrome.cookies.getAll({})]
    E --> F[遍历所有 Cookie]
    F --> G{filterMatchesCookie?}
    G -->|匹配| H[chrome.cookies.remove]
    G -->|不匹配| F
    C -->|重复| I[返回重复索引]
```

## 七、数据键映射表

| 存储键 | JS 属性 | 类型 | 默认值 |
|--------|---------|------|--------|
| options_showAlerts | preferences.showAlerts | boolean | false |
| options_showCommandsLabels | preferences.showCommandsLabels | boolean | false |
| options_showDomain | preferences.showDomain | boolean | true |
| options_showDomainBeforeName | preferences.showDomainBeforeName | boolean | true |
| options_showFlagAndDeleteAll | preferences.showFlagAndDeleteAll | boolean | false |
| options_showContextMenu | preferences.showContextMenu | boolean | true |
| options_refreshAfterSubmit | preferences.refreshAfterSubmit | boolean | false |
| options_skipCacheRefresh | preferences.skipCacheRefresh | boolean | true |
| options_useMaxCookieAge | preferences.useMaxCookieAge | boolean | false |
| options_maxCookieAgeType | preferences.maxCookieAgeType | number | -1 |
| options_maxCookieAge | preferences.maxCookieAge | number | 1 |
| options_useCustomLocale | preferences.useCustomLocale | boolean | false |
| options_customLocale | preferences.customLocale | string | 'en' |
| options_copyCookiesType | preferences.copyCookiesType | string | 'json' |
| options_showChristmasIcon | preferences.showChristmasIcon | boolean | true |
| options_sortCookiesType | preferences.sortCookiesType | string | 'domain_alpha' |
| options_showDevToolsPanel | preferences.showDevToolsPanel | boolean | true |
| data_filters | data.filters | FilterRule[] | [] |
| data_readOnly | data.readOnly | ReadOnlyRule[] | [] |
| data_nCookiesCreated | data.nCookiesCreated | number | 0 |
| data_nCookiesChanged | data.nCookiesChanged | number | 0 |
| data_nCookiesDeleted | data.nCookiesDeleted | number | 0 |
| data_nCookiesProtected | data.nCookiesProtected | number | 0 |
| data_nCookiesFlagged | data.nCookiesFlagged | number | 0 |
| data_nCookiesShortened | data.nCookiesShortened | number | 0 |
| data_nPopupClicked | data.nPopupClicked | number | 0 |
| data_nPanelClicked | data.nPanelClicked | number | 0 |
| data_nCookiesImported | data.nCookiesImported | number | 0 |
| data_nCookiesExported | data.nCookiesExported | number | 0 |
| data_lastVersionRun | data.lastVersionRun | string | undefined |
| option_panel | (直接键) | string | null |
