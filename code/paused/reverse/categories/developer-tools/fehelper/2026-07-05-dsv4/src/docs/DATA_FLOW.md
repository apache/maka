# FeHelper 数据流文档

> 反向工程版本：dsv4 | 原始版本：v2026.7.3  
> 本文档描述 FeHelper Chrome 扩展中各组件的消息传递、数据流转和状态同步机制。

---

## 一、整体数据流概览

```mermaid
flowchart TB
    subgraph Browser["Chrome 浏览器"]
        direction TB
        subgraph Pages["Web 页面"]
            CS["Content Scripts<hr/>jQuery + evalCore<br/>自动 JSON 格式化<br/>页面取色 / 栅格标尺 / 截屏<br/>油猴脚本注入"]
        end
        subgraph Extension["FeHelper 扩展"]
            direction LR
            SW["Service Worker<hr/>background.js<br/>消息总线<br/>生命周期管理"]
            Popup["Popup 弹窗<hr/>Vue.js<br/>Lite / Omni 双模式"]
            Options["Options 控制台<hr/>Vue.js<br/>工具市场 / 设置"]
            Tools["工具页面<hr/>Vue.js 独立页面<br/>30+ 工具"]
            Sandbox["Sandbox 沙箱<hr/>unsafe-eval CSP<br/>第三方工具隔离"]
        end
        subgraph Storage["存储层"]
            Local["chrome.storage.local"]
            Session["chrome.storage.session"]
        end
    end

    subgraph External["外部服务"]
        Hotfix["热修复 JSON<br/>fehelper.com"]
        Stats["统计服务<br/>fehelper.com"]
        CWS["Chrome Web Store<br/>更新检测"]
    end

    CS -->|"chrome.runtime.sendMessage"| SW
    CS -->|"window.postMessage"| Pages
    SW -->|"chrome.scripting.executeScript"| CS
    SW -->|"chrome.tabs.create"| Tools
    SW -->|"chrome.action.setPopup"| Popup
    SW -->|"chrome.contextMenus"| Browser
    Popup -->|"chrome.runtime.sendMessage"| SW
    Options -->|"chrome.runtime.sendMessage"| SW
    Tools -->|"chrome.runtime.sendMessage"| SW
    SW -->|"postMessage"| Sandbox
    SW <-->|"读写"| Local
    SW <-->|"读写"| Session
    SW -->|"fetch"| Hotfix
    SW -->|"上报"| Stats
    SW -->|"检测"| CWS
```

---

## 二、核心数据流路径

### 2.1 工具打开流程

```mermaid
sequenceDiagram
    participant User
    participant Popup
    participant SW as Service Worker
    participant ToolPage as 工具页面
    participant Storage as chrome.storage

    User->>Popup: 点击工具 (或 Enter / Alt+数字)
    Popup->>SW: { type: "open-dynamic-tool", page: "qr-code" }
    
    alt 工具含 noPage: true
        SW->>SW: 调用 inject-tools.js 注入到当前标签页
    else 标准工具
        SW->>SW: 查询是否已有该工具页打开
        alt 已存在（且 FORBID_OPEN_IN_NEW_TAB=true）
            SW->>ToolPage: tabs.update + tabs.reload（复用）
        else 不存在
            SW->>ToolPage: tabs.create("/qr-code/index.html")
        end
        SW->>Storage: session.set("fh-content-<tabId>", {content})
    end
    
    SW->>SW: 记录 Statistics.recordToolUsage
```

### 2.2 内容脚本注入流程

```mermaid
sequenceDiagram
    participant Browser
    participant SW as Service Worker
    participant CS as Content Scripts
    participant Page as Web Page

    Browser->>SW: tabs.onUpdated (status=complete)
    SW->>SW: url-policy.isInjectableTabUrl(url)?
    alt 可注入
        SW->>CS: chrome.scripting.executeScript<br/>{ func: set __FH_TAB_ID__ }
        SW->>CS: injectTools.inject 注入工具内容脚本
        loop 每个已安装且含 contentScriptJs 的工具
            SW->>CS: 注入 js 文件列表<br/>{ files: [json-bigint.js, ..., content-script.js] }
            SW->>CS: 注入 func 调用 window.<tool>ContentScript()
        end
        loop 每个已安装且含 contentScriptCss 的工具
            SW->>CS: 注入 css 文件
        end
    end
```

### 2.3 DYNAMIC_ANY_THING 消息分发

