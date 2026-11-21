# Octotree v8.3.0 架构文档

> 逆向工程分析 (dsv4) | 基于 v8.3.0 | Manifest V3

---

## 一、项目概览

Octotree 是一款 Chrome 浏览器扩展，为 GitHub 仓库页面提供侧边栏树形视图，类似于 IDE 中的文件浏览器。用户可快速浏览、搜索和访问仓库中的任意文件，极大提升 GitHub 代码浏览体验。

- **版本**: 8.3.0
- **Manifest 版本**: V3
- **扩展名称**: Octotree - GitHub code tree
- **作者**: Team Octotree
- **官网**: https://www.octotree.io

---

## 二、文件结构

```
dist/
├── manifest.json              # 扩展清单（MV3）
├── background.js              # Service Worker（Webpack 打包，~21KB）
├── content.js                 # 内容脚本（Webpack 打包，~565KB）
├── content.css                # 侧边栏与树形视图样式（~1.2MB）
├── browser-polyfill.js        # Mozilla WebExtension Polyfill（~10KB）
├── NOTICE.txt                 # 第三方库许可声明（~67KB）
├── fonts/                     # 字体文件（18 个 .woff2 文件）
│   ├── anonymous-pro.woff2
│   ├── cascadia-code.woff2
│   ├── devopicons.woff2
│   ├── file-icons.woff2
│   ├── fira-code.woff2
│   ├── fontawesome.woff2
│   ├── inconsolata.woff2
│   ├── iosevka-regular.woff2
│   ├── jetbrains-mono.woff2
│   ├── mfixx.woff2
│   ├── octicons.woff2
│   ├── octotree.woff2
│   ├── recursive-mono.woff2
│   ├── source-code-pro.woff2
│   ├── space-mono.woff2
│   ├── ubuntu-mono.woff2
│   └── victor-mono-regular.woff2
├── icons/                     # 扩展图标 + VSCode 文件图标主题
│   ├── icon16/32/48/128/256/512/1024.png
│   ├── logo.svg
│   ├── vscode/               # VSCode 风格文件图标（~250+ SVG）
│   └── vscodemat/            # VSCode Material 风格文件图标
├── images/                    # 扩展内嵌图片
│   ├── 32px.png
│   ├── 40px.png
│   ├── throbber.gif          # 加载动画
└── _metadata/                 # Chrome Web Store 元数据
```

---

## 三、架构分层

```mermaid
graph TD
    subgraph "GitHub 页面 (宿主环境)"
        CS[content.js<br/>内容脚本<br/>~565KB, Webpack 打包]
        CSS[content.css<br/>样式表 ~1.2MB]
        FONTS[fonts/<br/>18个字体文件]
        ICONS[icons/vscode<br/>文件图标 SVG]
    end

    subgraph "Chrome 扩展运行时"
        SW[background.js<br/>Service Worker<br/>~21KB, Webpack 打包]
    end

    subgraph "外部服务"
        OCTO[api.octotree.io<br/>许可证/用户数据]
        GITHUB[api.github.com<br/>GitHub REST API]
    end

    SW -->|chrome.tabs.sendMessage| CS
    CS -->|chrome.runtime.sendMessage<br/>octotree_send_request| SW
    SW -->|fetch| OCTO
    SW -->|fetch (通过 content 代理)| GITHUB
    CS -->|注入 DOM| GitHub页面
    CS -->|fetch| GITHUB

    style SW fill:#e1f5fe
    style CS fill:#fff3e0
    style OCTO fill:#f3e5f5
    style GITHUB fill:#e8f5e9
```

---

## 四、模块职责表

| 模块 | 文件 | 大小 | 职责 |
|------|------|------|------|
| **Service Worker** | `background.js` | ~21KB | 权限管理、右键菜单、API 请求代理、动态内容脚本注册 |
| **内容脚本** | `content.js` | ~565KB | GitHub 页面 DOM 操作、树形视图渲染、文件内容加载、搜索、GitHub API 调用 |
| **样式表** | `content.css` | ~1.2MB | 侧边栏 UI 样式、树形视图样式、主题变量、响应式布局 |
| **Polyfill** | `browser-polyfill.js` | ~10KB | Mozilla WebExtension Polyfill（Firefox/Chrome 兼容） |
| **字体** | `fonts/*.woff2` | ~1MB | 等宽代码字体（11 种）+ 图标字体（7 种） |
| **图标** | `icons/vscode/*.svg` | ~1.5MB | VSCode 风格文件类型图标（250+ 种文件类型） |

