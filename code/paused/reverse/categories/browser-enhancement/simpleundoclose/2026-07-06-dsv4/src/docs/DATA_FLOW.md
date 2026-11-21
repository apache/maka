# SimpleUndoClose v3.0.1 — 数据流文档

> 基于 v3.0.1 源码逆向分析

## 一、总览

SimpleUndoClose 的数据流围绕以下核心实体展开：
1. **TabList** — 当前打开标签页的快照 (追踪中)
2. **ClosedTab** — 已关闭标签页的快照 (待恢复)
3. **Settings** — 用户偏好配置 (持久化于 `storage.local`)
4. **Indexes** — 维护插入顺序的索引数组

```mermaid
graph TD
    subgraph "浏览器标签页事件"
        TC[tabs.onCreated]
        TU[tabs.onUpdated]
        TR[tabs.onRemoved]
    end

    subgraph "chrome.storage.local"
        S[settings]
        TLI[TabListIndex]
        CLI[ClosedTabIndex]
        TL[TabList-{tabId}]
        CL[ClosedTab-{randomId}]
    end

    subgraph "Service Worker (background.js)"
        INI[initialize]
        AT[addNewTab]
        ACT[addClosedTab]
        RESET[resetData]
        CLEAN[cleanClosedTabs]
        BADGE[setBadge]
    end

    subgraph "Popup UI (popup.html + popup.js)"
        POP[populate 渲染]
        SRCH[searchFor 搜索]
        CTA[createTab]
        RCTA[removeClosedTab]
    end

    subgraph "Options UI (options.html + options.js)"
        SAVE[save 持久化]
        CLEAR[clearMemory]
    end

    subgraph "外部"
        CMD[快捷键 Alt+Z]
    end

    TC --> AT
    TU --> AT
    TR --> ACT
    AT --> TL
    AT --> TLI
    ACT --> CL
    ACT --> CLI
    ACT --> BADGE
    INI --> S
    INI --> TLI
    INI --> CLI
    POP --> CLI
    POP --> CL
    CTA -->|runtime.sendMessage| ACT
    RCTA -->|runtime.sendMessage| ACT
    SRCH --> POP
    SAVE --> S
    CLEAR -->|runtime.sendMessage| RESET
    RESET --> TLI
    RESET --> CLI
    RESET --> TL
    RESET --> CL
    CLEAN --> CL
    CMD -->|onCommand| ACT
```

## 二、扩展初始化流

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant SL as storage.local

    Note over SW: onInstalled ("install")
    SW->>SL: set({settings: defaultSettings})
    SW->>SL: set({dcTime: Date.now()})
    SW->>SL: set({updatedTill: version})
    SW->>SL: set({TabListIndex: []})
    SW->>SL: set({ClosedTabIndex: []})
    SW->>SW: regExistingTabs()
    SW->>SW: chrome.tabs.query({"url":"*://*/*"})
    loop 每个标签页
        SW->>SW: addNewTab(tab)
        SW->>SL: set({TabList-{tab.id}: "url|!|title"})
        SW->>SL: TabListIndex.push(tab.id)
    end

    Note over SW: onStartup (浏览器启动)
    SW->>SL: get('settings')
    alt settings.saveHistory == false
        SW->>SW: resetData()
    else settings.saveHistory == true
        SW->>SW: tabListProcessing()
        loop 每个 TabListIndex 条目
            SW->>SW: addClosedTab(tabId, mode=1)
        end
        SW->>SW: cleanClosedTabs()
    end
    SW->>SW: setBadge()
```

## 三、标签页关闭与记录流

```mermaid
sequenceDiagram
    participant TABS as Chrome Tabs
    participant SW as Service Worker
    participant SL as storage.local

    Note over TABS: 用户关闭标签页
    TABS->>SW: tabs.onRemoved(tabId, info)
    SW->>SW: addClosedTab(tabId, mode=0)

    SW->>SL: get(`TabList-${tabId}`)
    SL-->>SW: tabData = "url|!|title"

    alt tabData 存在且 URL 匹配 http/https/chrome-extension
        SW->>SL: get('ClosedTabIndex')
        SL-->>SW: index[]

        Note over SW: URL 去重检查
        loop 遍历 ClosedTabIndex (倒序)
            SW->>SL: get(`ClosedTab-${index[i]}`)
            SL-->>SW: closedTab
            alt URL 匹配
                SW->>SL: remove(`ClosedTab-${matchedId}`)
                SW->>SW: 从 index 移除 matchedId
            end
        end

        SW->>SW: randomId = Math.random().toString(36).substr(2,8)
        SW->>SW: createStr = Date.now() + "|!|" + tabData
        SW->>SL: set({ClosedTab-{randomId}: createStr})
        SW->>SL: ClosedTabIndex.push(randomId)

        alt index.length > settings.numLimit
            Note over SW: 从头部删除最旧条目
            SW->>SL: remove(`ClosedTab-${index[0]}`)
            SW->>SW: index.shift()
        end

        SW->>SL: set({ClosedTabIndex: index})
    end

    SW->>SL: remove(`TabList-${tabId}`)
    SW->>SL: TabListIndex = TabListIndex.filter(id => id !== tabId)
    SW->>SW: setBadge()
