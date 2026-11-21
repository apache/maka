# Octotree v8.3.0 数据流文档

> 逆向工程分析 (dsv4) | 基于 v8.3.0

---

## 一、核心业务流程：页面加载到树形视图渲染

```mermaid
sequenceDiagram
    participant Browser as 浏览器
    participant CS as Content Script<br/>(content.js)
    participant SW as Service Worker<br/>(background.js)
    participant GitHub as api.github.com
    participant OctotreeAPI as api.octotree.io
    participant DOM as GitHub 页面 DOM

    Browser->>CS: 注入 content.js<br/>(document_start)
    CS->>CS: 解析 URL 判断是否为仓库页面<br/>提取 owner/repo/branch

    alt 非 GitHub 仓库页面
        CS->>CS: 注册 pjax 监听器，等待导航
    else GitHub 仓库页面
        CS->>CS: 从 chrome.storage.local<br/>读取用户设置和 Token

        CS->>DOM: 创建侧边栏容器<br/>(#octotree-sidebar)
        CS->>DOM: 注入 CSS 样式 + 字体加载
        CS->>CS: 初始化 jsTree 实例

        CS->>GitHub: GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
        GitHub-->>CS: 返回完整文件树 JSON

        CS->>CS: 解析树结构<br/>构建 OctotreeNode 森林
        CS->>CS: jsTree 渲染文件树

        CS->>SW: sendMessage({eventName: "octotree_send_request"})
        Note over CS,SW: 可选：验证许可证/同步设置
        SW->>OctotreeAPI: fetch 用户许可证信息
        OctotreeAPI-->>SW: 许可证状态
        SW-->>CS: 响应数据

        CS->>DOM: 绑定事件监听器<br/>(点击/搜索/键盘快捷键)
        CS->>CS: 标记 OCTOTREE_INITIALIZED = true
    end
```

---

## 二、文件点击 -> 内容预览流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant jsTree as jsTree 组件
    participant CS as Content Script
    participant GitHub as api.github.com
    participant DOM as GitHub 页面

    User->>jsTree: 点击树节点（文件名）
    jsTree->>CS: 触发 select_node 事件

    CS->>CS: 判断节点类型

    alt 目录节点
        CS->>GitHub: GET /repos/{owner}/{repo}/git/trees/{sha}
        GitHub-->>CS: 返回子目录内容
        CS->>jsTree: 展开/加载子节点
    else 文件节点
        CS->>DOM: 显示 Loading 状态

        CS->>GitHub: GET /repos/{owner}/{repo}/git/blobs/{sha}
        GitHub-->>CS: 返回 base64 编码文件内容

        CS->>CS: 解码 base64 内容
        CS->>CS: 根据文件类型决定渲染方式

        alt 代码文件（有语法高亮支持）
            CS->>CS: 应用语法高亮
            CS->>DOM: 渲染代码查看器 + 行号
        else 图片文件
            CS->>CS: 识别图片扩展名
            CS->>DOM: 渲染 <img> 标签
        else Markdown 文件
            CS->>CS: 渲染 Markdown to HTML
            CS->>DOM: 渲染格式化文档
        else 其他文件
            CS->>DOM: 渲染纯文本/二进制提示
        end
    end
```

---

## 三、API 代理请求流程

```mermaid
sequenceDiagram
    participant CS as Content Script
    participant SW as Service Worker
    participant OctotreeAPI as api.octotree.io<br/>（后端服务）

    Note over CS: 需要调用 Octotree 后端 API<br/>(许可证验证/用户数据同步)

    CS->>SW: chrome.runtime.sendMessage({<br/>  eventName: "octotree_send_request",<br/>  method: "GET",<br/>  path: "/user/license",<br/>  token: "ghp_xxxx",<br/>  body: null<br/>})

    SW->>SW: 构建 HTTP 请求头<br/>Content-Type: application/json<br/>Authorization: Bearer {token}

    SW->>OctotreeAPI: fetch("https://www.octotree.io/api/v1.0/user/license", {<br/>  headers, body, method<br/>})

    OctotreeAPI-->>SW: HTTP Response

    alt 响应成功 (2xx)
        SW->>SW: 解析 Content-Type<br/>判断 JSON / 纯文本
        SW-->>CS: sendResponse({responseBody, responseStatus})
    else API 限流 (429)
        SW->>SW: 提取 Retry-After 头
        SW-->>CS: sendResponse({statusCode: 429, retryAfter: N})
    else 其他错误
        SW-->>CS: sendResponse({message, statusCode})
    end

    CS->>CS: 根据响应处理业务逻辑
