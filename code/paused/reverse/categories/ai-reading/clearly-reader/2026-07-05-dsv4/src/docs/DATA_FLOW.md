# Clearly Reader 数据流文档

## 总体数据流概览

```mermaid
flowchart TB
    subgraph Browser["Chrome 浏览器"]
        subgraph Background["Service Worker (background.bundle.js)"]
            MBus["Message Bus (MBus)"]
            Settings["Settings Manager"]
            Auth["Auth Manager"]
            API["API Client"]
            Translator["Translation Service"]
        end

        subgraph Page["目标网页"]
            CS["Content Script (content.bundle.js)"]
            Parser["Page Parser"]
            Highlighter["Page Highlighter"]
            TipUI["Content Tip UI"]
        end

        subgraph ReaderFrame["阅读器 iframe"]
            App["App UI (app.bundle.js)"]
            Renderer["Article Renderer"]
            Speech["Speech Controller"]
            ThemeMgr["Theme Manager"]
            ExportH["Export Handler"]
        end

        subgraph SkimFrame["Skim iframe"]
            Skim["Skim Panel (skim.bundle.js)"]
        end
    end

    subgraph External["外部服务"]
        ClearlyAPI["api.clearlyreader.com"]
        GoogleTL["Google Translate API"]
    end

    User["用户"] -->|点击图标 / Alt+R| Background
    User -->|Alt+S| Background
    Background -->|tabs.sendMessage| CS
    CS -->|postMessage| ReaderFrame
    CS -->|postMessage| SkimFrame
    ReaderFrame -->|chrome.runtime.sendMessage| Background
    Background -->|HTTP| ClearlyAPI
    Background -->|HTTP| GoogleTL

    CS -->|DOM 解析| Page
    CS -->|提取内容| Parser
    Parser -->|ArticleContent| CS
    CS -->|发送内容| ReaderFrame
```

---

## 1. 阅读模式激活流程

```mermaid
sequenceDiagram
    actor User
    participant Browser as Chrome Browser
    participant BG as Service Worker
    participant CS as Content Script
    participant Parser as Page Parser
    participant App as Reader App (iframe)

    User->>Browser: 点击扩展图标 / Alt+R
    Browser->>BG: chrome.action.onClicked
    BG->>BG: 获取当前标签页
    BG->>CS: clearly:content:open-frame
    CS->>CS: 检查 iframe 是否已创建
    alt iframe 不存在
        CS->>CS: 创建 #clearly-root
        CS->>CS: 注入 <iframe id="clearly-container">
        CS->>App: iframe 加载 app.bundle.js
    end
    CS->>Parser: 解析当前页面 DOM
    Parser-->>CS: ArticleContent {title, content, ...}
    CS->>App: clearly:app:update-content (文章数据)
    App->>App: 渲染文章内容
    App->>App: 应用用户主题/字体设置
    CS->>CS: 添加 clearly-enabled 类 → 隐藏原始页面
    BG->>BG: 更新工具栏图标为 active
```

---

## 2. 配置读写流程

```mermaid
sequenceDiagram
    participant App as Reader App (iframe)
    participant CS as Content Script
    participant BG as Service Worker
    participant Storage as chrome.storage.local

    Note over App: 用户修改阅读设置 (如字号)

    App->>CS: postMessage({type: "clearly:background:update-settings", data: {...}})
    CS->>BG: chrome.runtime.sendMessage({type: "clearly:background:update-settings", data: {...}})

    BG->>BG: 校验设置数据
    BG->>Storage: chrome.storage.local.set({settings: updatedSettings})
    Storage-->>BG: 写入成功

    BG-->>CS: {success: true, response: updatedSettings}
    CS-->>App: {success: true, response: updatedSettings}

    App->>App: 立即应用新设置到 UI
```

```mermaid
sequenceDiagram
    participant App as Reader App (iframe)
    participant CS as Content Script
    participant BG as Service Worker
    participant Storage as chrome.storage.local

    Note over App: 阅读器初始化, 需要加载用户配置

    App->>CS: postMessage({type: "clearly:background:get-settings"})
    CS->>BG: chrome.runtime.sendMessage({type: "clearly:background:get-settings"})

    BG->>Storage: chrome.storage.local.get(["settings"])
    Storage-->>BG: {settings: {...}}

    alt settings 存在
        BG-->>CS: {success: true, response: {settings: {...}}}
        CS-->>App: {success: true, response: {settings: {...}}}
        App->>App: 应用已保存的设置
    else settings 不存在
        BG-->>CS: {success: true, response: {settings: defaultSettings}}
        CS-->>App: {success: true, response: {settings: defaultSettings}}
        App->>App: 应用默认设置
    end
```

---

## 3. 翻译流程

