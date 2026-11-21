# JSON Viewer Pro 架构文档

> 逆向工程分析 (dsv4) | 基于 v1.0.6 | Manifest V3

---

## 一、项目概览

JSON Viewer Pro 是一款 Chrome 浏览器扩展，当用户访问返回 JSON 数据的页面或打开本地 JSON 文件时，自动将原始 JSON 文本渲染为可交互的树形查看器，支持搜索、图表视图和主题切换。

- **版本**: 1.0.6
- **Manifest 版本**: V3
- **权限**: `contextMenus`, `storage`, `host_permissions: *://*/*`

---

## 二、文件结构

```
dist/
├── manifest.json                  # 扩展清单（MV3）
├── index.html                     # 独立标签页入口（点击扩展图标打开）
├── options.html                   # 设置页
├── js/
│   ├── background.js              # Service Worker（后台）
│   ├── contentScript.js           # 内容脚本（注入所有页面）
│   ├── main.js                    # 主应用（React + CodeMirror，~954 KB）
│   └── options.js                 # 设置页应用（~436 KB）
├── css/
│   ├── style.css                  # 主样式
│   ├── codemirror.css             # CodeMirror 编辑器样式
│   ├── options.css                # 设置页样式
│   └── color-themes/
│       ├── dark-pro.css           # 默认深色主题
│       └── mdn-light.css          # MDN 风格浅色主题
└── images/icons/                  # 图标资源
```

---

## 三、架构分层

```
┌─────────────────────────────────────────────────────┐
│                  Service Worker                     │
│              (js/background.js)                      │
│                                                     │
│  - 管理右键菜单（Download JSON / Settings）           │
│  - chrome.storage.local 读写选项                     │
│  - 向所有标签页广播选项变更                           │
│  - 处理扩展图标点击（打开独立查看页）                  │
└──────────────┬──────────────────────────────────────┘
               │  chrome.tabs.sendMessage()
               │  chrome.runtime.onMessage
               ▼
┌─────────────────────────────────────────────────────┐
│                Content Script                       │
│            (js/contentScript.js)                     │
│                                                     │
│  - 注入时机: document_start                          │
│  - JSON 检测: contentType 或 解析页面文本             │
│  - URL 过滤（按前缀匹配跳过指定网站）                  │
│  - 动态注入 CSS <link> 与 main.js <script>           │
│  - 通过 <meta> 标签向 main.js 传递选项               │
└──────────────┬──────────────────────────────────────┘
               │  注入 js/main.js + css/style.css
               ▼
┌─────────────────────────────────────────────────────┐
│                   Main App                          │
│               (js/main.js)                           │
│                                                     │
│  - 内嵌 React 18 (production build)                  │
│  - 内嵌 CodeMirror 6 (编辑器)                        │
│  - Tab: tree（树形查看）/ chart（图表）/ jsonInput    │
│  - 支持搜索、折叠、复制、下载 JSON                    │
│  - 从 <meta name="extension-options"> 读取配置       │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│                 Options Page                        │
│            (options.html + js/options.js)            │
│                                                     │
│  - CodeMirror 自定义 CSS 编辑器                      │
│  - 主题选择 / JSON 检测策略 / URL 过滤               │
│  - 通过 chrome.storage.local 持久化                  │
│  - 保存时广播 settings_updated 到 content script     │
└─────────────────────────────────────────────────────┘
```

---

## 四、关键设计决策

### 4.1 MV3 限制下的选项传递

Manifest V3 禁止内容脚本使用 `chrome.storage.local`（Service Worker 中可用但内容脚本运行在隔离世界）。该扩展的解决方案是：

1. Service Worker 从 `chrome.storage.local` 读取选项
2. 通过 `chrome.tabs.sendMessage()` 发送给内容脚本
3. 内容脚本将选项序列化为 `<meta name="extension-options" content="...">` 标签
4. `main.js` 从 DOM 中读取该 meta 标签获取配置

### 4.2 JSON 检测双重策略

| 策略 | 方法 | 适用场景 |
|------|------|----------|
| Content Type 检测 | 检查 `document.contentType` | API 返回 JSON 的页面 |
| JSON Content 检测 | 移除 script/style 后尝试 `JSON.parse()` 页面文本 | 无正确 Content-Type 头但内容为 JSON 的页面 |

### 4.3 模块打包

`main.js` 和 `options.js` 均为 Webpack/Rollup 打包产物，包含：
- **main.js**: React 18 + ReactDOM + CodeMirror 6 + 自定义 JSON 查看器组件
- **options.js**: CodeMirror 6 + 选项管理逻辑

两个文件均经 Terser 压缩混淆，变量名被替换为短名（如 `QX`, `Wt` 等）。

### 4.4 URL 过滤机制

用户在设置页配置 URL 列表，内容脚本在渲染前执行前缀匹配：

```
if (filteredURL.some(url => window.location.href.startsWith(url))) {
    // 跳过渲染
}
```

---

## 五、权限使用分析

| 权限 | 用途 |
|------|------|
| `contextMenus` | 注册右键菜单（Download JSON、Settings） |
| `storage` | 通过 `chrome.storage.local` 持久化用户选项 |
| `host_permissions: *://*/*` | 内容脚本匹配所有 HTTP/HTTPS/FTP/file 页面 |
| `web_accessible_resources` | 暴露 main.js、CSS、图标给宿主页面 |

---

## 六、独立标签页模式

点击扩展图标时，Service Worker 打开 `index.html`（附带选项查询参数），该页面：

1. 读取自身 `<pre>` 标签或页面文本作为 JSON 输入
2. 从 URL query string 或 meta 标签获取选项
3. 使用 React 渲染 JSON 查看器（不通过内容脚本）

---

## 七、技术栈总结

| 技术 | 用途 |
|------|------|
| React 18 | UI 框架（树形查看器 + 图表） |
| CodeMirror 6 | 自定义 CSS 编辑器（设置页） + JSON 输入 Tab |
| Chrome Extension MV3 API | 扩展生命周期与通信 |
| chrome.storage.local | 选项持久化 |
| Terser | JS 压缩混淆 |
