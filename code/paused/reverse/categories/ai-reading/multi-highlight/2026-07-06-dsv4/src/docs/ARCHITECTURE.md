# Multi Highlight 架构文档

## 概述

Multi Highlight 是一款轻量级 Chrome 浏览器扩展，用于在阅读网页文章时高效且灵活地高亮多个关键词。代码为原生 JavaScript 编写，无打包器、无框架，仅依赖 jQuery (v3.x) 和基于 jQuery 的 highlight 插件。

**版本**: 2.11.1 | **Manifest**: V3 | **代码风格**: 原生 JavaScript

---

## 项目结构

```
multi-highlight-source-code/
├── manifest.json              # MV3 扩展声明
├── background.js              # Service Worker (后台服务)
├── content-action.js          # Content Script (页面注入)
├── getPagesSource.js          # 页面文本提取脚本 (scripting.executeScript 注入)
├── highlight.css              # 20 种高亮颜色样式
├── popup.html                 # 弹出窗口 HTML
├── popup.js                   # 弹出窗口逻辑
├── jquery/
│   ├── jquery.js              # jQuery v3.x (压缩版)
│   ├── jquery.highlight.js    # 自定义高亮插件 (基于 Bartek Szopka 的插件修改)
│   └── jquery.inactivity.min.js # 输入空闲检测插件
├── options/
│   ├── options.html           # 选项页 HTML
│   ├── options.js             # 选项页逻辑
│   └── options.css            # 选项页样式
├── img/                       # 图标资源
│   ├── logo16.png / logo19.png / logo38.png / logo48.png / logo128.png / logo350.png
│   ├── github.png             # GitHub 链接图标
│   └── options_icon.svg       # 设置齿轮图标
└── _metadata/
    └── verified_contents.json # Chrome Web Store 签名验证数据
```

---

## 系统架构

Multi Highlight 采用标准 Chrome MV3 三层架构，组件间通过 Chrome 消息 API 通信。

