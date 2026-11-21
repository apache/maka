# React Developer Tools v7.0.1 — 数据流文档

## 概述

本文档描述 React Developer Tools 中核心业务流程的数据流向，涵盖启动初始化、组件检查、性能分析和页面重载分析等关键场景。

---

## 1. 扩展启动与脚本初始化流

```mermaid
sequenceDiagram
    participant SW as Service Worker<br/>(background.js)
    participant CS as Content Script<br/>(ISOLATED)
    participant MW as Main World<br/>(page)
    participant Hook as __REACT_DEVTOOLS_GLOBAL_HOOK__

    SW->>SW: 启动
    SW->>SW: unregisterContentScripts() 清理旧脚本
    SW->>SW: registerContentScripts(4个脚本)

    Note over SW: proxy.js (ISOLATED, document_start)<br/>fileFetcher.js (ISOLATED, document_end)<br/>installHook.js (MAIN, document_start)<br/>hookSettingsInjector.js (ISOLATED, document_start)

    SW->>SW: tabs.query() 检查所有已打开Tab

    loop 每个 Tab
        alt 受限页面 (chrome://, about://)
            SW->>SW: setIcon("restricted") + setPopup("restricted.html")
        end
    end

    Note over MW: installHook.js 执行
    MW->>Hook: 挂载 window.__REACT_DEVTOOLS_GLOBAL_HOOK__

    Note over CS: hookSettingsInjector.js 执行
    CS->>SW: chrome.storage.local.get()
    SW-->>CS: 返回 Hook 设置
    CS->>MW: postMessage({settings})
    MW->>Hook: hook.settings = settings
```

---

## 2. React 检测与 Backend 激活流

```mermaid
sequenceDiagram
    participant Page as React 应用页面
    participant Hook as __REACT_DEVTOOLS_GLOBAL_HOOK__
    participant BEM as backendManager.js<br/>(MAIN world)
    participant Proxy as proxy.js<br/>(ISOLATED world)
    participant SW as Service Worker
    participant Backend as react_devtools_backend_compact.js

    Note over Page: React 渲染 → 调用 hook.emit("renderer-attached", ...)
    Hook->>Hook: renderers.set(id, rendererInterface)
    Hook->>BEM: 发送 "renderer" 事件

    BEM->>BEM: registerRenderer(renderer)
    BEM->>BEM: compareVersions() 检查版本兼容性
    BEM->>BEM: backends.has(version) ?

    alt backend 已注册
        BEM->>Backend: activateBackend(version, hook)
        Backend->>Backend: new Bridge({listen, send})
        Backend->>Backend: new Agent(bridge)
        Backend->>Backend: initBackend(hook, agent, window)
        Backend->>Proxy: bridge.send("extensionBackendInitialized")
    else backend 未注册
        BEM->>Proxy: postMessage({type: "require-backends", versions: [...]})
        Proxy->>SW: chrome.runtime.sendMessage()
        SW->>MW: chrome.scripting.executeScript(backend JS)
        Note over MW: 加载完成后 backends.set(version, backend)
    end

    BEM->>Proxy: postMessage("react-devtools-content-script", {hello: true})
    Proxy->>Proxy: connectPort() → chrome.runtime.connect("proxy")
```

---

## 3. DevTools 面板开通信流

```mermaid
sequenceDiagram
    participant User as 用户
    participant DT as DevTools Panel<br/>(main.js)
    participant SW as Service Worker
    participant Proxy as proxy.js
    participant MW as Main World
    participant Agent as Agent (backend)

    User->>DT: 打开 DevTools → "Components" 标签

    DT->>SW: chrome.runtime.connect(name: 数字tabId)
    Note over SW: 注册 extension port

    SW->>SW: registerTab(tabId)
    alt proxy port 已存在
        SW->>SW: connectExtensionAndProxyPorts(ext, proxy, tabId)
        Note over SW: 建立双向消息转发管道
    end

    DT->>SW: port.postMessage(event)
    SW->>Proxy: proxy.onMessage → 转发
    Proxy->>MW: window.postMessage(event)
    MW->>Agent: bridge.send(event, payload)
    Agent->>Agent: 处理请求 (inspectElement, getOwnersList 等)
    Agent->>MW: bridge.send("inspectedElement", data)
    MW->>Proxy: window.postMessage(response)
    Proxy->>SW: port.postMessage(response)
    SW->>DT: ext.onMessage → 转发
    DT->>DT: 渲染组件树 UI
```

