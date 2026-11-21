# NopeCHA: CAPTCHA Solver v0.6.1 — 数据流文档

## 1. 总体流程概览

```mermaid
sequenceDiagram
    participant Page as 网页
    participant CS as Content Script
    participant SW as Service Worker
    participant CDP as Chrome Debugger
    participant API as api.nopecha.com
    participant Iframe as CAPTCHA iframe

    Page->>CS: 页面加载完成
    CS->>SW: connect("stream")
    CS->>Page: 检测 CAPTCHA 元素
    CS->>SW: CAPTCHA 检测到 (provider, sitekey)
    SW->>SW: 检查 auto_open/auto_solve 设置
    SW->>CDP: 需要时 attach debugger
    SW-->>CS: 开始解决

    alt 需要点击展开
        SW->>CDP: 模拟鼠标点击 CAPTCHA 按钮
        CDP->>Iframe: 交互触发验证
    end

    Iframe->>CS: CAPTCHA 图片加载
    CS->>SW: 提取图片 base64
    SW->>API: POST /v1/recognition
    API-->>SW: 识别结果 (token/answer)
    SW->>CDP: 模拟鼠标输入答案
    CDP->>Iframe: 填写/点击验证
    Iframe->>Page: token 生成
    CS->>SW: 验证完成通知
```

---

## 2. 核心业务流程

### 2.1 安装/启动流程

```mermaid
flowchart TD
    A[扩展安装/启动] --> B{首次安装?}
    B -->|是| C[初始化默认设置]
    B -->|否| D[从 storage 加载设置]
    C --> E[Valibot 校验设置]
    D --> E
    E --> F{enabled?}
    F -->|否| G[图标变灰 + 全false]
    F -->|是| H[图标激活]
    G & H --> I[注册 DNR 规则]
    I --> J[启动可观测性调度器]
    J --> K[监听 connect/sendMessage]
    K --> L[等待 CAPTCHA 检测]
```

### 2.2 设置更新流程

```mermaid
flowchart TD
    A[用户修改设置] --> B{来源}
    B -->|Popup| C[runtime.sendMessage]
    B -->|Setup Page| D[URL hash 解析]
    C & D --> E[Service Worker 接收]
    E --> F[Valibot 校验]
    F --> G{校验通过?}
    G -->|否| H[丢弃 + 日志]
    G -->|是| I[chrome.storage.local.set]
    I --> J[更新全局 settings Promise]
    J --> K{enabled 状态变化?}
    K -->|是| L[更新 Badge 图标]
    K -->|否| M[仅更新 badge 文本]
    L & M --> N[Broadcast 通知所有 Content Script]
```

### 2.3 hCAPTCHA 自动化解决流程

```mermaid
sequenceDiagram
    participant Page as 宿主网页
    participant CS as vk3s1y.js (ISOLATED)
    participant Hook as t7658k.js (MAIN)
    participant SW as Service Worker
    participant API as api.nopecha.com
    participant HC as hCaptcha Server

    Page->>CS: hCaptcha iframe 加载
    CS->>CS: 检测 challenge frame
    CS->>SW: job::update (phase="detecting")

    Note over Hook,HC: 主世界请求拦截
    Hook->>HC: XHR GET /getcaptcha/{id}
    HC-->>Hook: binary response
    Hook->>Hook: 解码二进制 → JSON
    Hook->>CS: postMessage (明文数据)

    CS->>SW: 提取 task image
    SW->>API: POST /v1/recognition (image base64)
    API-->>SW: {data: "answer_grid"}
    SW->>CS: 识别答案

    CS->>CS: 构造响应 payload
    CS->>Page: 提交答案到 hCaptcha
    Page->>CS: token 生成
    CS->>SW: job::update (phase="completed")
```

### 2.4 reCAPTCHA 自动化解决流程

```mermaid
sequenceDiagram
    participant Page as 宿主网页
    participant CS as kathhh.js
    participant SW as Service Worker
    participant CDP as Chrome Debugger
    participant API as api.nopecha.com
    participant RC as reCAPTCHA Server

    Page->>CS: reCAPTCHA 加载 (grecaptcha API)
    CS->>CS: 劫持 grecaptcha.execute/render

    CS->>SW: CAPTCHA 检测
    SW->>SW: 检查 auto_open 设置

    SW->>CDP: 寻找 reCAPTCHA iframe
    CDP-->>SW: iframe 位置信息

    alt 需要点击
        SW->>CDP: Input.dispatchMouseEvent (click)
        CDP->>Page: 模拟点击 "我不是机器人"
    end

    RC->>Page: 图片挑战出现
    CS->>SW: 提取图片 base64 + 题目
    SW->>API: POST /v1/recognition
    API-->>SW: {data: "tile_indices"}
    SW->>CDP: 模拟点击图片网格
    CDP->>Page: 点击对应 tile

    RC->>Page: 验证通过 / 新挑战
    CS->>SW: token 就绪
    SW->>CS: 返回 token
    CS->>Page: 填入 token
```

