# Automa v1.30.01 — 数据流文档

> 本文档基于对 Automa v1.30.01 Webpack bundle 的逆向分析编写。
> 覆盖两条核心数据流：工作流执行流程、触发器注册与激活流程。

---

## 一、工作流执行流程

这是 Automa 的核心业务流程：用户触发工作流 → Background 调度 → 逐 Block 执行 → 结果返回。

### 1.1 序列图

```mermaid
sequenceDiagram
    actor User as 用户
    participant Popup as Popup/Dashboard
    participant BG as Background SW
    participant Store as chrome.storage.local
    participant Offscreen as Offscreen Document
    participant CS as Content Script
    participant Tab as 目标标签页

    User->>Popup: 点击"执行"按钮
    Popup->>BG: runtime.sendMessage({name:"workflow:execute", data:{id, options}})

    rect rgb(240, 248, 255)
    Note over BG: 阶段 1: 初始化
    BG->>Store: storage.local.get("workflows")
    Store-->>BG: 工作流定义 (drawflow + settings)
    BG->>BG: 解析 drawflow 图<br/>拓扑排序节点<br/>注入全局变量/数据表
    BG->>BG: 检查触发器权限<br/>检查并发执行限制
    BG->>Store: storage.local.set({workflows:[...]}) <br/>写入执行状态 "running"
    end

    rect rgb(255, 248, 240)
    Note over BG: 阶段 2: 主执行循环
    loop 每个 Block 节点 (按拓扑顺序)
        BG->>BG: 解析 Block 类型 (label)<br/>查找对应 handler

        alt Block 需要 offscreen 功能
            BG->>Offscreen: runtime.sendMessage({name:"offscreen--execute", data:{block}})
            Offscreen->>Offscreen: 执行 Block 逻辑<br/>(debugger命令/DOM操作/Clipboard等)
            Offscreen-->>BG: 执行结果
        else Block 需要 content script
            BG->>CS: tabs.sendMessage({type:"execute-block", data:{block}})
            CS->>Tab: 注入脚本 / 操作 DOM
            Tab-->>CS: DOM 交互结果
            CS-->>BG: 执行结果
        else Block 在 background 直接执行
            BG->>BG: 直接执行<br/>(变量赋值/条件判断/HTTP请求等)
        end

        BG->>BG: 收集 Block 输出<br/>更新全局变量上下文<br/>写入数据表行

        alt Block 执行失败
            BG->>BG: settings.continueOnError?<br/>是 → 记录错误继续<br/>否 → 中断执行
        end
    end
    end

    rect rgb(240, 255, 240)
    Note over BG: 阶段 3: 完成与通知
    BG->>Store: storage.local.set({workflows:[...]})<br/>写入执行日志 (status:success/error)
    BG->>Popup: runtime.sendMessage({name:"workflow:execution-completed", data:{log}})
    Popup-->>User: 显示执行结果 (成功/失败/日志)
    end
```

### 1.2 关键数据对象流转

```
输入:
  workflow:execute 消息
    └─ { id: string, options: { checkParam: boolean, data: { variables: Record<string,string> } } }

中间态:
  WorkflowContext (不持久化，仅内存)
    ├─ nodes: DrawflowNode[] (拓扑排序后)
    ├─ edges: DrawflowEdge[]
    ├─ variables: Map<string, any> (全局变量上下文)
    ├─ table: TableRow[] (数据表)
    ├─ columnData: Map<string, any> (当前 Block 输出列)
    ├─ loopData: any (循环上下文)
    └─ logs: LogStep[] (执行日志)

输出:
  chrome.storage.local.workflows[id].logs[]
    └─ { id, workflowId, status, startedAt, endedAt, steps: LogStep[] }

  runtime.sendMessage({ name: "workflow:execution-completed", data: { log: WorkflowLog } })
```

### 1.3 Block 类型路由机制

