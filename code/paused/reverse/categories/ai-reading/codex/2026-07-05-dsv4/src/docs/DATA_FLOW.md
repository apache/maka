# Codex 数据流分析文档

> 基于 Codex v1.1.5 源码逆向 | 输出目录: `dsv4` | 2026-07-06

---

## 一、总体数据流概览

```mermaid
flowchart TB
    subgraph External["外部环境"]
        AI["AI 模型 / Agent\n(桌面端 App / CLI)"]
        NH["Native Messaging Host\n(com.openai.codexextension)"]
    end

    subgraph Chrome["Chrome 扩展 (MV3)"]
        subgraph BG["Background Service Worker"]
            NT["NativeTransport\n连接/重连/心跳"]
            MR["Message Router\n消息路由"]
            CDP["CDP Executor\nchrome.debugger"]
            TM["Tab Manager\ntabs/tabGroups/windows"]
            SM["Session Manager\n会话/租约"]
            WM["Window Manager\n侧边栏/窗口"]
        end

        subgraph CS["Content Script (每页面)"]
            CO["Agent Cursor Overlay\n光标渲染/动画"]
            FB["Favicon Badge Manager\nFavicon 徽章"]
        end

        subgraph UI["UI 组件"]
            POP["Popup\n(popup.html + SPA)"]
            SP["Side Panel\n(chrome.sidePanel)"]
        end
    end

    subgraph Browser["Chrome Browser"]
        TABS["标签页 / 窗口"]
        DEBUG["Debugger API\nCDP 协议"]
        STOR["chrome.storage\n(local + session)"]
    end

    AI <-->|"stdin/stdout\n(JSON)"| NH
    NH <-->|"chrome.runtime.connectNative\n(request/notify/ping)"| NT
    NT <--> MR
    MR <--> CDP
    MR <--> TM
    MR <--> SM
    MR <--> WM
    CDP <-->|"attach/detach/sendCommand"| DEBUG
    TM <-->|"create/query/group/update"| TABS
    WM <-->|"create/close/focus"| TABS
    SM <-->|"读/写"| STOR
    MR <-->|"chrome.tabs.sendMessage"| CS
    MR <-->|"chrome.runtime.onMessage"| POP
    MR <-->|"chrome.runtime.onMessage"| SP
    CO <-->|"Shadow DOM + rAF"| TABS
    FB <-->|"DOM 操作"| TABS
```

---

## 二、核心数据流详解

### 2.1 AI 命令执行流

```mermaid
sequenceDiagram
    participant AI as AI Agent
    participant NH as Native Host
    participant NT as NativeTransport
    participant BG as Background SW
    participant CDP as CDP Executor
    participant Tab as Chrome Tab

    AI->>NH: JSON Command (CDP method + params)
    NH->>NT: port.postMessage(json)
    NT->>BG: 解析 & 路由命令

    alt CDP 命令
        BG->>CDP: executeCdp(tabId, method, params)
        CDP->>Tab: debugger.attach(tabId)
        CDP->>Tab: debugger.sendCommand(method, params)
        Tab-->>CDP: CDP Result / Event
        CDP-->>BG: 返回结果
    else 标签操作
        BG->>Tab: tabs.query/create/group/remove
        Tab-->>BG: Tab 对象
    else 窗口操作
        BG->>Tab: windows.create/focus/getCurrent
        Tab-->>BG: Window 对象
    else 数据查询
        BG->>Tab: history.search / bookmarks.*
        Tab-->>BG: 查询结果
    end

    BG->>NT: sendResponse(ok, data)
    NT->>NH: port.postMessage(response)
    NH->>AI: JSON Response
```

### 2.2 Agent 光标状态同步流

```mermaid
sequenceDiagram
    participant AI as AI Agent
    participant NH as Native Host
    participant BG as Background SW
    participant CS as Content Script
    participant DOM as Web Page DOM

    AI->>NH: 光标状态更新 (x, y, visible, moveSequence)
    NH->>BG: 转发状态消息
    BG->>BG: 存储 cursor state
    BG->>CS: chrome.tabs.sendMessage(type: AGENT_CURSOR_STATE)
    CS->>CS: Ft() 解析状态 → 弹簧动画目标
    CS->>CS: requestAnimationFrame 60fps 动画循环
    CS->>DOM: 更新 Shadow DOM overlay transform
    CS-->>BG: AGENT_CURSOR_ARRIVED (moveSequence + sessionId)
    BG->>NH: 转发抵达事件
    NH->>AI: 光标动画完成通知
```

### 2.3 内容脚本启动流

```mermaid
sequenceDiagram
    participant BG as Background SW
    participant CS as Content Script
    participant DOM as Page DOM
    participant MO as MutationObserver

    CS->>CS: WXT 框架注册 (match: <all_urls>)
    CS->>CS: x = chrome.runtime.onMessage 监听
    CS->>BG: 请求 GET_AGENT_CURSOR_STATE
    BG-->>CS: 当前光标状态
    CS->>DOM: 创建 #codex-agent-overlay-root
    CS->>DOM: attachShadow({mode: "closed"})
    CS->>DOM: 注入 CSS (z-index: 2147483646)
    CS->>DOM: 创建 cursor 容器 + img 元素
    CS->>MO: observe(documentElement, {childList: true})
    MO-->>CS: 检测覆盖层被移除 → 重新注入
    CS->>BG: CONTENT_PING (确认存活)
```

