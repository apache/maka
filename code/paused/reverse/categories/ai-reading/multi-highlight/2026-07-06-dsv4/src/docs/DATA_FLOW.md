# Multi Highlight 数据流文档

## 总体数据流概览

```mermaid
flowchart TB
    subgraph User["👤 用户"]
        Input["在 Popup 输入关键词"]
        ContextClick["右键选中文本"]
        OptionChange["修改设置"]
    end

    subgraph Popup["Popup UI (popup.js)"]
        TextArea["textarea#highlightWords"]
        Parser["关键词解析器"]
        KwTags["关键词标签列表"]
        Settings["设置控件"]
    end

    subgraph Background["Service Worker (background.js)"]
        StorageRW["chrome.storage.local 读写"]
        ContextMenu["右键菜单管理"]
        Badge["Badge 状态"]
        TabLifecycle["标签页生命周期"]
    end

    subgraph ContentScript["Content Script (content-action.js)"]
        Observer["MutationObserver"]
        Highlight["高亮引擎"]
        jQueryHL["jQuery Highlight 插件"]
    end

    subgraph Page["目标网页 DOM"]
        Body["document.body"]
        Highlighted["<span class='...'> 高亮文本"]
    end

    subgraph Storage["chrome.storage.local"]
        SettingsData["settings"]
        PopupCfgData["popupConfig"]
        TabData["multi-highlight_{tabId}"]
    end

    Input --> TextArea
    TextArea --> Parser
    Parser -->|"keywordsFromStr()"| KwTags
    Parser -->|"Keyword[]"| ContentScript

    ContextClick --> ContextMenu
    ContextMenu -->|"addKw/removeKw"| StorageRW
    ContextMenu -->|"_hl_search/_hl_clear"| ContentScript

    OptionChange --> Settings
    Settings -->|"chrome.runtime.sendMessage"| Background
    Settings -->|"chrome.tabs.sendMessage"| ContentScript

    Background --> Storage
    Background <--> Storage

    ContentScript -->|"chrome.runtime.sendMessage"| Background
    ContentScript --> jQueryHL
    jQueryHL -->|"$(body).highlight()"| Page
    Observer -->|"DOM 变化"| ContentScript
    ContentScript --> Body

    Storage -->|"读取"| Popup
    Storage -->|"读取"| Background
```

---

## 1. 关键词高亮完整流程

```mermaid
sequenceDiagram
    actor User
    participant Popup as Popup UI
    participant BG as Service Worker
    participant CS as Content Script
    participant DOM as 网页 DOM
    participant Storage as chrome.storage.local

    Note over User,Storage: === 关键词添加 ===

    User->>Popup: 在 textarea 输入关键词
    Popup->>Popup: inactivity 检测 (300ms 无输入)
    Popup->>Popup: keywordsFromStr(inputStr)<br/>解析为 Keyword[]

    Popup->>Storage: 读取 savedKws (现有关键词)
    Storage-->>Popup: savedKws

    Popup->>Popup: addedKws = KeywordsMinus(inputKws, savedKws)<br/>removedKws = KeywordsMinus(savedKws, inputKws)

    alt instant 模式
        Popup->>CS: chrome.tabs.sendMessage<br/>{action: "_hl_clear", removedKws}
        CS->>CS: observer.disconnect()
        CS->>CS: $(body).unhighlight() for each removedKw
        CS->>CS: observer.observe()
        CS-->>Popup: 回调

        Popup->>CS: chrome.tabs.sendMessage<br/>{action: "_hl_search", addedKws}
        CS->>CS: observer.disconnect()
        CS->>CS: $(body).highlight(kwStr, {className, ...}) for each addedKw
        CS->>CS: observer.observe()
    else refresh 模式
        Popup->>CS: chrome.tabs.sendMessage<br/>{action: "hl_refresh", inputKws}
        CS->>CS: hl_clearall() → hl_search()
    end

    Popup->>Storage: 更新 settings.latest_keywords<br/>更新 tabinfo.keywords
    Popup->>Popup: build_keywords_list() 更新 UI 标签

    Note over User,Storage: === DOM 自动重高亮 ===

    DOM->>CS: MutationObserver 触发 (DOM 变化)
    CS->>Storage: 读取 settings.isAlwaysSearch
    alt isAlwaysSearch == true
        CS->>Storage: 读取 tabinfo.keywords
        Storage-->>CS: keywords
        CS->>CS: hl_refresh(keywords) 重建所有高亮
    end
```

