# Proxy SwitchyOmega (V3) v3.0.5 — 数据流文档

## 概述

本文档描述 Proxy SwitchyOmega 的三大核心数据流:
1. **代理决策流** — URL 请求如何匹配到代理配置
2. **用户配置流** — 用户在 UI 中的操作如何持久化并生效
3. **扩展间通信流** — 外部扩展如何控制和查询代理状态

---

## 1. 代理决策流 (Proxy Decision Flow)

当用户在浏览器中访问一个 URL 时, SwitchyOmega 决定使用哪个代理配置。

```mermaid
sequenceDiagram
    participant Browser as Chrome 浏览器
    participant SW as Service Worker<br/>(background.js)
    participant Storage as chrome.storage.local
    participant OmegaPac as OmegaPac 引擎
    participant ProxyAPI as chrome.proxy API

    Note over Browser, SW: 1. 请求前决策 (PAC 脚本模式)
    Browser->>SW: 导航到 https://example.com
    SW->>Storage: 读取配置 (options)
    Storage-->>SW: 返回完整 OmegaOptions
    SW->>OmegaPac: Conditions.requestFromUrl("https://example.com")
    OmegaPac-->>SW: WebRequest {url, host, protocol}
    SW->>OmegaPac: options.matchProfile(request)
    
    Note over OmegaPac: 2. 配置匹配遍历
    OmegaPac->>OmegaPac: 获取当前活动配置 (currentProfile)
    
    alt 配置类型 = SwitchProfile
        OmegaPac->>OmegaPac: 遍历 rules[]
        loop 每条规则
            OmegaPac->>OmegaPac: 评估 condition (HostWildcard/UrlRegex/IP/...)
            alt 条件匹配
                OmegaPac-->>OmegaPac: 返回对应 profileName
            end
        end
        OmegaPac->>OmegaPac: 无匹配 → 返回 defaultProfileName
    else 配置类型 = VirtualProfile
        OmegaPac->>OmegaPac: 递归查找 defaultProfileName
    else 配置类型 = FixedProfile
        OmegaPac-->>SW: 返回代理服务器配置
    end

    Note over SW, ProxyAPI: 3. 代理应用
    SW->>ProxyAPI: chrome.proxy.settings.set({value: {...}})
    ProxyAPI->>Browser: 代理配置生效
    Browser->>Browser: 通过配置的代理请求 example.com

    Note over SW: 4. Icon/Badge 更新
    SW->>SW: drawIcon(resultColor, profileColor)
    SW->>Browser: chrome.action.setIcon / setBadgeText
```

### 代理配置优先级

```mermaid
flowchart TD
    A[URL 请求] --> B{是否有临时规则?}
    B -->|是| C[应用临时规则指定的配置]
    B -->|否| D{当前配置类型?}
    D -->|SwitchProfile| E[遍历条件规则列表]
    E --> F{条件匹配?}
    F -->|匹配| G[使用匹配到的配置]
    F -->|不匹配| H[使用默认配置]
    D -->|VirtualProfile| I[递归查找 defaultProfileName]
    D -->|FixedProfile| J[使用固定代理服务器]
    D -->|PacProfile| K[使用 PAC 脚本]
    D -->|DirectProfile| L[直接连接]
    D -->|SystemProfile| M[使用系统代理]
    G --> N{目标配置类型?}
    H --> N
    I --> N
    N -->|也是 VirtualProfile| I
    N -->|FixedProfile| O[设置 chrome.proxy 为 fixed_servers]
    N -->|PacProfile| P[设置 chrome.proxy 为 pac_script]
    N -->|DirectProfile| Q[设置 chrome.proxy 为 direct]
    N -->|SystemProfile| R[设置 chrome.proxy 为 system]
```

---

## 2. 用户配置流 (User Configuration Flow)

用户通过 Options 页面或 Popup 面板修改配置的全流程。

