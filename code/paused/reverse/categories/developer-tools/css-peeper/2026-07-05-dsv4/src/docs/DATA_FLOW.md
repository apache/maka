# CSS Peeper 数据流文档

> **版本**: v1.2.2 | **基于**: 源码逆向分析 | **分析日期**: 2026-07-05

---

## 一、整体数据流概览

```mermaid
sequenceDiagram
    participant User as 用户
    participant SidePanel as Side Panel (React UI)
    participant SW as Service Worker (background)
    participant CS_Loc as Content Script: element-locator
    participant CS_Inspector as Content Script: inspector-tools
    participant CS_Main as Content Script: inspector
    participant Page as 目标网页 DOM
    participant Storage as chrome.storage

    Note over User,Storage: === 扩展启动流程 ===
    SW->>Storage: 加载用户偏好 (theme, license)
    Storage-->>SW: 返回存储数据

    Note over User,Storage: === 打开 Side Panel ===
    User->>SidePanel: 点击扩展图标
    SidePanel->>SW: 请求当前状态
    SW-->>SidePanel: 返回 tab 信息、激活状态
    SidePanel->>SidePanel: 渲染 React UI (主题/状态)

    Note over User,Storage: === 激活检查模式 ===
    User->>SidePanel: 点击 "检查元素"
    SidePanel->>SW: ACTIVATE_INSPECTOR
    SW->>CS_Main: chrome.tabs.sendMessage()
    CS_Main->>Page: 注入 hover/click 事件监听
    CS_Main-->>SW: 确认激活
    SW-->>SidePanel: 检查模式已激活

    Note over User,Storage: === 选中元素 ===
    User->>Page: 鼠标悬停在元素上
    Page->>CS_Main: mouseover 事件
    CS_Main->>Page: 渲染高亮选择框
    User->>Page: 点击目标元素
    CS_Main->>CS_Inspector: 传递选中元素引用
    CS_Inspector->>Page: window.getComputedStyle(el)
    Page-->>CS_Inspector: CSSStyleDeclaration

    Note over User,Storage: === 提取样式数据 ===
    CS_Inspector->>CS_Inspector: 解析计算样式
    CS_Inspector->>CS_Inspector: 提取颜色调色板
    CS_Inspector->>CS_Inspector: 提取排版信息
    CS_Inspector->>CS_Inspector: 过滤分组 CSS 属性
    CS_Inspector->>CS_Inspector: 计算对比度 (WCAG)
    CS_Inspector-->>SidePanel: INSPECT_RESULT (chrome.runtime.sendMessage)

    Note over User,Storage: === 渲染检查结果 ===
    SidePanel->>SidePanel: 渲染颜色调色板
    SidePanel->>SidePanel: 渲染排版信息
    SidePanel->>SidePanel: 渲染 CSS 属性列表
    SidePanel->>SidePanel: 渲染对比度分析

    Note over User,Storage: === 定位元素 (回标) ===
    User->>SidePanel: 在属性列表中点击某个属性/元素
    SidePanel->>SW: LOCATE_ELEMENT (含elementData)
    SW->>CS_Loc: chrome.tabs.sendMessage()
    CS_Loc->>CS_Loc: 元素匹配查找
    CS_Loc->>Page: 滚动到元素 + 渲染覆盖层
    CS_Loc-->>SidePanel: 确认定位成功

    Note over User,Storage: === 保存偏好 ===
    User->>SidePanel: 切换主题/dismiss onboarding
    SidePanel->>Storage: chrome.storage.local.set()
```

---

## 二、消息流详细说明

### 2.1 消息通道

CSS Peeper 使用 Chrome Extension 的标准消息传递机制：

```
Side Panel ──(chrome.runtime.sendMessage)──► Service Worker
Service Worker ──(chrome.runtime.sendMessage)──► Side Panel
Service Worker ──(chrome.tabs.sendMessage)──► Content Script
Content Script ──(chrome.runtime.sendMessage)──► Service Worker
Content Script ──(chrome.runtime.sendMessage)──► Side Panel (直达)
```

### 2.2 核心消息类型

| 消息类型 | 发送方 | 接收方 | 触发条件 |
|----------|--------|--------|----------|
| `ACTIVATE_INSPECTOR` | Side Panel | Service Worker | 用户点击激活检查 |
| `DEACTIVATE_INSPECTOR` | Side Panel | Service Worker | 用户关闭检查模式 |
| `LOCATE_ELEMENT` | Side Panel | Content Script: locator | 用户在侧栏选中元素 |
| `GET_COMPUTED_STYLES` | Content Script: inspector | Content Script: tools | 用户选中页面元素 |
| `GET_COLOR_PALETTE` | Content Script: inspector | Content Script: tools | 提取颜色 |
| `GET_TYPOGRAPHY` | Content Script: inspector | Content Script: tools | 提取排版 |
| `INSPECT_RESULT` | Content Script | Side Panel | 检查结果已就绪 |
| `ERROR` | 任意 | 任意 | 发生错误 |

