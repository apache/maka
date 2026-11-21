# Redux DevTools v3.2.10 — 数据流文档

## 整体通信架构

```
┌──────────────┐   postMessage    ┌──────────────┐  chrome.runtime  ┌──────────────┐  chrome.runtime  ┌──────────────┐
│  Page        │ ◄──────────────► │  Content     │ ◄──────────────► │  Background  │ ◄──────────────► │  DevTools    │
│  (MAIN)      │  @devtools-page  │  Script      │  port.connect   │  Service     │  port.connect   │  Panel       │
│              │  @devtools-ext   │  (Isolated)  │                 │  Worker      │                 │  (React UI)  │
└──────────────┘                  └──────────────┘                  └──────────────┘                  └──────────────┘
        ▲                                                                                                   ▲
        │                                                                                                   │
        │  chrome.storage.sync                                                                             │
        └───────────────────────────────────────────────────────────────────────────────────────────────────┘
        │                                                                                                   │
        ▼                                                                                                   │
┌──────────────┐                                                                                  ┌──────────────┐
│  Options     │                                                                                  │  Remote      │
│  Page        │                                                                                  │  DevTools    │
│  (React UI)  │                                                                                  │  (React UI)  │
└──────────────┘                                                                                  └──────────────┘
```

## 关键数据流

### 流程 1: 初始化连接

```mermaid
sequenceDiagram
    participant P as Page (MAIN)
    participant CS as Content Script
    participant BG as Background SW
    participant DT as DevTools Panel

    Note over P: Redux store 创建时调用<br/>__REDUX_DEVTOOLS_EXTENSION__()
    P->>CS: postMessage({type: "INIT_INSTANCE", instanceId})
    CS->>BG: chrome.runtime.connect({name: "tab"})
    BG->>DT: chrome.runtime.connect({name: "...")
    CS->>P: postMessage({type: "INIT_INSTANCE"}) // 确认

    Note over P: 读取 chrome.storage.sync 配置
    P->>CS: postMessage({type: "OPTIONS", options})
    CS->>DT: relay OPTIONS

    Note over P: 发送初始 state
    P->>CS: postMessage({type: "INIT", payload: serializedState})
    CS->>BG: relay INIT
    BG->>DT: relay INIT

    Note over DT: UI 渲染初始 state
    DT-->>BG: ready
    BG-->>CS: ready
    CS-->>P: ready
```

### 流程 2: Action 分派与记录

```mermaid
sequenceDiagram
    participant P as Page (MAIN)
    participant CS as Content Script
    participant BG as Background SW
    participant DT as DevTools Panel

    Note over P: dispatch({type: "ADD_TODO", text: "..."})
    P->>P: Lifted Store 执行 reducer
    P->>P: 记录 computedState
    P->>P: 应用过滤规则
    P->>P: 序列化 state (jsan)

    alt state 小于 32MB
        P->>CS: postMessage({type: "ACTION",<br/>payload: serializedState,<br/>action: serializedAction})
    else state 超过 32MB
        P->>CS: postMessage({split: "start", ...})
        loop 每个 chunk
            P->>CS: postMessage({split: "chunk", chunk: [key, valuePart]})
        end
        P->>CS: postMessage({split: "end", ...})
    end

    CS->>BG: port.postMessage({name: "RELAY", message})
    BG->>DT: relay message
    Note over DT: React UI 更新<br/>显示新 action 和 state
```

### 流程 3: 时间旅行 (Jump to Action)

```mermaid
sequenceDiagram
    participant User as 用户
    participant DT as DevTools Panel
    participant BG as Background SW
    participant CS as Content Script
    participant P as Page (MAIN)

    User->>DT: 点击某个历史 action
    DT->>BG: port.postMessage({type: "DISPATCH",<br/>payload: {type: "JUMP_TO_ACTION", actionId}})
    BG->>CS: relay DISPATCH
    CS->>P: postMessage({type: "DISPATCH",<br/>payload: {type: "JUMP_TO_ACTION", actionId}})
    P->>P: Lifted Store 重新计算状态链<br/>定位到目标 action 的状态
    P->>P: 更新页面 Redux store state
    P->>CS: postMessage({type: "STATE", payload: updatedState})
    CS->>BG: relay
    BG->>DT: relay
    Note over DT: UI 更新到对应位置
```