Background Service Worker 内部维护一个 Block Handler 注册表。当解析 drawflow 节点时：

1. 读取节点的 `label` 字段 (如 `"trigger"`, `"tab"`, `"click-element"`, `"http-request"` 等)
2. 在注册表中查找对应的 handler 函数
3. 根据 handler 的目标上下文决定执行位置：
   - **Background 本地**: 纯数据操作 Block (变量、条件、循环、HTTP 请求)
   - **Offscreen**: 需要 debugger/DOM API 的 Block (元素交互、CSS 操作、网络拦截)
   - **Content Script**: 需要页面上下文的 Block (表单填写、元素提取、截图)

---

## 二、触发器注册与激活流程

Automa 支持多种触发器启动工作流，包括定时器、上下文菜单、导航事件、键盘快捷键等。

### 2.1 序列图

```mermaid
sequenceDiagram
    actor User as 用户
    participant Dashboard as Dashboard
    participant BG as Background SW
    participant Store as chrome.storage.local
    participant Browser as Chrome Browser

    User->>Dashboard: 添加触发器 Block 到工作流
    User->>Dashboard: 保存工作流
    Dashboard->>BG: runtime.sendMessage({name:"workflow:register", data:{triggerBlock, workflowId}})

    rect rgb(240, 248, 255)
    Note over BG: 阶段 1: 触发器注册
    BG->>BG: 解析 triggerBlock.data.type<br/>确定触发器类别
    alt type === "interval" 或 "cron-job"
        BG->>Browser: chrome.alarms.create(workflowId, {periodInMinutes/delayInMinutes})
        BG->>BG: 监听 chrome.alarms.onAlarm
    else type === "context-menu"
        BG->>Browser: chrome.permissions.request("contextMenus")
        BG->>Browser: chrome.contextMenus.create({id:workflowId, title, contexts})
        BG->>BG: 监听 chrome.contextMenus.onClicked
    else type === "visit-web"
        BG->>Browser: chrome.webNavigation.onCompleted.addListener
    else type === "keyboard-shortcut"
        BG->>Browser: chrome.commands.onCommand.addListener
    else type === "on-startup"
        BG->>BG: 监听 chrome.runtime.onStartup
    else type === "specific-day"
        BG->>BG: 计算下次执行时间<br/>设置一次性 alarm
    end
    BG->>Store: storage.local.set({workflows:[...]})<br/>持久化 triggerBlock 关联
    end

    rect rgb(255, 248, 240)
    Note over BG: 阶段 2: 触发器激活
    Browser-->>BG: alarm/event/command 触发
    BG->>BG: 匹配触发器 → workflowId
    BG->>Store: storage.local.get("workflows")
    Store-->>BG: 获取工作流定义
    BG->>BG: 进入工作流执行流程<br/>(见 1.1 阶段 1-3)
    end

    rect rgb(240, 255, 240)
    Note over BG: 阶段 3: 触发器注销
    User->>Dashboard: 删除工作流或禁用触发器
    Dashboard->>BG: runtime.sendMessage({name:"workflow:unregister", data:{triggerBlock, workflowId}})
    BG->>Browser: chrome.alarms.clear(workflowId)<br/>或 chrome.contextMenus.remove(workflowId)
    BG->>Store: storage.local.set({workflows:[...]})<br/>清除 triggerBlock 关联
    end
```

### 2.2 触发器类型对照表

| 触发器类型 | Chrome API | 注册方式 | 数据结构 |
|-----------|-----------|---------|---------|
| `interval` | `chrome.alarms.create` | 周期性 alarm | `{ type, interval: number, delay: number }` |
| `specific-day` | `chrome.alarms.create` | 一次性 alarm | `{ type, date: string, time: string }` |
| `cron-job` | `chrome.alarms.create` | cron 解析 → 周期性 alarm | `{ type, cronExpression: string }` |
| `context-menu` | `chrome.contextMenus.create` | 右键菜单项 | `{ type, title: string, contexts: string[] }` |
| `visit-web` | `chrome.webNavigation.onCompleted` | 导航事件监听 | `{ type, url: string, pattern: string }` |
| `keyboard-shortcut` | `chrome.commands.onCommand` | 命令监听 | `{ type, shortcut: string }` |
| `on-startup` | `chrome.runtime.onStartup` | 启动事件 | `{ type }` |

