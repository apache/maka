# crxMouse 数据流文档

> 逆向工程分析 | v7.0.5 | 2026-07-06

---

## 概述

本文档描述 crxMouse Chrome Gestures 扩展的数据流动路径，覆盖手势识别、配置同步、广告检测、分析上报等关键数据流。

---

## 一、鼠标手势识别流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant CS5 as contentStart.js<br/>(document_start)
    participant CS3 as contentEnd.js<br/>(document_end)
    participant CS1 as content.js+jQuery<br/>(document_start)
    participant SW as service_worker.js
    participant Storage as chrome.storage

    Note over CS5: 初始化 MpiUO 模块系统
    CS5->>CS5: 注入 eventPriority.js
    CS5->>CS5: 初始化 kBx (反馈队列)
    CS5->>CS5: 初始化 kJoHB (生命周期)

    Note over CS3: DOM 就绪后
    CS3->>Storage: 读取 proconstantinator_key
    Storage-->>CS3: 混淆常量表
    CS3->>CS3: lNV 模块就绪
    CS3->>CS3: jfq 引擎就绪
    CS3->>CS3: RWf/XJZ/WwI 模块就绪

    Note over CS1: 最核心的手势逻辑
    CS1->>SW: 查询手势配置
    SW-->>CS1: 手势规则列表

    User->>CS1: 按下右键 (mousedown)
    CS1->>CS1: 记录起始坐标
    User->>CS1: 移动鼠标 (mousemove)
    CS1->>CS1: 采集轨迹点
    CS1->>CS1: 绘制轨迹线 (Canvas/SVG)
    CS1->>CS1: 实时方向识别 (U/D/L/R)
    User->>CS1: 释放右键 (mouseup)
    CS1->>CS1: 生成手势字符串 (e.g. "DR")
    CS1->>CS1: 匹配手势规则
    alt 规则匹配
        CS1->>CS1: 执行对应动作
        CS1->>SW: dispatchEvent("mouse-gestures-feedback")
        Note over SW: 记录反馈（分析/热门推荐）
    else 无匹配
        CS1->>CS1: 触发原生右键菜单
    end
```

---

## 二、超级拖拽数据流

```mermaid
sequenceDiagram
    participant User as 用户
    participant CS1 as content.js
    participant SW as service_worker.js

    User->>CS1: 按住左键拖拽链接
    CS1->>CS1: 检测拖拽元素类型 (link/image/text)
    User->>CS1: 拖拽 + 释放
    CS1->>CS1: 生成拖拽手势字符串
    CS1->>CS1: 匹配 Drag-Link/Drag-Image/Drag-Text 规则
    alt 链接拖拽
        CS1->>CS1: 提取 href
        CS1->>SW: 打开新标签页 (tabs.create)
    else 图片拖拽
        CS1->>CS1: 提取 src
        CS1->>SW: 下载图片 (downloads API)
    else 文本拖拽
        CS1->>CS1: 提取选中文本
        CS1->>SW: 搜索引擎查询 (tabs.create + search URL)
    end
```

---

## 三、配置数据流

```mermaid
flowchart TD
    subgraph UI_Layer [UI 层]
        OPT[options.html<br/>设置页面]
        POP[popup.html<br/>弹出窗口]
    end

    subgraph Storage_Layer [存储层]
        LS[chrome.storage.local]
        SS[chrome.storage.sync]
        LOCAL[localStorage]
    end

    subgraph SW_Layer [Service Worker 层]
        SW[service_worker.js<br/>配置管理器 MNe 模块]
    end

    subgraph CS_Layer [Content Script 层]
        CS[content.js<br/>手势引擎]
    end

    OPT -->|保存配置| SW
    POP -->|编辑手势| SW
    SW -->|持久化| LS
    SW -->|同步| SS
    SW -->|下发规则| CS
    CS -->|查询配置| SW
    LS -->|读取| SW
```

### 存储分布

| 存储介质 | 内容 | 访问范围 |
|---------|------|---------|
| `chrome.storage.local` | 主配置 JSON、手势规则、拖拽规则、摇杆规则、滚动配置、光标选择、黑名单 | SW + Options + Popup |
| `chrome.storage.sync` | 跨设备同步的配置子集 | SW + Options (登录用户) |
| `localStorage` | 单页面缓存 (checksum-hash, private-hash, 热门手势缓存) | Content Script |
| `sessionStorage` | 会话级临时数据 | Content Script |
| `self.geZbb` (内存) | jfq 引擎运行时变量存储 | Content Script (contentEnd.js) |

---

## 四、VAST 广告检测数据流

```mermaid
sequenceDiagram
    participant Page as 网页 (XML/VAST)
    participant CS1 as content.js (RWf)
    participant SW as service_worker.js
    participant Server as crxmouse 服务器

    CS1->>Page: 监听 DOM 变更
    Page-->>CS1: XHR 响应包含 VAST XML
    CS1->>CS1: DOMParser 解析 XML
    CS1->>CS1: 匹配 native 规则 (查找 <Ad> 元素)
    CS1->>CS1: 提取 Ad ID + Creative + MediaFile
    CS1->>SW: chrome.runtime.sendMessage({topic:"VAST", msg:{type:"vast", data:[...]}})
    SW->>Server: 上报广告数据（需 advanced features consent）