```mermaid
flowchart LR
    SW["Service Worker<br/>onMessage handler"]
    
    SW -->|"thing: trigger-screenshot"| A["截屏工具"]
    SW -->|"thing: request-jsonformat-options"| B["读取 JSON 设置"]
    SW -->|"thing: save-jsonformat-options"| C["保存 JSON 设置"]
    SW -->|"thing: code-beautify"| D["代码美化注入"]
    SW -->|"thing: qr-decode"| E["二维码解码"]
    SW -->|"thing: request-page-content"| F["传递页面内容"]
    SW -->|"thing: set-page-timing-data"| G["性能数据传递"]
    SW -->|"thing: color-picker-capture"| H["取色截屏"]
    SW -->|"thing: page-screenshot-done"| I["截屏结果传递"]
    SW -->|"thing: request-monkey-start"| J["启动油猴脚本"]
    SW -->|"thing: page-monkey-log"| K["油猴日志记录"]
    SW -->|"thing: page-monkey-require-fetch"| L["油猴 @require 代理"]
    SW -->|"thing: open-options-page"| M["打开设置页"]
    SW -->|"thing: open-donate-modal"| N["打开打赏弹窗"]
    SW -->|"thing: statistics-tool-usage"| O["使用统计"]
    SW -->|"thing: fetch-hotfix-json"| P["获取热修复"]
    SW -->|"thing: fh-get-tool-patch"| Q["读取工具补丁"]
    SW -->|"thing: save-options"| R["保存设置"]
```

### 2.4 弹窗 (Popup) 数据流

```mermaid
sequenceDiagram
    participant Popup
    participant SW as Service Worker
    participant Storage

    Popup->>Popup: created(): loadTools()
    Popup->>SW: getInstalledTools()
    SW->>Storage: 读取所有 DYNAMIC_TOOL:* 键
    Storage-->>SW: 已安装工具列表
    SW-->>Popup: toolMap (含 installed/favorite 状态)
    
    Popup->>Storage: 读取 favorites, recentUsed, UI_MODE
    Storage-->>Popup: 用户偏好数据
    
    Popup->>Popup: computed: 构建 visibleGroups
    Popup->>SW: { type: "fh-popup-opened" }
    SW-->>Popup: { ok: true }
    
    Note over Popup: deferNonCriticalStartup():<br/>notifyPopupOpened → loadPatchHotfix → recordUsage
```

### 2.5 设置 (Options) 数据流

```mermaid
sequenceDiagram
    participant Options
    participant SW as Service Worker
    participant Storage
    participant Menu as 右键菜单

    Options->>Options: initData()
    Options->>SW: getAllTools() → 全部工具元数据
    Options->>SW: getInstalledTools() → 安装状态
    Options->>Storage: 读取 favorites
    Options->>SW: 【request-jsonformat-options】→ JSON 设置

    User->>Options: 点击"保存设置"
    Options->>Storage: 写入 selectedOpts
    Options->>SW: 【save-jsonformat-options】→ JSON 设置
    Options->>SW: menuMgr("download-crx"/"fehelper-setting", install/offload)
    Options->>Storage: 写入 tool_custom_order（排序）
    Options->>SW: { type: "dynamic-tool-install-or-offload" }
```

### 2.6 油猴脚本 (Page Monkey) 数据流

```mermaid
sequenceDiagram
    participant Browser
    participant SW as Service Worker
    participant MW as MAIN World
    participant IW as ISOLATED World
    participant Storage

    Browser->>SW: webNavigation.onCommitted / onDOMContentLoaded / onCompleted
    SW->>Storage: 读取 PAGE-MONKEY-LOCAL-STORAGE-KEY
    Storage-->>SW: 已启用的脚本列表

    Note over SW: 过滤：runAt 匹配 + URL 匹配 + 未禁用

    SW->>IW: executeScript: 注入日志桥接 (ISOLATED world)
    IW-->>IW: 监听 postMessage 转发给 SW

    SW->>MW: executeScript: 注入脚本代码 (MAIN world)
    MW->>MW: eval 用户脚本

    loop 脚本运行时
        MW->>MW: GM_log / console.error
        MW->>IW: postMessage({ __fh_monkey_log })
        IW->>SW: runtime.sendMessage({ page-monkey-log })
        SW->>Storage: 追加到 PAGE-MONKEY-LOG-KEY
    end

    opt @require
        MW->>IW: postMessage({ __fh_monkey_require })
        IW->>SW: runtime.sendMessage({ page-monkey-require-fetch })
        SW-->>IW: fetch 结果
        IW-->>MW: postMessage 返回代码文本
        MW->>MW: eval @require 代码
    end
```

---

## 三、存储键空间设计

### 3.1 chrome.storage.local（持久存储）