```mermaid
sequenceDiagram
    actor User
    participant App as Reader App
    participant BG as Service Worker
    participant Google as Google Translate API

    User->>App: 选择文本 → 点击翻译
    App->>BG: clearly:background:translate-text ({text, sourceLanguage, targetLanguage})
    BG->>BG: 构建翻译请求参数
    BG->>Google: GET https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=...
    Google-->>BG: [[["译文", "原文", ...]], ...]
    BG->>BG: 解析翻译结果
    BG-->>App: {success: true, response: {translatedText: "译文"}}
    App->>App: 显示翻译结果
```

---

## 4. AI 功能流程 (摘要/助手)

```mermaid
sequenceDiagram
    actor User
    participant App as Reader App
    participant BG as Service Worker
    participant API as api.clearlyreader.com

    User->>App: 点击 AI 摘要 / 提问
    App->>BG: clearly:background:call-api ({path: "/ai/summarize", method: "POST", body: {content}})

    BG->>BG: 检查认证令牌
    alt 令牌有效
        BG->>API: POST /ai/summarize (Authorization: Bearer token)
        API-->>BG: {success: true, data: {summary: "..."}}
        BG-->>App: {success: true, response: {summary: "..."}}
        App->>App: 显示 AI 摘要
    else 令牌过期
        BG->>API: POST /auth/refresh (refreshToken)
        API-->>BG: {accessToken: "...", refreshToken: "..."}
        BG->>BG: 更新存储中的令牌
        BG->>API: POST /ai/summarize (新令牌)
        API-->>BG: {success: true, data: {summary: "..."}}
        BG-->>App: {success: true, response: {summary: "..."}}
    else 未登录
        BG-->>App: {success: false, error: "no_user_or_token"}
        App->>App: 显示登录提示
    end
```

---

## 5. 语音朗读流程

```mermaid
sequenceDiagram
    actor User
    participant App as Reader App
    participant Browser as Web Speech API

    User->>App: 点击朗读按钮
    App->>App: 检查 speechConfig (语速/音高/音量)

    App->>Browser: new SpeechSynthesisUtterance(content)
    App->>Browser: utterance.rate = config.rate
    App->>Browser: utterance.pitch = config.pitch
    App->>Browser: utterance.volume = config.volume
    App->>Browser: utterance.voice = selectedVoice
    App->>Browser: speechSynthesis.speak(utterance)

    Browser-->>App: onstart 事件
    App->>App: 更新 UI 为播放状态

    loop 朗读过程中
        Browser-->>App: onboundary 事件 (当前朗读位置)
        App->>App: 高亮当前朗读文本位置
    end

    Browser-->>App: onend 事件
    App->>App: 更新 UI 为停止状态
```

---

## 6. 导出流程 (PDF/Markdown)

```mermaid
sequenceDiagram
    actor User
    participant App as Reader App
    participant BG as Service Worker

    User->>App: 点击导出 → 选择格式 (PDF/Markdown/HTML/Text)

    alt 导出为 Markdown
        App->>App: 使用 marked 库将 HTML 转为 Markdown
        App->>App: 生成 Blob (text/markdown)
        App->>App: 触发下载 (chrome.downloads / <a> download)
    else 导出为 PDF
        App->>BG: clearly:app:print
        BG->>BG: 生成打印样式 HTML
        BG-->>App: 返回打印 HTML
        App->>App: window.print()
    else 导出为 HTML
        App->>App: 应用导出 CSS
        App->>App: 生成 Blob (text/html)
        App->>App: 触发下载
    else 导出为 Text
        App->>App: 提取纯文本
        App->>App: 生成 Blob (text/plain)
        App->>App: 触发下载
    end
```

---

## 7. Skim 速览面板流程

```mermaid
sequenceDiagram
    actor User
    participant Browser as Chrome Browser
    participant BG as Service Worker
    participant CS as Content Script
    participant Skim as Skim iframe

    User->>Browser: Alt+S 快捷键
    Browser->>BG: chrome.commands.onCommand ("skim-toggle")
    BG->>CS: clearly:content:open-frame (skim mode)

    alt Skim 面板未打开
        CS->>CS: 创建 #clearly-skim-root
        CS->>CS: 注入 <iframe class="clearly-skim-frame">
        CS->>Skim: iframe 加载 skim.bundle.js
        CS->>CS: 添加 clearly-skim-frame--open 类
        CS->>Skim: 发送当前页面信息
        Skim->>CS: 请求 AI 摘要
        CS->>BG: clearly:background:call-api
        BG-->>CS: AI 摘要数据
        CS-->>Skim: 显示摘要和关键要点
    else Skim 面板已打开
        CS->>CS: 添加 clearly-skim-frame--closing 类
        CS->>CS: 动画结束后移除 iframe
    end
```

---

## 8. 用户认证流程

