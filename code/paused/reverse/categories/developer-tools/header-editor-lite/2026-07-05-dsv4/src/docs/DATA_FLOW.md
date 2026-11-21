# Header Editor Lite - 数据流文档 (DATA_FLOW.md)

## 1. 启动流程

```mermaid
sequenceDiagram
    participant B as Browser
    participant SW as Service Worker
    participant IDB as IndexedDB
    participant DNR as declarativeNetRequest
    participant CDP as chrome.debugger

    B->>SW: 扩展安装/启动 (runtime.onStartup)
    SW->>SW: rA() 初始化
    SW->>IDB: 数据迁移检查 (version_mark)
    Note over SW,IDB: 迁移 v0→v1: localStorage→IndexedDB<br/>迁移 v1→v2: action 字段规范化

    SW->>IDB: 加载所有规则 (t7 for each table)
    IDB-->>SW: 规则数组 (t5 cache)

    SW->>SW: 初始化 DNR 处理器 (rf)
    SW->>SW: 初始化响应体修改器 (ru)
    SW->>SW: 加载偏好 (N.ready)

    SW->>DNR: updateSessionRules (addRules)
    SW->>CDP: 检查 Fetch 域启用条件
```

## 2. 规则保存流程

```mermaid
sequenceDiagram
    participant UI as Options/Popup
    participant SW as Service Worker
    participant IDB as IndexedDB
    participant Cache as 内存缓存 (t5)
    participant DNR as declarativeNetRequest
    participant Pub as Event Emitter (t6)

    UI->>SW: sendMessage({method:"save_rule", rule})
    SW->>SW: ri() 路由到对应 handler
    SW->>IDB: openCursor 获取现有规则
    IDB-->>SW: 现有规则 (或 null)

    alt 规则 ID 存在
        SW->>SW: deepClone + merge 规则字段
        SW->>IDB: put(mergedRule)
        SW->>Pub: emit RULE_UPDATE (from, target)
        SW->>UI: 返回合并后的规则
    else 新规则
        SW->>IDB: add(rule)
        IDB-->>SW: 新 ID
        SW->>Pub: emit RULE_UPDATE (null, target)
        SW->>UI: 返回带新 ID 的规则
    end

    SW->>Cache: reloadCache(tableName)

    alt 规则启用且 runner = dnr
        SW->>DNR: updateSessionRules
    end

    Pub-->>UI: onEvent RULE_UPDATE
    UI->>UI: 更新本地状态 (mutate)
```

## 3. 请求拦截流程

```mermaid
sequenceDiagram
    participant Browser
    participant DNR as declarativeNetRequest
    participant SW as Service Worker
    participant CDP as chrome.debugger
    participant Server

    Browser->>Browser: 发起 HTTP 请求

    alt DNR 规则 (cancel/redirect/headers)
        Browser->>DNR: 匹配 session rules
        DNR->>DNR: 检查 regexFilter/urlFilter/domains
        alt cancel
            DNR-->>Browser: 阻止请求
        else redirect
            DNR-->>Browser: 重定向到目标 URL
        else modify headers
            DNR-->>Browser: 修改后的请求/响应头
        end
    end

    alt CDP 规则 (modify response body)
        Browser->>CDP: Fetch.requestPaused 事件
        CDP->>SW: onEvent (tabId, requestId, ...)

        SW->>SW: re() 匹配规则
        Note over SW: 检查 URL、method、resourceType

        alt 规则匹配
            SW->>CDP: Fetch.getResponseBody
            CDP-->>SW: 响应体 (可能 base64)

            alt 规则有自定义函数
                SW->>SW: 执行 _func(body, context)
                Note over SW: context: {url, method, headers, ...}
            else 普通修改
                SW->>SW: 替换 body.value
            end

            SW->>SW: 合并 response headers
            SW->>CDP: Fetch.fulfillRequest (modified)

            alt header 值 = "_header_editor_remove_"
                SW->>SW: 从响应头中移除该 header
            end
        else 无匹配
            SW->>CDP: Fetch.continueRequest
        end
    end

    Browser->>Server: 实际 HTTP 请求 (如果未被取消)
    Server-->>Browser: HTTP 响应
```

## 4. URL 匹配逻辑

```mermaid
flowchart TD
    A[开始匹配] --> B{condition.all?}
    B -->|是| C[匹配成功]
    B -->|否| D{condition.url?}
    D -->|是| E{url === condition.url?}
    E -->|是| F[继续检查]
    E -->|否| G[不匹配]
    D -->|否| H{condition.urlPrefix?}
    H -->|是| I{url startsWith prefix?}
    I -->|是| F
    I -->|否| G
    H -->|否| J{condition.domain?}
    J -->|是| K{提取 URL 域名}
    K --> L{domains.includes domain?}
    L -->|是| F
    L -->|否| G
    J -->|否| M{condition.regex?}
    M -->|是| N{regex.test(url)?}
    N -->|是| F
    N -->|否| G
    M -->|否| O[默认匹配]
    O --> F

    F --> P{excludeDomain?}
    P -->|匹配| Q[匹配但排除]
    P -->|不匹配| R{excludeRegex?}
    R -->|匹配| Q
    R -->|不匹配| S{method check}
    S -->|不匹配| G
    S -->|匹配| T{resourceType check}
    T -->|不匹配| G
    T -->|匹配| C
```

