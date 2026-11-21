# JSON Viewer Pro 数据流文档

> 逆向工程分析 (dsv4) | 基于 v1.0.6

---

## 一、扩展初始化流程

```mermaid
sequenceDiagram
    participant Browser as 浏览器
    participant SW as Service Worker<br/>(background.js)
    participant CS as Content Script<br/>(contentScript.js)
    participant Main as Main App<br/>(main.js)

    Browser->>SW: 扩展安装/更新 (onInstalled)
    SW->>SW: 创建右键菜单<br/>(Download JSON / Settings)

    Browser->>CS: 注入 contentScript.js<br/>(document_start, 所有匹配 URL)

    CS->>CS: 注册 onMessage 监听器
    CS->>CS: 监听 document.onreadystatechange

    Note over CS: readyState === 'interactive'

    CS->>SW: sendMessage({ action: 'give_me_options' })

    SW->>SW: 从 chrome.storage.local 读取选项
    SW->>SW: 合并默认值
    SW->>SW: 注入 optionPageURL

    SW->>CS: tabs.sendMessage({<br/>  action: 'options_received',<br/>  options: {...}<br/>})

    CS->>CS: 检查 URL 过滤列表
    alt URL 命中过滤列表
        CS->>CS: 跳过，不渲染
    else URL 未过滤
        CS->>CS: 判断 JSON 检测策略

        alt contentType 模式
            CS->>CS: 检查 document.contentType
        else jsonContent 模式
            CS->>CS: 移除 script/style 后 JSON.parse()
            CS->>CS: 解析成功 → 判定为 JSON 页面
        end

        alt 检测通过
            CS->>Main: 注入 <link> CSS + <script> main.js
            CS->>Main: 注入 <meta name="extension-options">
            Main->>Main: 读取 meta 标签中的 options
            Main->>Main: React.render() 渲染 JSON 查看器
            CS->>CS: window.JSON_VIEWER_PRO_INITIALISED = true
        else 检测未通过
            CS->>CS: 不注入，页面保持原样
        end
    end
```

---

## 二、选项保存与广播流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant Options as 设置页<br/>(options.js)
    participant Storage as chrome.storage.local
    participant SW as Service Worker
    participant AllTabs as 所有标签页<br/>(contentScript.js)

    User->>Options: 修改设置（主题/CSS/检测策略/URL）

    Options->>Storage: chrome.storage.local.set({...})

    Options->>AllTabs: chrome.tabs.query({})<br/>遍历所有标签页

    loop 每个标签页
        Options->>AllTabs: tabs.sendMessage({<br/>  action: 'settings_updated',<br/>  options: newOptions<br/>})
    end

    AllTabs->>AllTabs: 检查是否需要重载

    alt 此前已渲染 JSON Viewer 或 检测模式可能改变结果
        AllTabs->>AllTabs: window.location.reload()
    end

    Options->>User: Toast 提示 "Settings have been saved"
```

---

## 三、独立标签页模式流程（点击扩展图标）

```mermaid
sequenceDiagram
    participant User as 用户
    participant SW as Service Worker
    participant Tab as 独立标签页<br/>(index.html)

    User->>SW: 点击扩展图标 (action.onClicked)

    SW->>SW: 从 chrome.storage.local 读取选项

    SW->>SW: 将 options 编码为 URL query param

    alt 存在非默认主题
        SW->>Tab: tabs.create({ url: 'index.html?options=...' })
    else 默认主题
        SW->>Tab: tabs.create({ url: 'index.html' })
    end

    Tab->>Tab: 解析 URL query 或 meta 获取 options
    Tab->>Tab: 读取 <pre> 标签内容作为 JSON 输入
    Tab->>Tab: React.render() 渲染查看器
```

---

## 四、右键菜单下载 JSON 流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant SW as Service Worker
    participant CS as Content Script
    participant Page as 宿主页面

    User->>SW: 右键菜单 → "Download JSON"

    SW->>CS: tabs.sendMessage({<br/>  action: 'rb_download_json'<br/>})

    CS->>Page: location.hash = 'downloadJSON=true'

    Note over Page: main.js 监听 hashchange<br/>触发 JSON 下载逻辑
```

---

## 五、数据存储结构

### chrome.storage.local

```
Key: "rb-awesome-json-ver-options"

Value:
{
  "theme": "default" | "mdn",
  "css": "... 自定义 CSS 文本 ...",
  "collapsed": 0 | N,
  "filteredURL": ["https://example.com", ...],
  "jsonDetection": {
    "method": "contentType" | "jsonContent",
    "selectedContentTypes": [
      "application/json",
      "text/json",
      "application/javascript",
      ...
    ]
  }
}
```

---

## 六、消息类型汇总

| 消息 action | 方向 | 触发时机 |
|-------------|------|----------|
| `give_me_options` | CS → SW | 页面 readyState === interactive |
| `options_received` | SW → CS | SW 响应 give_me_options |
| `settings_updated` | 设置页 → CS (全Tab广播) | 用户在设置页保存 |
| `rb_download_json` | SW → CS | 右键菜单点击 Download JSON |

---

## 七、关键通信机制

### 7.1 跨上下文通信

由于 MV3 安全隔离限制，扩展使用三种通信方式：

1. **SW <-> CS**: `chrome.runtime.sendMessage` + `chrome.tabs.sendMessage`
2. **CS -> Main App**: 通过 DOM（`<meta name="extension-options">` 标签）
3. **设置页 -> 全局**: 查询所有 tabs 后逐个 sendMessage

### 7.2 向后兼容的选项读取

`background.js` 中的 `getBackwardCompatibleOptions()` 处理两种存储格式：
- **旧格式**: `chrome.storage.local` 中的字符串值（尝试 `JSON.parse`）
- **新格式**: 直接存储的对象值

---

## 八、选项传递的替代路径

```mermaid
flowchart TD
    A[选项来源] --> B{运行环境判断}

    B -->|chrome-extension:// URL<br/>且 query 包含 options| C[从 URL SearchParams 解析]
    B -->|普通宿主页面| D[从 meta 标签读取<br/>name=extension-options]
    B -->|独立标签页无 meta| E[从 chrome.storage.local 直接读取]

    C --> F[合并到 window.extensionOptions]
    D --> F
    E --> F

    F --> G[React 应用使用 options 渲染]
```