```mermaid
sequenceDiagram
    participant User as 用户
    participant UI as Options 页面<br/>(AngularJS)
    participant OmegaWeb as omegaTarget 服务<br/>(omega_target_web.js)
    participant SW as Service Worker<br/>(background.js)
    participant Storage as Storage 层
    participant State as State 层<br/>(localStorage)

    Note over User, UI: 阶段 A: 页面加载
    User->>UI: 打开 chrome-extension://xxx/options.html
    UI->>OmegaWeb: omegaTarget.refresh()
    OmegaWeb->>SW: chrome.runtime.sendMessage({method: "getAll"})
    SW->>Storage: storage.getAll()
    Storage-->>SW: 返回 options + profiles
    SW-->>OmegaWeb: {result: options}
    OmegaWeb->>UI: $rootScope.options = options
    UI->>UI: AngularJS 渲染所有配置

    Note over User, SW: 阶段 B: 修改配置
    User->>UI: 修改代理 host/port/规则
    UI->>UI: $rootScope.optionsDirty = true
    User->>UI: 点击 "Apply Changes"
    UI->>UI: jsondiffpatch.diff(oldOptions, newOptions) → patch
    UI->>OmegaWeb: omegaTarget.optionsPatch(patch)
    OmegaWeb->>SW: chrome.runtime.sendMessage({method: "patch", args: [patch]})
    SW->>Storage: storage.setPatch(patch)
    SW->>State: state.set(...)
    SW-->>OmegaWeb: {result: ok}
    OmegaWeb->>UI: omegaTarget.refresh() 重新加载
    UI->>UI: showAlert("Options saved")

    Note over SW, State: 阶段 C: 代理立即生效
    SW->>SW: options.currentProfileChanged(reason)
    SW->>SW: 重新执行代理决策流
    SW->>SW: 更新 icon + badge + title

    Note over User, SW: 阶段 D: Popup 快速切换
    User->>UI: 点击 Popup 中的配置名
    UI->>SW: chrome.runtime.sendMessage({method: "applyProfile", noReply: true})
    SW->>State: state.set({currentProfileName: name})
    SW->>SW: options.setCurrentProfile(name)
    SW->>SW: 重新计算代理 → 更新 icon
    SW->>SW: refreshActivePage() 刷新当前页面
```

### 配置持久化存储模型

```mermaid
flowchart LR
    subgraph "chrome.storage.local"
        A["key: 'omega.local.options'<br/>存储完整 OmegaOptions 对象<br/>如 {'+proxy': FixedProfile, ...}"]
    end

    subgraph "chrome.storage.sync (可选)"
        B["key: 'omega.sync.options'<br/>跨设备同步配置<br/>transformValue 处理精简化"]
    end

    subgraph "localStorage (omega.local.*)"
        C["currentProfileName"]
        D["firstRun"]
        E["syncOptions"]
        F["web.restoreOnlineUrl"]
        G["web.last_url"]
        H["customCss"]
        I["refreshOnProfileChange"]
    end

    subgraph "IndexedDB (via idb-keyval)"
        J["key: 'localStorage'<br/>localStorage 的持久化后端<br/>(Service Worker 环境)"]
    end

    A -->|默认读写| 配置数据
    C -->|运行时状态| 配置数据
    F -->|URL 恢复| 配置数据
    J -.->|polyfill 映射| C
```

---

## 3. 扩展间通信流 (External API Flow)

允许其他扩展通过 `chrome.runtime.sendMessage` 控制 SwitchyOmega。

```mermaid
sequenceDiagram
    participant OtherExt as 其他扩展
    participant SW as Service Worker<br/>(background.js)
    participant ExtAPI as ExternalApi 实例
    participant Options as Options 实例

    Note over OtherExt, ExtAPI: 外部扩展发送消息
    OtherExt->>SW: chrome.runtime.sendMessage(<br/>  OMEGA_ID, {method: "setProfile", ...})
    SW->>ExtAPI: externalApi._onMessage(request, sender)
    
    alt method = "setProfile"
        ExtAPI->>ExtAPI: 验证 sender.id 在白名单?<br/>验证 profileName 存在?
        ExtAPI->>Options: setCurrentProfile(profileName)
        Options->>Options: 重新计算代理
        ExtAPI-->>OtherExt: {result: "ok"}
    else method = "getState"
        ExtAPI->>Options: 读取当前状态
        ExtAPI-->>OtherExt: {result: stateData}
    else method = "addProfile"
        ExtAPI->>ExtAPI: 验证 profile 数据结构
        ExtAPI->>Options: 添加到 options 并存储
        ExtAPI-->>OtherExt: {result: "ok"}
    else 未授权
        ExtAPI-->>OtherExt: {error: "not authorized"}
    end
```