---

## 五、技术栈识别

### 5.1 打包工具

**Webpack** — 两个 JS 文件均为 Webpack 打包产物：
- `background.js`: Webpack bootstrap 代码可见，使用 `__webpack_require__` 模式
- `content.js`: 同样的 Webpack bootstrap，更大体积反映了完整的 UI 逻辑

判断依据：
1. 文件头存在 Webpack IIFE 包装 `(() => { ... })()`
2. 代码中包含 `webpackChunk`、`__webpack_require__` 引用
3. 模块加载模式符合 Webpack 5 特征

### 5.2 核心框架与库

| 技术 | 版本/说明 | 用途 |
|------|----------|------|
| **jQuery** | 内嵌 (经 Terser 压缩) | DOM 操作、事件处理、AJAX |
| **jQuery UI** | 内嵌 | UI 组件（拖拽、调整大小等） |
| **jQuery-pjax** | 内嵌 | GitHub 页面 pjax 导航兼容 |
| **jsTree** | 内嵌 | 文件树渲染核心 |
| **keymaster** | 内嵌 | 键盘快捷键管理 |
| **blueimp-md5** | 内嵌 | MD5 哈希计算 |
| **fast-copy** | 内嵌 | 深度对象拷贝 |
| **file-icons-js** | 内嵌 | 文件类型图标映射 |
| **find-versions** | 内嵌 | 语义化版本号解析 |
| **semver-compare** | 内嵌 | 版本号比较 |
| **webextension-polyfill** | Mozilla, MPL-2.0 | 浏览器 API 兼容层 |
| **webext-patterns** | fregante, MIT | URL 模式匹配 |
| **webext-permission-toggle** | fregante, MIT | 域名级权限切换 |
| **webext-dynamic-content-scripts** | fregante, MIT | 动态内容脚本注入 |

### 5.3 字体资源

| 字体 | 许可 | 用途 |
|------|------|------|
| Cascadia Code | SIL OFL 1.1 | 代码文件展示 |
| Fira Code | SIL OFL 1.1 | 代码文件展示 |
| Iosevka | SIL OFL 1.1 | 代码文件展示 |
| JetBrains Mono | SIL OFL 1.1 | 代码文件展示 |
| Source Code Pro | SIL OFL 1.1 | 代码文件展示 |
| Ubuntu Mono | (Ubuntu 字体许可) | 代码文件展示 |
| Inconsolata | SIL OFL 1.1 | 代码文件展示 |
| Anonymous Pro | SIL OFL 1.1 | 代码文件展示 |
| Recursive Mono | SIL OFL 1.1 | 代码文件展示 |
| Space Mono | SIL OFL 1.1 | 代码文件展示 |
| Victor Mono | SIL OFL 1.1 | 代码文件展示 |
| Font Awesome | (字体图标许可) | UI 图标 |
| Octicons | GitHub, MIT | GitHub 风格图标 |
| Devopicons | — | 开发工具图标 |
| File Icons | MIT | 文件类型图标 |
| MFixx | — | 特殊图标 |
| Octotree | (自定制) | Octotree 专用图标 |

---

## 六、权限清单表

| 权限 | 类型 | 用途 | 风险等级 |
|------|------|------|----------|
| `storage` | `permissions` | 用户设置、Token、许可证信息持久化 | 低 |
| `contextMenus` | `permissions` | 右键菜单权限切换（启用/禁用 Octotree） | 低 |
| `activeTab` | `permissions` | 获取当前活动标签页 URL（用于权限判断） | 低 |
| `scripting` | `permissions` | 动态脚本注入（`chrome.scripting.executeScript`） | 中 |
| `https://api.github.com/*` | `host_permissions` | 调用 GitHub REST API 获取仓库树/文件内容 | 中 |
| `https://www.octotree.io/*` | `host_permissions` | 调用 Octotree 后端 API（许可证验证/用户数据） | 中 |
| `http://*/*` | `optional_host_permissions` | 可选：允许在非 GitHub 网站使用 | 高 |
| `https://*/*` | `optional_host_permissions` | 可选：允许在非 GitHub 网站使用 | 高 |
| `web_accessible_resources` | — | 字体/图片/图标暴露给宿主页面 | 低 |