```
┌─────────────────────────────────────────────────────────────┐
│                    Chrome Extension 运行时                    │
├─────────────────────────────────────────────────────────────┤
│  Service Worker (background.js)                             │
│  ├── 安装/更新初始化 (onInstalled)                              │
│  │   ├── 创建默认 settings + popupConfig                      │
│  │   └── 注册右键菜单 (addKw / removeKw)                      │
│  ├── 标签页生命周期管理                                         │
│  │   ├── tabs.onUpdated → 初始化 tabinfo                      │
│  │   └── tabs.onActivated → 验证 tabinfo → 更新 badge          │
│  ├── 右键菜单事件处理 (contextMenus.onClicked)                   │
│  │   ├── addKw → 添加关键词 + 发送 _hl_search                  │
│  │   └── removeKw → 移除关键词 + 发送 _hl_clear                 │
│  ├── 设置同步 (handle_addKw_change / handle_removeKw_change)    │
│  ├── Popup 尺寸管理 (handle_popupSize_change)                  │
│  ├── Popup 关闭检测 (runtime.onConnect + port.onDisconnect)      │
│  ├── 消息路由 (runtime.onMessage)                              │
│  └── Badge 状态管理 (set_badge)                                │
├─────────────────────────────────────────────────────────────┤
│  Content Script (content-action.js)                          │
│  ├── 初始化 → 获取 tabId + storage key                         │
│  ├── MutationObserver → DOM 变化时自动重新高亮                    │
│  ├── 高亮引擎                                                  │
│  │   ├── hl_refresh()      → 全部重建                          │
│  │   ├── _hl_search()      → 增量添加                          │
│  │   ├── _hl_clear()       → 增量移除                          │
│  │   └── hl_clearall()     → 全部清除                          │
│  ├── jQuery highlight 插件集成                                  │
│  │   ├── $(body).highlight(kwStr, options)                    │
│  │   └── $(body).unhighlight(options)                        │
│  └── 消息监听 (runtime.onMessage)                              │
├─────────────────────────────────────────────────────────────┤
│  Popup UI (popup.html + popup.js)                            │
│  ├── 关键词输入框 (textarea#highlightWords)                     │
│  ├── 设置控件                                                  │
│  │   ├── 分隔符 (delimiter)                                    │
│  │   ├── 即时搜索 (instant)                                    │
│  │   ├── 开关切换 (toggleMHL)                                  │
│  │   ├── 自动重新高亮 (alwaysSearch)                              │
│  │   ├── 换行切换颜色 (newlineNewColor)                           │
│  │   ├── 区分大小写 (casesensitive)                              │
│  │   ├── 全词匹配 (wholeWord)                                  │
│  │   └── 保留关键词 (saveWords)                                  │
│  ├── 关键词标签列表 (kw-list)                                     │
│  │   ├── Ctrl+Click 移除关键词                                  │
│  │   └── 显示关键词在页面中是否存在                                 │
│  ├── 关键词解析器                                               │
│  │   ├── keywordsFromStr()   → 文本 → Keyword[]               │
│  │   ├── keywordsToStr()     → Keyword[] → 文本                │
│  │   └── KeywordsMinus()     → 差集运算                         │
│  └── 空闲检测 (jquery.inactivity → 300ms)                       │
├─────────────────────────────────────────────────────────────┤
│  Options Page (options/options.html + options.js)            │
│  ├── Popup 高度配置 (popupHeight: 40-500px)                    │
│  ├── Popup 宽度配置 (popupWidth: 400-760px)                    │
│  ├── 右键菜单开关 (addKw / removeKw)                           │
│  └── GitHub 链接                                              │
├─────────────────────────────────────────────────────────────┤
│  脚本注入 (getPagesSource.js)                                  │
│  ├── DOMtoString() → 提取 document.body.innerText              │
│  └── 发送 getVisibleText 消息到 popup                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心技术细节

### 1. 无打包器 / 无框架

| 特征 | 详情 |
|------|------|
| 打包方式 | 无 (原生 JS) |
| JavaScript 框架 | 无 |
| DOM 操作库 | jQuery v3.x (压缩版) |
| 高亮插件 | jquery.highlight.js (基于 Bartek Szopka 的 [highlight v3](http://johannburkard.de/blog/programming/javascript/highlight-javascript-text-higlighting-jquery-plugin.html)) |
| 空闲检测 | jquery.inactivity v1.3.2 (压缩版) |
| 模块系统 | 无 (全局命名空间) |

### 2. 高亮机制

#### 颜色系统

高亮颜色通过 CSS 预定义 **20 种**颜色组合 (`highlight.css`)，使用以下 CSS 类体系：

- **顶层容器类**: `chrome-extension-FindManyStrings` (所有高亮 span 的通用样式)
- **颜色样式类**: `chrome-extension-FindManyStrings-style-{0..19}` (对应 20 种颜色)
- **关键词编码类**: `CE-FMS-{encodeURI(keyword)}` (每个关键词的唯一标识)

```
示例:
<span class="chrome-extension-FindManyStrings chrome-extension-FindManyStrings-style-3 CE-FMS-hello">
  hello
</span>
```

#### 颜色分配策略

有两种策略（通过 `isNewlineNewColor` 切换）：

1. **按关键词轮转** (默认): `kwGrp = index % 20` -- 每个关键词依次使用不同颜色
2. **按行分组**: 同一行的关键词使用相同颜色，换行后切换到下一个颜色

#### jQuery Highlight 插件修改

原版 `jquery.highlight.js` 使用 `replaceChild` 处理嵌套高亮元素的清除（可能导致跨标签文本融合问题）。Multi Highlight 将其改为 `flatten()` 方法：

```javascript
// 修改前 (原版)
$(element + '.' + className).each(function() {
  var parent = this.parentNode;
  parent.replaceChild(this.firstChild, this);
  parent.normalize();
});