---

## 2. 右键菜单添/删关键词流程

```mermaid
sequenceDiagram
    actor User
    participant Browser as Chrome Browser
    participant BG as Service Worker
    participant CS as Content Script
    participant Storage as chrome.storage.local

    User->>Browser: 选中文本 → 右键 → "Add Keyword"
    Browser->>BG: contextMenus.onClicked<br/>{menuItemId: "addKw", selectionText}

    BG->>BG: kw = selectionText.toLowerCase().split(' ')[0]
    BG->>Storage: 读取 settings + tabinfo

    alt isNewlineNewColor
        BG->>BG: addedKw = {kwGrp: 0, kwStr: kw}
        BG->>BG: tabinfo.keywords.unshift(addedKw)
    else 按关键词轮转颜色
        BG->>BG: addedKw = {kwGrp: tabinfo.keywords.length % 20, kwStr: kw}
        BG->>BG: tabinfo.keywords.push(addedKw)
    end

    BG->>CS: chrome.tabs.sendMessage<br/>{action: "_hl_search", addedKws: [addedKw]}
    CS->>CS: 执行高亮

    BG->>Storage: 更新 settings + tabinfo

    Note over User,Storage: === 移除关键词 ===

    User->>Browser: 选中文本 → 右键 → "Remove Keyword"
    Browser->>BG: contextMenus.onClicked<br/>{menuItemId: "removeKw", selectionText}

    BG->>Storage: 读取 settings + tabinfo
    BG->>BG: 查找 keywords 中匹配的 kw
    alt 找到匹配
        BG->>CS: chrome.tabs.sendMessage<br/>{action: "_hl_clear", removedKws: [kw]}
        CS->>CS: 移除高亮
        BG->>BG: tabinfo.keywords.splice(pos, 1)
        BG->>Storage: 更新 settings + tabinfo
    else 未找到
        BG->>BG: 忽略（无操作）
    end
```

---

## 3. 标签页生命周期管理

```mermaid
sequenceDiagram
    participant Browser as Chrome Browser
    participant BG as Service Worker
    participant Storage as chrome.storage.local

    Note over Browser,Storage: === 新标签页加载 ===

    Browser->>BG: tabs.onUpdated<br/>(status === 'complete')
    BG->>Storage: 读取 settings

    alt isSaveKws == true
        BG->>BG: tabinfo.keywords = settings.latest_keywords
    else isSaveKws == false
        BG->>BG: tabinfo.keywords = []
    end

    BG->>Storage: chrome.storage.local.set<br/>{[tabkey]: tabinfo}
    BG->>BG: set_badge('normal')

    Note over Browser,Storage: === 标签页切换 ===

    Browser->>BG: tabs.onActivated
    BG->>Storage: 读取 tabinfo[tabkey]

    alt tabinfo 存在
        BG->>BG: set_badge('normal') → 清除 Badge
    else tabinfo 不存在 (extension 对该标签页未生效)
        BG->>BG: set_badge('error') → 显示红色 "!"
    end
```

---

## 4. Popup 设置变更流程