---

## 4. 组件检查流（inspectElement）

```mermaid
sequenceDiagram
    participant DT as DevTools Panel
    participant SW as Service Worker
    participant Agent as Agent (backend)
    participant RI as RendererInterface
    participant React as React Reconciler

    DT->>SW: send("inspectElement", {id, path, rendererID})
    SW->>Agent: 消息转发
    Agent->>RI: inspectElement(requestID, id, path, forceFullData)
    RI->>React: 查询 Fiber 节点树
    React-->>RI: Fiber 节点数据
    RI-->>Agent: InspectedElementResult

    alt full-data
        Agent->>DT: send("inspectedElement", {type: "full-data", value})
        DT->>DT: 渲染 Props/State/Hooks/Context 面板
    else hydrated-path
        Agent->>DT: send("inspectedElement", {type: "hydrated-path", path, value})
        DT->>DT: 按需展开嵌套路径
    else no-change
        Agent->>DT: send("inspectedElement", {type: "no-change"})
        Note over DT: 无需更新 UI
    else not-found
        Agent->>DT: send("inspectedElement", {type: "not-found"})
        Note over DT: 显示 "元素不存在"
    end
```

---

## 5. 属性覆写流（overrideValueAtPath）

```mermaid
sequenceDiagram
    participant DT as DevTools Panel
    participant Agent as Agent (backend)
    participant RI as RendererInterface
    participant React as React Reconciler

    User->>DT: 在面板中编辑 Props/State/Hooks 值

    DT->>Agent: send("overrideValueAtPath", {id, path, rendererID, type, value})
    Agent->>Agent: overrideValueAtPath → 验证 + 分发

    alt type = "context"
        Agent->>RI: overrideValueAtPath("context", id, null, path, value)
    else type = "hooks"
        Agent->>RI: overrideValueAtPath("hooks", id, hookID, path, value)
    else type = "props"
        Agent->>RI: overrideValueAtPath("props", id, null, path, value)
    else type = "state"
        Agent->>RI: overrideValueAtPath("state", id, null, path, value)
    end

    RI->>React: 更新 Fiber 节点状态
    React->>React: 触发 re-render
    React->>RI: 新的 operations
    RI->>Agent: onHookOperations(operations)
    Agent->>DT: send("operations", data)
    DT->>DT: 更新 UI
```

---

## 6. 性能分析流（Profiling）

```mermaid
sequenceDiagram
    participant User as 用户
    participant DT as Profiler 面板
    participant Agent as Agent (backend)
    participant RI as RendererInterface
    participant React as React Reconciler

    User->>DT: 点击 "Start Profiling"
    DT->>Agent: send("startProfiling", {recordChangeDescriptions, recordTimeline})
    Agent->>Agent: _isProfiling = true
    Agent->>RI: startProfiling(recordChangeDescriptions, recordTimeline)
    RI->>React: 启用性能标记 (performance.mark)

    Note over User,React: ... 用户操作 React 应用 ...

    User->>DT: 点击 "Stop Profiling"
    DT->>Agent: send("stopProfiling")
    Agent->>RI: stopProfiling()
    RI->>React: 收集 profiling 数据
    RI-->>Agent: ProfilingData (commit 树、timing 数据)

    DT->>Agent: send("getProfilingData", {rendererID})
    Agent->>RI: getProfilingData()
    RI-->>Agent: ProfilingData
    Agent->>DT: send("profilingData", data)
    DT->>DT: 渲染火焰图 / 排行图
```

---

## 7. 重载并分析流（Reload and Profile）

