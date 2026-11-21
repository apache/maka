# VisBug v0.4.10 — 数据流文档

## 1. 流程总览

VisBug 的数据流围绕三个核心事件展开：激活/停用、颜色偏好同步、跨上下文消息传递。

**参与者：**
- **用户** — 通过工具栏图标、快捷键或右键菜单交互
- **Service Worker** — 后台协调器 (visbug.js + contextmenu 模块)
- **Content Script** — 页面注入脚本 (inject/eject/restore.js)
- **VisBug Core** — 页面内运行的主应用 (bundle.min.js)
- **chrome.storage.sync** — 持久化存储
- **chrome.contextMenus** — 右键菜单 API

## 2. 激活/停用流程

```mermaid
sequenceDiagram
    actor User
    participant SW as Service Worker<br/>(visbug.js)
    participant CS as Content Script<br/>(inject.js)
    participant DOM as Page DOM
    participant Bundle as VisBug Core<br/>(bundle.min.js)

    User->>SW: 点击工具栏图标 / Alt+Shift+D / 右键菜单
    SW->>SW: 检查 state.loaded[tabId]

    alt tab 首次激活 (fresh start)
        SW->>DOM: chrome.scripting.insertCSS(bundle.css)
        SW->>DOM: chrome.scripting.executeScript(inject.js)
        SW->>SW: state.loaded[tabId] = true
        SW->>SW: state.injected[tabId] = true
        SW->>SW: 调用 getColorMode() / getColorScheme()
        CS->>DOM: 创建 <script type="module" src="bundle.min.js">
        CS->>DOM: 创建 <vis-bug> 自定义元素 (prepend to body)
        Bundle->>DOM: 初始化 VisBug UI 工具栏
        SW->>DOM: chrome.tabs.onUpdated 监听器 (页面刷新时重置 loaded)
    else tab 已注入但隐藏 (restore)
        SW->>DOM: chrome.scripting.executeScript(restore.js)
        SW->>SW: state.injected[tabId] = true
        CS->>DOM: 重新创建 <vis-bug> 元素
    else tab 已注入且可见 (eject)
        SW->>DOM: chrome.scripting.executeScript(eject.js)
        SW->>SW: state.injected[tabId] = false
        CS->>DOM: animate() 淡出 + 移除 <vis-bug>
    end
```

## 3. 颜色偏好变更流程

```mermaid
sequenceDiagram
    actor User
    participant SW as Service Worker
    participant Storage as chrome.storage.sync
    participant CS as Content Script<br/>(inject.js)
    participant VisBug as <vis-bug> Element

    Note over SW: 右键菜单初始化
    SW->>SW: contextMenus.create (color-mode 父菜单)
    SW->>SW: contextMenus.create (hex/rgb/hsl 子菜单, type=radio)

    User->>SW: 右键 → Colors → 选择 hex/rgb/hsl
    SW->>Storage: storage.sync.set({visbug-color-mode: 'hsl'})
    SW->>SW: colormodestate.mode = 'hsl'
    SW->>CS: tabs.sendMessage({action: 'COLOR_MODE', params: {mode: 'hsl'}})
    CS->>VisBug: visbug.setAttribute('color-mode', 'hsl')
    Note over VisBug: VisBug Core 读取属性应用新颜色格式

    Note over SW: 每次 tab 激活时也同步
    SW->>Storage: storage.sync.get(['visbug-color-mode'])
    Storage-->>SW: 返回存储值 (或默认值 'hex')
    SW->>CS: tabs.sendMessage({action: 'COLOR_MODE', params: {mode}})
    CS->>VisBug: visbug.setAttribute('color-mode', mode)
```

## 4. 主题 (颜色方案) 变更流程

```mermaid
sequenceDiagram
    actor User
    participant SW as Service Worker
    participant Storage as chrome.storage.sync
    participant CS as Content Script<br/>(inject.js)
    participant VisBug as <vis-bug> Element

    User->>SW: 右键 → Theme → 选择 auto/light/dark
    SW->>Storage: storage.sync.set({visbug-color-scheme: 'dark'})
    SW->>SW: colorschemestate.mode = 'dark'
    SW->>CS: tabs.sendMessage({action: 'COLOR_SCHEME', params: {mode: 'dark'}})
    CS->>VisBug: visbug.setAttribute('color-scheme', 'dark')
```

## 5. 存储 Schema

```
chrome.storage.sync:
├── visbug-color-mode:    "hex" | "rgb" | "hsl"     (默认: "hex")
└── visbug-color-scheme:  "auto" | "light" | "dark" (默认: "auto")
```

**旧值迁移规则 (colormode.js):**
- `hsla` → `hsl`
- `rgba` → `rgb`
- 首次安装 → 写入默认值 `hex`

## 6. 消息协议

### Service Worker → Content Script

| 消息 | 格式 | 触发时机 |
|------|------|---------|
| COLOR_MODE | `{action: 'COLOR_MODE', params: {mode: 'hex'\|'rgb'\|'hsl'}}` | 用户切换颜色格式 / tab 激活时同步 |
| COLOR_SCHEME | `{action: 'COLOR_SCHEME', params: {mode: 'auto'\|'light'\|'dark'}}` | 用户切换主题 / tab 激活时同步 |

### 无 Content Script → Service Worker 消息

本扩展中内容脚本不向 Service Worker 发送消息，通信是单向的 (SW → 页面)。

## 7. Tab 生命周期状态机

```mermaid
stateDiagram-v2
    [*] --> Idle: 用户打开新 tab
    Idle --> FreshStart: 用户点击激活 (首次)
    FreshStart --> LoadedAndVisible: inject.js 执行完成
    LoadedAndVisible --> Hidden: 用户再次点击 (eject)
    Hidden --> LoadedAndVisible: 用户再次点击 (restore)
    LoadedAndVisible --> Idle: tab 导航/刷新<br/>(onUpdated 重置 loaded)
    Hidden --> Idle: tab 导航/刷新<br/>(onUpdated 重置 loaded)
    Idle --> FreshStart: 用户再次激活
```

## 8. 关键数据流边界

1. **SW 状态不持久化**: `state.loaded` / `state.injected` 仅存在内存中，SW 被回收后丢失。重新激活时视为 fresh start，会重新注入完整 VisBug
2. **颜色偏好同步**: 仅在 `toggleIn()` 调用时同步 (即用户激活/切换 tab 时)，不会实时监听 storage 变更事件
3. **`tutsBaseURL` 计算**: 通过 `platform.runtime.getURL('tuts/guides.gif')` 获取完整 URL，再截取目录路径部分，传递给 `<vis-bug>` 元素用于加载教程 GIF
