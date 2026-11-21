# ContextSearch web-ext 数据流文档

> 基于 v1.48.4.13 源码逆向分析

## 一、总览

ContextSearch web-ext 的数据流围绕三个核心实体展开：
1. **userOptions** - 用户配置（存储于 `storage.local`）
2. **quickMenuObject** - 快捷菜单运行时状态（存储于页面全局变量）
3. **tabTerms / searchTerms** - 搜索词与标签页追踪（存储于 Service Worker 全局变量）

```mermaid
graph TD
    subgraph "浏览器存储"
        SL[storage.local<br/>userOptions]
        SS[storage.session<br/>lastSearch / clipboard]
    end

    subgraph "Service Worker (background.js)"
        UO[userOptions 对象]
        TT[tabTerms 数组]
        ST[self.searchTerms]
        HM[notify 消息路由器]
    end

    subgraph "选项页 (options.html)"
        OUI[搜索引擎管理器]
        OC[选项控件]
    end

    subgraph "页面注入 (content scripts)"
        QMO[quickMenuObject]
        INJ[inject.js]
        SH[Shadow DOM]
    end

    subgraph "弹出面板 (iframe)"
        QM[QuickMenu]
        SB[SearchBar]
        FB[FindBar]
        SD[Sidebar]
    end

    SL <-->|"读写 userOptions"| UO
    SS <-->|"session 读写"| HM
    UO -->|"推送更新"| INJ
    INJ -->|"选中/鼠标事件"| QMO
    QMO -->|"sendMessage"| QM
    QMO -->|"sendMessage"| SB
    QM -->|"search 消息"| HM
    SB -->|"search 消息"| HM
    HM -->|"openSearch"| TT
    HM -->|"saveUserOptions"| SL
    OUI -->|"saveUserOptions"| HM
    OC -->|"直接写"| SL
```

## 二、初始化流

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant CS as Content Script
    participant P as Web Page
    participant IF as Iframe (QM/SB)

    Note over SW: 扩展安装/启动
    SW->>SW: importScripts (批量加载模块)
    SW->>SW: loadUserOptions() from storage.local
    SW->>SW: updateUserOptionsVersion (迁移)
    SW->>SW: buildContextMenu()
    SW->>SW: registerAllUserScripts()
    SW->>SW: setIcon()

    Note over CS,P: 用户打开网页
    CS->>CS: init_content.js 检测协议
    alt top frame
        CS->>SW: sendMessage "injectContentScripts"
    else iframe
        CS->>CS: 监听 mousedown (延迟注入)
        P->>CS: mousedown 事件
        CS->>SW: sendMessage "injectContentScripts"
    end

    SW->>SW: injectContentScripts(tab)
    SW->>CS: executeScript inject.js, contexts.js, tools.js...
    CS->>CS: 创建 Shadow Root
    CS->>CS: 设置 quickMenuObject
    CS->>SW: sendMessage "injectComplete"

    SW->>CS: executeScript inject_quickmenu.js (条件)
    SW->>CS: executeScript inject_sidebar.js (条件)
```

## 三、右键菜单搜索流

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant CM as contextMenu.js
    participant PAGE as Web Page
    participant INJ as inject.js

    Note over PAGE: 用户选中文本 → 右键
    PAGE->>INJ: selectionchange 事件
    INJ->>INJ: 更新 quickMenuObject.searchTerms
    INJ->>SW: sendMessage "updateSearchTerms"
    SW->>SW: 更新 self.searchTerms
    SW->>CM: updateContextMenu(searchTerms)
    CM->>CM: 按上下文过滤节点树
    CM->>CM: 更新菜单标签/可见性
    CM->>CM: updateMatchRegexFolders

    Note over PAGE: 用户点击菜单项
    browser->>CM: contextMenus.onClicked
    CM->>CM: contextMenuSearch(info, tab)
    CM->>CM: 解析 menuItemId（去前缀、去后缀计数）
    CM->>CM: 判断 modifier key → get openMethod
    CM->>INJ: executeScript 获取 selectionText
    CM->>CM: 按 context 类型确定 searchTerms
    CM->>SW: openSearch(info)
    SW->>SW: 模板替换 → 构建 URL
    SW->>SW: openWithMethod → 打开标签页
    SW->>SW: addTabTerms (追踪)
    SW->>SW: 监听 tab onUpdated → highlightSearchTermsInTab
```

## 四、Quick Menu 搜索流

```mermaid
sequenceDiagram
    participant PAGE as Web Page
    participant INJ as inject.js
    participant QM as QuickMenu Iframe
    participant SW as Service Worker

    Note over PAGE: 用户选中文本 → 自动/手动触发 QM
    INJ->>INJ: 检测触发条件 (mouseup/keydown/selection)
    INJ->>INJ: 计算 QM 位置
    INJ->>INJ: 创建/显示 QuickMenu iframe
    INJ->>QM: postMessage / sendMessage (位置、搜索词)

    Note over QM: iframe 加载
    QM->>SW: sendMessage "getUserOptions"
    SW->>QM: userOptions (含 nodeTree)
    QM->>QM: 渲染瓦片菜单 (tilemenu.js)
    QM->>QM: 上下文过滤 (contexts.js filterContexts)

    Note over QM: 用户点击引擎瓦片
    QM->>QM: 判断 modifier → openMethod
    QM->>SW: sendMessage "quickMenuSearch" {info}
    SW->>SW: openSearch(info) → openWithMethod
    SW->>PAGE: 打开搜索结果标签页

    Note over QM: 用户切换文件夹
    QM->>QM: 更新 node.parent → 重新渲染
    QM->>INJ: sendMessage "updateQuickMenuObject"
```

