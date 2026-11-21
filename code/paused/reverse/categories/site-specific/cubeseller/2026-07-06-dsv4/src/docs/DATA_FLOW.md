# CubeSeller 数据流文档

> **版本**: 11.1.5 | **基于**: 逆向工程静态分析

---

## 一、全局数据流总览

```mermaid
flowchart TB
    subgraph Browser["浏览器标签页 (电商平台页面)"]
        subgraph MAIN["MAIN World"]
            PAGE_DATA["window.__INITIAL_STATE__<br/>window.g_config<br/>等页面数据"]
            BRIDGE["windowDataMessage.js<br/>通过 postMessage 提取"]
        end

        subgraph ISOLATED["ISOLATED World"]
            CS["content/extract.js<br/>Vue 3 提取面板"]
            NOTIFY["content/message.js<br/>采集结果通知"]
            CSS["content/extract.css<br/>面板样式"]
        end

        DOM["页面 DOM<br/>(商品图片/视频元素)"]
    end

    subgraph Extension["Chrome 扩展进程"]
        BG["background.js<br/>Service Worker<br/>规则引擎 + 代理"]
        STORAGE["chrome.storage.local<br/>用户设置 / 规则"]
        DNR["declarativeNetRequest<br/>动态 Referer 规则"]
        COOKIES["chrome.cookies<br/>跨域 Cookie 管理"]
    end

    subgraph Popup["扩展弹窗"]
        POP["popup/popup.js<br/>Vue 3 控制面板"]
    end

    subgraph ExtractPage["提取结果页"]
        EXTRACT["extract/extract.js<br/>Vue 3 画廊页面"]
        JSZIP["JSZip 3.10.1<br/>打包下载"]
    end

    subgraph Remote["外部服务"]
        IMG_CDN["电商图片 CDN<br/>(跨域资源)"]
        USHANG["ushangtech.com<br/>翻译/抠图服务"]
        LOCAL["本地客户端<br/>192.168.1.105:3100"]
    end

    POP -->|"sendMessage<br/>触发采集"| CS
    CS -->|"DOM 抓取<br/>CSS 选择器"| DOM
    CS -->|"sendMessage<br/>imgFetch"| BG
    CS -->|"postMessage<br/>ext_gwd_EC_16931258"| BRIDGE
    BRIDGE -->|"Reflect.ownKeys<br/>读取路径"| PAGE_DATA
    BRIDGE -->|"postMessage<br/>回调结果"| CS
    BG -->|"fetch() + 修改 Referer"| DNR
    BG -->|"getCookies/setCookie"| COOKIES
    DNR -->|"Origin/Referer<br/>伪装为同源"| IMG_CDN
    BG -->|"fetch blob<br/>→ base64"| IMG_CDN
    IMG_CDN -->|"blob 数据"| BG
    BG -->|"sendResponse<br/>base64 数据"| CS
    CS -->|"渲染画廊<br/>JSZip 打包"| JSZIP
    CS -->|"chrome.downloads"| BG
    CS -->|"postMessage<br/>EC_message"| NOTIFY
    NOTIFY -->|"链接"| LOCAL
    BG -->|"任务队列"| USHANG
    CS -->|"读/写"| STORAGE
    POP -->|"读/写"| STORAGE
    EXTRACT -->|"读结果"| STORAGE
```

---

## 二、核心流程: 商品图片采集

### 2.1 完整时序

```mermaid
sequenceDiagram
    actor User
    participant Tab as 电商页面标签
    participant CS as content/extract.js<br/>(ISOLATED world)
    participant BG as background.js<br/>(Service Worker)
    participant DNR as declarativeNetRequest
    participant CDN as 图片 CDN
    participant ST as chrome.storage

    Note over Tab: 用户打开商品详情页

    User->>Tab: 点击扩展图标
    Tab->>CS: 注入提取面板 UI
    CS->>CS: URL 匹配规则库 → 识别平台

    Note over CS: 平台: 1688 商品详情

    CS->>BG: sendMessage({ type: "setReferers", fRules: [...] })
    BG->>DNR: updateDynamicRules (添加/删除)
    Note over DNR: Referer: https://detail.1688.com<br/>Origin: https://detail.1688.com

    CS->>CS: 执行提取规则配置
    CS-->>CS: querySelectorAll(".swiper-slide img")
    CS-->>CS: 提取 src 属性 → 图片 URL 列表

    loop 每个图片 URL
        CS->>BG: sendMessage({ type: "imgFetch", url })
        BG->>DNR: 应用前设置的 Referer 规则
        BG->>CDN: fetch(url, { responseType: "blob" })
        CDN-->>BG: Blob 数据
        BG->>BG: FileReader → readAsDataURL(blob)
        BG-->>CS: sendResponse(base64)
    end

    CS->>CS: 渲染图片画廊 (Vue 3)
    CS->>CS: JSZip 打包 (可选)

    alt 用户选择直接下载
        CS->>BG: sendMessage({ type: "download", downloadCfg })
        BG->>BG: chrome.downloads.download()
    else 用户选择打包下载
        CS->>CS: JSZip 生成 ZIP Blob
        CS->>CS: URL.createObjectURL(zipBlob)
        CS->>Tab: 触发浏览器下载
    end

    CS->>ST: chrome.storage.local.set (保存任务记录)
```

