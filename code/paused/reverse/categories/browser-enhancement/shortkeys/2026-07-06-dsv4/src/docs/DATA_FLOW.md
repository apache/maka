# Shortkeys v5.0.1 — 数据流文档

## 1. 快捷键激活完整流程

```mermaid
sequenceDiagram
    actor User
    participant Page as 页面 (DOM)
    participant CS as Content Script
    participant BG as Service Worker
    participant API as Chrome API
    participant Storage as chrome.storage

    Note over CS: 页面加载时初始化

    CS->>BG: sendMessage({action:"getKeys", url:document.URL})
    BG->>Storage: storage.sync.get("keys")
    alt sync 有数据
        Storage-->>BG: keys JSON
    else sync 无数据
        BG->>Storage: storage.local.get("keys")
        Storage-->>BG: keys JSON
    end
    BG->>Storage: storage.sync/local.get("groupSettings")
    Storage-->>BG: groupSettings JSON
    BG->>BG: 按 URL 过滤快捷键<br/>(blacklist/sitesArray + group activateOn/deactivateOn)
    BG-->>CS: 过滤后的快捷键列表
    CS->>CS: Mousetrap.bind(key, handler)

    Note over User,CS: 用户按下快捷键

    User->>Page: 按下键盘组合 (如 ctrl+shift+k)
    Page->>CS: keydown/keypress/keyup 事件
    CS->>CS: Mousetrap 解析修饰键+主键<br/>检查 stopCallback (输入框过滤)
    CS->>CS: 匹配绑定的快捷键 → 获取 action

    alt 内容脚本操作
        CS->>CS: 直接执行 (javascript/showcheatsheet/...)
        CS->>CS: 如果是 javascript: CustomEvent → userScripts → MAIN world eval
    else 后台操作
        CS->>BG: sendMessage({action, ...params})
        BG->>BG: 命令分发器路由到处理函数
        BG->>API: chrome.tabs/windows/bookmarks/etc.
        API-->>BG: 操作结果
    end

    opt 使用统计已启用
        CS->>BG: sendMessage({action:"trackUsage", shortcutId})
        BG->>Storage: storage.local 更新使用计数
    end
```

## 2. 存储读写流程

```mermaid
flowchart TD
    subgraph 写入
        A[用户保存快捷键] --> B{JSON.stringify 后<br/>大小 < 99KB?}
        B -->|是| C[storage.sync.set]
        B -->|否| D[仅 storage.local.set]
        C --> E[同时 storage.local.set<br/>作为本地备份]
    end

    subgraph 读取
        F[读取快捷键] --> G[尝试 storage.sync.get]
        G --> H{sync 有数据?}
        H -->|有| I[尝试 storage.local.get]
        H -->|无| J[storage.local.get]
        I --> K{比较两个数据源}
        K -->|local 更完整| L[使用 local]
        K -->|sync 更完整| M[使用 sync]
        J --> L
    end

    subgraph 迁移
        N[扩展更新/安装] --> O{已迁移标记?}
        O -->|已迁移| P[跳过]
        O -->|未迁移| Q[读取 local keys]
        Q --> R{local 有数据?}
        R -->|无| P
        R -->|有| S{sync 已有数据?}
        S -->|有| P
        S -->|无| T{数据 < 99KB?}
        T -->|是| U[写入 sync]
        T -->|否| P
        U --> V[设置迁移标记]
    end
```

## 3. 截图流程 (使用 chrome.debugger)

```mermaid
sequenceDiagram
    actor User
    participant BG as Service Worker
    participant Debugger as Chrome Debugger API
    participant Page as 目标页面
    participant FS as 文件系统

    User->>BG: 触发截图快捷键 (capturescreenshot/capturefullsizescreenshot)

    BG->>Debugger: debugger.attach({tabId}, "1.3")
    Debugger-->>BG: 已附加

    opt 完整页面截图
        BG->>BG: 计算页面总高度<br/>(通过 scripting.executeScript 获取 scrollHeight)
        BG->>Debugger: Emulation.setDeviceMetricsOverride<br/>{height: pageHeight, width, deviceScaleFactor:0}
        Debugger-->>BG: 视口已调整
    end

    BG->>Debugger: Page.captureScreenshot
    Debugger->>Page: 渲染页面
    Page-->>Debugger: 位图数据
    Debugger-->>BG: {data: "base64..."}

    BG->>Debugger: debugger.detach({tabId})
    Debugger-->>BG: 已分离

    BG->>Page: scripting.executeScript<br/>(创建下载链接并触发下载)
    Page->>FS: 保存 PNG 文件
```