## 5. 偏好同步流程

```mermaid
flowchart TD
    A[用户修改偏好] --> B{UI 类型}
    B -->|Options Page| C[setPrefs]
    B -->|Popup Panel| C

    C --> D[N.set(key, value)]
    D --> E[$().set({settings})]
    E --> F[chrome.storage.sync]

    D --> G[j.emit EVENT_PREFS_UPDATE]

    F --> H[storage.onChanged listener]
    H --> I{其他设备同步?}
    I -->|是| J[N.set(key, newValue, true)]
    J --> G

    G --> K{监听者}
    K -->|DNR Handler| L[rf.setDisableAll]
    K -->|CDP Handler| M[ru.checkEnable]
    K -->|Action Icon| N[ra update icon]
    K -->|Options Page| O[et.handleUpdate]
    K -->|Popup Panel| P[更新 UI 状态]
```

## 6. 云备份流程

```mermaid
sequenceDiagram
    participant UI as Options Page
    participant SW as Service Worker
    participant Sync as chrome.storage.sync

    UI->>SW: getAllRules()
    SW-->>UI: 所有规则 (ExportData)

    UI->>UI: 计算分片大小
    Note over UI: QUOTA_BYTES_PER_ITEM - 500

    loop 每个分片
        UI->>UI: 按表分配规则到分片
        UI->>Sync: set({backup_N: chunk})
    end

    UI->>Sync: set({backup: {time, index}})
    Note over Sync: 跨设备同步

    alt 恢复到其他设备
        UI->>Sync: get("backup")
        Sync-->>UI: {time, index}
        UI->>Sync: get(["backup_0", ..., "backup_N"])
        Sync-->>UI: 合并所有分片
        UI->>UI: 重组完整 ExportData
        UI->>SW: 逐条 saveRule()
    end
```

## 7. 组件间通信模式

```mermaid
flowchart LR
    subgraph Background
        SW[Service Worker]
        EM[t6 Event Emitter]
        IDB[(IndexedDB)]
        DNR[DNR Handler]
        CDP[CDP Handler]
        PREFS[Preferences]
    end

    subgraph UI Pages
        OPTIONS[Options Page]
        POPUP[Popup Panel]
    end

    subgraph Chrome APIs
        MSG[runtime.sendMessage]
        ONMSG[runtime.onMessage]
    end

    OPTIONS -->|sendMessage| MSG
    POPUP -->|sendMessage| MSG
    MSG --> ONMSG
    ONMSG --> SW

    SW --> EM
    EM -->|RULE_UPDATE| OPTIONS
    EM -->|RULE_DELETE| OPTIONS
    EM -->|RULE_UPDATE| POPUP
    EM -->|PREFS_UPDATE| OPTIONS
    EM -->|PREFS_UPDATE| POPUP

    SW --> IDB
    SW --> DNR
    SW --> CDP
    PREFS -->|sync| SW

    OPTIONS -.->|tabs.sendMessage<br/>(rule switch suggest)| POPUP
```

## 8. 数据存储总览

| 存储 | API | 用途 | 容量 |
|------|-----|------|------|
| IndexedDB (`headeditor`) | IndexedDB | 规则持久化存储 | 无限制 (unlimitedStorage) |
| `chrome.storage.sync` | storage.sync API | 偏好同步 + 云备份 | ~100KB |
| `chrome.storage.local` | storage.local API | 规则切换历史、common rules | ~10MB |
| `chrome.storage.session` | Proxy wrapper | 通知消息 (session 级) | ~10MB |
| 内存 (`t5` cache) | 变量 | 规则运行时缓存 | 页面生命周期 |

## 9. 数据迁移历史

| 版本标记 | 迁移内容 |
|----------|----------|
| version_mark < 1 | localStorage 中的 `groups` 和 `dl_history` 迁移到 IndexedDB 和 storage.local |
| version_mark < 2 | 规则 `action` 字段规范化: {name, value} → headers 字典 |

## 10. 关键数据结构序列化规则

1. **规则导出**: 移除所有运行时字段 (`_reg`, `_func`, `_v_key`, `_runner`, `_exclude`)
2. **规则导入**: 规范化旧格式字段 (`matchType`→`condition`, `action`→`headers`)
3. **DNR 规则 ID**: `ruleId * 100000 + tableOffset`
4. **云备份分片**: 每片 `< QUOTA_BYTES_PER_ITEM - 500 bytes`
5. **Switch history key**: `rule_switch_{tableName}-{ruleId}`
