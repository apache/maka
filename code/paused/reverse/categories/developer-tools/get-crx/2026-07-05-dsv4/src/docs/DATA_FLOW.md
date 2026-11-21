# Get CRX — 数据流文档

## 整体数据流（Mermaid 序列图）

```mermaid
sequenceDiagram
    actor User
    participant Browser as Chrome Browser
    participant SW as Service Worker (bg.js)
    participant Tabs as Chrome Tabs API
    participant Platform as Chrome PlatformInfo API
    participant Downloads as Chrome Downloads API
    participant Google as clients2.google.com

    Note over SW: 扩展安装时注册上下文菜单

    User->>Browser: 在 Chrome Web Store 页面上<br/>右键 → "Get CRX of this extension"
    Browser->>SW: contextMenus.onClicked

    SW->>Tabs: tabs.query({active: true, currentWindow: true})
    Tabs-->>SW: 返回当前标签页对象 (url, title)

    alt 经典版 Web Store (chrome.google.com)
        Note over SW: 解析 title: "扩展名 - Chrome Web Store"<br/>解析 url: /webstore/detail/xxx/{extId}
    else 新版 Web Store (chromewebstore.google.com)
        Note over SW: 解析 title: "扩展名"<br/>解析 url: /detail/{extId}
    else 其他页面
        SW-->>SW: console.log("Error")
        Note over SW: 无操作，流程终止
    end

    SW->>SW: 提取 extName (文件系统非法字符过滤)
    SW->>SW: 提取 extId (URL 第6段或第5段)
    SW->>SW: 提取 Chrome 版本号 (navigator.userAgent)

    SW->>Platform: runtime.getPlatformInfo()
    Platform-->>SW: {nacl_arch: "x86-64"}

    SW->>SW: 构造下载 URL<br/>https://clients2.google.com/service/update2/crx<br/>?response=redirect&nacl_arch=...&prodversion=...<br/>&acceptformat=crx2,crx3&x=id%3D...%26uc

    SW->>Downloads: downloads.download({url, saveAs: true})
    Downloads-->>Google: GET /service/update2/crx?...
    Google-->>Downloads: 302 → 实际 .crx 文件 URL
    Downloads-->>Google: GET 实际 .crx 文件 URL
    Google-->>Downloads: application/x-chrome-extension (二进制)

    Downloads->>SW: onDeterminingFilename (拦截)
    Note over SW: 将随机文件名替换为<br/>"{extName} {版本号}.crx"
    SW-->>Downloads: suggest({filename: "xxx 1.5.1.0.crx"})

    Downloads-->>User: 浏览器"另存为"对话框
    User->>Browser: 选择保存位置
    Downloads-->>User: 文件写入磁盘

    Note over SW: ExtName = undefined (清理全局状态)
```

## 关键数据转换

### 1. 扩展 ID 提取

```
经典版: https://chrome.google.com/webstore/detail/扩展名/abcdefghijklmnopqrstuvwxyz123456
                                               [0] [1]  [2]   [3]   [4]   [5]              [6]
                                              split("/")[6].split("?")[0]
                                              结果: "abcdefghijklmnopqrstuvwxyz123456"

新版:   https://chromewebstore.google.com/detail/abcdefghijklmnopqrstuvwxyz123456
                                           [0]  [1]   [2]   [3]   [4]              [5]
                                          split("/")[5].split("?")[0]
                                          结果: "abcdefghijklmnopqrstuvwxyz123456"
```

### 2. 扩展名称清理

```
经典版: title = "uBlock Origin - Chrome Web Store"
        → split(" - Chrome Web Store")[0] → "uBlock Origin"
        → 去掉 [/&\\:"*<>|?] → "uBlock Origin"

新版:   title = "uBlock Origin"
        → 直接去掉 [/&\\:"*<>|?] → "uBlock Origin"
```

### 3. CRX 下载 URL 构造

```
https://clients2.google.com/service/update2/crx
  ?response=redirect
  &nacl_arch=x86-64                          ← 来自 PlatformInfo
  &prodversion=126.0.6478.126                 ← 来自 navigator.userAgent
  &acceptformat=crx2,crx3
  &x=id%3Dabcdefghij...%26installsource%3Dondemand%26uc
    ↑
    参数部分进行 URL 编码:
    id=abcdefghij...&installsource=ondemand&uc
```

### 4. 文件名转换

```
Google 原始返回文件名: extension_1_5_1_0.crx
                         └──┬──┘ └┬┘
                      substring("_") ← 找到第一个下划线位置
                        去掉第一个下划线
                        后续下划线替换为点号

结果文件名: {extName} 1.5.1.0.crx

示例: "uBlock Origin 1.61.1.0.crx"
```

## 全局状态时序风险

```mermaid
sequenceDiagram
    participant SW as Service Worker
    participant G as Global ExtName

    Note over SW,G: 风险场景：快速连续下载

    SW->>G: ExtName = "Extension A"
    SW->>SW: downloads.download(A)
    Note over SW: 下载 A 开始，等待用户选择保存位置...

    SW->>G: ExtName = "Extension B" ← 覆盖！
    SW->>SW: downloads.download(B)

    Note over SW: 下载 A 的 onDeterminingFilename 触发
    SW->>G: 读取 ExtName → "Extension B" ← 错误！
    Note over SW: 扩展 A 的文件被错误命名为 "Extension B 1.0.0.0.crx"
```

**缓解因素**：由于 `downloads.download({saveAs: true})` 会弹出"另存为"对话框阻塞 UI，用户几乎不会在同一个对话框打开期间触发第二次下载。但在 Service Worker 生命周期内，如果用户快速操作，极端情况下仍可能出现此 Race Condition。