### 2.4 Favicon 徽章更新流

```mermaid
sequenceDiagram
    participant AI as AI Agent
    participant NH as Native Host
    participant BG as Background SW
    participant CS as Content Script
    participant DOM as Page DOM

    AI->>NH: 设置徽章 (tabId, badge: "active"/"deliverable"/"handoff")
    NH->>BG: 转发徽章命令
    BG->>BG: 查询 tab favIconUrl
    BG->>CS: chrome.tabs.sendMessage(TAB_FAVICON_BADGE)
    CS->>CS: mn(originalFavicon, badge) → SVG 合成
    CS->>CS: 查找 <link rel="icon"> 元素
    CS->>DOM: 替换 href = data:image/svg+xml,...
    CS->>DOM: 设置 data-codex-favicon-badge="true"

    Note over CS,DOM: 恢复时读取 data-codex-original-favicon-href
```

### 2.5 原生传输重连流

```mermaid
sequenceDiagram
    participant NT as NativeTransport
    participant AL as chrome.alarms
    participant NH as Native Host
    participant BG as Background SW

    NT->>NT: port.onDisconnect 触发
    NT->>NT: status = "disconnected"
    NT->>BG: 广播状态变更
    NT->>NT: scheduleReconnect()
    NT->>AL: alarms.create("native-transport-reconnect")
    
    loop 重连尝试
        AL->>NT: onAlarm("native-transport-reconnect")
        NT->>NT: reconnectAttempt++
        NT->>NH: chrome.runtime.connectNative()
        alt 连接成功
            NH-->>NT: port 建立
            NT->>NT: status = "connected"
            NT->>NT: 重置 reconnectAttempt
            NT->>AL: alarms.clear()
            NT->>BG: 广播状态变更
        else 连接失败
            NT->>NT: reconnectPending = true
            NT->>AL: 重新调度 (递增延迟)
        end
    end
```

### 2.6 心跳/保活流

```mermaid
sequenceDiagram
    participant BG as Background SW
    participant NT as NativeTransport
    participant NH as Native Host
    participant AI as AI Agent

    loop 每 N 秒
        BG->>BG: alarms.onAlarm("client-heartbeat-alarm")
        BG->>NT: ping()
        NT->>NH: port.postMessage({type: "ping"})
        NH->>AI: ping
        AI->>NH: pong
        NH->>NT: port.onMessage({type: "pong"})
        NT-->>BG: ping() Promise.resolve()
        
        alt 超时无响应
            NT->>NT: 标记 disconnect
            NT->>NT: scheduleReconnect()
        end
    end
```

### 2.7 下载监控流

```mermaid
sequenceDiagram
    participant BG as Background SW
    participant DL as chrome.downloads
    participant NH as Native Host
    participant AI as AI Agent

    DL->>BG: downloads.onCreated(downloadItem)
    BG->>BG: 记录下载信息
    BG->>NH: onDownloadChange({...downloadItem})
    NH->>AI: 下载开始通知

    DL->>BG: downloads.onChanged(downloadDelta)
    BG->>BG: 更新下载状态
    BG->>NH: onDownloadChange({...delta})
    NH->>AI: 下载进度/完成通知
```

---

## 三、消息格式规范

### 3.1 Native Messaging 消息格式

**请求**:
```json
{
  "type": "command_type",
  "tabId": 123,
  "sessionId": "abc...",
  "turnId": "def...",
  "params": {}
}
```

**响应**:
```json
{
  "ok": true,
  "type": "command_type",
  "data": {}
}
```

**通知** (无响应期望):
```json
{
  "type": "notification_type",
  "params": {}
}
```

### 3.2 内容脚本消息格式

参见 `src/types/index.ts` 中的 `AgentCursorEvent`、`FaviconBadgeMessage` 等类型定义。

---

## 四、Service Worker 生命周期

```mermaid
stateDiagram-v2
    [*] --> Installing: 扩展安装/更新
    Installing --> Active: install 事件
    Active --> Idle: 30s 无活动
    Idle --> Terminated: 内存压力/超时
    Terminated --> Active: 收到事件 (alarm/message/connect)
    
    state Active {
        [*] --> Init: 初始化 NativeTransport
        Init --> Connected: 原生主机连接成功
        Connected --> Disconnected: 断连
        Disconnected --> Reconnecting: 自动重连
        Reconnecting --> Connected: 重连成功
        Reconnecting --> Disconnected: 重连失败 (递增延迟)
    }
```

---

## 五、关键时序参数

| 参数 | 估计值 | 说明 |
|------|--------|------|
| 光标动画帧率 | 60fps (~16.67ms) | requestAnimationFrame |
| 弹簧仿真步长 | 1/240s (~4.17ms) | 物理仿真精度 |
| 心跳间隔 | ~30s | alarms.create 周期 |
| 重连延迟 | 递增 (1s, 2s, 4s, ...) | 指数退避 |
| Service Worker 空闲超时 | 30s | Chrome 默认 |
| 内容脚本重注入延迟 | 1s | 覆盖率检测间隔 |