```mermaid
sequenceDiagram
    actor User
    participant Popup as Popup UI
    participant BG as Service Worker
    participant CS as Content Script
    participant Storage as chrome.storage.local

    User->>Popup: 切换设置 (如 Match Case)

    Popup->>Popup: 读取所有设置控件当前值

    Popup->>Popup: forceRefresh = (isWholeWord 变化)<br/>|| (isCasesensitive 变化)<br/>|| (isNewlineNewColor 变化)<br/>|| (toggleMHL 切换)

    Popup->>Storage: chrome.storage.local.set({settings})

    alt toggleMHL 关闭
        Popup->>CS: {action: "hl_clearall"}
        CS->>CS: 清除所有高亮
    else forceRefresh 且已开启
        Popup->>CS: {action: "hl_refresh", inputKws}
        CS->>CS: 重建所有高亮
    end

    Note over User,Storage: === isSaveKws 联动 ===

    alt isSaveKws 开启
        Popup->>Popup: 启用 alwaysSearch 复选框
    else isSaveKws 关闭
        Popup->>Popup: alwaysSearch = false (强制取消)
        Popup->>Popup: 禁用 alwaysSearch 复选框
    end
```

---

## 5. Popup 关闭时刷新流程

```mermaid
sequenceDiagram
    participant Popup as Popup UI
    participant BG as Service Worker
    participant CS as Content Script

    Popup->>BG: chrome.runtime.connect<br/>({name: "popup_{tabId}"})

    Note over Popup,BG: 用户关闭 Popup

    Popup->>BG: port.onDisconnect 触发
    BG->>BG: tabId = parseInt(port.name.substring(6))

    BG->>BG: 读取 settings.isOn

    alt isOn == true
        BG->>CS: chrome.tabs.sendMessage<br/>{action: "hl_refresh_existing"}
        CS->>CS: 使用 tabinfo.keywords 重建高亮
    end
```

---

## 6. 选项页配置变更流程

```mermaid
sequenceDiagram
    actor User
    participant Options as Options Page
    participant BG as Service Worker
    participant Storage as chrome.storage.local

    User->>Options: 修改 Popup 高度/宽度

    Options->>BG: chrome.runtime.sendMessage<br/>{action: "handle_popupSize_change", newHeight, newWidth}

    BG->>Storage: 读取 popupConfig

    alt newHeight 有值
        BG->>BG: popupConfig.popup_height = newHeight
    end
    alt newWidth 有值
        BG->>BG: popupConfig.popup_width = newWidth
    end

    BG->>Storage: chrome.storage.local.set({popupConfig})

    Note over User,Storage: === 右键菜单开关 ===

    User->>Options: 切换 "Add Keyword" 右键菜单

    Options->>BG: chrome.runtime.sendMessage<br/>{action: "handle_addKw_change", enableIt}

    alt enableIt == true
        BG->>BG: chrome.contextMenus.create({id: "addKw", ...})
        BG->>BG: settings.enableAddKw = true
    else enableIt == false
        BG->>BG: chrome.contextMenus.remove("addKw")
        BG->>BG: settings.enableAddKw = false
    end

    BG->>Storage: chrome.storage.local.set({settings})
```

---

## 7. 关键词可用性检查流程

```mermaid
sequenceDiagram
    participant Popup as Popup UI
    participant BG as Service Worker
    participant CS as Content Script
    participant Page as 目标网页
    participant Injected as getPagesSource.js

    Popup->>BG: chrome.scripting.executeScript<br/>({files: ["getPagesSource.js"]})

    alt 注入成功
        BG->>Page: 注入 getPagesSource.js
        Page->>Injected: 执行脚本
        Injected->>Injected: visibleText = document.body.innerText
        Injected->>Popup: chrome.runtime.sendMessage<br/>{action: "getVisibleText", source: visibleText}
        Popup->>Popup: 遍历 #kw-list > .keywords 标签
        loop 每个关键词
            Popup->>Popup: pattern = isWholeWord<br/>? '\b(' + kw + ')\b'<br/>: '(' + kw + ')'
            Popup->>Popup: new RegExp(pattern, isCasesensitive ? '' : 'i')
            alt visibleText.match(pattern)
                Popup->>Popup: elem 保留彩色边框
            else 未匹配
                Popup->>Popup: elem.classList.add("notAvailable") → 灰色边框
            end
        end
    else 注入失败 (如 chrome:// 或 Web Store 页面)
        Popup->>Popup: textarea 禁用<br/>显示 "[ Disabled ]" 提示
        Popup->>Popup: Badge 显示红色 "!"
    end
```

