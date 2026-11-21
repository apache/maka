# React Context DevTool v4.4 — 数据流文档

## 1. 整体数据流概览

```
用户页面 (MAIN world)          Content Script (ISOLATED)        Background (Service Worker)      UI (Panel/Popup)
     │                              │                                │                               │
     │  [React Fiber Tree]          │                                │                               │
     │         │                    │                                │                               │
     │   ① onCommitFiberRoot        │                                │                               │
     │         │                    │                                │                               │
     │   ② Hook 拦截 + Fiber 遍历   │                                │                               │
     │         │                    │                                │                               │
     │   ③ window.postMessage ─────►│                                │                               │
     │      (type: "CONTENT")       │                                │                               │
     │                              │  ④ chrome.runtime.connect ───►│                               │
     │                              │     (CONTEXT_DATA_UPDATED)     │                               │
     │                              │                                │  ⑤ 更新 Tab 状态缓存          │
     │                              │                                │         │                     │
     │                              │                                │  ⑥ chrome.runtime ──────────►│
     │                              │                                │     (CONTEXT_DATA)             │
     │                              │                                │                               │
     │                              │                                │◄── ⑦ 请求 (GET_CONTEXT_DATA) ──│
     │                              │                                │──► ⑧ 响应 (CONTEXT_DATA) ────►│
     │                              │                                │                               │
     │◄─ ⑨ DISPATCH_USE_REDUCER_ACTION ───────── (反向)             │                               │
     │                              │◄──────────────────────────────│◄──────────────────────────────│
```

## 2. 关键流程

### 2.1 React 检测与初始化

```mermaid
sequenceDiagram
    participant Page as 用户页面 (MAIN)
    participant CS as Content Script (ISOLATED)
    participant BG as Background (SW)
    participant MC as Main Content (MAIN)

    Page->>CS: document_start 注入 injectGlobalHook.js
    CS->>CS: 建立 content port → background
    Page->>Page: React App 启动, 挂载 __REACT_DEVTOOLS_GLOBAL_HOOK__
    Page->>CS: window.postMessage(type:"CONTENT", payload)
    Note over Page,CS: 来源: "react-devtools-detector" 或 "react-devtools-hook"
    CS->>BG: port 消息: REACT_JS_FOUND
    BG->>BG: 切换图标 + popup → popup.html
    BG->>BG: 读取设置 (chrome.storage.local)
    BG->>Page: chrome.scripting.executeScript({files:["mainContent.js"], world:"MAIN"})
    BG->>MC: port 消息: START_DEVTOOL (条件触发)
    MC->>MC: 初始化: __REACT_DEVTOOLS_GLOBAL_HOOK__ 注入
    MC->>MC: onCommitFiberRoot 监听 Fiber 提交
```

### 2.2 Context/useReducer 数据采集与上报

```mermaid
sequenceDiagram
    participant Fiber as React Fiber Commit
    participant MC as Main Content Script
    participant CS as Content Script
    participant BG as Background
    participant UI as DevTools Panel / Popup

    Fiber->>MC: onCommitFiberRoot(rendererId, root)
    MC->>MC: 100ms debounce
    MC->>MC: 遍历 Fiber 树 (current)
    loop 每个 Fiber 节点
        alt tag === 10 (Context.Provider)
            MC->>MC: 读取 memoizedProps.value, displayName
            MC->>MC: 对比上次值, 标记 valueChanged
        else useReducer hook (has baseState + queue)
            MC->>MC: Hook 拦截: lastRenderedReducer + dispatch
            MC->>MC: 捕获 action / state 变更
        end
    end
    MC->>MC: 聚合 contextKeys, useReducerKeys
    MC->>MC: 序列化 changed 条目 (JSON.stringify safe)
    MC->>CS: window.postMessage(CONTEXT_DATA_UPDATED)
    CS->>BG: port 消息: CONTEXT_DATA_UPDATED
    BG->>BG: 合并到 Tab 状态缓存 (增量更新)
    BG->>UI: port 消息: CONTEXT_DATA (推送)
    UI->>UI: React setState → 重新渲染界面
```

### 2.3 UI 数据查看

```mermaid
sequenceDiagram
    participant Panel as DevTools Panel
    participant BG as Background
    participant Popup as Popup

    Panel->>BG: port 连接: "devtool:{tabId}"
    Popup->>BG: port 连接: "popup"

    alt Panel/Popup 初始化
        Panel->>BG: GET_CONTEXT_DATA (带 currentTab 标记)
        BG->>Panel: CONTEXT_DATA (当前 tab 全量数据)
    else BG 主动推送
        BG->>Panel: CONTEXT_DATA (增量更新)
    end

    Note over Panel: 侧边栏列表: Context/useReducer 选择
    Note over Panel: 主体区域: Tree View / JSON Editor / Diff View
    Note over Panel: 切换视图: Tree (w-json-view) → JSON (CodeMirror) → Diff (jsondiffpatch)
```