```mermaid
sequenceDiagram
    actor User
    participant App as Reader App
    participant BG as Service Worker
    participant API as api.clearlyreader.com
    participant Storage as chrome.storage.local

    Note over User,Storage: 登录流程

    User->>App: 输入凭证 / 使用第三方登录
    App->>BG: clearly:background:login-from-token ({token, refreshToken})

    BG->>API: GET /user/me (Authorization: Bearer token)
    alt 认证成功
        API-->>BG: {user: {id, email, plan, ...}}
        BG->>Storage: chrome.storage.local.set({user: {...}})
        BG-->>App: {success: true, response: {user: {...}}}
        App->>App: 更新 UI 显示已登录状态
    else 认证失败
        API-->>BG: {error: "unauthorized"}
        BG-->>App: {success: false, error: "token_valid"}
        App->>App: 显示错误提示
    end

    Note over User,Storage: 令牌自动刷新

    BG->>BG: 定时检查令牌过期时间
    alt 令牌即将过期
        BG->>Storage: chrome.storage.local.get(["user"])
        Storage-->>BG: {user: {refreshToken: "..."}}
        BG->>API: POST /auth/refresh ({refreshToken})
        alt 刷新成功
            API-->>BG: {accessToken: "...", refreshToken: "..."}
            BG->>Storage: chrome.storage.local.set({user: updatedUser})
        else 刷新失败
            BG->>BG: 广播 clearly:background:token-expired
            App->>App: 显示重新登录提示
        end
    end
```

---

## 9. 页面高亮流程

```mermaid
sequenceDiagram
    actor User
    participant CS as Content Script
    participant Highlighter as Page Highlighter
    participant Storage as chrome.storage.local

    User->>CS: 选中文本 → 选择高亮颜色

    CS->>Highlighter: 传入选中范围 (Range)
    Highlighter->>Highlighter: 计算文本偏移量 (相对于文档)
    Highlighter->>Highlighter: 创建 HighlightEntry {id, text, color, pageUrl, createdAt}

    Highlighter->>Storage: 保存高亮到 chrome.storage.local
    Storage-->>Highlighter: 保存成功

    Highlighter->>CS: 用 <mark> 包裹选中文本
    CS->>CS: 应用高亮颜色样式

    Note over CS,Storage: 页面重新加载后恢复高亮
    CS->>Storage: chrome.storage.local.get(["highlights"])
    Storage-->>CS: [{id, text, pageUrl, color, ...}]
    CS->>CS: 在当前页面查找并恢复所有高亮
```

---

## 10. 右键菜单流程

```mermaid
sequenceDiagram
    actor User
    participant Browser as Chrome Browser
    participant BG as Service Worker
    participant CS as Content Script

    Note over BG: 扩展安装/更新时创建右键菜单

    BG->>Browser: chrome.contextMenus.create({id: "openClearly", title: "用 Clearly 打开"})
    BG->>Browser: chrome.contextMenus.create({id: "skimPage", title: "Skim 当前页面"})

    User->>Browser: 在链接上右键 → "用 Clearly 打开"
    Browser->>BG: chrome.contextMenus.onClicked ({menuItemId: "openClearly", linkUrl})

    BG->>Browser: chrome.tabs.create({url: linkUrl})
    Browser->>BG: 新标签页创建完成
    BG->>CS: clearly:content:open-article
    CS->>CS: 自动进入阅读模式
```

---

## 数据存储结构

```mermaid
erDiagram
    EXTENSION_SETTINGS {
        string readerConfig_json "JSON 序列化的 ReaderConfig"
        string speechConfig_json "JSON 序列化的 SpeechConfig"
        string translationConfig_json "JSON 序列化的 TranslationConfig"
        string exportConfig_json "JSON 序列化的 ExportConfig"
        string highlightConfig_json "JSON 序列化的 HighlightConfig"
        string autoOpen_json "JSON 序列化的 AutoOpenConfig"
        string shortcuts_json "JSON 序列化的 ShortcutConfig"
        string privacy_json "JSON 序列化的 PrivacySettings"
        string locale "用户语言偏好"
    }

    USER_DATA {
        string id "用户唯一 ID"
        string email "用户邮箱"
        string username "用户名"
        string avatarUrl "头像 URL"
        string plan "订阅计划 (free/pro/premium)"
        string token "JWT 访问令牌"
        string refreshToken "JWT 刷新令牌"
        number tokenExpiry "令牌过期时间戳"
    }

    API_CONFIG {
        string apiMode "production/development/custom"
        string customEndpoint "自定义 API 端点"
    }

    HIGHLIGHTS {
        string id "高亮唯一 ID"
        string text "高亮文本内容"
        string color "高亮颜色 hex"
        string pageUrl "页面 URL"
        number createdAt "创建时间戳"
        string note "备注 (可选)"
    }

    USAGE_STATS {
        number skimUsedCount "Skim 使用次数"
        string lastUsedDate "最后使用日期"
    }

    EXTENSION_SETTINGS ||--o| USER_DATA : "关联到当前用户"
    EXTENSION_SETTINGS ||--o| API_CONFIG : "API 配置"
    EXTENSION_SETTINGS ||--o{ HIGHLIGHTS : "高亮数据"
    EXTENSION_SETTINGS ||--o| USAGE_STATS : "使用统计"
```