## 五、用户选项持久化流

```mermaid
sequenceDiagram
    participant OPT as Options Page
    participant SW as Service Worker
    participant SL as storage.local
    participant TABS as All Open Tabs

    OPT->>OPT: 用户修改任意选项
    OPT->>OPT: 标记 changed
    OPT->>OPT: saveOptions()
    OPT->>SL: browser.storage.local.set({userOptions})

    Note over OPT: 或者通过消息代理
    OPT->>SW: sendMessage "saveUserOptions"
    SW->>SL: browser.storage.local.set({userOptions})
    SW->>SW: 更新内存 userOptions
    SW->>SW: debounce() → "updateUserOptions"
    SW->>TABS: broadcast userOptions to all tabs
    TABS->>TABS: inject.js 更新本地 userOptions
    SW->>SW: buildContextMenu() (重建)
    SW->>SW: updateUserScripts() (延迟 debounce 2s)
```

## 六、高亮/查找流

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant TAB as Target Tab
    participant FB as FindBar Iframe

    Note over SW: 搜索完成后
    SW->>SW: highlightSearchTermsInTab(tab, terms)
    SW->>SW: waitOnInjection(tab.id)
    SW->>SW: highlightInjectScripts(tab)
    SW->>TAB: executeScript mark.js + inject_highlight.js
    SW->>TAB: dispatchEvent "CS_markEvent" {searchTerms}
    TAB->>TAB: mark.js 高亮页面关键词

    Note over TAB: 用户打开查找栏
    TAB->>SW: sendMessage "openFindBar"
    SW->>FB: 创建/显示 FindBar iframe
    SW->>TAB: 注入 inject_highlight.js

    Note over FB: 用户在查找栏输入
    FB->>SW: sendMessage "mark"
    SW->>TAB: 广播 mark 事件到所有 frame
    TAB->>TAB: 重新执行高亮

    Note over FB: 导航 (上一个/下一个)
    FB->>SW: sendMessage "findBarNext"
    SW->>TAB: sendMessage "findBarNext" (to top frame)
    TAB->>TAB: mark.js 跳转到下一个匹配
```

## 七、搜索引擎添加流

```mermaid
sequenceDiagram
    participant PAGE as Web Page
    participant INJ as inject_addContextSearchEngine.js
    participant SW as Service Worker
    participant SL as storage.local

    Note over PAGE: 用户在输入框右键 → Add Custom Search
    PAGE->>SW: contextMenus.onClicked "add_engine"
    SW->>PAGE: sendMessage "openCustomSearch"
    PAGE->>INJ: 弹出搜索引擎编辑 iframe

    Note over INJ: 用户填入搜索 URL 参数
    INJ->>INJ: dataToSearchEngine(formdata)
    INJ->>SW: sendMessage "addContextSearchEngine" {searchEngine}
    SW->>SW: 检查 nameExists
    SW->>SW: gen() 生成 ID
    SW->>SW: 插入到 nodeTree
    SW->>SL: saveUserOptions
    SW->>SW: buildContextMenu() 重建菜单
```

## 八、外部程序调用流

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant NM as Native Messaging Host
    participant TAB as Target Tab

    Note over SW: 用户通过右键/快捷菜单触发
    SW->>SW: executeExternalProgram(info)
    SW->>SW: replaceOpenSearchParams (模板处理)
    SW->>SW: 检测 {prompt} → promptCurrentTab
    SW->>SW: 检测 {download_url} → browserSaveAs
    SW->>SW: 检查 nativeMessaging 权限
    SW->>NM: runtime.sendNativeMessage("contextsearch_webext", msg)
    NM->>NM: 执行外部程序
    NM->>SW: 返回 stdout
    SW->>SW: 执行 postScript (可选)
    SW->>TAB: executeUserScript (postScript)
```

## 九、全局状态管理

| 变量 | 位置 | 说明 |
|------|------|------|
| `self.userOptions` | Service Worker | 用户配置完整对象 (内存缓存) |
| `self.searchTerms` | Service Worker | 当前选中文本 |
| `self.searchTermsObject` | Service Worker | 按上下文分类的选中文本 `{selection, link, image...}` |
| `self.tabTerms` | Service Worker | 标签页搜索词追踪数组 `[{id, tabId, searchTerms}]` |
| `self.popupWindows` | Service Worker | 弹出窗口 ID 列表 |
| `self.contextMenuMatchRegexMenus` | Service Worker | 正则匹配菜单项 ID 列表 (用于更新/删除) |
| `self.ctrlKey` | Service Worker | 右键菜单弹出时 Ctrl 键状态 |
| `quickMenuObject` (window) | Content Script | 快捷菜单运行时状态 |
| `userOptions` (window) | Content Script | 页面注入层的用户配置缓存 |
| `killswitch` (window) | Content Script | 全局开关，禁用注入功能 |