| 键名模式 | 用途 | 数据结构 |
|----------|------|----------|
| `DYNAMIC_TOOL:<name>` | 工具安装标记 | 时间戳（Number） |
| `DYNAMIC_TOOL:CS:<name>` | 工具内容脚本缓存 | JS 字符串 |
| `DYNAMIC_TOOL:CS:CSS:<name>` | 工具内容样式缓存 | CSS 字符串 |
| `DYNAMIC_MENU:<name>` | 工具右键菜单状态 | "1" 或 "0" |
| `DEV-TOOLS:MY-TOOLS` | 第三方开发工具列表 | JSON 字符串 |
| `favorites` | 用户收藏工具 | `string[]` |
| `popup_recent_tools` | 最近使用工具 | `string[]` (最多 10) |
| `FH_USER_USAGE_DATA` | 使用统计数据 | JSON → `UserUsageData` |
| `FH_UI_MODE` | 全局 UI 模式 | "lite" 或 "omni" |
| `FH_POPUP_UI_MODE` | Popup UI 模式 | "lite" 或 "omni" |
| `FH_OPTIONS_UI_MODE` | Options UI 模式 | "lite" 或 "omni" |
| `tool_custom_order` | 工具排序 | JSON 字符串 |
| `PAGE-MODIFIER-LOCAL-STORAGE-KEY` | 油猴脚本定义 | JSON 字符串 |
| `PAGE-MODIFIER-LOG-KEY` | 油猴运行日志 | JSON 字符串（限 300 条） |
| `fehelper_view_mode` | 视图模式 | "grid" 或 "list" |
| `fehelper_latest_version_data` | 版本检测缓存 | JSON → `VersionInfo` |
| `FH_PATCH_HOTFIX_<version>` | 工具热修复补丁 | `ToolPatchMap` |
| `fh_ai_provider` | AI Provider 选择 | "builtin" |
| `fh_ai_builtin_status_snapshot` | AI 模型状态 | `AiModelStatusSnapshot` |

### 3.2 chrome.storage.session（会话存储）

| 键名模式 | 用途 | 生命周期 |
|----------|------|----------|
| `fh-content-<tabId>` | 工具页面内容传递（如 JSON 原文） | 会话级别 |

### 3.3 localStorage（页面内部 / 油猴脚本）

| 键名模式 | 用途 |
|----------|------|
| `__FH_GM_<scriptId>_<key>` | 油猴脚本 GM_setValue/GM_getValue |
| `AUTO_DARK_MODE` / `ALWAYS_DARK_MODE` | 夜间模式状态同步 |

---

## 四、事件流

```mermaid
flowchart TB
    subgraph Events["主要事件"]
        E1["chrome.tabs.onUpdated<br/>(页面加载完成)"]
        E2["chrome.webNavigation.onCommitted<br/>(导航提交)"]
        E3["chrome.webNavigation.onDOMContentLoaded<br/>(DOM 就绪)"]
        E4["chrome.webNavigation.onCompleted<br/>(导航完成)"]
        E5["chrome.webNavigation.onHistoryStateUpdated<br/>(SPA 路由变化)"]
        E6["chrome.runtime.onInstalled<br/>(安装/更新)"]
        E7["chrome.runtime.onStartup<br/>(浏览器启动)"]
        E8["chrome.alarms.onAlarm<br/>(定时更新检测)"]
        E9["chrome.runtime.onMessage<br/>(消息接收)"]
        E10["chrome.contextMenus.onClicked<br/>(右键菜单)"]
    end

    E1 --> SW_INIT["注入 content scripts<br/>设置 __FH_TAB_ID__"]
    E2 & E3 & E4 & E5 --> MONKEY["油猴脚本匹配注入<br/>(按 runAt 过滤)"]
    E6 --> INSTALL["安装: 打开 Options<br/>更新: 显示 Badge<br/>共用: 重建右键菜单"]
    E7 --> MENU["重建右键菜单"]
    E8 --> UPDATE["检测 CWS 更新<br/>update_available → reload"]
    E9 --> DISPATCH["消息分发<br/>(见 2.3 DYNAMIC_ANY_THING)"]
    E10 --> TOOL["打开对应工具页面"]
```

---

## 五、热修复机制

```
1. 工具页/Popup/Options 加载完成后调用 fh-get-tool-patch
2. Service Worker 从 chrome.storage.local 读取 FH_PATCH_HOTFIX_<version>
3. 命中则返回 { css, js }
4. 工具页创建 <style> 注入 css，用 new Function() 执行 js（限 50KB）
5. 补丁数据来源：
   - 上次 fetch-hotfix-json 请求的缓存
   - fetch-hotfix-json 从 https://fehelper.com/static/js/hotfix.json 获取
```

---

## 六、内容传递（工具间通信）

部分工具需要跨页面传递数据，使用 `chrome.storage.session` 临时存储：

1. **来源**：用户在 Web 页面上选中 JSON 文本，通过 content_script 发送请求
2. **存储**：SW 将内容缓存到 `chrome.storage.session` 键 `fh-content-<tabId>`
3. **消费**：工具页打开后通过 `request-page-content` 读取
4. **清理**：读取后立即删除（`chrome.storage.session.remove`）

也支持通过 `withContent` 直接在 `open-dynamic-tool` 消息中携带数据。