// 修改后 (Multi Highlight)
jQuery(settings.element + '.' + settings.className, document.body || document).flatten();
```

`flatten()` 先展开所有子节点再进行替换，避免嵌套高亮导致的文本结构破坏。

### 3. 标签页状态隔离

每个标签页独立维护关键词列表，使用 `chrome.storage.local` 中特定 key 存储：

| Storage Key | 内容 | 说明 |
|-------------|------|------|
| `settings` | `Settings` | 全局设置（所有标签页共享） |
| `popupConfig` | `PopupConfig` | Popup 尺寸配置（全局） |
| `multi-highlight_{tabId}` | `TabInfo` | 每个标签页的关键词列表（独立） |

Tool functions:
- `get_tabkey(tabId)` -> `"multi-highlight_" + tabId`
- `get_tabId(tabkey)` -> `parseInt(tabkey.substring(16))`

### 4. DOM 变化监听

Content Script 使用 `MutationObserver` 监听页面 DOM 变化：

```javascript
var MutationObserverConfig = {
  childList: true,   // 子节点增删
  subtree: true,     // 监听整个子树
  characterData: true, // 文本内容变化
};
```

当 `isAlwaysSearch` 开启时，每次 DOM 变化都会触发 `hl_refresh()` 重建所有高亮。在执行高亮操作（添加/移除 span）时，会先 `disconnect()` observer 以避免递归触发，完成后再 `observe()` 重新连接。

### 5. 消息通信协议

扩展使用 Chrome Extension API 进行组件间通信：

| 发送方 | 接收方 | API | 消息类型 |
|--------|--------|-----|---------|
| Popup | Content Script | `chrome.tabs.sendMessage` | `hl_clearall`, `hl_refresh`, `_hl_search`, `_hl_clear` |
| Background | Content Script | `chrome.tabs.sendMessage` | `_hl_clear`, `_hl_search` |
| Content Script | Background | `chrome.runtime.sendMessage` | `getTabId` |
| Popup/Options | Background | `chrome.runtime.sendMessage` | `handle_addKw_change`, `handle_removeKw_change`, `handle_popupSize_change` |
| Injected Script | Popup | `chrome.runtime.sendMessage` | `getVisibleText` |
| Popup | Background | `chrome.runtime.connect` | `popup_{tabId}` port (用于检测 popup 关闭) |

### 6. Popup 空闲检测

使用 `jquery.inactivity` 插件，在用户停止输入 **300ms** 后触发完整刷新操作（`refresh: true`），避免每次按键都重建高亮。同时支持即时模式（`isInstant`）和分隔符触发模式。

### 7. 关键词可用性检查

Popup 通过 `chrome.scripting.executeScript` 注入 `getPagesSource.js` 到当前标签页：

1. `getPagesSource.js` 提取 `document.body.innerText`
2. 通过 `chrome.runtime.sendMessage` 发送给 popup
3. Popup 根据 `settings.isWholeWord` 和 `settings.isCasesensitive` 构建正则
4. 匹配关键词是否在页面文本中出现
5. 存在的关键词添加 `notAvailable` 类（灰色边框），不存在的保持彩色边框

### 8. 权限分析

| 权限 | 用途 | 数据访问范围 |
|------|------|------------|
| `activeTab` | 获取当前活动标签页 ID 和基本信息 | 仅当前标签页（用户激活后） |
| `storage` | 读写 chrome.storage.local | 仅扩展自身存储空间 |
| `contextMenus` | 注册"添加关键词"/"移除关键词"右键菜单 | 选中文本 |
| `scripting` | 注入 getPagesSource.js 获取页面文本 | 当前标签页 body.innerText |
| `https://*/*` | 在所有 HTTPS 页面注入 content script | 完整 DOM 访问 |
| `http://*/*` | 在所有 HTTP 页面注入 content script | 完整 DOM 访问 |

### 9. 外部依赖

| 库 | 版本 | 文件大小 | 许可证 |
|----|------|---------|--------|
| jQuery | v3.x (压缩) | ~87 KB | MIT |
| jQuery Highlight | 基于 highlight v3 修改 | ~8 KB | MIT |
| jQuery Inactivity | v1.3.2 (压缩) | ~1 KB | MIT |

---

## 构建信息

- **构建方式**: 无构建流程，直接使用原生 JavaScript
- **代码混淆**: 无（所有 JS 文件皆为可读源码）
- **Source Map**: 无
- **文件总数**: 23 (含图标资源 8 个、jQuery 库 3 个、Chrome 元数据 1 个)

---

## 版本信息

- **扩展版本**: 2.11.1
- **Manifest 版本**: 3
- **扩展 ID**: `ghinpogongmlphfkmnjfapdaoaaainejn`
- **更新 URL**: Chrome Web Store 自动更新
- **GitHub**: https://github.com/vinc96/Multi-Highlight
