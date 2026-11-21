# 架构文档 — Material Icons for GitHub (dsv4)

## 1. 概述

**Material Icons for GitHub** 是一款 Chrome 扩展（MV3），核心功能是在 Git 托管平台的文件浏览器中为每个文件/文件夹注入 Material Design 风格的 SVG 图标。它没有任何后台脚本（Service Worker），是纯粹的内容脚本型扩展。

- **版本**: 1.16.2
- **Manifest 版本**: 3
- **图标资源**: 约 1251 个 SVG 文件
- **核心逻辑**: 集中在单个打包文件 `main.js`（约 52K tokens）
- **支持站点**: GitHub、Bitbucket、Azure DevOps、Gitea、GitLab、Gitee、SourceForge、Codeberg、Tangled

## 2. 整体架构

```
material-icons-for-github/
├── manifest.json          # MV3 声明
├── main.js                # 核心逻辑（打包后单文件）
├── options.html           # 选项页面（Svelte/React 壳）
├── options.js             # 选项页逻辑
├── options.css            # 选项页样式
├── settings-popup.html    # 弹出窗口（Svelte/React 壳）
├── settings-popup.js      # 弹出窗口逻辑
├── settings-popup.css     # 弹出窗口样式
├── injected-styles.css    # 注入到页面的样式
├── icon-*.png             # 扩展图标（16/32/48/128）
└── *.svg                  # ~1251 个 Material Design SVG 图标
```

## 3. 组件关系

```
┌────────────────────────────────────────────────┐
│                  manifest.json                  │
│  content_scripts: [main.js + injected-styles]  │
│  permissions: storage, activeTab, scripting    │
│  web_accessible_resources: *.svg               │
└──────┬──────────────┬──────────────┬───────────┘
       │              │              │
       ▼              ▼              ▼
┌───────────┐ ┌────────────┐ ┌──────────────────┐
│  main.js  │ │  options   │ │ settings-popup   │
│ (content  │ │   page     │ │   page           │
│  script)  │ │ (Vue/React)│ │ (Vue/React)      │
└─────┬─────┘ └─────┬──────┘ └────────┬─────────┘
      │             │                │
      │    chrome.storage.sync       │
      └─────────────┼────────────────┘
                    │
           ┌────────▼────────┐
           │   User Settings  │
           │ (per-host keys)  │
           └─────────────────┘
```

## 4. main.js 内部模块划分

从逆向分析来看，`main.js` 是一个由 Vite/Rollup 打包的单文件，内含以下逻辑分区：

### 4.1 webextension-polyfill (第 1 层)
- 完整的 `webextension-polyfill` 库内联
- 将 Chrome 的 callback 式 API 包装为 Promise 接口
- 提供跨浏览器兼容层（Firefox/Chrome）

### 4.2 图标清单生成器 (第 2 层)
- `generateManifest()`: 根据用户设置生成完整的文件-图标映射表
- `availableIconPacks`: 暴露所有可选图标包列表
- 文件扩展名到图标的映射（数百种文件类型）
- 文件名到图标的精确匹配（配置文件、特殊文件）
- 语言 ID 到图标的映射

### 4.3 图标包定义 (第 3 层)
- 10 个图标包: Angular, Nest, NgRx, React, Redux, Roblox, Qwik, Vue, Vuex, Bashly
- 每个包定义了框架特有的文件-图标映射
- 支持 `fileExtensions`、`fileNames`、`patterns` 三种匹配方式
- 模式类型: `ecmascript`、`configuration`、`nodeEcosystem`、`cosmiconfig`、`yaml`、`dotfile`

### 4.4 设置管理 (第 4 层)
- 默认设置: `folders`、`rootFolders`、`files`、`languages`、`activeIconPack` 等
- Per-host 设置: `iconPack`、`iconSize`、`extEnabled`、`fileIconBindings`、`folderIconBindings`
- 存储键格式: `${hostname}:${settingKey}` (host 级) / `default:${settingKey}` (全局默认)
- 存储后端: `chrome.storage.sync`

### 4.5 DOM 注入引擎 (第 5 层)
- `as(siteConfig, iconPack, fileBindings, folderBindings)`: 主注入函数
  - 调用 `generateManifest()` 生成图标映射
  - 通过站点选择器查找所有文件行
  - 为每行创建 `<img>` 元素并替换原始图标
- `we(original, iconName, fileName, siteConfig)`: 创建 `<img>` 元素
  - 设置 `data-material-icons-extension="icon"`
  - 通过 `chrome.runtime.getURL(svgPath)` 加载 SVG
- `Co(name, nameLower, extensions, isDirectory, isGit, isSymlink, mapping)`: 确定图标名

