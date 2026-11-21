# Lumno - 数据流文档

> 版本: 0.9.14 | 描述扩展内部主要数据流程

## 一、覆盖层搜索数据流

```mermaid
sequenceDiagram
    actor User
    participant CS as Content Script<br/>(hotkey-listener)
    participant BG as Service Worker<br/>(background.js)
    participant OL as Overlay<br/>(注入到页面)
    participant API as Chrome APIs<br/>(history/bookmarks/tabs)

    Note over User,API: Ctrl+Shift+K 触发覆盖层

    User->>CS: 按下 Ctrl+Shift+K
    CS->>CS: 检查非可编辑元素
    CS->>CS: 去重检查 (去抖 180ms)
    CS->>BG: runtime.sendMessage({ action: 'triggerShowSearchFromPageHotkey' })
    BG->>BG: 检查活动标签 URL 是否允许
    BG->>BG: 去重检查 (去抖 180ms)
    BG->>OL: scripting.executeScript() 注入覆盖层
    OL->>OL: shadow DOM 创建 shell
    OL->>OL: 加载 Open Sans + Remix Icon
    OL->>OL: fetch locale messages
    OL->>OL: 动画入场
    OL-->>User: 显示搜索面板

    Note over User,API: 用户输入搜索词

    User->>OL: 输入 "github"
    OL->>OL: 拼音标准化 (pinyin-pro)
    OL->>BG: 请求搜索建议
    BG->>API: chrome.history.search()
    BG->>API: chrome.bookmarks.search()
    BG->>API: chrome.topSites.get()
    BG->>BG: 搜索算法评分排序
    BG-->>OL: 返回建议列表
    OL->>OL: 渲染建议面板

    Note over User,API: 用户选择建议项

    User->>OL: 点击/回车选择
    OL->>OL: 记录搜索选择统计
    OL->>BG: tabs.update() / tabs.create()
    BG->>API: chrome.tabs API
    OL->>OL: 关闭覆盖层动画
```

## 二、标签页切换器数据流

```mermaid
sequenceDiagram
    actor User
    participant BG as Service Worker
    participant Tabs as Chrome Tabs API
    participant TB as Tab Tracker<br/>(recent-tab-switcher)
    participant Storage as chrome.storage

    Note over User,Storage: 标签切换事件追踪

    BG->>Tabs: tabs.query() 获取所有标签
    BG->>BG: syncTabSwitchStatsFromTabList()
    BG->>BG: 对比 lastAccessed 时间戳
    BG->>BG: 记录切换事件 (去抖 450ms)
    BG->>Storage: 持久化切换统计

    Note over User,Storage: Alt+Q 触发标签切换器

    User->>BG: 按下 Alt+Q
    BG->>BG: 获取最近标签列表
    BG->>BG: 排序（频次 × 8 + 日活 × 2.6 + 衰减新近度 × 3.2）
    BG->>BG: 检查是否需要捕获缩略图
    BG->>Tabs: tabs.captureVisibleTab() (JPEG Q42 320x200)
    BG->>TB: 存储缩略图 base64
    BG->>Storage: 定期持久化 (debounce 350ms)
    BG-->>User: 显示标签切换面板

    Note over User,Storage: 用户切换标签

    User->>BG: 选择目标标签
    BG->>BG: 隐藏切换器 UI (capture visibility)
    BG->>Tabs: tabs.update({ active: true })
    BG->>BG: 恢复可见性
    BG->>BG: 记录切换事件
```

## 三、新标签页数据流

```mermaid
sequenceDiagram
    actor User
    participant NT as New Tab Page<br/>(newtab.html+js)
    participant BG as Service Worker
    participant API as Chrome APIs
    participant Storage as chrome.storage

    Note over User,Storage: 新标签页打开

    User->>NT: 打开新标签页
    NT->>NT: wallpaper-preload.js 预加载壁纸
    NT->>NT: 初始化 CSS 变量 (主题色)
    NT->>Storage: 读取设置 (主题/壁纸/布局)
    NT->>NT: 渲染 Wordmark 入场动画

    Note over User,Storage: 数据加载

    NT->>BG: 请求书签数据
    BG->>API: chrome.bookmarks.getTree()
    BG-->>NT: 返回书签树
    NT->>NT: 展平书签树
    NT->>NT: 渲染书签网格 (级联菜单)

    NT->>BG: 请求常用网站
    BG->>API: chrome.topSites.get()
    BG-->>NT: 返回 top sites
    NT->>NT: 融入 pinned/hidden 状态
    NT->>NT: 渲染最近站点卡片

    Note over User,Storage: 搜索交互

    User->>NT: 在搜索框输入
    NT->>BG: 请求搜索建议
    BG->>API: history + bookmarks + topSites
    BG->>BG: 搜索算法评分
    BG-->>NT: 返回排序建议
    NT->>NT: 渲染建议面板 (毛玻璃效果)

    Note over User,Storage: 壁纸切换

    NT->>NT: 壁纸过渡层 (230ms opacity)
    NT->>NT: canvas 特效层渲染
    NT->>Storage: 保存壁纸选择
```