### 流程 4: 导入 State

```mermaid
sequenceDiagram
    participant User as 用户
    participant DT as DevTools Panel
    participant BG as Background SW
    participant CS as Content Script
    participant P as Page (MAIN)

    User->>DT: 粘贴 JSON 或选择文件
    DT->>DT: 反序列化 JSON
    DT->>BG: port.postMessage({type: "IMPORT", state: serialized})
    BG->>CS: relay IMPORT
    CS->>P: postMessage({type: "IMPORT", state: serialized})
    P->>P: jsan.parse() 反序列化
    P->>P: Lifted Store dispatch IMPORT_STATE
    P->>P: 重建 actionsById 和 computedStates
    P->>CS: postMessage({type: "STATE", payload: newLiftedState})
    CS->>BG: relay
    BG->>DT: relay
    Note over DT: UI 显示导入的完整历史
```

### 流程 5: 错误通知

```mermaid
sequenceDiagram
    participant P as Page (MAIN)
    participant CS as Content Script
    participant BG as Background SW
    participant DT as DevTools Panel
    participant OS as 系统通知

    Note over P: window.onerror 触发
    P->>P: throttled (每 5s 最多1次)
    P->>CS: postMessage({type: "ERROR", message})
    CS->>BG: relay ERROR
    BG->>DT: relay ERROR

    alt 页面不在焦点
        BG->>OS: chrome.notifications.create({...})
    end
```

### 流程 6: 选项同步

```mermaid
sequenceDiagram
    participant U as 用户
    participant OP as Options Page
    participant BG as Background SW
    participant CS as Content Script
    participant P as Page (MAIN)

    U->>OP: 修改设置 (如 maxAge, 过滤规则)
    OP->>OP: chrome.storage.sync.set({...})

    Note over P: 下次 INIT_INSTANCE 时
    P->>CS: 请求配置
    CS->>CS: chrome.storage.sync.get({...})
    CS->>P: postMessage({type: "OPTIONS", options})
    P->>P: 应用新配置
```

## 消息协议

### postMessage 通道 (page <-> content script)

消息格式: `window.postMessage(data, "*")`

| type | 方向 | 说明 |
|------|------|------|
| `INIT_INSTANCE` | Page → CS → BG | 新建 store 实例 |
| `DISPATCH` | DT → CS → Page | 执行 lifted action |
| `ACTION` | Page → CS → DT | 单个 action + state |
| `STATE` | Page → CS → DT | 完整 lifted state |
| `PARTIAL_STATE` | Page → CS → DT | 增量 state 更新 |
| `EXPORT` | Page → CS → DT | 导出 action 历史 |
| `IMPORT` | DT → CS → Page | 导入 state |
| `START` | DT → CS → Page | 开始监听 |
| `STOP` | DT → CS → Page | 停止监听 |
| `ERROR` | CS → BG | 运行时错误 |
| `OPTIONS` | CS → Page | 配置更新 |
| `OPEN` | Page → CS → BG | 打开 DevTools 窗口 |
| `DISCONNECT` | Page → CS | 断开连接 |

### 消息大小控制

- 消息大小限制: 32 MB (Chrome 扩展消息上限)
- 超大消息自动拆分为 chunk (start → chunk[] → end)
- 每个 chunk 包含 `[key, partialValue]` 对

## 状态生命周期

```
INIT ──► START ──► PERFORM_ACTION ──► (循环) ──► COMMIT/RESET ──► STOP
                    │                    │
                    ├── TOGGLE_ACTION    ├── ROLLBACK
                    ├── JUMP_TO_*        ├── SWEEP
                    ├── REORDER_ACTION   ├── IMPORT_STATE
                    ├── LOCK_CHANGES     └── PAUSE_RECORDING
                    └── SET_ACTIONS_ACTIVE
```

- `PAUSE_RECORDING`: 暂停记录但保留历史
- `LOCK_CHANGES`: 锁定所有变更
- `COMMIT`: 将当前"时间旅行"状态固定为新的基准
- `ROLLBACK`: 回到上次 commit 状态
- `SWEEP`: 清除所有被 skip 的 action