---

## 三、提取规则执行流程

### 3.1 规则结构与执行

```mermaid
flowchart TB
    START["页面加载完成"] --> MATCH{"URL 匹配<br/>规则库 reg 字段"}
    MATCH -->|"匹配成功"| LOAD_CONFIG["加载平台 config JSON"]
    MATCH -->|"匹配失败"| SKIP["跳过 (不注入UI)"]

    LOAD_CONFIG --> PARSE["解析 config 中的<br/>extract funcs"]
    PARSE --> ITER["遍历每个 ExtractFunc"]

    subgraph Extract["执行单个提取函数"]
        FTYPE{"funcName?"}
        FTYPE -->|"getImageBySelector"| SEL["CSS 选择器提取"]
        FTYPE -->|"getImageBySelectorComment"| COMM["评论图片提取"]
        FTYPE -->|"getImageBySelectorJsonp"| JSONP["JSONP 接口提取"]
        FTYPE -->|"自定义函数"| CUSTOM["专用提取逻辑"]

        SEL --> SEL_ITER["遍历 params 中的<br/>每个 ResourceGroup"]
        SEL_ITER --> QUERY["document.querySelectorAll(selector)"]
        QUERY --> ATTR["提取 attributes 中的属性值"]
        ATTR --> REPLACE{"有 replaceUrlRules?"}
        REPLACE -->|"是"| REG_REPLACE["正则替换 URL<br/>(清理参数/获取原图)"]
        REPLACE -->|"否"| DEDUP["URL 去重"]
        REG_REPLACE --> DEDUP
    end

    DEDUP --> SORT{"用户选择排序?"}
    SORT -->|"自动排序"| AUTO_SORT["按文件名自然排序"]
    SORT -->|"大图优先"| BIG_FIRST["按宽x高降序"]
    SORT -->|"小图优先"| SMALL_FIRST["按宽x高升序"]
    AUTO_SORT --> DISPLAY["Vue 渲染结果列表"]
    BIG_FIRST --> DISPLAY
    SMALL_FIRST --> DISPLAY
```

### 3.2 规则配置示例 (1688 商品详情)

```json
{
  "mainType": "func",
  "funcName": "getImageBySelector",
  "params": [
    {
      "groupName": "主图",
      "type": "img",
      "rules": [{
        "selector": ".swiper-slide img",
        "attributes": ["src"],
        "replaceUrlRules": [{
          "reg": "\\?.*$",
          "replace": ""
        }]
      }]
    },
    {
      "groupName": "详情",
      "type": "img",
      "rules": [{
        "selector": "[alt=\"商品详情图\"]",
        "attributes": ["dataset.original", "src"],
        "replaceUrlRules": [{
          "reg": "\\?.*$",
          "replace": ""
        }]
      }]
    }
  ]
}
```

**执行逻辑**:
1. 对 "主图" 分组: `document.querySelectorAll('.swiper-slide img')` → 取 `src` 属性 → 删除 `?` 后的查询参数
2. 对 "详情" 分组: `document.querySelectorAll('[alt="商品详情图"]')` → 先尝试 `dataset.original`，回退到 `src` → 删除查询参数

---

## 四、跨域图片获取流程

CoreSeller 使用 **Background Service Worker 代理** 绕开浏览器 CORS 限制:

```mermaid
sequenceDiagram
    participant CS as content/extract.js
    participant BG as background.js
    participant DNR as declarativeNetRequest
    participant CDN as 跨域图片 CDN

    Note over CS: page origin: detail.1688.com<br/>image origin: cbu01.alicdn.com

    CS->>CS: 提取到图片 URL<br/>https://cbu01.alicdn.com/xxx.jpg

    CS->>BG: sendMessage({<br/>  type: "imgFetch",<br/>  url: "https://cbu01.alicdn.com/xxx.jpg"<br/>})

    Note over BG: 检查 DNR 规则是否已设置<br/>Referer: https://detail.1688.com

    BG->>CDN: fetch(url, {<br/>  method: "GET",<br/>  responseType: "blob"<br/>})
    Note over DNR: DNR 自动附加 Referer 头<br/>使 CDN 认为请求来自商品页

    CDN-->>BG: image/jpeg Blob

    BG->>BG: const reader = new FileReader()<br/>reader.readAsDataURL(blob)
    BG-->>CS: sendResponse("data:image/jpeg;base64,...")

    CS->>CS: 创建 <img src="data:image/jpeg;base64,..."/><br/>或加入 JSZip 打包
```

**为什么需要 imgFetch?**
- Content Script 的 `fetch()` 受页面 CSP 限制，无法跨域加载图片
- Background Worker 具有 `*://*/*` host_permissions，可发起任意请求
- DNR 规则伪造 Referer/Origin，使 CDN 不拒绝请求

---

## 五、Referer 管理流程

```mermaid
flowchart LR
    subgraph CS["Content Script"]
        DETECT["检测当前页面域名<br/>如 detail.1688.com"]
    end

    subgraph BG["Background"]
        BUILD["构造 DNR 规则数组"]
        UPDATE["updateDynamicRules()"]
    end

    subgraph DNR["Chrome DNR 引擎"]
        RULES["动态规则集"]
    end

    DETECT -->|"sendMessage<br/>{type: 'setReferers'}"| BUILD
    BUILD -->|"removeRuleIds + addRules"| UPDATE
    UPDATE --> RULES

    Note1["规则示例:<br/>id: 自定义<br/>priority: 1<br/>action.requestHeaders:<br/>  Referer → 目标域名<br/>  Origin → 目标域名<br/>condition.urlFilter:<br/>  ||CDN域名"]
```

**Referer 规则生命周期**:
1. 用户打开商品页 -> Content Script 向 Background 发送 `setReferers` 消息，传入该平台需要的 Referer 规则
2. Background 先删除旧规则 (`removeRuleIds`)，再添加新规则 (`addRules`)
3. 后续所有通过 Background 发起的 `fetch()` 请求自动应用新的 Referer 规则
4. 用户离开页面/关闭标签时，规则保持 (在下次 `setReferers` 调用时被覆盖)

---

## 六、Cookie 管理流程

```mermaid
sequenceDiagram
    participant CS as Content Script
    participant BG as Background Worker
    participant CK as chrome.cookies API
    participant SITE as 电商平台

    Note over CS: 用户需要登录态才能<br/>提取带有权限的资源

    CS->>BG: sendMessage({<br/>  type: "getCookies",<br/>  cookieOpts: { url, name }<br/>})

    BG->>CK: chrome.cookies.get({ url, name })
    CK-->>BG: Cookie 对象 或 null

    alt Cookie 不存在或已过期
        BG-->>CS: null → 提示用户登录
    else Cookie 有效
        BG-->>CS: { name, value, domain, ... }
        CS->>CS: 使用 Cookie 值发起认证请求
    end

    Note over CS: 登录后保存 Cookie

    CS->>BG: sendMessage({<br/>  type: "setCookie",<br/>  cookieOpts: { url, name, value, ... }<br/>})

    BG->>CK: chrome.cookies.set({ url, name, value, ... })
    CK-->>BG: 设置成功/失败
```

---

## 七、评论图片提取流程

```mermaid
sequenceDiagram
    actor User
    participant CS as Content Script
    participant BG as Background Worker

    User->>CS: 点击 "采集评论" 按钮
    CS->>CS: 检测评论分页器 → 获取总页数

    User->>CS: 设置页数范围 (如 1-5)

    loop 每页评论
        CS->>CS: 从当前页提取评论中的图片 URL
        CS->>CS: querySelectorAll(commentImgSelector)

        loop 每个评论图片
            CS->>BG: sendMessage({ type: "imgFetch", url })
            BG-->>CS: base64 数据
        end

        CS->>CS: 翻页 → 等待 DOM 更新
    end

    CS->>CS: 汇总所有评论图片
    CS->>User: 显示采集结果
```

---

## 八、翻译与抠图集成流程

CubeSeller 与 `ushangtech.com` 的在线工具集成，实现图片翻译和批量抠图:

