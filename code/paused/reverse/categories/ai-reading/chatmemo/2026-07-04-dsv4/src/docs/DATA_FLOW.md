# Chat Memo v1.3.3 — 数据流图

```mermaid
flowchart TD
    A[用户访问 AI 平台] --> B{Content Script 注入}
    B --> C1[content_common.js<br/>创建悬浮标签]
    B --> C2[analytics.js<br/>注册 Analytics 对象]
    B --> C3[平台适配器<br/>chatgpt/claude/...]
    
    C3 --> D{URL 检测<br/>isValidConversationUrl}
    D -->|有效对话页| E[提取消息<br/>extractMessages]
    D -->|非对话页| F[挂起等待]
    
    E --> G[DOM 观察器<br/>MutationObserver]
    G --> H{检测到消息变化?}
    H -->|是| I[防抖延迟 1s]
    H -->|无变化| G
    
    I --> J[保存消息<br/>saveAllMessages]
    J --> K[StorageManager<br/>智能增量更新]
    
    K --> L[chrome.runtime.sendMessage]
    L --> M[Background Service Worker]
    M --> N[IndexedDB CRUD]
    
    N --> O[(IndexedDB<br/>KeepAIMemoryDB)]
    
    P[用户点击悬浮标签] --> Q[toggleSidebar]
    Q --> R[注入 iframe<br/>html/popup.html]
    R --> S[Popup UI<br/>对话管理]
    
    S --> T[导出请求]
    T --> M
    M --> U[JSZip 打包]
    U --> V[chrome.downloads]
    V --> W[下载 ZIP/TXT]

    M --> X[Analytics<br/>批量上报]
    X --> Y[Cloudflare Worker<br/>chatmemo-analytics.kylis.workers.dev]
```

## 消息流

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Content     │     │  Background   │     │   IndexedDB   │
│   Script      │     │  Worker       │     │               │
├──────────────┤     ├──────────────┤     ├──────────────┤
│              │     │              │     │              │
│ connectDB ────────►              │     │              │
│              │     │      ───────► open │              │
│              │◄──────── status:ok      │              │
│              │     │              │     │              │
│ findConvByUrl──────►              │     │              │
│              │     │      ───────► get │              │
│              │◄──── conversation       │              │
│              │     │              │     │              │
│ createConv ────────►              │     │              │
│              │     │      ───────► add │              │
│              │◄── conversationId       │              │
│              │     │              │     │              │
│ updateConv ────────►              │     │              │
│              │     │      ───────► put │              │
│              │◄──── status:ok          │              │
│              │     │              │     │              │
│ (sidebar)    │     │              │     │              │
│ toggleSidebar│◄────── sendMessage │     │              │
│              │     │              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
```
