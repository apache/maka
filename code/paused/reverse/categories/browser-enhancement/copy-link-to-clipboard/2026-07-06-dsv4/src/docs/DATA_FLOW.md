# DATA_FLOW.md -- 复制链接到剪贴板 v15.1.3

## 1. 整体数据流概览

```mermaid
flowchart TD
    A[用户操作] --> B{触发方式}
    B -->|右键菜单| C[contextMenus.onClicked]
    B -->|快捷键| D[commands.onCommand]
    B -->|弹出窗口| E[popup.html 按钮点击]
    B -->|工具栏图标| E

    C --> F[extractClickedData]
    D --> G[handleCmd]
    E --> H[menuOnClick]

    G -->|构造 info| F
    H -->|sendMessage EXEC_COPY| I[Service Worker]
    I -->|extractClickedData| F

    F --> J{menuItemId 前缀判断}
    J -->|copyPageURL| K[getContextInfo]
    J -->|copyLinkURL| L[getContextInfo]
    J -->|copyTabURL| M[直接使用 tab 信息]
    J -->|copyTabsURL| N[getSelectedTabsInfo]
    J -->|copyOtherTabsURL| O[getOtherTabsInfo]
    J -->|copyAllTabsURL| P[getAllTabsInfo]
    J -->|openOptions| Q[runtime.openOptionsPage]

    K --> R[createLinkText]
    L --> R
    M --> R
    N --> S[createTabsLinkText]
    O --> S
    P --> S

    R --> T[execCopy]
    S --> T

    T --> U[offscreen.createDocument]
    U --> V[runtime.sendMessage EXEC_COPY]
    V --> W[offscreen-main: execCopy]
    W --> X[Clip.copy]
    X --> Y[剪贴板写入]
    Y --> Z{notify?}
    Z -->|是| AA[notifyOnCopy]
    Z -->|否| AB[closeWindow]
    AA --> AB
```

## 2. 右键菜单复制流程 (核心流程)

```mermaid
sequenceDiagram
    participant U as 用户
    participant CM as contextMenus
    participant BG as background.js
    participant MN as main.js
    participant TB as browser.js
    participant CS as context-info.js
    participant FM as format.js
    participant EC as exec-copy.js
    participant OS as offscreen.html
    participant CP as clipboard.js

    U->>CM: 右键点击链接
    CM->>BG: menus.onClicked(info, tab)
    BG->>MN: extractClickedData(info, tab)

    Note over MN: 1. 检查 userOpts/enabledFormats 是否已加载
    MN->>TB: getAllStorage()
    TB-->>MN: user options
    MN->>MN: setUserOpts()
    MN->>MN: setFormatData() + setUserEnabledFormats()

    Note over MN: 2. 判断 menuItemId 类型
    alt COPY_LINK / COPY_PAGE
        MN->>TB: executeScriptToTab({files: ['/js/context-info.js']})
        TB->>CS: 注入内容脚本
        CS-->>TB: {canonicalUrl, content, isLink, title, url, selectionText}
        TB-->>MN: contextInfo
    else COPY_TAB
        Note over MN: 直接使用 tab.title, tab.url
    end

    Note over MN: 3. 获取格式模板
    MN->>FM: getFormatTemplate(formatId)
    FM-->>MN: template string

    Note over MN: 4. 确定 content/title/url
    MN->>MN: 根据 menuItemId/userOpts 选择 content 来源
    Note over MN: linkText/selectionText/tabTitle/canonicalUrl

    Note over MN: 5. URL 净化
    MN->>MN: sanitizeURL(url)

    Note over MN: 6. (可选) 编辑提示
    alt userOpts PROMPT = true
        MN->>OS: offscreen.createDocument → promptContent
        OS-->>MN: edited content
    end

    Note over MN: 7. 渲染模板
    MN->>FM: createLinkText(data)
    FM->>FM: 格式特定转义 (LaTeX/Markdown/HTML...)
    FM-->>MN: formatted text

    Note over MN: 8. 执行复制
    MN->>EC: execCopy({formatTitle, mimeType, text, notify})
    EC->>OS: offscreen.createDocument(CLIPBOARD)
    EC->>OS: runtime.sendMessage({executeCopy: opt})
    OS->>CP: new Clip(text, mimeType).copy()
    CP->>CP: clipboard.write() + clipboard.writeText()
    CP-->>OS: 完成

    opt userOpts NOTIFY_COPY = true
        OS->>BG: sendMessage({notifyOnCopy: formatTitle})
        BG->>TB: createNotification()
    end
    OS->>OS: window.close()
```