```

---

## 五、反馈 / 分析管道 (XJZ, WwI, RWf)

### 模块协作

```mermaid
flowchart LR
    subgraph Content_Script
        EVENTS[鼠标手势事件<br/>mouse-gestures-feedback]
        Q[kBx 缓冲队列<br/>max 64 条]
        RWf[RWf 模块<br/>规则匹配引擎]
        XJZ[XJZ 模块<br/>高级反馈规则]
        WwI[WwI 模块<br/>私有反馈规则]
    end

    subgraph Service_Worker
        SW[service_worker.js]
    end

    subgraph External
        GA[Google Analytics]
        SERVER[crxmouse 服务器]
    end

    EVENTS -->|CustomEvent| Q
    Q -->|去队处理| RWf
    Q -->|去队处理| XJZ
    Q -->|去队处理| WwI

    XJZ -->|条件匹配| XJZ
    XJZ -->|发送| SW
    WwI -->|条件匹配| WwI
    WwI -->|发送| SW

    SW -->|gaEvent| GA
    SW -->|热门手势请求| SERVER
    SERVER -->|推荐规则| SW
```

### 三种规则引擎的区别

| 模块 | 触发条件 | 数据去向 | 条件 |
|------|---------|---------|------|
| RWf | 页面包含 VAST XML / 匹配规则 | SW -> 服务器 | 需 advanced features consent |
| XJZ | 本地规则匹配 URL + 事件详情 | SW -> 服务器 | 需 advanced features consent + checksum-hash 验证 |
| WwI | 本地规则匹配 URL + 事件详情 | SW -> 服务器 | 需 private-hash 验证（用户自愿） |

---

## 六、模块初始化时序

```mermaid
sequenceDiagram
    participant CS5 as contentStart.js
    participant CS3 as contentEnd.js
    participant CS1 as content.js
    participant SW as service_worker.js

    Note over CS5: document_start
    CS5->>CS5: MpiUO 注册 kBx, kJoHB
    CS5->>CS5: kJoHB.nyvg(1) 开始轮询

    Note over CS3: document_end
    CS3->>CS3: core-js polyfill 初始化
    CS3->>CS3: lNV 模块: 读取 proconstantinator_key
    Note over CS3: 指数退避 10000ms 等待
    CS3->>CS3: lNV 就绪 -> jfq 就绪
    CS3->>CS3: RWf/XJZ/WwI 并行初始化
    Note over CS3: RWf: 等待 jfq + zYg + lNV
    Note over CS3: XJZ: 等待 jfq + zYg + lNV
    Note over CS3: WwI: 等待 jfq + zYg + lNV

    Note over CS1: document_start (并行)
    CS1->>CS1: jQuery 加载
    CS1->>CS1: 手势监听器注册
    CS1->>SW: 查询服务端规则 (XJZ)
    CS1->>SW: 查询私有规则 (WwI)
    SW-->>CS1: 规则 + checksum/private hash
    CS1->>CS1: 分派 mouse-gestures-feedback 自定义事件
```

---

## 七、热门手势同步流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant SW as service_worker.js
    participant Server as crxmouse API
    participant POP as popup.html

    User->>POP: 打开弹出窗口
    POP->>SW: 请求热门手势
    SW->>Server: GET /api/popular?url=current_url
    Server-->>SW: 热门手势 JSON
    SW->>POP: 渲染热门手势列表
    Note over POP: 用户可一键添加到自己的手势

    Note over SW: 用户执行手势后
    SW->>Server: POST 匿名手势使用统计
    Note over Server: 聚合后生成热门推荐
```

---

## 八、消息路由完整清单

```mermaid
flowchart TD
    subgraph Senders [消息发送方]
        CS1[content.js]
        CS2[frame.js]
        CS3[contentEnd.js]
        CS4[websiteHandler.js]
        POPUP[popup.html/js]
        OPTIONS[options.html/js]
    end

    subgraph SW [service_worker.js 消息路由]
        ROUTER[chrome.runtime.onMessage]
        VAST[VAST 处理]
        CONFIG[配置管理]
        GA[GA 上报]
        TABS[标签页操作]
        BOOK[书签操作]
        CLIP[剪贴板操作]
        DL[下载操作]
        CURSOR[光标管理]
        FEED[反馈处理]
    end

    CS1 -->|href/ahref/feedback| ROUTER
    CS2 -->|href/ahref| ROUTER
    CS3 -->|XJZ_feedback/WwI_feedback| ROUTER
    CS4 -->|gaEvent/getExtensionVersion| ROUTER
    POPUP -->|手势编辑/光标选择| ROUTER
    OPTIONS -->|配置保存/导入导出| ROUTER

    ROUTER --> VAST
    ROUTER --> CONFIG
    ROUTER --> GA
    ROUTER --> TABS
    ROUTER --> BOOK
    ROUTER --> CLIP
    ROUTER --> DL
    ROUTER --> CURSOR
    ROUTER --> FEED
```