---

## 三、Web Service 工作流导入流程

### 3.1 序列图

```mermaid
sequenceDiagram
    actor User as 用户
    participant WebPage as automa.site 网页
    participant WS as Web Service CS
    participant BG as Background SW
    participant Store as chrome.storage.local

    User->>WebPage: 浏览 automa.site<br/>找到工作流，点击 "安装到插件"
    WebPage->>WS: dispatchEvent(CustomEvent("__automa-ext__", {detail:{type:"add-workflow", data:{workflow}}}))
    WS->>WS: 生成 21 字符随机 ID<br/>补充元数据 (createdAt, dataColumns)

    WS->>Store: storage.local.get("workflows")
    Store-->>WS: 现有工作流列表

    alt 数组存储模式
        WS->>WS: workflows.push(newWorkflow)
    else 对象映射模式
        WS->>WS: workflows[id] = newWorkflow
    end

    WS->>Store: storage.local.set({workflows})

    WS->>BG: runtime.sendMessage({name:"workflow:added", data:{workflowId, workflowData}})
    BG->>BG: 检查 triggerBlock → 注册触发器

    WS->>WebPage: dispatchEvent(CustomEvent("__automa-ext__workflow-installed"))
    WebPage-->>User: 显示安装成功
```

### 3.2 Web Service 事件总线

Web Service 通过 `window.addEventListener("__automa-ext__", ...)` 建立事件总线：

| 事件类型 | 方向 | 功能 |
|---------|------|------|
| `open-dashboard` | 网页 → 插件 | 打开 Dashboard 并导航到指定路径 |
| `open-workflow` | 网页 → 插件 | 打开指定工作流的编辑器 |
| `add-workflow` | 网页 → 插件 | 添加新工作流到本地存储 |
| `add-team-workflow` | 网页 → 插件 | 添加团队共享工作流 |
| `check-team-workflow` | 网页 → 插件 | 检查团队工作流是否存在 |
| `add-package` | 网页 → 插件 | 安装 Block 包 |
| `update-package` | 网页 → 插件 | 更新已安装的 Block 包 |
| `send-message` | 网页 ⇄ 插件 | 通用双向通信 (内部协议) |
| `__automa-ext__workflow-installed` | 插件 → 网页 | 确认工作流安装完成 |
| `__automa-team-workflow__` | 插件 → 网页 | 回复团队工作流检查结果 |

---

## 四、Debugger 协议代理流程

由于 MV3 Service Worker 无法直接使用 `chrome.debugger`（需要 Window 上下文），Automa 通过 Offscreen Document 代理所有 Debugger 操作。

### 4.1 序列图