## 3. 弹出窗口流程

```mermaid
sequenceDiagram
    participant U as 用户
    participant PP as popup.html
    participant BG as Service Worker

    Note over PP: 启动时
    PP->>PP: localizeHtml() (i18n)
    PP->>PP: addListenerToMenu() (事件绑定)
    PP->>BG: sendMessage({getContextInfo: true})
    BG->>BG: getContextInfo(tabId)
    BG->>BG: executeScriptToTab → context-info.js
    BG-->>PP: {contextInfo: {...}}
    PP->>PP: updateMenu(data)
    Note over PP: 根据 isLink 显示/隐藏 copyLink 区域
    Note over PP: 填充 content/selectionText

    U->>PP: 点击格式按钮
    PP->>PP: createCopyData(evt)
    Note over PP: 读取输入框编辑后的文本
    PP->>BG: sendMessage({executeCopy: {info, tab}})
    BG->>BG: extractClickedData(info, tab)
    Note over BG: 后续流程与右键菜单相同
```

## 4. 存储变更同步流程

```mermaid
sequenceDiagram
    participant OP as options.html
    participant SS as chrome.storage
    participant SW as Service Worker
    participant PU as popup.html

    OP->>SS: setStorage({AsciiDoc: {checked: false}})
    SS->>SW: storage.onChanged
    SW->>SW: handleStorage(data, area, changed=true)
    SW->>SW: setStorageValue(key, value)
    SW->>SW: setUserEnabledFormats()
    SW->>SW: removeContextMenu() → createContextMenu()
    Note over SW: 右键菜单重建

    SW-->>PU: storage.onChanged (如 popup 打开)
    PU->>PU: handleStorage(data)
    PU->>PU: toggleMenuItem()
    Note over PU: 隐藏/显示未启用的格式按钮
```

## 5. 启动初始化流程

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant SS as chrome.storage
    participant FM as format.js
    participant MM as menu.js

    Note over SW: runtime.onInstalled / runtime.onStartup
    SW->>FM: setFormatData()
    Note over FM: 读取 16 个格式默认启用状态 → enabledFormats Set
    SW->>SS: getAllStorage()
    SS-->>SW: user prefs
    SW->>SW: handleStorage(data, area, false)
    Note over SW: 应用存储的启用状态覆盖默认值
    SW->>MM: removeContextMenu()
    SW->>MM: createContextMenu()
    Note over MM: 为 7 个 menuItemId × 启用的格式数 创建子菜单
```

## 6. 剪贴板数据流 (Clip 类内部)

```mermaid
flowchart TD
    A[Clip.copy] --> B{mimeType?}
    B -->|text/plain| C[navigator.clipboard.writeText]
    B -->|text/html etc| D{clipboard.write + ClipboardItem?}
    C -->|失败| E[document.execCommand('copy') fallback]
    D -->|支持| F[DOMParser 解析 → serializeDomString 重建 → Blob → ClipboardItem]
    D -->|不支持| E
    F -->|HTML| G[同时写入 text/html + text/plain 双 blob]
    F -->|其他| H[写入对应 MIME blob]
    F -->|失败| E
    G --> I[navigator.clipboard.write]
    H --> I

    E --> J[addEventListener('copy') → setData → execCommand('copy')]
```

## 7. Sanitize 委托链

Service Worker 无法访问 DOM, URL 净化和 HTML 属性净化均通过 offscreen document 委托执行:

```
main.js (SW)
  └→ sanitize.js: sanitizeURL(url, opt)
       ├─ protocol !== 'data:' → 直接调用 lib/url/url-sanitizer (纯 JS, 可用)
       └─ protocol === 'data:' → offscreen.createDocument → sendMessage(SANITIZE_URL)
            └→ offscreen-main.js: sanitizeURL(url, opt) [来自 url-sanitizer 库]

main.js (SW)
  └→ sanitize.js: sanitizeAttributes(attr)
       └→ offscreen.createDocument → sendMessage(SANITIZE_ATTR)
            └→ offscreen-main.js: sanitize-attr.js: sanitizeAttributes(attr) [DOMPurify]
```

## 8. 关键数据结构流

```
Tab (Chrome API)
  └→ TabLinkData {id, formatId, template, title, url, content, attr?}
       └→ createLinkText(data) → string (format-specific)
            └→ createTabsLinkText(arr) → string (joined with \n or <br>)
                 └→ execCopy({formatTitle, mimeType, text, notify})
                      └→ Clip(content, mimeType).copy()
                           └→ clipboard.write() / writeText()
```