### 2.4 Action Dispatch (时间旅行调试)

```mermaid
sequenceDiagram
    participant Panel as DevTools Panel
    participant BG as Background
    participant CS as Content Script
    participant MC as Main Content Script
    participant Hook as useReducer Hook

    Panel->>BG: DISPATCH_ACTION
    Note over Panel: { type: "useReducer", debugId, data }
    BG->>CS: DISPATCH_ACTION (port 转发)
    CS->>MC: window.postMessage(DISPATCH_USE_REDUCER_ACTION)
    MC->>MC: 查找 debugId 对应的 hook
    MC->>Hook: hook.queue.dispatch(data)
    Note over Hook: React 重新计算 state
    Hook->>MC: onCommitFiberRoot 再次触发
    MC->>CS: CONTEXT_DATA_UPDATED (新 state)
    CS->>BG: CONTEXT_DATA_UPDATED
    BG->>Panel: CONTEXT_DATA (刷新)
```

### 2.5 设置变更流程

```mermaid
sequenceDiagram
    participant Options as Options Page
    participant BG as Background
    participant CS as Content Script
    participant MC as Main Content Script

    Options->>BG: chrome.storage.local.set({...})
    BG->>BG: GET_SETTINGS handler → 内存同步
    Options->>BG: port 断开 (onDisconnect)

    alt startDebugWhenV2 === "extensionLoad"
        BG->>BG: 检查 port 连接状态 (popup / devtool)
        alt 有 port 连接
            BG->>CS: START_DEVTOOL ({settings})
        else 无 port 连接
            BG->>CS: STOP_DEVTOOL ({settings})
        end
    else startDebugWhenV2 === "pageLoad"
        BG->>CS: START_DEVTOOL ({settings}) (始终启动)
    end

    CS->>MC: window.postMessage(START_DEBUGGING | STOP_DEBUGGING)
    MC->>MC: startDebug() | stopDebug()
```

## 3. 通信协议详细说明

### 3.1 端口命名规范

| 端口名称模式 | 示例 | 说明 |
|-------------|------|------|
| `background` | `background` | 内置虚拟端口（非 Chrome 真实端口，内部消息转发用） |
| `content:{tabId}` | `content:123` | Content Script 端口（后台自动解析 "active" → 当前 tab ID） |
| `devtool:{tabId}` | `devtool:123` | DevTools Panel 端口 |
| `popup` | `popup` | Browser Action Popup 端口 |

### 3.2 window.postMessage 协议

| type | 方向 | eventName |
|------|------|-----------|
| `CONTENT_WINDOW` | Content Script → 主页面 | START_DEBUGGING, STOP_DEBUGGING, DISPATCH_USE_REDUCER_ACTION |
| `CONTENT` | 主页面 → Content Script | CONTEXT_DATA_UPDATED, REACT_JS_FOUND (via "react-devtools-detector"/"react-devtools-hook") |

### 3.3 消息生命周期

每条消息包含 `to`/`from`/`eventName`/`eventData` 字段。支持请求-响应模式：

1. 发送方调用 `sendMessage(to, eventName, eventData)`
2. 接收方在 `onMessage` 中处理，return 的值自动作为 `eventName::RESPONSE`
3. 异常自动转为 `eventName::RESPONSE_ERROR`
4. 30 秒超时后 reject Promise

## 4. 数据缓存策略

### 4.1 Background Tab 状态缓存 (`O` map)

```typescript
Map<tabId: number, TabDebugData> {
  tabId: number;
  tab: { title?: string };
  context: {                     // 增量更新：有新 key 则添加，缺少 key 则删除
    [debugId]: { oldValue, newValue }
  };
  useReducer: {                  // 增量更新
    [debugId]: { actions[], state[], displayName, hook, valueChanged }
  };
  reactInfo: { version, rendererPackageName };
  reactDevtoolPayload: { reactBuildType };
  isReactDetected: boolean;
}
```

- **写入时机**：CONTEXT_DATA_UPDATED 消息到达时（增量 merge）
- **清除时机**：Tab 关闭事件 (`chrome.tabs.onRemoved`)
- **读取时机**：UI 初始化 GET_CONTEXT_DATA 请求时

### 4.2 Settings 缓存

- 持久化：`chrome.storage.local` 中的 `startDebugWhenV2`、`debugUseReducer`、`debugContext` 三个键
- 内存：每次 `GET_SETTINGS` 请求时从 storage 读取最新值（无内存缓存，保证实时性）