### 2.3 元素定位数据流

当用户在 Side Panel 的属性列表中点击时，`LOCATE_ELEMENT` 消息携带以下数据：

```
{
  type: "LOCATE_ELEMENT",
  tabId: number,
  elementData: {
    tag: "div",
    elements: [{ text, className, styles }],
    className: "...",
    id: "..."
  },
  indexOfElement: 0
}
```

Content Script (locator) 响应：
```
{ success: boolean, message?: string }
```

### 2.4 检查结果数据流

```
{
  type: "INSPECT_RESULT",
  payload: {
    selector: "body > div.container > ...",
    tagName: "div",
    computedStyles: { "font-size": "16px", ... },
    colorPalette: { backgroundColor: {...}, textColor: {...}, ... },
    typography: { fontFamily: "Inter", fontSize: "16px", ... },
    cssProperties: [{ name, value, group, isShorthand, isOverridden, source }],
    boundingRect: DOMRect
  }
}
```

---

## 三、样式提取流程

```mermaid
flowchart TD
    A[用户选中页面元素] --> B[inspector.js 捕获 click 事件]
    B --> C{是有效的 DOM 元素?}
    C -->|否| Z[忽略点击]
    C -->|是| D[inspectortools.js 获取 window.getComputedStyle]
    D --> E[解析 CSSStyleDeclaration]
    E --> F[并行提取三组数据]

    F --> G1[颜色提取器]
    G1 --> G2[提取 color / background-color / border-color]
    G2 --> G3[转换 HEX / RGB / HSL]
    G3 --> G4[匹配语义化颜色 token]
    G4 --> G5[计算 WCAG 对比度]

    F --> H1[排版提取器]
    H1 --> H2[提取 font-family / font-size / font-weight]
    H2 --> H3[提取 line-height / letter-spacing / text-align]
    H3 --> H4[检测 Web Font]
    H4 --> H5[识别实际渲染字体]

    F --> I1[属性提取器]
    I1 --> I2[遍历所有计算样式属性]
    I2 --> I3[按分组分类: layout, spacing, typography, colors, ...]
    I3 --> I4[标记 isShorthand / isOverridden]
    I4 --> I5[构建 CSSProperty 数组]

    G5 --> J[组装 InspectResult]
    H5 --> J
    I5 --> J
    J --> K[chrome.runtime.sendMessage 发送到 Side Panel]
    K --> L[Side Panel React 渲染结果]
```

---

## 四、扩展容器 DOM 注入

```mermaid
flowchart LR
    A[Content Script 加载] --> B{文档中存在 #csspeeper-extension-container?}
    B -->|否| C[创建 div#csspeeper-extension-container]
    C --> D[设置样式: fixed, z-index: 2147483647, pointer-events: none, isolation: isolate]
    D --> E[document.documentElement.appendChild]
    B -->|是| F[复用已有容器]
    E --> G[容器内创建覆盖层元素]
    F --> G
    G --> H[覆盖层 z-index: 2147483646, border: pink, pointer-events: none]
    H --> I[覆盖层跟踪选中元素位置]
    I --> J[监听 scroll / resize 实时更新]
```

---

## 五、Side Panel 状态管理

```mermaid
stateDiagram-v2
    [*] --> Idle: 扩展加载完成
    Idle --> Active: 用户激活检查模式
    Active --> Inspecting: 用户选中页面元素
    Inspecting --> Active: 选择新元素
    Inspecting --> Idle: 用户停用检查
    Active --> Idle: 用户停用检查

    state Inspecting {
        [*] --> Colors: 默认 Tab
        Colors --> Typography: 切换到排版
        Typography --> Properties: 切换到属性
        Properties --> Colors
        Colors --> Export: 导出
        Export --> Colors
    }
```

---

## 六、跨组件通信总结

| 方向 | 方式 | 延迟 | 适用场景 |
|------|------|------|----------|
| Side Panel → Content Script | `chrome.tabs.sendMessage` (经 SW 中转) | ~5-20ms | 激活检查、定位元素 |
| Content Script → Side Panel | `chrome.runtime.sendMessage` | ~5-20ms | 返回检查结果 |
| Side Panel ↔ SW | `chrome.runtime.sendMessage` | ~1-5ms | 查询状态、路由消息 |
| Content Script ↔ Page | DOM Events + CSSOM | 同步 | 样式读取、事件监听 |
| 所有 → Storage | `chrome.storage.local` | ~5-50ms | 持久化偏好 |