```

## 四、Popup 渲染与交互流

```mermaid
sequenceDiagram
    participant DOM as Popup DOM
    participant JS as popup.js
    participant SL as storage.local
    participant SW as Service Worker

    Note over DOM: DOMContentLoaded
    JS->>SL: get('settings')
    SL-->>JS: settings
    JS->>JS: 计算布局参数 (tWidth, tWidth2, delType, lpdVal)
    JS->>JS: btnLangAdj() (语言特定调整)
    JS->>JS: setup()

    Note over JS: setup() → populate()
    JS->>SL: get('ClosedTabIndex')
    SL-->>JS: index[]

    alt index.length == 0
        JS->>DOM: innerHTML = "No closed tabs"
    else index 有数据
        JS->>DOM: innerHTML = ""
        loop i = n-1 到 0 (倒序, 分页跳页)
            JS->>SL: get(`ClosedTab-${index[i]}`)
            SL-->>JS: "timestamp|!|url|!|title"
            JS->>JS: createEntry(id, closedTab)
            JS->>JS: createLink → addEventListener (click/mousedown/auxclick)
            JS->>DOM: appendChild(link)
        end
    end

    Note over DOM: 用户点击条目
    DOM->>JS: click 事件 (left button)
    JS->>SW: runtime.sendMessage({action:"createTab", id, selected:true})
    SW->>SL: get(`ClosedTab-${id}`)
    SL-->>SW: url
    SW->>SW: chrome.tabs.create({url, active:true})
    SW->>SW: removeClosedTab(id)

    Note over DOM: 用户点击删除按钮 (×)
    DOM->>JS: click 事件 (event.stopPropagation)
    JS->>SW: runtime.sendMessage({action:"removeClosedTab", id})
    SW->>SL: remove(`ClosedTab-${id}`)
    SW->>SW: ClosedTabIndex.filter(id)
    SW->>SL: set({ClosedTabIndex})
    JS->>JS: populate() (重新渲染)
```

## 五、搜索流

```mermaid
sequenceDiagram
    participant INPUT as 搜索框
    participant JS as popup.js
    participant SL as storage.local

    INPUT->>JS: input 事件
    JS->>JS: searchFor(input.value)

    Note over JS: 输入预处理
    JS->>JS: replace(/%/g, '%25') (转义百分号)
    JS->>JS: trim()
    JS->>JS: stripVowelAccent() (去元音变音)
    JS->>JS: toLowerCase()
    JS->>JS: filterStrings = string.split(' ')

    Note over JS: 200ms debounce
    JS->>JS: clearTimeout(filterTimeOut)
    JS->>JS: filterTimeOut = setTimeout(setup, 200)

    JS->>JS: setup() → populate()

    Note over JS: populate() 搜索结果模式
    JS->>SL: get('ClosedTabIndex')
    SL-->>JS: index[]
    loop 倒序遍历所有条目 (pageNo=0, disp_per_pg=1000)
        JS->>SL: get(`ClosedTab-${index[i]}`)
        SL-->>JS: closedTab
        alt closedTab.multiFind(filterStrings)
            JS->>JS: createEntry() → 高亮匹配关键词
            JS->>JS: multiReplace → <u>标签包裹匹配文本
        end
    end

    alt 无匹配结果
        JS->>DOM: "未找到包含 '{keywords}' 的已关闭标签"
    end

    Note over INPUT: 用户点击"删除搜索结果"
    INPUT->>JS: deleteFoundTabs()
    loop 遍历所有 ClosedTab
        JS->>SL: get(`ClosedTab-${index[i]}`)
        alt multiFind == true
            JS->>SW: removeClosedTab(id)
        end
    end
