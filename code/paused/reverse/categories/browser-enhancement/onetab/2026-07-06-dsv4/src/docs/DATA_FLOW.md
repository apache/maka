# OneTab v2.18 — 数据流文档 (DATA_FLOW)

## 一、核心数据流概览

```mermaid
flowchart TD
    User[用户操作] --> Action{操作类型}
    Action -->|发送标签页| SendFlow[存储流程]
    Action -->|恢复标签页| RestoreFlow[恢复流程]
    Action -->|拖拽重组| MoveFlow[移动流程]
    Action -->|分享| ShareFlow[分享流程]
    Action -->|导入/导出| ImportExportFlow[导入导出流程]

    SendFlow --> CloseTabs[关闭原始标签页]
    SendFlow --> SaveToStorage[写入 chrome.storage.local]
    SendFlow --> Broadcast[广播 stateChange]

    RestoreFlow --> ReadStorage[读取 chrome.storage.local]
    RestoreFlow --> CreateTabs[创建/恢复标签页]
    RestoreFlow --> UpdateStorage[更新存储]
    RestoreFlow --> Broadcast

    MoveFlow --> UpdateTree[更新 childIds/parentIds]
    MoveFlow --> SaveToStorage
    MoveFlow --> Broadcast

    ShareFlow --> Fetch[fetch → one-tab.com]
    ShareFlow --> UpdateStorage[标记 shared=true]
    ShareFlow --> Broadcast

    ImportExportFlow --> Parse[解析 HTML/JSON/纯文本]
    ImportExportFlow --> SaveToStorage
    ImportExportFlow --> Broadcast
```

## 二、存储标签页流程（Send Tabs to OneTab）

这是最核心的流程。支持多种触发方式：工具栏图标点击、右键菜单、键盘快捷键、地址栏 `11` 关键词。

```mermaid
sequenceDiagram
    actor User
    participant Popup as Popup UI
    participant BG as Service Worker
    participant Storage as chrome.storage.local
    participant TabsAPI as chrome.tabs

    User->>Popup: 点击 OneTab 图标
    Popup->>BG: sendTabsInWindow({windowId})
    BG->>TabsAPI: tabs.query({windowId, pinned:false})
    TabsAPI-->>BG: Tab[]

    loop 每个标签页
        BG->>BG: 提取 url, title, favicon
        BG->>BG: 检查重复（按 URL 哈希）
        BG->>BG: 检查排除域名
    end

    BG->>BG: 创建 tabGroup/windowGroup
    BG->>Storage: storage.local.set({items, root, ...})
    Storage-->>BG: OK

    loop 每个标签页
        BG->>TabsAPI: tabs.remove(tabId)
    end

    BG->>Popup: message: stateChange
    Popup->>Popup: 更新列表 UI
```

### 2.1 URL 规范化

存储前对 URL 进行规范化处理：
- 去除 `about:reader?url=` 前缀，提取原始 URL
- 统一 `http://` → `https://`
- 截断 `www.` 前缀用于域名匹配
- 对 Google Docs 特殊域名（sheets/document/presentation/forms/drawings）做分类标记

### 2.2 Favicon 获取

使用 `chrome.favicon` 权限获取 favicon，通过 `Image` 对象加载后转为 base64 PNG data URL（32x32 canvas 绘制）。

## 三、恢复标签页流程（Restore Tabs）

```mermaid
sequenceDiagram
    actor User
    participant UI as onetab.html
    participant BG as Service Worker
    participant Storage as chrome.storage.local
    participant TabsAPI as chrome.tabs

    User->>UI: 点击恢复按钮
    UI->>BG: restoreItems([itemId])
    BG->>Storage: storage.local.get([itemId])
    Storage-->>BG: TabItem | GroupItem

    alt 单个 Tab
        BG->>TabsAPI: tabs.create({url, active})
    else Window Group
        BG->>TabsAPI: tabs.create 多个标签页
        BG->>TabsAPI: tabs.group({tabIds})
    else Tab Group
        BG->>TabsAPI: tabs.create 多个标签页
        BG->>TabsAPI: tabs.group({tabIds, color})
    end

    alt autoActionOnOpen = "trash"
        BG->>Storage: 将 item 移入 trash
    else autoActionOnOpen = "none"
        BG->>Storage: 保留 item
    end

    BG->>UI: stateChange broadcast
```

### 3.1 恢复策略

- **单个 Tab**: `chrome.tabs.create({url})`
- **Window Group**: 在新窗口（或当前窗口）中批量创建标签页
- **Tab Group**: 创建标签页后调用 `chrome.tabs.group({tabIds, groupId})` 分组
- **Folder 中的 Tab**: 展平所有子文件夹，收集所有 Tab 后统一恢复

### 3.2 恢复后行为

- 可配置自动移至回收站（`autoActionOnOpen: "trash"`）
- 可配置丢弃非活跃标签页（`discardNonActiveTabOnOpen: true`）
- 可配置切换到新打开的标签页（`switchToOpenedTab: true`）

