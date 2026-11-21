# Tab Session Manager v7.3.0 — 数据流文档

## 一、组件通信概览

```mermaid
flowchart TB
    subgraph UI["UI 层"]
        Popup["Popup (React)\npopup.js"]
        Options["Options (React)\noptions.js"]
        Replaced["Replaced Page\nreplaced.js"]
    end

    subgraph BG["后台层"]
        SW["Service Worker\nbackground.js"]
        Alarm["chrome.alarms\n定时触发"]
    end

    subgraph Ext["外部接口"]
        Offscreen["Offscreen Document\noffscreen.js"]
        Drive["Google Drive API\n云端同步"]
        Download["本地文件系统\n下载/导入"]
    end

    subgraph Storage["存储层"]
        IDB["IndexedDB\nsessions"]
        Local["chrome.storage.local\nsettings"]
    end

    Popup <-->|"browser.runtime.sendMessage"| SW
    Options <-->|"browser.runtime.sendMessage"| SW
    Replaced -->|"browser.runtime.sendMessage"| SW
    SW -->|"browser.runtime.sendMessage"| Offscreen
    SW <--> Storage
    SW <-->|"OAuth 2.0 + REST"| Drive
    SW -->|"browser.downloads.download"| Download
    Download -->|"browser.runtime.sendMessage"| SW
    Alarm -->|"onAlarm"| SW
```

## 二、核心业务流程

### 2.1 保存会话

```mermaid
sequenceDiagram
    participant User
    participant Popup as Popup (React)
    participant SW as Service Worker
    participant IDB as IndexedDB

    User->>Popup: 点击"保存"按钮
    Popup->>Popup: 获取会话名称输入

    alt 保存所有窗口
        Popup->>SW: sendMessage({message:"saveCurrentSession", name, allWindows:true})
    else 仅当前窗口
        Popup->>SW: sendMessage({message:"saveCurrentSession", name, allWindows:false})
    end

    SW->>SW: browser.windows.getAll({populate:true})
    SW->>SW: 构建 Session 对象
    Note over SW: {id:uuid, name, windows:[{tabs:[...]}], date:ISO8601}

    SW->>IDB: idb.put('sessions', session)
    IDB-->>SW: 写入成功

    alt 启用云端同步
        SW->>SW: 上传到 Google Drive
    end

    SW-->>Popup: {message:"sessionSaved"}

    alt 启用自动备份
        SW->>SW: 导出会话到下载文件夹
    end
```

### 2.2 恢复会话

```mermaid
sequenceDiagram
    participant User
    participant Popup as Popup (React)
    participant SW as Service Worker
    participant Chrome as Chrome Tabs API

    User->>Popup: 点击会话的"打开"按钮

    alt 在新窗口打开
        Popup->>SW: sendMessage({message:"openSession", sessionId, mode:"newWindow"})
        SW->>Chrome: windows.create({})
        loop 每个标签页
            SW->>Chrome: tabs.create({url, active, pinned, index, windowId})
            Note over Chrome: 若 ifLazyLoading，使用 discarded:true
        end
    else 在当前窗口打开
        Popup->>SW: sendMessage({message:"openSession", mode:"currentWindow"})
        SW->>Chrome: tabs.query({currentWindow:true})
        SW->>Chrome: tabs.remove(existingTabIds)
        loop 每个标签页
            SW->>Chrome: tabs.create({url, windowId:currentWindow})
        end
    else 添加到当前窗口
        Popup->>SW: sendMessage({message:"openSession", mode:"addToCurrent"})
        loop 每个标签页
            SW->>Chrome: tabs.create({url, windowId:currentWindow})
        end
    end

    Note over Chrome: 若启用 TST，逐标签恢复树结构
```

### 2.3 自动保存流程

```mermaid
flowchart TD
    subgraph Triggers["触发源"]
        Alarm["chrome.alarms\n(定时, X 分钟)"]
        WinClose["windows.onRemoved\n窗口关闭"]
        BrowserExit["runtime.onSuspend\n浏览器退出"]
    end

    Triggertimer["定时保存"] -->|interval| CheckSettings
    Triggers["窗口关闭"] -->|winClose| CheckSettings
    Triggerexit["浏览器退出"] -->|suspend| CheckSettings

    CheckSettings{"检查设置"}
    CheckSettings -->|"ifAutoSave = true"| SaveRegular["保存当前所有窗口\n名称: 'Auto Save - Regularly'"]
    CheckSettings -->|"ifAutoSaveWhenClose"| CheckMinTabs{"标签数 >= 最小阈值?"}
    CheckMinTabs -->|是| SaveWinClose["保存关闭的窗口\n名称: 'Auto Save - Window closed'"]
    CheckMinTabs -->|否| Skip["跳过"]
    CheckSettings -->|"ifAutoSaveWhenExitBrowser"| SaveExit["保存所有窗口\n名称: 'Auto Save - Browser exited'"]

    SaveRegular --> LimitCheck{"超过 autoSaveLimit?"}
    SaveWinClose --> LimitCheck2{"超过 whenCloseLimit?"}
    SaveExit --> LimitCheck3{"超过 whenExitLimit?"}

    LimitCheck -->|是| DeleteOldest["删除最旧的自动保存"]
    LimitCheck2 -->|是| DeleteOldest2["删除最旧的退出保存"]
    LimitCheck3 -->|是| DeleteOldest3["删除最旧的定期保存"]

    DeleteOldest --> Save["写入 IndexedDB"]
    DeleteOldest2 --> Save
    DeleteOldest3 --> Save
```