## 四、PiP 自动检测数据流

```mermaid
sequenceDiagram
    actor User
    participant Page as 网页视频页面
    participant CS as Content Script<br/>(site-auto-pip / youtube-auto-pip)
    participant BG as Service Worker
    participant PiP as PiP Ownership Manager

    Note over User,PiP: 视频播放检测

    Page->>CS: 视频元素开始播放
    CS->>CS: 检测视频尺寸/可见性
    CS->>BG: 请求 PiP 所有权
    BG->>PiP: requestGlobalPipOwnership()
    PiP->>PiP: 检查当前所有者
    PiP-->>BG: 授权/拒绝

    alt 获得所有权
        BG->>CS: 注入 PiP 脚本 (MAIN world)
        CS->>Page: 调用 video.requestPictureInPicture()
        Page-->>User: 显示 PiP 窗口
    else 被拒绝
        BG-->>CS: 拒绝理由
    end

    Note over User,PiP: 标签关闭时

    BG->>PiP: clearGlobalPipOwnerForTabId()
    PiP->>PiP: 清除所有权记录
```

## 五、设置同步数据流

```mermaid
sequenceDiagram
    actor User
    participant Options as Options Page
    participant Storage as chrome.storage.sync
    participant BG as Service Worker
    participant NT as New Tab / Overlay

    Note over User,NT: 用户修改设置

    User->>Options: 修改主题/布局等
    Options->>Storage: storage.sync.set({ key: value })

    Note over User,NT: 存储变更传播

    Storage-->>BG: storage.onChanged 事件
    BG->>BG: 更新内存缓存
    Storage-->>NT: storage.onChanged 事件
    NT->>NT: 重新渲染主题/壁纸
    Storage-->>Options: storage.onChanged 事件
    Options->>Options: 同步 UI 状态
```

## 六、固定标签恢复数据流

```mermaid
sequenceDiagram
    participant BG as Service Worker
    participant Tabs as Chrome Tabs API
    participant Storage as chrome.storage.local

    Note over BG,Storage: 运行时快照

    BG->>BG: 定期触发 (debounce 600ms)
    BG->>Tabs: tabs.query({ pinned: true })
    BG->>BG: 按窗口+序号排序
    BG->>BG: 过滤 incognito + 受限制 URL
    BG->>Storage: 保存快照 { urls, capturedAt }

    Note over BG,Storage: 浏览器启动恢复

    BG->>Storage: 读取快照
    BG->>Tabs: tabs.query() 当前标签
    BG->>BG: diff 计算缺失 tab
    BG->>Tabs: tabs.create({ url, pinned: true }) 逐个恢复
    BG->>BG: 获取最近焦点窗口 (windows.getLastFocused)
```

## 七、搜索算法核心流程

```mermaid
flowchart TD
    A[用户输入查询] --> B[buildSearchQueryContext]
    B --> C{URL 导航?}
    C -->|是| D[isDirectNavigationUrl]
    C -->|否| E[classifySearchIntent]
    E --> F{brand?}
    F -->|是| G[buildSearchBrandDirectSuggestion]
    F -->|否| H[collectSearchMatches]
    H --> I1[history.search]
    H --> I2[bookmarks.search]
    H --> I3[topSites.get]
    I1 & I2 & I3 --> J[mergeItemsByUrl]
    J --> K[calculateSearchRelevanceScore]
    K --> K1[textScore 文本匹配 +140]
    K --> K2[behaviorScore 行为 +20]
    K --> K3[sourceScore 来源 +12]
    K --> K4[categoryAdjustment 分类 +/-95]
    K --> K5[directNavigationAdjustment +/-36]
    K --> K6[selectionBoost 选择历史 +320]
    K1 & K2 & K3 & K4 & K5 & K6 --> L[compareSearchSuggestions]
    L --> M[applySearchSuggestionHostDiversity]
    M --> N[limitSearchSuggestionsForDisplay]
    N --> O[返回最终建议列表]
```

## 八、标签切换评分公式

```
score = (shortCount × 8) + (dayCount × 2.6) + (recencyBoost × 3.2)

其中:
  shortCount  = 近 30 分钟切换次数
  dayCount    = 近 24 小时切换次数
  recencyBoost = exp(-max(0, 距上次切换分钟数) / 16)

高频标记:
  highFreq = shortCount >= 2 || dayCount >= 5

最终排序 = score + accessBoost
  accessBoost = exp(-max(0, idleMinutes) / 30)
```