## 四、拖拽重组流程（Move / Reorganize）

```mermaid
sequenceDiagram
    actor User
    participant UI as onetab.html
    participant BG as Service Worker
    participant Storage as chrome.storage.local

    User->>UI: 拖拽 item 到目标位置
    UI->>BG: move({dt: [{itemId, sourceParentId}], G: targetId, _: index})

    BG->>BG: 验证移动合法性
    Note over BG: - 不能将 folder 移入 tabGroup<br/>- 不能将 tabGroup 移入 tabGroup<br/>- 不能将 tab 和 group 混合拖拽

    BG->>Storage: 更新 childIds/parentIds
    BG->>BG: 处理级联（如将 folder 展开为 tabs）
    BG->>Storage: 批量更新
    BG->>UI: stateChange broadcast
```

### 4.1 智能移动规则

代码中包含复杂的"智能移动"逻辑（`_n` 函数），处理以下场景：
- Tab 移入 Folder —— 直接添加
- Tab 移入 TabGroup —— 保持 tab/group 类型一致
- Folder 移入 Folder —— 嵌套分组
- Window 组展开为 Tab 移入 TabGroup —— 需要先展平
- Tab 移入 trash —— 标记删除

### 4.2 拖放目标验证

移动操作会验证：
1. 源和目标类型是否兼容
2. 是否会导致循环引用（folder 不能移入自己的子节点）
3. 混合类型拖拽时自动分离

## 五、分享与云同步流程

```mermaid
sequenceDiagram
    actor User
    participant UI as onetab.html
    participant BG as Service Worker
    participant Server as one-tab.com

    User->>UI: 点击分享
    UI->>BG: share({itemId})
    BG->>BG: 序列化 item + 子元素 → JSON
    BG->>Server: POST /page/create (JSON body)
    Server-->>BG: {pageId, shareUrl}
    BG->>Storage: 更新 item.shared = true
    BG->>UI: stateChange + shareUrl
    UI->>User: 显示分享链接
```

### 5.1 分享内容

- 默认 30 天过期
- 可配置包含笔记和评分
- 使用 `crypto.getRandomValues` 生成 22 字符 base64url ID
- URL 格式: `https://www.one-tab.com/page/{pageId}`

### 5.2 同步机制

- 在线时自动同步未提交的变更（`uncommittedChangesStore`）
- 离线时变更排队，联网后自动推送
- 定期清理 14 天前的未提交变更记录
- 版本不匹配时通过 `corePing()` 检测并要求重载

## 六、导入导出流程

### 6.1 导入支持格式

1. **OneTab 自有格式** — 通过解析 HTML `<a>` 标签列表
2. **纯文本 URL 列表** — 每行一个 URL，支持 `URL | Title` 格式
3. **Chrome 书签** — 通过 `chrome.bookmarks.getTree()`（需要 optional 权限）
4. **Chrome 阅读列表** — 通过 `chrome.readingList.query()`（需要 optional 权限）

### 6.2 导入解析策略

代码中实现了三级解析策略：
1. 尝试从 `<a>` 标签提取链接（最可靠）
2. 尝试每行 `URL | Title` 格式正则匹配
3. 尝试从纯文本段落提取 URL 正则匹配

### 6.3 导出格式

- **Rich Text** — 带链接和样式的 HTML（默认，用于粘贴到 Word/Google Docs）
- **Plain Text** — `URL | Title` 格式的纯文本列表
- 使用 `navigator.clipboard.write` 写入剪贴板

## 七、State Change 广播机制

```mermaid
sequenceDiagram
    participant BG as Service Worker
    participant Page1 as onetab.html
    participant Page2 as popup.html
    participant Page3 as options.html

    BG->>BG: 数据变更完成
    BG->>Page1: runtime.sendMessage({type:"stateChange", s0:diff})
    BG->>Page2: runtime.sendMessage({type:"stateChange", s0:diff})
    BG->>Page3: runtime.sendMessage({type:"stateChange", s0:diff})

    Page1->>Page1: 对比 diff，局部更新 UI
    Page2->>Page2: 对比 diff，局部更新 UI
```

各页面注册 `stateChange` 监听器，收到广播后进行增量 UI 更新，避免了轮询和全量刷新。

## 八、内容脚本通信

### 8.1 页面注入 Content Script

通过 `chrome.scripting.registerContentScripts` 动态注册内容脚本到用户页面，用于：
- 监听键盘快捷键（在非扩展页面中）
- 通过 `runtime.onMessage` 接收 `getLinks` 命令，提取当前页面 `<a>` 标签链接列表

### 8.2 one-tab.com Content Script

注入到 `https://www.one-tab.com/*` 的页面，用于：
- 检测用户是否在查看分享页面
- 提供"添加到我的 OneTab"按钮的交互