### 2.4 云端同步 (Google Drive)

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant Auth as Google OAuth
    participant Drive as Google Drive API
    participant IDB as IndexedDB

    Note over SW,IDB: 初始化阶段

    SW->>Auth: browser.identity.launchWebAuthFlow()
    Auth-->>SW: authorization_code
    SW->>Auth: POST oauth2/v4/token (exchange code)
    Auth-->>SW: {access_token, refresh_token}
    Note over SW: 令牌加密存储到 chrome.storage.local

    Note over SW,Drive: 同步 - 上传

    SW->>IDB: 获取所有会话
    IDB-->>SW: sessions[]

    loop 每个会话
        SW->>Drive: GET drive/v3/files?q=name='{session.id}.json'
        Drive-->>SW: 文件存在/不存在

        alt 文件存在
            SW->>Drive: PATCH upload/drive/v3/files/{fileId}
        else 文件不存在
            SW->>Drive: POST upload/drive/v3/files
        end
        SW->>IDB: 更新 session.driveFileId
    end

    Note over SW,Drive: 同步 - 下载

    SW->>Drive: GET drive/v3/files (appfolder)
    Drive-->>SW: files[]

    loop 每个云端文件
        SW->>Drive: GET drive/v3/files/{fileId}
        Drive-->>SW: 会话 JSON
        alt 本地不存在 或 云端更新
            SW->>IDB: put session
        end
    end
```

### 2.5 会话导出/导入

```mermaid
flowchart LR
    subgraph Export["导出"]
        UserExport["用户操作: 导出会话"]
        UserExport --> GetAll["获取所有会话<br/>从 IndexedDB"]
        GetAll --> BuildJSON["构建 JSON 结构<br/>{version, sessions[], exportDate}"]
        BuildJSON --> Offscreen["发送到 Offscreen Document"]
        Offscreen --> CreateBlob["URL.createObjectURL(JSON Blob)"]
        CreateBlob --> Download["browser.downloads.download()"]
    end

    subgraph Import["导入"]
        UserImport["用户操作: 导入文件"]
        UserImport --> ReadFile["FileReader 读取文件"]
        ReadFile --> ParseJSON["解析 JSON"]
        ParseJSON --> Validate["验证数据结构"]
        Validate --> Merge["合并到 IndexedDB\n(去重: 按 id)"]
        Merge --> Notify["通知 UI 刷新列表"]
    end
```

### 2.6 会话追踪 (Tracking)

```mermaid
flowchart TD
    Start["用户: 对会话选择 'Track window changes'"]
    Start --> Register["SW: 监听 windows.onRemoved, tabs.* 事件"]
    Register --> Mark["标记该会话为 'tracking'"]

    Event["窗口/标签页变化事件"]
    Event --> IsTracking{"正在追踪此会话?"}

    IsTracking -->|是| TabCreate["tabs.onCreated"]
    IsTracking -->|是| TabRemove["tabs.onRemoved"]
    IsTracking -->|是| TabUpdate["tabs.onUpdated"]

    TabCreate --> ShouldTrackNew{"shouldTrackNewWindow?"}
    ShouldTrackNew -->|是| AddTab["添加新标签到会话"]
    ShouldTrackNew -->|否| IgnoreNewWindow["忽略新窗口的标签"]

    TabRemove --> RemoveTab["从会话中移除标签"]
    TabUpdate --> UpdateTab["更新会话中的标签信息"]

    AddTab --> SaveTrack["更新 IndexedDB 中的会话"]
    RemoveTab --> SaveTrack
    UpdateTab --> SaveTrack

    Stop["用户: 停止追踪"]
    Stop --> Unregister["SW: 取消事件监听"]
```

## 三、消息类型完整列表

| 消息类型 | 发送方 | 接收方 | 说明 |
|----------|--------|--------|------|
| `saveCurrentSession` | Popup/快捷键 | SW | 保存当前会话 |
| `requestAllSessions` | Popup/Options | SW | 请求所有会话列表 |
| `responseAllSessions` | SW | Popup/Options | 返回所有会话 |
| `deleteSession` | Popup | SW | 删除指定会话 |
| `updateSession` | Popup | SW | 更新会话 (重命名、加标签) |
| `getCurrentSession` | Popup | SW | 获取当前浏览器状态 |
| `backupAllSessions` | Options | SW | 触发全量备份 |
| `compressAllSessions` | Options | SW | 压缩所有会话的 favicon |
| `updateCompressStatus` | SW | Options | 压缩进度通知 |
| `signInGoogle` | Options | SW | 触发 Google 登录 |
| `signOutGoogle` | Options | SW | 触发 Google 登出 |
| `updateSyncStatus` | SW | Options | 同步状态通知 |
| `updateTrackingStatus` | SW | Popup | 追踪状态通知 |
| `updateUndoStatus` | SW | Popup/Options | 撤销状态更新 |
| `applyDeviceName` | Options | SW | 批量添加设备名称标签 |
| `importSessions` | Options | SW | 导入会话数据 |
| `exportSessions` | Options | SW | 导出所有会话 |
| `deleteAllSessions` | Options | SW | 删除所有会话 |
| `migrateSessionsFromStorage` | 启动 | SW | 从旧格式迁移数据 |
| `offscreen_createObjectUrl` | SW | Offscreen | 创建下载 Blob URL |
| `offscreen_revokeObjectUrl` | SW | Offscreen | 释放 Blob URL |
