# BewlyBewly 数据流文档

> **版本**: 0.41.2 | **基于**: 逆向工程静态分析

---

## 一、全局数据流总览

```mermaid
flowchart TB
    subgraph Browser["浏览器标签页"]
        subgraph MAIN["MAIN World"]
            HISTORY["window.history<br/>(Bilibili SPA)"]
            INJECT["inject/index.js<br/>Hook pushState / replaceState"]
        end

        subgraph ISOLATED["ISOLATED World"]
            CS["contentScripts/index.global.js<br/>Vue 3 应用"]
            CSS["contentScripts/style.css<br/>CSS 变量 + 组件样式"]
        end

        DOM["Bilibili DOM<br/>(原有页面元素)"]
        WINDOW["window 对象<br/>(CustomEvent 桥接)"]
    end

    subgraph Extension["Chrome 扩展进程"]
        BG["dist/background/index.js<br/>Service Worker<br/>API 代理"]
        STORAGE["chrome.storage.local<br/>用户偏好"]
        DNR["declarativeNetRequest<br/>rules.json"]
    end

    subgraph Remote["Bilibili 服务端"]
        API["api.bilibili.com<br/>x/web-interface/*<br/>pgc/*<br/>xlive/* 等"]
        PASSPORT["passport.bilibili.com<br/>登录认证"]
    end

    HISTORY -->|"pushState/replaceState<br/>被拦截"| INJECT
    INJECT -->|"dispatchEvent<br/>CustomEvent('historyChange')"| WINDOW
    WINDOW -->|"addEventListener 监听"| CS
    CS -->|"chrome.runtime.sendMessage<br/>{contentScriptQuery: '...'}"| BG
    BG -->|"fetch() + 修改头"| DNR
    DNR -->|"Origin: www.bilibili.com<br/>Referer: www.bilibili.com"| API
    BG -->|"fetch()"| PASSPORT
    API -->|"JSON 响应"| BG
    PASSPORT -->|"JSON 响应"| BG
    BG -->|"sendResponse<br/>数据回传"| CS
    CS -->|"Vue 渲染<br/>DOM 操作"| DOM
    CS -->|"读/写"| STORAGE
```

---

## 二、首屏加载数据流

扩展安装后首次访问 `www.bilibili.com` 的完整时序：

```mermaid
sequenceDiagram
    actor User
    participant Tab as 标签页
    participant Inject as inject/index.js<br/>(MAIN world)
    participant CS as contentScripts/index.global.js<br/>(ISOLATED world)
    participant BG as background/index.js<br/>(Service Worker)
    participant API as api.bilibili.com
    participant Storage as chrome.storage.local

    Note over Tab: document_start

    Tab->>Inject: 加载并执行 (MAIN world)
    Inject->>Inject: hook history.pushState<br/>hook history.replaceState<br/>hook history.forward
    Inject->>Tab: window.___inject = true

    Tab->>CS: 加载并执行 (ISOLATED world)
    CS->>Storage: 读取用户配置
    Storage-->>CS: { theme, homepageConfig, ... }

    CS->>CS: 创建 Vue 3 应用实例
    CS->>CS: 挂载到 Bilibili 页面 DOM

    CS->>CS: 检测当前 URL → pageType

    alt pageType === 'home'
        CS->>BG: sendMessage({ contentScriptQuery: 'getRecommendVideos', ... })
        BG->>API: GET /x/web-interface/index/top/feed/rcmd?...
        API-->>BG: { code: 0, data: { item: [...] } }
        BG-->>CS: 解析后的 data
        CS->>CS: Vue 渲染推荐视频卡片

        CS->>BG: sendMessage({ contentScriptQuery: 'getUserInfo' })
        BG->>API: GET /x/web-interface/nav
        API-->>BG: { code: 0, data: { isLogin, uname, face, ... } }
        BG-->>CS: 用户信息
        CS->>CS: 更新顶栏头像/登录状态

        CS->>BG: sendMessage({ contentScriptQuery: 'getTopBarNewMomentsCount' })
        BG->>API: GET /x/web-interface/dynamic/entrance
        API-->>BG: { code: 0, data: { ... } }
        BG-->>CS: 动态未读数
        CS->>CS: 更新顶栏消息角标
    end

    CSS-->>Tab: CSS 变量 + 组件样式生效
    User->>Tab: 看到 BewlyBewly 重设计的首页
```

---

## 三、SPA 导航数据流

用户在 Bilibili 站点内导航（不刷新页面）时的数据流：

```mermaid
sequenceDiagram
    actor User
    participant BiliSPA as Bilibili SPA 路由
    participant Inject as inject/index.js<br/>(MAIN world)
    participant CS as Vue 3 应用<br/>(ISOLATED world)
    participant BG as Service Worker
    participant API as Bilibili API

    User->>BiliSPA: 点击导航链接<br/>(如: 搜索 → 视频详情)
    BiliSPA->>BiliSPA: history.pushState(url)
    
    Note over Inject: intercept 触发
    Inject->>Inject: 保存原始 pushState 引用
    Inject->>BiliSPA: 调用原始 pushState (保证原生行为)
    Inject->>CS: dispatchEvent(new CustomEvent('historyChange'))

    CS->>CS: 解析新 URL → pageType
    CS->>CS: Vue Router 切换到对应页面组件

    alt pageType === 'video'
        CS->>BG: sendMessage({ contentScriptQuery: 'getVideoInfo', bvid })
        BG->>API: GET /x/web-interface/view?bvid=...
        API-->>BG: 视频详情
        BG-->>CS: parsed data
        CS->>CS: 渲染视频信息面板

        CS->>BG: sendMessage({ contentScriptQuery: 'getVideoComments', oid })
        BG->>API: GET /x/v2/reply?oid=...
        API-->>BG: 评论列表
        BG-->>CS: parsed data
        CS->>CS: 渲染评论区域
    end

    User->>CS: 看到新页面的 BewlyBewly UI
```