### 2.5 鼠标模拟流程 (Human-Like Movement)

```mermaid
flowchart TD
    A[目标坐标 (x,y)] --> B[获取当前 Pointer Session]
    B --> C[生成种子 + Profile 参数]
    C --> D[计算贝塞尔曲线路径]
    D --> E[路径细化]:
    E --> F[震颤 (tremor)]
    E --> G[微调 (microAdjustment)]
    E --> H[暂停 (pause)]
    E --> I[抖动 (jitter)]
    F & G & H & I --> J[生成 Waypoint 序列]
    J --> K[逐点执行]
    K --> L{下一个 waypoint}
    L -->|继续| M[Input.dispatchMouseEvent(mouseMoved)]
    M --> N[sleep(delayMs)]
    N --> L
    L -->|最后一个| O[Input.dispatchMouseEvent(mousePressed)]
    O --> P[sleep(clickHoldDelay)]
    P --> Q[Input.dispatchMouseEvent(mouseReleased)]
    Q --> R[完成]
```

### 2.6 API 通信流程

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant API as api.nopecha.com

    Note over SW: 定期状态轮询
    loop 每 5 秒
        SW->>API: GET /v1/status?v={version}&key={api_key}
        API-->>SW: {plan, status, credit, quota}
        SW->>SW: 更新 Badge (text + color)
    end

    Note over SW: CAPTCHA 识别
    SW->>API: POST /v1/recognition
    Note right of SW: {type, image, sitekey, metadata}
    API-->>SW: {data, job_id}
    SW->>SW: 更新 Job 状态

    Note over SW: 可观测性上报
    SW->>SW: scheduler.shouldCollectForRecognition()
    alt 允许采集
        SW->>API: POST /v1/observability
        API-->>SW: 200 OK
        SW->>SW: 更新 lastSentAt
    end
```

### 2.7 可观测性调度流程

```mermaid
flowchart TD
    A[扩展启动/安装] --> B[启动调度器]
    B --> C[随机初始延迟 2-3 分钟]
    C --> D[检查状态]
    D --> E{状态判定}
    E -->|unscheduled| F[首次计划: 设置 nextSendAfter]
    E -->|cooldown| G[冷却中: 等待 intervalMs]
    E -->|delayed| H[延迟中: 等待至 nextSendAfter]
    E -->|ready| I[可采集]
    I --> J[采集数据 + POST /v1/observability]
    J --> K[更新 lastSentAt]
    K --> D

    G & H --> L[等待到期]
    L --> D
```

### 2.8 Message 校验流程

每个 `runtime.sendMessage` 消息都经过完整性校验：

```mermaid
flowchart LR
    A[发送消息] --> B[构造 meta = timestamp,random]
    B --> C[计算 CRC-32 checksum]
    C --> D[发送 [meta, event, ...args]]
    D --> E[SW 接收]
    E --> F[验证 checksum]
    F --> G{校验通过?}
    G -->|是| H[处理事件]
    G -->|否| I[丢弃消息]
```

---

## 3. 数据存储

| Key | 类型 | 用途 |
|-----|------|------|
| `settings` | `NopechaSettings` | 全量用户设置 (Valibot validated) |
| `observability:last-sent-at` | `number` | 上次可观测性上报时间戳 |
| `observability:next-send-after` | `number` | 下次可观测性上报最早时间 |

---

## 4. 关键依赖

| 依赖 | 来源 | 用途 |
|------|------|------|
| Valibot | 内置裁剪版 | Schema 验证 (设置/API 响应) |
| CRC-32 | 内置 | 消息完整性校验 |
| Mersenne Twister PRNG | 内置 | 鼠标模拟确定性随机数 |
| chrome.debugger API | Chrome 内置 | CDP 鼠标事件注入 |
| chrome.declarativeNetRequest | Chrome 内置 | HTTP 参数注入 |
