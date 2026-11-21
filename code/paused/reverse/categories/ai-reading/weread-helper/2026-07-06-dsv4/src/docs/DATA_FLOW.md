# i微信读书 数据流文档

## 总体数据流概览

```mermaid
flowchart TB
    subgraph Chrome["Chrome 浏览器"]
        subgraph BG["Background Script (Persistent)"]
            WebReq["webRequest 拦截器"]
            FSAPI["飞书 API Client"]
            MsgListener["Message Listener"]
        end

        subgraph Page["微信读书网页 (weread.qq.com)"]
            CS["Content Script (document_start)"]
            Inj["Inject Script (plugin.js + i.js)"]
        end

        subgraph ReactApp["React 应用 (plugin.js)"]
            App["App 根组件"]
            TButton["ToolButton 设置面板"]
            TBar["ToolBarItem 划线工具栏"]
            BCard["BookCard 书签卡片"]
            Store["Store Proxy (window.r)"]
            DB["store2 DB (namespace:iwr)"]
        end
    end

    subgraph External["外部服务"]
        Weread["微信读书 API"]
        Flomo["Flomo"]
        Readwise["Readwise"]
        NotionProxy["Notion 中转代理\n(wx.redream.cn)"]
        SentrySvc["Sentry"]
        BaiduTJ["百度统计"]
        Unsplash["Unsplash"]
        MDPreview["md.redream.cn"]
        FS["飞书开放平台"]
    end

    User["用户"] -->|打开微信读书| Page
    Inj -->|Proxy get| Store
    Store -->|实时引用| Weread
    Inj -->|dispatchEvent 'textselect'| App
    App -->|设置存储| DB
    TBar -->|划线操作| Flomo
    TBar -->|卡片生成| BCard
    BCard -->|随机图片| Unsplash
    BCard -->|截图下载| User
    TButton -->|同步笔记| Readwise
    TButton -->|同步笔记| NotionProxy
    TButton -->|导出 MD| MDPreview
    Inj -->|行为追踪| BaiduTJ
    ReactApp -->|错误上报| SentrySvc
    WebReq -->|移除CSP| Page
```

---

## 1. 扩展加载与初始化流程

```mermaid
sequenceDiagram
    actor User
    participant Chrome as Chrome Browser
    participant BG as Background Script
    participant CS as Content Script
    participant Page as 微信读书页面
    participant Ijs as i.js (Inject)
    participant Pjs as plugin.js (Inject)

    User->>Chrome: 访问 weread.qq.com
    Chrome->>BG: 启动 Persistent Background
    BG->>BG: init() — 注册 webRequest 监听
    Chrome->>CS: 注入 contentScript.js (document_start)
    CS->>CS: DOMContentLoaded 事件触发
    CS->>Page: injectCustomJs(i.js)
    CS->>Page: injectCustomJs(plugin.js)
    Ijs-->>Page: Function.prototype.apply 劫持
    Ijs-->>Page: 百度统计初始化
    Pjs-->>Page: ReactDOM.render(<App/>)
    CS->>CS: window.load 事件触发
    CS->>Page: injectCustomFont(x5) — 注入 @font-face
    Page-->>BG: 首次 webRequest 请求
    BG->>BG: onHeadersReceived — 移除 CSP + 注入 CORS
```

---

## 2. 划线摘抄与 Flomo 同步流程

```mermaid
sequenceDiagram
    actor User
    participant Page as 微信读书页面
    participant Ijs as i.js (Hooked)
    participant App as React App
    participant TBar as ToolBarItem
    participant Flomo as Flomo API

    User->>Page: 选中文本
    Page->>Page: 微信读书内部: showSelectionToolBar()
    Ijs->>Ijs: 劫持 detect: objs → CustomEvent
    Ijs->>App: dispatchEvent('textselect', {detail:{objs}})
    App->>App: setState({hasToolBarShowed:true})
    App->>TBar: 渲染划线工具栏
    User->>TBar: 点击「直线划线」/「手写划线」/「背景划线」
    TBar->>TBar: getTextFromObjs(objs) → 拼接文本
    TBar->>Flomo: POST (flomoApi URL)
    Note over Flomo: body: {content: "#微信读书/书名 划线文本"}
    Flomo-->>TBar: 返回结果
    TBar->>TBar: 百度统计 _trackEvent
    TBar->>TBar: Toast 提示结果
```

---

## 3. 批量同步笔记到 Readwise / Notion 流程

```mermaid
sequenceDiagram
    actor User
    participant TButton as ToolButton
    participant Store as window.r Proxy
    participant Index as utils/index.js
    participant RW as Readwise API
    participant NP as Notion Proxy (wx.redream.cn)
    participant Sentry as Sentry

    User->>TButton: 点击「同步笔记」(Readwise)
    TButton->>Store: 读取 store.notes.noteList
    TButton->>Index: postToReadwise(noteList, token)
    Index->>Index: formatReadwise(noteList)
    Note over Index: 过滤去重 → 格式化为 Readwise Highlight[]
    Index->>RW: POST /api/v2/highlights/
    Note over RW: Authorization: Token {readwiseToken}
    RW-->>Index: 200 OK
    Index-->>TButton: 同步成功
    TButton->>TButton: 百度统计 _trackEvent + Toast

    User->>TButton: 点击「同步笔记」(Notion)
    TButton->>Store: 读取 store.notes.noteList + store.bookInfo
    TButton->>Index: upsertPage(token, pageID, store)
    Index->>Index: uniqueNotes() → notesAddChapter()
    Note over Index: 去重 + 附加章节标题
    Index->>NP: POST /weixin/ireader/notion/upsert/
    Note over NP: body: {token, databaseId, data:{bookInfo, noteList[]}}
    NP-->>Index: 返回结果
    alt 同步失败 (response.message)
        Index->>Sentry: captureMessage(错误详情)
    end
    Index-->>TButton: 同步完成
    TButton->>TButton: 百度统计 _trackEvent + Toast
```