---

## 四、API 代理层数据流

Background Service Worker 中的消息处理与请求转发：

```mermaid
flowchart TB
    subgraph Input["消息入口"]
        MSG["chrome.runtime.onMessage"]
    end

    subgraph Dispatch["路由分发"]
        CHECK{"contentScriptQuery<br/>是否存在?"}
        MAP{"FullAPI 查表"}
        DIRECT{"是否为函数?"}
    end

    subgraph Process["请求处理"]
        BUILD["构造 fetch 参数<br/>• 合并 params + 消息字段<br/>• 处理 GET/POST body<br/>• URLSearchParams 编码"]
        DO_FETCH["fetch(url, options)"]
    end

    subgraph After["后处理链"]
        JSON_PARSE["toJsonHandler<br/>.json() 解析"]
        JSON_DATA["toData<br/>提取 .data"]
        SEND_RESP["sendResponseHandler<br/>sendResponse(data)"]
    end

    MSG --> CHECK
    CHECK -->|"不存在"| ERR1["console.error 并返回"]
    CHECK -->|"存在"| MAP
    MAP -->|"未找到"| ERR2["console.error 并返回"]
    MAP -->|"找到"| DIRECT
    DIRECT -->|"是函数"| DIRECT_CALL["直接调用<br/>api(message, sender, sendResponse)"]
    DIRECT -->|"否 (API 配置对象)"| BUILD
    BUILD --> DO_FETCH
    DO_FETCH --> JSON_PARSE
    JSON_PARSE --> JSON_DATA
    JSON_DATA --> SEND_RESP

    style ERR1 fill:#f66,color:#fff
    style ERR2 fill:#f66,color:#fff
```

**后处理器组合 (afterHandle)**:

| 模式 | 处理器链 | 适用场景 |
|------|---------|---------|
| `J_D` | `.json()` → `toData` (提取 .data) | 大部分数据查询 API |
| `J_S` | `.json()` → `sendResponse` | 登录/认证 API (需要完整响应) |
| `S` | `sendResponse` (原样返回) | 特殊操作 (如标签页创建) |

---

## 五、存储数据流

```mermaid
flowchart LR
    subgraph CS["Content Script"]
        VUE["Vue 响应式状态"]
        WATCH["watch 监听变化"]
    end

    subgraph Storage["chrome.storage.local"]
        CONFIG["homepageConfig<br/>theme<br/>themeColor<br/>fontSettings<br/>hiddenSections"]
    end

    subgraph BG_WRITE["Background (间接写入)"]
        BG_MSG["onMessage<br/>特殊存储操作"]
    end

    VUE -->|"初始化时"| STORE_GET["chrome.storage.local.get()"]
    STORE_GET --> CONFIG
    CONFIG -->|"结果"| VUE

    WATCH -->|"用户修改配置"| STORE_SET["chrome.storage.local.set()"]
    STORE_SET --> CONFIG

    VUE -.->|"可选"| BG_MSG
    BG_MSG -.->|"需要时"| STORE_SET
```

---

## 六、declarativeNetRequest 规则触发流

```mermaid
sequenceDiagram
    participant CS as Content Script
    participant BG as Service Worker
    participant Chrome as Chrome Network Stack
    participant DNR as declarativeNetRequest
    participant API as api.bilibili.com

    CS->>BG: sendMessage({ contentScriptQuery: 'logout', biliCSRF: '...' })
    BG->>BG: 构造 POST 请求<br/>URL: passport.bilibili.com/login/exit/v2
    
    BG->>Chrome: fetch(url, { method: 'POST', body: ... })
    
    Note over Chrome,DNR: 请求发起前拦截
    Chrome->>DNR: 检查规则匹配
    DNR->>DNR: urlFilter: ||passport.bilibili.com ✓<br/>domainType: thirdParty ✓<br/>resourceTypes: xmlhttprequest ✓<br/>requestMethods: post ✓
    
    DNR->>Chrome: 修改请求头<br/>Origin → https://www.bilibili.com<br/>Referer → https://www.bilibili.com
    
    Chrome->>API: POST (带修改后的头)
    API-->>Chrome: 200 OK (Bilibili 服务端认为来自同源)
    Chrome-->>BG: Response
    BG-->>CS: sendResponse(data)
```

---

## 七、关键数据结构的运行时转换

```
Bilibili API 原始响应:
{
  "code": 0,
  "message": "0",
  "data": {
    "item": [
      { "id": 123, "title": "...", "owner": {...}, "stat": {...} },
      ...
    ]
  }
}

        │ toJsonHandler (response.json())
        ▼

{
  code: 0,
  message: "0",
  data: { item: [...] }
}

        │ toData (提取 .data)
        ▼

{
  item: [
    { id: 123, title: "...", owner: {...}, stat: {...} },
    ...
  ]
}

        │ sendResponse 回传给 content script
        ▼

Vue 组件接收 → computed/ref → 模板渲染
```