---

## 七、入口点分析

### 7.1 Service Worker (`background.js`)

```
启动流程:
  1. Service Worker 首次激活
  2. 注册 `octotree_send_request` 消息监听器（API 代理）
  3. 初始化 webext-permission-toggle（右键菜单）
  4. 初始化 webext-dynamic-content-scripts（可选域名注入）
  5. 检测当前标签页 URL，更新权限切换开关状态
```

关键入口函数：
- **消息监听器**: `browser.runtime.onMessage.addListener` — 监听来自 content script 的 `octotree_send_request` 消息
- **权限切换**: `chrome.contextMenus.onClicked.addListener` — 处理用户点击右键菜单"Enable Octotree on this domain"
- **标签页切换**: `chrome.tabs.onActivated` / `chrome.tabs.onUpdated` — 跟踪活动标签页并更新菜单状态

### 7.2 Content Script (`content.js`)

```
启动流程:
  1. document_start 阶段注入（DOM 构建之前）
  2. 检测当前页面是否为 GitHub 仓库页面
  3. 如果是仓库页面:
     a. 解析 URL，提取 owner/repo/branch
     b. 创建侧边栏 DOM 容器
     c. 注入 jQuery + jsTree
     d. 通过 GitHub API 获取仓库文件树
     e. 渲染 jsTree 树形视图
     f. 绑定事件（点击/搜索/键盘快捷键）
  4. 如果不是仓库页面: 不渲染，等待 pjax 导航
```

关键功能模块：
- **仓库检测**: URL 模式匹配 GitHub 仓库页面
- **树形视图**: jsTree 渲染文件/目录列表
- **文件查看**: 点击文件后通过 GitHub API 获取内容并渲染
- **搜索**: 文件/目录名称模糊搜索
- **主题切换**: 深色/浅色/跟随系统
- **设置同步**: 通过 `chrome.storage.local` 持久化用户偏好
- **键盘快捷键**: keymaster 驱动的快捷键绑定

### 7.3 Content Script 注入匹配

```json
{
  "matches": ["https://github.com/*"],
  "run_at": "document_start",
  "js": ["content.js"],
  "css": ["content.css"]
}
```

仅注入 `github.com` 页面，可选域名通过用户手动授权（右键菜单）扩展。

---

## 八、关键设计决策

### 8.1 API 代理模式

Content Script 不直接调用 Octotree 后端 API，而是通过消息通道交由 Service Worker 代理：

**原因**: MV3 Service Worker 无法直接访问 DOM，但 Content Script 运行在页面沙箱中。将 API 请求提升到 SW 层可以：
1. 统一管理身份认证（Bearer Token）
2. 处理 API 限流（Retry-After 头）
3. 避免在页面上下文中暴露 API 密钥

### 8.2 动态域名权限

采用 `optional_host_permissions` + 右键菜单切换的设计：
- 默认仅在 `github.com` 运行
- 用户可通过右键菜单为特定域名授权（如 GitHub Enterprise 实例）
- `webext-dynamic-content-scripts` 库监听权限变更，自动注入/移除 content script

### 8.3 jsTree 树形渲染

使用 jsTree 而非自研树形组件，原因：
- jsTree 成熟稳定，支持异步加载、拖拽、搜索
- 直接利用 jQuery 生态（扩展已依赖 jQuery 用于 DOM 操作）
- 减少自定义 UI 维护成本

### 8.4 多字体策略

扩展内置 11 种等宽代码字体（~1MB），用户可在设置中选择。使用 `web_accessible_resources` 以 `*.woff2` 通配模式暴露给页面，通过 CSS `@font-face` 加载。

### 8.5 VSCode 图标主题

包含两个完整的 VSCode 文件图标集（`icons/vscode/` 和 `icons/vscodemat/`），支持 250+ 种文件类型的图标映射，使用 `file-icons-js` 库完成文件扩展名到图标的映射。

---

## 九、资源总览

| 资源类型 | 文件数 | 总大小（约） |
|----------|--------|-------------|
| JavaScript | 3 | ~596KB |
| CSS | 1 | ~1.2MB |
| SVG 图标 | ~600 | ~1.5MB |
| PNG 图标 | 9 | ~71KB |
| 字体 (woff2) | 17 | ~1.0MB |
| 其他 | 3 | ~68KB |
| **合计** | **~630** | **~4.4MB** |