## 4. JavaScript 执行流程 (userScripts 桥接)

```mermaid
flowchart TD
    subgraph 初始化
        A[Service Worker 启动] --> B{chrome.userScripts API 可用?}
        B -->|是| C[读取所有 action=javascript 的快捷键]
        B -->|否| D[跳过 userScripts 注册]
        C --> E[构造 handlers 对象<br/>{shortcutId: function(){...}}]
        E --> F[注册/更新 userScripts<br/>id='shortkeys-actions'<br/>world='MAIN']
    end

    subgraph 运行时
        G[用户按下 JavaScript 快捷键] --> H[Content Script 接收]
        H --> I[document.dispatchEvent<br/>CustomEvent('shortkeys_js_run')<br/>detail = shortcutId]
        I --> J[userScript 监听器捕获]
        J --> K[handlers[shortcutId]() 执行]
        K --> L[用户代码在 MAIN world 运行]
    end
```

## 5. 宏执行流程

```mermaid
flowchart TD
    A[触发宏快捷键] --> B[读取 macroSteps 数组]
    B --> C[取前 10 步]
    C --> D{遍历每一步}

    D --> E{step.delay > 0?}
    E -->|是| F[setTimeout 等待 delay ms]

    D --> G{step.action 类型}
    G -->|javascript| H[scripting.executeScript<br/>new Function(code)() 在页面执行]
    G -->|内容脚本操作| I[tabs.sendMessage 到 Content Script]
    G -->|后台操作| J[调用对应的 action handler]

    H --> K{还有下一步?}
    I --> K
    J --> K
    K -->|是| D
    K -->|否| L[宏执行完成]
```

## 6. 使用统计数据流

```mermaid
flowchart LR
    A[快捷键触发] --> B[Content Script]
    B --> C{使用统计启用?}
    C -->|是| D[sendMessage<br/>trackUsage + shortcutId]
    C -->|否| E[跳过]

    D --> F[Service Worker]
    F --> G[读取 storage.local usage]
    G --> H[更新该 shortcutId 的计数]
    H --> I[更新 usageDaily 当日计数]
    I --> J[截断 usageDaily 到 90 天]
    J --> K[写回 storage.local]
```

## 7. 外部导入流程

```mermaid
sequenceDiagram
    actor User
    participant Web as shortkeys.app
    participant BG as Service Worker
    participant Storage as chrome.storage

    User->>Web: 在网站上生成快捷键配置
    Web->>BG: runtime.sendMessage(extensionId, {action:"importShortcuts", shortcuts:[...]})
    Note over BG: externally_connectable 白名单验证
    BG->>BG: 为每个无 ID 的快捷键生成 UUID
    BG->>Storage: 读取现有快捷键
    Storage-->>BG: 现有列表
    BG->>BG: 合并新旧列表
    BG->>Storage: 写入合并后的列表
    BG-->>Web: {success: true, count: N}
```

## 8. Chrome Commands API 流程

```mermaid
flowchart TD
    A[用户按下全局快捷键] --> B[Chrome 路由到注册的 Command]
    B --> C[chrome.commands.onCommand 触发]
    C --> D[解析 command ID<br/>如 '03-nexttab' → action='nexttab']
    D --> E{特殊处理?}
    E -->|lastusedtab| F[标签页历史切换]
    E -->|capture*| G[截图引擎]
    E -->|其他| H[命令分发器 → 对应 handler]
```

## 关键数据格式

### 快捷键 JSON (存储格式)

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "key": "ctrl+shift+k",
    "action": "newtab",
    "label": "新标签页",
    "enabled": true,
    "activeInInputs": false,
    "group": "我的快捷键",
    "blacklist": "false",
    "sitesArray": ["*github.com*"]
  }
]
```

### 分组设置 (存储格式)

```json
{
  "我的快捷键": {
    "activateOn": "*github.com*\n*stackoverflow.com*",
    "deactivateOn": ""
  }
}
```

### 使用统计 (存储格式)

```json
{
  "usage": {
    "shortcut-id-1": { "count": 42, "firstUsed": 1700000000000, "lastUsed": 1700100000000 }
  },
  "usageDaily": [
    { "date": "2024-11-15", "counts": { "shortcut-id-1": 5 } }
  ]
}
```