```

---

## 四、域名权限切换流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant Menu as 右键菜单
    participant SW as Service Worker
    participant Tabs as 所有标签页
    participant CS as Content Script

    User->>Menu: 右键点击扩展图标<br/>"Enable Octotree on this domain"

    Menu->>SW: contextMenus.onClicked<br/>(checked: true/false)

    SW->>SW: 提取当前标签页 URL<br/>解析 origin

    alt 用户勾选（启用）
        SW->>Browser: chrome.permissions.request({<br/>  origins: [origin + "/*"]<br/>})
        Browser-->>SW: 权限授权成功
        SW->>SW: 标记菜单为已勾选
        SW->>SW: 触发 webext-dynamic-content-scripts<br/>向已授权域名注入 content script

        Note over SW,Tabs: 通过 tabs.onUpdated 监听<br/>匹配域名的新标签页

        loop 匹配的标签页
            SW->>Tabs: executeScript 注入 content.js
            Tabs-->>SW: 注入完成
        end

        Note over User: 页面自动刷新后<br/>显示侧边栏
    else 用户取消勾选（禁用）
        SW->>Browser: chrome.permissions.remove({<br/>  origins: [origin + "/*"]<br/>})
        Browser-->>SW: 权限移除成功
        SW->>SW: 取消动态内容脚本注册
        SW->>SW: 标记菜单为未勾选
    end
```

---

## 五、存储数据结构

### 5.1 chrome.storage.local

```
键：octotree_access_token
值：string  — GitHub Personal Access Token (ghp_xxxx)

键：octotree_settings
值：
{
  "dockPosition": "left" | "right",
  "sidebarWidth": 320,
  "theme": "default" | "dark" | "light",
  "fontFamily": "cascadia-code" | "fira-code" | ...,
  "fontSize": 13,
  "iconTheme": "vscode" | "vscodemat",
  "showFileIcons": true,
  "showFolderIcons": true,
  "autoCollapse": false,
  "expanded": false,
  "showLineNumbers": true,
  "codeHighlight": true,
  "prFileTree": true,
  "loadFonts": true,
  "hideEmptyDirectories": false,
  "lazyLoadDepth": 1
}

键：octotree_license
值：
{
  "tier": "free" | "pro" | "team" | "enterprise",
  "valid": true,
  "expiresAt": "2026-12-31T00:00:00Z",
  "githubUser": "username"
}

键：octotree_session
值：
{
  "lastUsed": "2026-07-05T12:00:00Z",
  "recentRepos": ["owner/repo1", "owner/repo2"]
}
```

### 5.2 chrome.storage.session

扩展使用 `webext-events` 模式检测扩展首次启动（`__webext-events__startup` 键），防止 `onExtensionStart` 回调重复触发。

---

## 六、消息类型汇总

| 消息 eventName | 方向 | 触发时机 | 说明 |
|----------------|------|----------|------|
| `octotree_send_request` | CS -> SW | Content Script 需要调用 Octotree 后端 API | 参数：method, path, body, token |
| `webext-permission-toggle:add-permission` | SW -> (内部) | 用户点击右键菜单权限切换 | 触发权限请求/移除 |
| `__webext-events__startup` | SW -> (内部) | 扩展首次启动检测 | chrome.storage.session 标记 |

---

## 七、关键通信机制

### 7.1 Content <-> Background 通信

```
Content Script                    Service Worker
     │                                  │
     │ chrome.runtime.sendMessage()      │
     │─────────────────────────────────>│
     │  {eventName, method, path, ...}   │
     │                                   │—— fetch() to Octotree API
     │  sendResponse({responseBody, ...})│
     │<─────────────────────────────────│
     │                                   │
```

### 7.2 SW -> 页面 权限变更

```
Service Worker                        标签页
     │                                  │
     │ chrome.tabs.sendMessage()         │
     │  {action: "permission_changed"}   │
     │─────────────────────────────────>│
     │                                   │—— location.reload()
```

### 7.3 SW -> 标签页 DOM（动态注入）

使用 `chrome.scripting.executeScript()` (MV3) 或 `chrome.tabs.executeScript()` (降级) 向匹配的标签页动态注入 `content.js`。

### 7.4 fetch API 代理

Content Script 不直接在页面沙箱中调用 Octotree 后端 API，而是通过 SW 代理所有请求，确保 Bearer Token 不被暴露在宿主页面的网络请求中。

---

## 八、GitHub pjax 导航兼容

```mermaid
flowchart TD
    A[GitHub 页面加载] --> B{检测是否为仓库页面}

    B -->|是| C[渲染侧边栏]
    B -->|否| D[注册 pjax:complete 监听器]

    C --> E[监听 pjax:send 事件]

    D --> F{等待用户导航}

    E --> G[pjax 导航开始]
    G --> H[销毁当前侧边栏]
    H --> I[等待 pjax:complete]
    I --> B

    F --> J[pjax:complete 触发]
    J --> B
```

Octotree 通过 jQuery-pjax 事件机制兼容 GitHub 的单页导航：
- `pjax:send`: 在页面切换前销毁旧侧边栏
- `pjax:complete`: 在新页面加载后重新检测仓库信息并渲染