```mermaid
sequenceDiagram
    actor User
    participant CS as content/extract.js
    participant BG as background.js
    participant USHANG as ushangtech.com

    User->>CS: 选中图片 → 点击 "翻译"
    CS->>BG: sendMessage({<br/>  type: "addTranslate",<br/>  data: [{ id, url }]<br/>})

    BG->>BG: 加入 translateQueue[]

    User->>CS: 打开 ushangtech.com/ec/transimage
    Note over USHANG: translate.js 注入此页面

    USHANG->>BG: sendMessage({ tp: "getTranslate" })
    BG-->>USHANG: translateQueue[]
    USHANG->>USHANG: 逐个处理翻译任务

    USHANG-->>USHANG: 翻译完成
    USHANG->>BG: sendMessage({ tp: "delTranslate" })
    BG->>BG: 清理 translateQueue[]
```

抠图流程与此相同，使用 `addCutout`/`getCutout`/`delCutout` 消息。

---

## 九、窗口数据提取 (windowDataMessage.js)

Content Script (ISOLATED world) 无法直接访问页面的 `window` 对象变量。`windowDataMessage.js` 在 MAIN world 中运行，提供安全的属性路径读取:

```mermaid
sequenceDiagram
    participant CS as Content Script<br/>(ISOLATED world)
    participant PAGE as 页面 window<br/>(MAIN world)
    participant WD as windowDataMessage.js<br/>(MAIN world, 注入)

    CS->>PAGE: window.postMessage({<br/>  type: "ext_gwd_EC_16931258",<br/>  paths: ["g_config.productId",<br/>          "__INITIAL_STATE__.skuInfo"],<br/>  cbType: "getProductDataCallback"<br/>}, "*")

    PAGE->>WD: message 事件触发

    WD->>WD: paths.forEach(p => {<br/>  const parts = p.split(".")<br/>  parts.reduce((obj, key) => {<br/>    // 处理 [Symbol] 特殊语法<br/>    const m = key.match(/^(.*?)\[Symbol\]$/)<br/>    return m<br/>      ? obj?.[Reflect.ownKeys(obj||{})?.[m[1]]]<br/>      : obj?.[key]<br/>  }, window)<br/>})

    WD->>PAGE: window.postMessage({<br/>  type: "getProductDataCallback",<br/>  data: [productId, skuInfo]<br/>}, "*")

    PAGE->>CS: message 事件 → 收到数据
```

**安全边界**:
- 仅通过 `postMessage` 通信，不共享 JS 上下文
- 使用 `Reflect.ownKeys` 安全遍历，不调用可能被污染的 getter
- `cbType` 由调用方指定，防止消息混淆

---

## 十、存储数据流

```mermaid
flowchart LR
    subgraph WRITERS["写入者"]
        POP["popup.js<br/>用户设置"]
        CS["content/extract.js<br/>提取规则/任务记录"]
    end

    subgraph STORAGE["chrome.storage.local"]
        SETTINGS["提取规则配置<br/>显示悬浮按钮<br/>用户偏好设置<br/>版本信息"]
    end

    subgraph READERS["读取者"]
        POP_R["popup.js<br/>初始化加载设置"]
        CS_R["content/extract.js<br/>加载自定义规则"]
        BG_R["background.js<br/>读取规则配置"]
    end

    POP -->|"chrome.storage.local.set"| SETTINGS
    CS -->|"chrome.storage.local.set"| SETTINGS
    SETTINGS -->|"chrome.storage.local.get"| POP_R
    SETTINGS -->|"chrome.storage.local.get"| CS_R
    SETTINGS -->|"chrome.storage.local.get"| BG_R
```

---

## 十一、下载流程

```mermaid
sequenceDiagram
    actor User
    participant CS as Content Script
    participant BG as Background Worker
    participant DL as chrome.downloads

    User->>CS: 选择图片 → 点击下载

    alt 直接下载 (单文件)
        CS->>BG: sendMessage({<br/>  type: "download",<br/>  downloadCfg: { url, filename }<br/>})
        BG->>DL: chrome.downloads.download({ url, filename })
        DL-->>User: 浏览器下载栏显示
    end

    alt 打包下载 (多文件)
        CS->>CS: 使用 JSZip 创建 ZIP
        CS->>CS: zip.file(name1, blob1)<br/>zip.file(name2, blob2)<br/>...<br/>zip.generateAsync({ type: "blob" })
        CS->>CS: URL.createObjectURL(zipBlob)
        CS->>CS: 触发 <a download="xxx.zip"> 点击
        CS-->>User: 浏览器下载栏显示
    end
```
