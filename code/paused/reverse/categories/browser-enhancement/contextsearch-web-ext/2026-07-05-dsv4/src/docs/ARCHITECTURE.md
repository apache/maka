# ContextSearch web-ext 架构文档

> 基于 v1.48.4.13 源码逆向分析，原文链接: https://github.com/ssborbis/ContextSearch-web-ext

## 一、项目概述

ContextSearch web-ext 是一个 Chrome/Firefox 浏览器扩展，允许用户通过右键菜单、快捷悬浮菜单、侧边栏、弹出窗口、快捷键等多种方式，使用任意搜索引擎快速搜索选中文本或链接。核心能力包括：

- 右键菜单搜索（支持上下文感知布局）
- Quick Menu 悬浮面板（拖选/点击/快捷键弹出）
- 搜索栏/Toolbar 弹出窗口
- 侧边栏面板
- 查找栏 + 关键词高亮
- Page Tiles 可视化搜索入口
- Omnibox 地址栏搜索
- 搜索引擎管理（支持 OpenSearch、POST 搜索、外部程序调用）

## 二、目录结构

```
contextsearch-web-ext-source-code/
├── manifest.json              # MV3 清单
├── background.js              # Service Worker 主入口 (1887行)
├── init_content.js            # Content Script 入口 (27行)
│
├── inject.js                  # 页面注入主逻辑 (全局变量 quickMenuObject)
├── inject_quickmenu.js        # 快捷菜单 iframe 注入与交互
├── inject_sidebar.js          # 侧边栏注入
├── inject_highlight.js        # 关键词高亮注入 (依赖 mark.js)
├── inject_pagetiles.js        # Page Tiles 注入
├── inject_addContextSearchEngine.js  # 自定义搜索引擎添加
├── inject_mycroftproject.js   # MycroftProject 钩子
├── inject_resultsEngineNavigator.js  # 搜索结果导航
│
├── contextMenu.js             # 右键菜单构建与搜索分发
├── searchbar.html/js          # Popup 搜索栏页面
├── quickmenu.html/js          # QuickMenu iframe 页面
├── options.html/js            # 设置页面 (~2082行HTML, 大型单页应用)
├── findbar.html/js            # 查找栏 UI
│
├── utils.js                   # 通用工具 (debounce, throttle, CopyPaste)
├── nodes.js                   # 节点树操作 (遍历/增删/查找/序列化)
├── contexts.js                # 上下文位掩码系统
├── contextsearchwindow.js     # 搜索窗口创建
├── searchEngineManager.js     # 设置页面的搜索引擎管理器 UI
├── searchEngineUtils.js       # 搜索引擎工具函数
├── searchActions.js           # 搜索动作分发 (mouseup/click → openMethod)
├── opensearch.js              # OpenSearch 参数替换与 POST
├── defaultEngines.js          # 默认搜索引擎列表
├── defaultUserOptions.js      # 用户选项默认值 (包含完整配置树)
├── update_useroptions.js      # 用户选项版本迁移
├── iconUtils.js               # 图标工具 (favicon 抓取、Canvas 生成)
├── bookmarks.js               # 书签操作 (bookmarklet)
├── keyTable.js                # 按键码表
├── Shortcuts.js               # 快捷键系统
├── TabHighlighter.js          # 标签页高亮跟踪
├── dock.js                    # iframe 停靠定位引擎
├── dragshake.js               # 拖拽抖动检测
├── resizeWidget.js            # 侧边栏缩放手柄
├── tilemenu.js                # 瓦片菜单渲染引擎
├── tools.js                   # QMtools 工具定义
├── themes.js                  # 主题系统
├── palettes.js                # 调色板
├── grid.js                    # 网格布局引擎
├── mozlz4.js                  # Firefox search.json.mozlz4 解析
├── omnibox.js                 # Omnibox 地址栏搜索
├── import_export.js           # 导入/导出
├── post.js                    # POST 表单提交
├── findbar.js                 # 查找栏逻辑
├── pagetiles.js               # Page Tiles 逻辑
│
├── lib/                       # 第三方库
│   ├── browser-polyfill.min.js
│   ├── encoding-indexes.js
│   ├── encoding.min.js
│   └── mark.es6.min.js
│
├── _locales/                  # 国际化
├── _metadata/                 # Chrome Web Store 元数据
├── icons/                     # SVG 图标
├── styles/                    # 样式
└── update/                    # 更新脚本
```

## 三、核心架构

### 3.1 分层结构