---

## 4. 导出笔记到 Markdown 流程

```mermaid
sequenceDiagram
    actor User
    participant TButton as ToolButton
    participant Store as window.r Proxy
    participant Index as utils/index.js
    participant Turndown as turndown 库
    participant Clipboard as Navigator Clipboard
    participant MDWeb as md.redream.cn

    User->>TButton: 点击「导出划线」或「导出笔记」
    alt 导出划线
        TButton->>Store: store.bookmarks.bookmarkList
        TButton->>Index: getBookmarks(bookmarkList)
        Note over Index: 遍历 + 章节标题拼接 → Markdown
    else 导出笔记
        TButton->>Store: store.notes.noteList
        TButton->>Index: getBookNotes(noteList)
        Note over Index: 过滤 noteType===1 + 章节标题 → Markdown
    end
    TButton->>Clipboard: copy(markdown) — 写入剪切板
    TButton->>TButton: Toast: "导出成功，已复制到剪切板"
    TButton->>MDWeb: window.open('https://md.redream.cn/', markdown)
    Note over MDWeb: 通过 postMessage 传递 Markdown 内容
```

---

## 5. 主题/纸张/字体切换流程

```mermaid
sequenceDiagram
    actor User
    participant TButton as ToolButton
    participant DOM as 页面 DOM
    participant Store as window.r Proxy

    User->>TButton: 点击主题色块
    TButton->>DOM: document.body.classList.remove(curThemeName)
    TButton->>DOM: document.body.classList.add(newThemeName)
    TButton->>DOM: 触发白底主题 click (确保非暗色模式)
    TButton->>TButton: 百度统计 _trackEvent('theme', 'change')

    User->>TButton: 点击纸张纹理
    TButton->>DOM: .app_content.style.backgroundImage = url(paper.url)
    TButton->>TButton: 百度统计 _trackEvent('paper', 'change')

    User->>TButton: 点击字体按钮
    TButton->>DOM: injectCSS(font-family CSS)
    TButton->>Store: store.clearDrawTexts()
    TButton->>Store: store.drawSomeTexts()
    Note over Store: 触发微信读书重绘以应用新字体
```

---

## 6. CSP 移除与 CORS 注入流程

```mermaid
sequenceDiagram
    participant BG as Background Script
    participant Chrome as Chrome WebRequest
    participant Server as 目标服务器

    Chrome->>BG: onHeadersReceived 事件触发
    BG->>BG: 遍历 responseHeaders
    loop 逐个 header
        alt header === 'content-security-policy'
            BG->>BG: 设置 value = '' (清空 CSP)
        else header === 'access-control-allow-origin'
            BG->>BG: 设置 value = '*'
            BG->>BG: hasCors = true
        end
    end
    alt !hasCors
        BG->>BG: 追加 Access-Control-Allow-Origin: https://weread.qq.com
        BG->>BG: 追加 Access-Control-Allow-Headers: Content-Type
    end
    BG->>Chrome: return {responseHeaders} (modified)
    Note over Chrome: 拦截范围: weread.qq.com / flomoapp.com / open.feishu.cn / api.notion.com
```

---

## 7. 腾讯云/阿里云 CPS 推广参数注入

```mermaid
sequenceDiagram
    actor User
    participant Browser
    participant Mjs as m.js (Content Script)
    participant Page as 腾讯云/阿里云页面

    User->>Browser: 访问 cloud.tencent.com 或 *.aliyun.com
    Browser->>Mjs: 注入 m.js (document_start)
    Mjs->>Mjs: 检测 host === 'cloud.tencent.com'
    alt 腾讯云
        Mjs->>Page: history.pushState({},'', url + '?cps_key=1d358d18...')
    else 阿里云
        Mjs->>Page: history.pushState({},'', url + '?userCode=okjhlpr5')
    end
    Note over Page: URL 携带 CPS 推广参数
```

---

## 8. 书签卡片生成与下载流程

```mermaid
sequenceDiagram
    actor User
    participant TBar as ToolBarItem
    participant BCard as BookCard 组件
    participant H2C as html2canvas
    participant Store as window.r Proxy
    participant DB as store2 DB
    participant Unsplash as Unsplash
    participant Toast as Toast 组件

    User->>TBar: 点击「书签」按钮
    TBar->>TBar: 读取 WriteBookReview textarea
    TBar->>BCard: 渲染书签卡片预览 (含选中文本+书评)
    BCard->>Store: 读取 bookInfo / user
    BCard->>DB: 读取 bookcard 配置 (font/theme)
    BCard->>Unsplash: GET random/750x400 (5次预取)
    User->>BCard: 点击下载
    BCard->>H2C: html2canvas('#iwr-bookcard-preview', {scale:3})
    H2C-->>BCard: Canvas
    BCard->>BCard: canvas.toDataURL('image/png')
    BCard->>BCard: 创建 <a download> → click() → remove()
    BCard->>Toast: Toast.show('下载成功')
    BCard->>BCard: 百度统计 _trackEvent('bookcard', 'download')
```