---

## 4. 内容脚本数据流

```mermaid
sequenceDiagram
    participant Page as 网页 (Window)
    participant CS as content_scripts.js
    participant SW as Service Worker

    Note over Page, CS: 页面 URL 变更检测
    Page->>CS: popstate 事件 / 页面加载
    CS->>CS: reportURLChange()
    CS->>SW: chrome.runtime.sendMessage({<br/>  type: "url-change",<br/>  hasTransition: !document.referrer})
    
    Note over SW: 分析统计采集
    SW->>SW: page_statistics.js 监听
    alt hasTransition = true (用户主动跳转)
        SW->>SW: tabInfo(tabId).hasTransition = true
    end
    SW->>SW: tabInfo(tabId).url = currentUrl
```

---

## 5. 代理外部变更检测流

```mermaid
sequenceDiagram
    participant Chrome as Chrome 浏览器
    participant SW as Service Worker
    participant Options as Options 实例

    Note over Chrome, Options: 监听代理设置被其他扩展/策略修改
    Chrome->>SW: proxyImpl.watchProxyChange(details)
    
    alt details.levelOfControl = controlled_by_other_extensions
        SW->>Options: setProxyNotControllable("app")
        SW->>SW: showWarning("Another extension is controlling proxy")
    else details.levelOfControl = not_controllable
        SW->>Options: setProxyNotControllable("policy")
        SW->>SW: showWarning("Proxy controlled by policy")
    else details.levelOfControl = controlled_by_this_extension
        SW->>Options: setProxyNotControllable(null)
        SW->>SW: 恢复正常图标
    else 外部应用设置了系统代理
        SW->>SW: proxyImpl.parseExternalProfile(details)
        SW->>Options: setExternalProfile(parsed)
        Options->>Options: currentProfileChanged("external")
        SW->>SW: 更新图标为 external 状态
    end
```

---

## 6. 规则列表 (RuleList) 在线更新流

```mermaid
sequenceDiagram
    participant User as 用户
    participant Options as Options 实例
    participant SW as Service Worker
    participant Remote as 远程 URL

    User->>Options: 触发 updateProfile(name)
    Options->>SW: options.updateProfile(name)

    alt 规则列表配置 (RuleListProfile)
        SW->>Remote: fetch(sourceUrl, {cache: "bypass"})
        Remote-->>SW: 返回规则列表文本
        SW->>SW: OmegaPac.RuleList.Switchy.parse(text)
        SW->>SW: 验证引用的配置名是否存在
        SW->>SW: 更新 attached ruleList 和 lastUpdate
        SW-->>Options: {profileName: RuleListProfile}
    else PAC 配置 (PacProfile)
        SW->>Remote: fetch(pacUrl, {cache: "bypass"})
        Remote-->>SW: 返回 PAC 脚本
        SW->>SW: 更新 pacScript 和 lastUpdate
        SW-->>Options: {profileName: PacProfile}
    end
    
    Options->>Options: 重新执行代理决策 (如果当前使用该配置)
```

---

## 7. 数据存储层级总结

| 存储层 | 用途 | 数据量 | 同步 | 持久性 |
|---|---|---|---|---|
| `chrome.storage.local` | 配置主数据 (所有 profiles + rules) | KB ~ MB | 否 | 永久 (不清除) |
| `chrome.storage.sync` | 跨设备配置同步 | 有限 (100KB) | 是, Chrome Sync | 永久 |
| `localStorage` (omega.local.*) | 运行时状态 (当前配置、首次运行标记等) | < 1KB | 否 | 清除即丢失 |
| `IndexedDB` (idb-keyval) | localStorage polyfill 后端 | < 1KB | 否 | 永久 |
| 图标缓存 (内存) | 动态生成的彩色 icon ImageData | 几 KB | 否 | 会话期 |
| 日志 (localStorage['log']) | 错误日志和调试日志 | 增长中 | 否 | 限制 5MB |