```
┌─────────────────────────────────────────────────────┐
│                    UI 层                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │QuickMenu │ │SearchBar │ │ Sidebar  │ │Options │ │
│  │ iframe   │ │  popup   │ │ 注入     │ │  Page  │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬────┘ │
│       │            │            │           │       │
├───────┴────────────┴────────────┴───────────┴───────┤
│                 消息总线层                             │
│  ┌─────────────────────────────────────────────────┐ │
│  │  browser.runtime.sendMessage / onMessage        │ │
│  │  + browser.tabs.sendMessage (content scripts)   │ │
│  └──────────────────────┬──────────────────────────┘ │
├──────────────────────────┴───────────────────────────┤
│              Service Worker 层 (background.js)        │
│  ┌──────────┐ ┌────────────┐ ┌────────────────────┐ │
│  │Context   │ │  Search    │ │  UserOptions       │ │
│  │Menu      │ │  Engine    │ │  Manager           │ │
│  │Builder   │ │  Dispatcher│ │  (storage.local)    │ │
│  └──────────┘ └────────────┘ └────────────────────┘ │
├─────────────────────────────────────────────────────┤
│                 数据层                                │
│  ┌──────────────────┐  ┌──────────────────────────┐ │
│  │ storage.local    │  │ storage.session           │ │
│  │ (userOptions)    │  │ (lastSearch, clipboard)   │ │
│  └──────────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 3.2 核心模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| Service Worker | `background.js` | 生命周期管理、消息路由、选项持久化、搜索引擎分发、用户脚本注册 |
| Content Script 入口 | `init_content.js` | 按需注入主逻辑（点击/聚焦触发 `injectContentScripts`） |
| 页面注入核心 | `inject.js` | Shadow DOM 创建、`quickMenuObject` 全局状态、选中文本追踪、鼠标事件监听 |
| 右键菜单 | `contextMenu.js` | `buildContextMenu` 构建菜单树、`contextMenuSearch` 处理点击分发 |
| 快捷菜单 iframe | `quickmenu.html` + `quickmenu.js` | QuickMenu UI 渲染、文件夹导航、搜索执行 |
| 搜索引擎管理 | `searchEngineManager.js` | 设置页的节点树编辑器（拖拽排序、表单编辑、右键上下文菜单） |
| 节点树 | `nodes.js` | 树结构遍历/查找/增删/序列化，节点类型定义 (`nodeDefaults`) |
| 上下文过滤 | `contexts.js` | 7 种上下文类型的位掩码 + 节点按上下文过滤 (`filterContexts`) |
| OpenSearch | `opensearch.js` | URL 模板参数替换 (`{searchTerms}`, `{selectdomain}` 等) + POST 搜索 |
| 快捷键 | `Shortcuts.js` | 全局键盘快捷键注册和匹配 |
| 图标工具 | `iconUtils.js` | favicon 抓取、Canvas 生成单字母图标、图片 Base64 缓存 |
| 编码 | `lib/encoding.min.js` | 非 UTF-8 字符集编码（如 SHIFT_JIS） |

## 四、节点树系统

所有用户配置（搜索引擎、文件夹、书签脚本等）存储在一棵树结构 (`userOptions.nodeTree`) 中。

### 节点类型

| 类型 | 说明 | 关键字段 |
|------|------|----------|
| `folder` | 文件夹 | `children`, `displayType`, `groupFolder` |
| `searchEngine` | 搜索引擎 | `template`, `method`, `params`, `queryCharset`, `searchCode` |
| `oneClickSearchEngine` | Firefox 原生搜索引擎 | `icon` (favIconUrl) |
| `bookmarklet` | 书签/脚本 | `searchCode` (JS 代码) |
| `externalProgram` | 外部程序 | `path`, `cwd`, `postScript` |
| `separator` | 分隔线 | — |
| `tool` | 工具按钮 | `tool` (对应 QMtools 键) |

### 上下文位掩码

每个节点用 `contexts` 字段（整数位掩码）控制在不同上下文中的可见性：

| 上下文 | 位值 | 含义 |
|--------|------|------|
| audio | 1 | 音频元素 |
| frame | 2 | 框架/iframe |
| image | 4 | 图片元素 |
| link | 8 | 链接 |
| page | 16 | 页面本体 |
| selection | 32 (默认) | 文本选中 |
| video | 64 | 视频元素 |

## 五、URL 模板系统

搜索引擎的 `template` 字段支持以下占位符（在 `opensearch.js` 中解析）：

| 占位符 | 说明 |
|--------|------|
| `{searchTerms}` | 搜索关键词 |
| `{selectdomain}` | 当前页面域名（构建 site: 搜索） |
| `{selectdomain.path}` | 域名的特定路径层级 |
| `{encoding}` | 指定字符集编码 |
| `{prompt}` / `{prompt=label}` | 弹出用户输入框 |
| `{download_url}` / `{download_url=path}` | 下载并返回本地路径 (外部程序) |

## 六、技术要点

1. **延迟注入**: `init_content.js` 仅在用户交互（mousedown/click）时通过消息触发主逻辑注入，避免性能影响
2. **Shadow DOM**: `inject.js` 创建 Shadow Root 隔离 QuickMenu UI，防止页面样式冲突
3. **全局状态同步**: `quickMenuObject` 通过 `browser.tabs.sendMessage` 在 iframe frame 间同步
4. **位掩码上下文**: 7 种上下文使用位运算组合，高效过滤
5. **importScripts 加载**: Service Worker 通过 `importScripts` 批量加载模块，避免 ES module 兼容问题
6. **双模式用户脚本**: Chrome 用 `browser.userScripts.execute()` (USER_SCRIPT world)，Firefox 用 `browser.scripting.executeScript()` (MAIN world) + `browser.userScripts.register()`
7. **POST 搜索**: 通过动态注入表单并 `submit()` 实现
8. **外部程序调用**: 通过 Native Messaging (`contextsearch_webext`) 调用本地命令行工具
