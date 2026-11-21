# Tab Session Manager v7.3.0 — 架构文档

## 一、总体架构

```
┌─────────────────────────────────────────────────────┐
│                    Chrome 扩展 (MV3)                  │
├───────────────┬─────────────────┬───────────────────┤
│  Popup (React) │ Options (React) │ Replaced Page     │
│  会话列表 UI    │  设置页面        │  不可打开页面       │
│  popup.js      │  options.js     │  replaced.js      │
│  775KB         │  538KB          │  含 polyfill      │
├───────────────┴─────────────────┴───────────────────┤
│            Service Worker (background.js, 540KB)      │
│  ┌─────────────────────────────────────────────────┐ │
│  │  SessionManager   │  CloudSync    │  Backup      │ │
│  │  AutoSaver        │  Tracker      │  Compressor  │ │
│  │  Import/Export    │  TabGroup     │  TSTSupport  │ │
│  └─────────────────────────────────────────────────┘ │
│  ┌─────────┐  ┌───────────┐  ┌────────────────────┐ │
│  │IndexedDB│  │chrome.    │  │ Google Drive API    │ │
│  │sessions │  │storage    │  │ (OAuth 2.0)         │ │
│  └─────────┘  └───────────┘  └────────────────────┘ │
├─────────────────────────────────────────────────────┤
│            Offscreen Document (offscreen.js)         │
│             下载处理 (createObjectURL/revokeObjectURL)│
└─────────────────────────────────────────────────────┘
```

## 二、模块职责

| 模块 | 文件 | 大小 | 职责 |
|------|------|------|------|
| **Service Worker** | `background/background.js` | 540KB | 核心业务逻辑、会话 CRUD、自动保存、云端同步、数据迁移 |
| **Popup UI** | `popup/popup.js` + `popup/index.html` + `popup/popup.css` | 775KB + | 会话列表展示、搜索过滤排序、保存/恢复/删除操作 |
| **Options UI** | `options/options.js` + `options/index.html` + `options/options.css` | 538KB + | 完整的设置面板：通用/自动保存/启动/备份/云端同步/弹窗/主题 |
| **Offscreen** | `offscreen/offscreen.js` + `offscreen/index.html` | 含 polyfill | 在 MV3 下处理会话导出下载（URL.createObjectURL + downloads API） |
| **Replaced** | `replaced/replaced.js` + `replaced/index.html` + `replaced/replaced.css` | 含 polyfill | 展示无法通过 TSM 打开的 URL（如 `about:*` 页面） |
| **i18n** | `_locales/{34语言}/messages.json` | - | 国际化字符串，34 种语言 |

## 三、技术栈

| 层级 | 技术 | 版本 | 用途 |
|------|------|------|------|
| **框架** | React + ReactDOM | 16.13.1 | Popup 和 Options 页面的 UI 渲染 |
| **打包** | Webpack | 5.x | 模块打包（minified, 单文件输出） |
| **跨浏览器** | webextension-polyfill | 最新 | 统一的 `browser.*` API（兼容 Chrome/Firefox/Edge） |
| **工具库** | lodash | 4.x | 通用工具函数（深拷贝、节流、数组操作） |
| **日期** | moment.js | 2.x | 日期格式化和解析 |
| **ID** | uuid | - | 会话唯一标识生成 |
| **编码** | base64-js + buffer + ieee754 | - | 二进制数据处理 |
| **存储** | idb (IndexedDB wrapper) | - | 会话数据持久化 |
| **云端** | Google Drive API v3 | - | OAuth 2.0 云端同步 |
| **样式** | Pure CSS + CSS Variables | - | 支持 light/dark 主题 |

## 四、数据存储设计

### 4.1 存储分层

```
┌──────────────────────────────────────┐
│          chrome.storage.local         │  ← 设置数据 (Settings 对象)
│          (同步，跨设备不共享)           │
├──────────────────────────────────────┤
│            IndexedDB                  │  ← 会话数据 (Session[])
│            DB: "sessions"             │     (unlimitedStorage 权限)
│            Store: "sessions"          │
├──────────────────────────────────────┤
│          Google Drive                 │  ← 云端备份 (可选，Beta)
│          (appfolder 作用域)            │     每个会话一个 JSON 文件
└──────────────────────────────────────┘
```

### 4.2 会话存储 Schema (IndexedDB)