```mermaid
sequenceDiagram
    participant BG as Background SW
    participant Offscreen as Offscreen Document
    participant Browser as Chrome Debugger

    rect rgb(240, 248, 255)
    Note over BG: 阶段 1: 发起 debugger 操作
    BG->>Offscreen: runtime.sendMessage({name:"offscreen--browser-api",<br/>data:{name:"debugger.attach", args:[{tabId}]}})
    Offscreen->>Browser: chrome.debugger.attach({tabId}, "1.3")
    Browser-->>Offscreen: attach 确认
    Offscreen-->>BG: attach 结果
    end

    rect rgb(255, 248, 240)
    Note over BG: 阶段 2: 发送 CDP 命令
    BG->>Offscreen: runtime.sendMessage({name:"offscreen--browser-api",<br/>data:{name:"debugger.sendCommand", args:[{tabId}, command, params]}})
    Offscreen->>Browser: chrome.debugger.sendCommand({tabId}, command, params)
    Browser-->>Offscreen: CDP 响应数据
    Offscreen-->>BG: 命令结果
    end

    rect rgb(240, 255, 240)
    Note over BG: 阶段 3: 事件监听
    BG->>Offscreen: runtime.sendMessage({name:"offscreen--browser-api",<br/>data:{name:"browser-api:toggle-browser-event-listener", args:[{name:"debugger.onEvent", type:"add"}]}})
    Offscreen->>Browser: chrome.debugger.onEvent.addListener(handler)
    loop 事件触发
        Browser-->>Offscreen: chrome.debugger.onEvent(debuggee, method, params)
        Offscreen->>BG: runtime.sendMessage({name:"offscreen--browser-api:on-browser-event",<br/>data:{name:"debugger.onEvent", args:[debuggee, method, params]}})
        BG->>BG: 处理 debugger 事件 (如网络请求拦截)
    end
    end
```

### 4.2 Browser API 注册表 (Offscreen 侧)

从代码中提取的 Offscreen 侧 Browser API 注册列表：

```typescript
const apiRegistry = [
  { path: "tabs.get",              api: () => browser.tabs.get },
  { path: "tabs.query",            api: () => browser.tabs.query },
  { path: "tabs.update",           api: () => browser.tabs.update },
  { path: "tabs.create",           api: () => browser.tabs.create },
  { path: "tabs.remove",           api: () => browser.tabs.remove },
  { path: "tabs.reload",           api: () => browser.tabs.reload },
  { path: "tabs.goBack",           api: () => browser.tabs.goBack },
  { path: "tabs.goForward",        api: () => browser.tabs.goForward },
  { path: "tabs.captureVisibleTab",api: () => browser.tabs.captureVisibleTab },
  { path: "tabs.sendMessage",      api: () => browser.tabs.sendMessage },
  { path: "windows.get",           api: () => browser.windows.get },
  { path: "windows.create",        api: () => browser.windows.create },
  { path: "debugger.attach",       api: () => chrome.debugger.attach },
  { path: "debugger.detach",       api: () => chrome.debugger.detach },
  { path: "debugger.sendCommand",  api: () => chrome.debugger.sendCommand },
  { path: "proxy.settings.set",    api: () => browser.proxy.settings.set },
  { path: "proxy.settings.clear",  api: () => browser.proxy.settings.clear },
  { path: "cookies.get",           api: () => browser.cookies?.get },
  { path: "cookies.set",           api: () => browser.cookies?.set },
  { path: "downloads.download",    api: () => browser.downloads?.download },
  // ... 共约 50+ API 路径
]
```

事件监听器路径：
```typescript
const eventRegistry = [
  "tabs.onRemoved",
  "windows.onRemoved",
  "webNavigation.onCreatedNavigationTarget",
  "webNavigation.onErrorOccurred",
  "debugger.onEvent",
  "storage.onChanged",
  "downloads.onCreated",
  "downloads.onDeterminingFilename",
  "downloads.onChanged",
]
```

---

## 五、存储结构全景

```
chrome.storage.local
├── workflows: Record<string, Workflow> | Workflow[]
│   ├── [workflowId]: { id, name, drawflow, dataColumns, table, variables,
│   │                    settings, createdAt, editedAt, logs, triggerBlock }
│   └── ...
├── teamWorkflows?: Record<string, Record<string, Workflow>>
│   └── [teamId]: { [workflowId]: Workflow }
├── savedBlocks?: SavedBlock[]
├── session?: SessionData
└── sessionToken?: SessionToken

IndexedDB: "automa" / v1
└── objectStore: "store"
    └── key: "workflows" → 备份的工作流数据 (webService context)

localStorage (仅 webService context):
└── "supabase.auth.token" → JSON SessionData
```