```mermaid
sequenceDiagram
    participant User as 用户
    participant DT as DevTools Panel
    participant Agent as Agent (backend)
    participant SW as Service Worker

    User->>DT: 点击 "Reload and Profile"
    DT->>Agent: send("reloadAndProfile", {recordChangeDescriptions, recordTimeline})

    Agent->>Agent: onReloadAndProfile(recordChangeDescriptions, recordTimeline)
    Note over Agent: sessionStorage.setItem("React::DevTools::reloadAndProfile", "true")
    Note over Agent: sessionStorage.setItem("React::DevTools::recordChangeDescriptions", ...)
    Note over Agent: sessionStorage.setItem("React::DevTools::recordTimeline", ...)

    Agent->>DT: send("reloadAppForProfiling")
    DT->>DT: chrome.devtools.inspectedWindow.reload()

    Note over DT: 页面重新加载...

    Note over Agent: backendManager.js 启动后检查 sessionStorage
    Agent->>Agent: getIfReloadedAndProfiling() → true
    Agent->>Agent: new Agent(bridge, true, onReloadAndProfile)
    Agent->>Agent: 自动开始 profiling
```

---

## 8. 图标/弹窗状态切换流

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant Tab as Browser Tab
    participant Hook as __REACT_DEVTOOLS_GLOBAL_HOOK__

    Note over SW: 监听多种来源的状态变化

    rect rgb(200, 230, 255)
    Note over SW: 来源1: Tab 导航检查
    SW->>Tab: tabs.query() + tabs.onCreated + tabs.onUpdated
    Tab-->>SW: URL (chrome://, about://)
    SW->>SW: isRestrictedBrowserPage(url) ?
    SW->>SW: setIcon("restricted") + setPopup("restricted.html")
    end

    rect rgb(255, 230, 200)
    Note over SW: 来源2: React 构建类型报告
    Hook->>SW: {source: "react-devtools-hook", type: "react-renderer-attached", reactBuildType}
    SW->>SW: setIcon(reactBuildType) + setPopup("{reactBuildType}.html")
    Note over SW: reactBuildType ∈ {development, production, outdated, deadcode, unminified}
    end

    rect rgb(230, 255, 230)
    Note over SW: 来源3: Tab 激活事件
    SW->>SW: tabs.onActivated
    SW->>SW: 遍历所有 Tab 端口映射
    loop 每个有 proxy+extension 的 Tab
        alt tabId === 激活的 Tab
            SW->>SW: postMessage("resumeElementPolling")
        else
            SW->>SW: postMessage("pauseElementPolling")
        end
    end
    end
```

---

## 9. 文件获取流（Fetch File with Cache）

```mermaid
sequenceDiagram
    participant DT as DevTools Panel
    participant SW as Service Worker
    participant CS as fileFetcher.js<br/>(ISOLATED world)
    participant Server as Web Server

    DT->>SW: send("fetch-file-with-cache", {tabId, url})
    SW->>CS: tabs.sendMessage({source: "devtools-page", type: "fetch-file-with-cache", url})

    CS->>Server: fetch(url, {cache: "force-cache", signal: AbortSignal.timeout(60000)})

    alt 成功
        Server-->>CS: HTTP 200 + text content
        CS->>SW: sendMessage({type: "fetch-file-with-cache-complete", url, value})
        SW->>DT: 转发完整响应
    else 失败/超时
        CS->>SW: sendMessage({type: "fetch-file-with-cache-error", url, value: null})
        SW->>DT: 转发错误响应
    end
```

---

## 10. 元素高亮与追踪流

```mermaid
sequenceDiagram
    participant User as 用户
    participant DT as DevTools Panel
    participant Agent as Agent (backend)
    participant DOM as Browser DOM

    User->>DT: 悬停/hover 组件树中的组件
    DT->>Agent: send("highlightHostInstance", {id, rendererID})

    Agent->>Agent: rendererInterfaces[id].findHostInstancesForElementID(id)
    Agent->>Agent: 计算 nestedBoundingClientRect (含 iframe 嵌套)

    Agent->>DOM: 在页面上绘制彩色矩形 overlay
    Note over DOM: margin(橙) → border(黄) → padding(绿) → content(蓝)

    Agent->>DOM: 显示 tooltip (组件名 + 尺寸)

    opt 开启 traceUpdates
        Agent->>Agent: setTraceUpdatesEnabled(true)
        loop requestAnimationFrame
            Agent->>Agent: 持续跟踪 DOM 变化
            Agent->>DOM: 在 canvas 上绘制更新高亮
            Note over DOM: 颜色按更新频率渐变 (绿→黄→橙→红)
        end
    end

    User->>DT: 移出/取消悬停
    DT->>Agent: send("clearHostInstanceHighlight")
    Agent->>DOM: 移除 overlay + tooltip
```