```
Key: session.id (UUID v4)
Value: Session {
  id: string,
  name: string,
  windows: [{id, tabs: [{url, title, favIconUrl, index, pinned, active, status, ...}]}],
  date: ISO8601,
  tag?: string,
  tags?: string[],
  driveFileId?: string  // Google Drive 文件 ID
}
```

### 4.3 设置存储 Schema (chrome.storage.local)

```
Key: "settings"
Value: Settings { ifOpenNewWindow, ifLazyLoading, autoSaveInterval, ... }
```

默认值在代码中硬编码，首次运行时写入 storage.local。

## 五、打包方式

- **Bundler**: Webpack 5
- **识别特征**: `__webpack_modules__`、`__webpack_require__`
- **入口分离**: 三个独立的 Webpack entry（background / popup / options），各自输出独立的 bundle
- **Offscreen/Replaced**: 独立小文件，分别内嵌 webextension-polyfill
- **混淆程度**: 中等（生产构建，代码压缩，变量名缩短，但未手工混淆，React 组件名称部分可见）
- **Source Map**: 未发布（production build 无 .map 文件）

## 六、权限清单与用途

| 权限 | 类型 | 用途 |
|------|------|------|
| `storage` | 必需 | 存储用户设置 (chrome.storage.local) |
| `unlimitedStorage` | 必需 | 允许 IndexedDB 存储大量会话数据，不受配额限制 |
| `tabs` | 必需 | 读取/创建/更新标签页和窗口 |
| `downloads` | 必需 | 导出会话为 JSON 文件下载到本地 |
| `identity` | 必需 | Google OAuth 2.0 身份验证 (云端同步) |
| `alarms` | 必需 | 定时触发自动保存 |
| `offscreen` | 必需 | MV3 下载处理（在 service worker 外创建 Blob URL） |
| `tabGroups` | 可选 | 保存和恢复 Chrome 标签组 |
| `https://www.googleapis.com/*` | 可选 host | Google Drive API 调用和 OAuth 验证 |

## 七、关键技术决策

1. **IndexedDB 而非 chrome.storage 存储会话**: `chrome.storage.local` 有 10MB 限制，大量标签页数据会超出配额，使用 `unlimitedStorage` + IndexedDB 满足需求。

2. **Offscreen Document 处理下载**: MV3 Service Worker 无法使用 `URL.createObjectURL`，需创建 offscreen 文档中转。

3. **Webpack 将 polyfill 打入每个 bundle**: background、popup、options 均内联了完整的 webextension-polyfill（约 50KB），增加总体积但保证独立运行。

4. **单 Webpack entry 输出单 JS 文件**: CSS 未被 inline（独立 .css 文件），JS 完全捆绑，无 code splitting。

5. **Google Drive appfolder 作用域**: 云端同步仅访问应用专属文件夹 (`https://www.googleapis.com/auth/drive.appfolder`)，不访问用户其他 Drive 文件。

## 八、文件清单

```
tab-session-manager-source-code/
├── manifest.json                    # MV3 声明
├── _locales/                        # 34 种语言 i18n
│   └── {lang}/messages.json
├── _metadata/                       # Chrome Web Store 元数据
│   └── verified_contents.json
├── background/
│   ├── background.js                # Service Worker (Webpack bundle, 540KB)
│   └── background.js.LICENSE.txt    # 第三方库许可声明
├── popup/
│   ├── popup.js                     # 弹窗 UI (Webpack bundle, 775KB)
│   ├── popup.css                    # 弹窗样式
│   ├── popup.js.LICENSE.txt
│   └── index.html                   # HTML 入口 (<div id="root"/>)
├── options/
│   ├── options.js                   # 设置页面 (Webpack bundle, 538KB)
│   ├── options.css                  # 设置页面样式
│   ├── options.js.LICENSE.txt
│   └── index.html                   # HTML 入口
├── offscreen/
│   ├── offscreen.js                 # 下载辅助 (含 webextension-polyfill)
│   └── index.html
├── replaced/
│   ├── replaced.js                  # 不可打开页面展示 (含 webextension-polyfill)
│   ├── replaced.css
│   ├── replaced.html
│   └── index.html
└── icons/
    ├── icon.png / icon.svg          # 64px 图标
    ├── icon_min.png / icon_min.svg  # 16px 图标
    ├── favicon.png                  # 默认 favicon
    ├── nofavicon.png               # 无 favicon 占位
    ├── google_signin.png           # Google 登录按钮图标
    ├── patreonButton.png           # Patreon 按钮
    └── paypalButton.png            # PayPal 按钮
```