```

## 六、设置持久化流

```mermaid
sequenceDiagram
    participant UI as Options Page
    participant OPT as options.js
    participant SL as storage.local
    participant SW as Service Worker

    Note over UI: 用户更改任意设置
    UI->>OPT: input/click 事件
    OPT->>OPT: 读取当前所有控件值
    OPT->>OPT: 组装 settings 对象
    OPT->>SL: set({settings})

    Note over OPT: 溢出修剪
    OPT->>SL: get('ClosedTabIndex')
    SL-->>OPT: index[]
    alt index.length > settings.numLimit
        OPT->>OPT: trimTabs(settings.numLimit)
        loop index[0..n] 旧条目
            OPT->>SL: remove(`ClosedTab-${id}`)
            OPT->>OPT: index.shift()
        end
        OPT->>SL: set({ClosedTabIndex: index})
    end

    OPT->>SW: runtime.sendMessage({action:"setBadge"})
    SW->>SW: setBadge()

    OPT->>SW: runtime.sendMessage({action:"updateIcon"})
    SW->>SW: updateIcon()

    Note over UI: 主题设置改变
    UI->>OPT: theme radio click
    OPT->>SL: set({settings})
    OPT->>OPT: location.reload() (立即生效)
```

## 七、数据重置流

```mermaid
sequenceDiagram
    participant UI as Popup / Options
    participant SW as Service Worker
    participant SL as storage.local

    Note over UI: 用户点击"清空"/"清除保存的标签页"
    UI->>SW: runtime.sendMessage({action:"resetData"})
    SW->>SW: resetData()

    SW->>SL: get('settings') + get('updatedTill')
    SL-->>SW: settings, oldUpdTill

    SW->>SL: get(null) (获取所有键)
    SL-->>SW: allKeys {}

    loop 所有键
        alt key != 'settings' && key != 'updatedTill'
            SW->>SL: remove(key)
        end
    end

    SW->>SL: set({settings}) (恢复设置)
    SW->>SL: set({updatedTill: oldUpdTill}) (保留版本标记)
    SW->>SL: set({TabListIndex: []})
    SW->>SL: set({ClosedTabIndex: []})

    SW->>SW: regExistingTabs() (重新记录当前标签页)
    SW->>SW: setBadge()
```

## 八、快捷键恢复流

```mermaid
sequenceDiagram
    participant KB as 键盘
    participant CH as Chrome
    participant SW as Service Worker
    participant SL as storage.local

    KB->>CH: Alt+Z / MacCtrl+Z
    CH->>SW: commands.onCommand("undo-latest")
    SW->>SW: getLatestCTab()

    SW->>SL: get('ClosedTabIndex')
    SL-->>SW: index[]

    alt index.length > 0
        SW->>SW: latestId = index[index.length - 1]
        SW->>SL: get(`ClosedTab-${latestId}`)
        SL-->>SW: "timestamp|!|url|!|title"
        SW->>SW: chrome.tabs.create({url, active:true})
        SW->>SW: removeClosedTab(latestId)
    end
```

## 九、主题流

```mermaid
sequenceDiagram
    participant PAGE as 页面 (popup/options/about/credits)
    participant TM as theme.js
    participant SL as storage.local
    participant CSS as Dark CSS <link>

    Note over PAGE: DOMContentLoaded
    TM->>SL: get('settings')
    SL-->>TM: settings

    alt settings.theme == "1" (系统默认)
        Note over CSS: 保留 media="(prefers-color-scheme: dark)"
        Note over CSS: 浏览器根据系统自动切换
    else settings.theme == "2" (强制亮色)
        TM->>CSS: link.removeAttribute("href")
        Note over CSS: 暗色样式表被完全禁用
    else settings.theme == "3" (强制暗色)
        TM->>CSS: link.removeAttribute("media")
        Note over CSS: 暗色样式表始终生效
    end
```

## 十、全局状态管理

| 变量 | 位置 | 说明 |
|------|------|------|
| `defaultSettings` (const) | background.js | 默认设置的模板对象，用于初始化 + 键合并 |
| `settings` (let) | popup.js, options.js | 从 storage 加载后的内存缓存 |
| `pageNo` (let) | popup.js | 当前分页页码 (0 起始) |
| `filterStrings` (let) | popup.js | 当前搜索关键词数组 (null = 无搜索) |
| `longpress` (let) | popup.js | 是否处于长按批量选择模式 |
| `chkArray` (let) | popup.js | 长按模式下选中的 ClosedTab ID 列表 |
| `delType` (let) | popup.js | 缓存自 settings.style 的删除按钮样式 |
| `lpdVal` (let) | popup.js | 缓存自 settings.lpDelay * 1000 的长按延迟 (ms) |
| `selLink` (let) | popup.js | 键盘导航时当前选中的链接索引 |
| `filterTimeOut` (let) | popup.js | 搜索 debounce 定时器 ID |