### 4.6 站点配置 (第 6 层)
每个支持的 Git 托管站点有一个配置对象：

| 站点 | 选择器策略 | 特殊处理 |
|------|-----------|---------|
| **GitHub** | `tr.react-directory-row` / `[aria-labelledby="files"] div[role="row"]` | 文件夹行 class 检测 |
| **Bitbucket** | `table[data-qa="repository-directory"] tr` / `table.aui` | 图标检测 `span.aui-icon` |
| **Azure DevOps** | `.repos-files-tree tbody tr` / `.bolt-table tbody tr` | 多视图兼容 |
| **Gitea** | `#repo-files-table tbody tr` / `table.directory-listing-table` | 文件夹 `tr.folder` 检测 |
| **GitLab** | `table.tree-table tr.tree-item` / `table[data-qa-selector]` | SVGO 图标替换 |
| **Gitee** | `#git-project-tree-list a.item` / `#tree-list-holder` | `tree-item` class |
| **SourceForge** | `#files_list_table tbody tr` | 文件/文件夹区分 |
| **Codeberg (Forgejo)** | 与 Gitea 相同结构 | 继承 Gitea |
| **Tangled** | `#file-tree .grid` / `.tree-file` / `.tree-directory` | Tailwind class 检测 |

### 4.7 事件系统 (第 7 层)
- `chrome.runtime.onMessage` 监听:
  - `cmd: "init"`: 重新初始化图标注入
  - `cmd: "guessProvider"`: 按选择器猜测当前站点
- `chrome.storage.onChanged` 监听设置变化并重新渲染
- `MutationObserver`: 监听 `<body>` 属性变化（用于 `data-material-icons-extension-size` 响应）

### 4.8 入口点 (第 8 层)
```javascript
us(); // 自动执行
// us() → Me() → So(location.href) → gs(host) → as(site, iconPack, ...)
```

## 5. 关键设计模式

### 5.1 Adapter 模式
每个 Git 托管平台有独立的 SiteConfig 适配器，封装 DOM 选择器和行为差异，上层注入引擎完全统一。

### 5.2 策略模式
图标匹配使用三级策略：
1. **精确文件名匹配** (fileNames) — 优先级最高
2. **文件扩展名匹配** (fileExtensions) — 后备
3. **语言 ID 匹配** (languageIds) — 编辑器专用

### 5.3 观察者模式
- `MutationObserver` 仅用于 body 属性监听（性能友好）
- 不使用 DOM 树观察器（避免性能问题）
- 改为在导航切换时重新触发 `init`

### 5.4 缓存策略
- SVG 图标路径通过 hash 参数实现缓存破坏（基于设置变化计算 hash）
- 图标定义对象 `iconDefinitions` 按需构建，通过 `chrome.runtime.getURL()` 获取扩展资源 URL

## 6. 数据存储模型

```
chrome.storage.sync
├── "github.com:iconPack"          → "react"
├── "github.com:iconSize"           → "md"
├── "github.com:extEnabled"         → true
├── "default:iconPack"              → "react"
├── "default:iconSize"              → "md"
├── "default:extEnabled"            → true
└── "customProviders"               → { "mygitea.com": { ... } }
```

Per-host 键优先于 default 键。当用户在特定站点上更改设置时，写入 host 级键；否则读取 default 键。

## 7. 图标资源结构

```
*.svg (1251 files)
├── file.svg                  # 默认文件图标
├── folder.svg                # 默认文件夹图标
├── folder-open.svg           # 默认展开文件夹
├── html.svg, css.svg, ...    # 按文件类型命名
├── folder-src.svg            # 特殊文件夹图标
├── folder-src-open.svg       # 展开的特殊文件夹图标
├── react.svg, react_ts.svg   # 框架专用图标
├── *_light.svg               # 浅色主题变体
└── *_highContrast.svg        # 高对比度变体
```

## 8. 无后台脚本的设计含义

- 所有逻辑在 content script 中运行，随页面生命周期存在
- `chrome.runtime.onMessage` 直接在 content script 中响应（无需 Service Worker 转发）
- `chrome.storage` 访问无需后台脚本代理
- 适用于不需要后台任务（定时器、网络请求拦截等）的纯 UI 增强型扩展

## 9. 技术栈总结

| 组件 | 技术 |
|------|------|
| 打包工具 | Vite / Rollup（推断） |
| Polyfill | webextension-polyfill |
| UI 框架 | Vue 或 React（options/settings-popup） |
| 图标格式 | SVG（静态文件，非图标字体） |
| 存储 | chrome.storage.sync |
| 目标浏览器 | Chrome (MV3), 兼容 Firefox |