---

## 8. 数据存储结构

```mermaid
erDiagram
    SETTINGS {
        number CSS_COLORS_COUNT "20"
        string CSSprefix1 "chrome-extension-FindManyStrings"
        string CSSprefix2 "chrome-extension-FindManyStrings-style-"
        string CSSprefix3 "CE-FMS-"
        string delim "分隔符"
        boolean isAlwaysSearch "自动重新高亮"
        boolean isOn "扩展开关"
        boolean isCasesensitive "区分大小写"
        boolean isInstant "即时搜索"
        boolean isNewlineNewColor "换行切换颜色"
        boolean isSaveKws "保留关键词"
        boolean isWholeWord "全词匹配"
        array latest_keywords "最新关键词列表"
        string element "DOM 标签名 (mh)"
        boolean enableAddKw "启用右键添加"
        boolean enableRemoveKw "启用右键移除"
    }

    POPUP_CONFIG {
        number popup_width "Popup 宽度 (400-760)"
        number popup_height "文本域高度 (40-500)"
    }

    TAB_INFO {
        number id "标签页 ID"
        array keywords "关键词列表"
    }

    SETTINGS ||--o| POPUP_CONFIG : "全局配置"
    SETTINGS ||--o{ TAB_INFO : "latest_keywords 同步"
```

---

## 9. 关键词数据结构转换

```
输入文本 (textarea.value)
    │
    ▼
keywordsFromStr(str, settings)
    │
    ├── isNewlineNewColor == true
    │   │ 按 "\n" 分行 → 每行内按 delim 分隔
    │   │ kwGrp = lineIndex % 20 (同行的关键词同色)
    │   └── [{kwGrp: 0, kwStr: "hello"}, {kwGrp: 0, kwStr: "world"}, ...]
    │
    └── isNewlineNewColor == false
        │ 按 delim 分隔
        │ kwGrp = index % 20 (每个关键词不同色轮转)
        └── [{kwGrp: 0, kwStr: "hello"}, {kwGrp: 1, kwStr: "world"}, ...]

Keyword[] → 文本:
    │
    ▼
keywordsToStr(kws, settings)
    │
    ├── isNewlineNewColor == true
    │   │ 同 kwGrp 用 delim 连接，不同 kwGrp 用 "\n" 分隔
    │   └── "hello,world\nfoo"
    │
    └── isNewlineNewColor == false
        │ 按顺序用 delim 连接，末尾追加 delim
        └── "hello,world,"
```

---

## 10. 扩展安装/更新初始化流程

```mermaid
sequenceDiagram
    participant Browser as Chrome Browser
    participant BG as Service Worker
    participant Storage as chrome.storage.local

    Browser->>BG: runtime.onInstalled

    alt reason == "install" (首次安装)
        BG->>BG: 创建 Settings 默认值 (20 色, delim=",", isOn=true, ...)
        BG->>BG: 创建 PopupConfig 默认值 (400x100)
        BG->>BG: chrome.contextMenus.create("addKw")
        BG->>BG: chrome.contextMenus.create("removeKw")
        BG->>Storage: chrome.storage.local.set({settings, popupConfig})
    else reason == "update" (扩展更新)
        BG->>Storage: 读取现有 settings + popupConfig
        Storage-->>BG: settings, popupConfig
        BG->>BG: 根据 settings 重建右键菜单
        BG->>BG: 根据 popupConfig 同步尺寸
    end
```
