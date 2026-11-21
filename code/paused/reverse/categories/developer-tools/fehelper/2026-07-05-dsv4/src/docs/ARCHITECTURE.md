# FeHelper 架构文档

> 反向工程版本：dsv4 | 原始版本：v2026.7.3 | Manifest V3  
> 分析范围：`background.js`、`popup/`、`options/`、各工具页面、内容脚本、沙箱页

---

## 一、概览

FeHelper（前端助手）是一个由 nicetool.net 维护的 Chrome 扩展，内置 30+ 开发者工具，覆盖 JSON 格式化、编解码、二维码生成、代码美化、API 调试等场景。架构采用"按需安装 + 独立工具页"模式，每个工具为独立目录，通过 Service Worker 统一协调消息传递和脚本注入。

| 指标 | 数值 |
|------|------|
| 工具数量 | 34 个注册工具（含 2 个无页工具） |
| 源码文件 | 约 263 个 |
| Manifest 版本 | 3 |
| CSP 扩展页 | `script-src 'self'` |
| CSP 沙箱页 | `script-src 'self' 'unsafe-eval'` |
| 开源仓库 | <https://github.com/zxlie/FeHelper> |

---

## 二、目录结构

```
fehelper-source-code/
├── manifest.json                  # MV3 声明
├── background/                    # Service Worker 核心
│   ├── background.js              # SW 入口：消息总线、生命周期
│   ├── awesome.js                 # 工具安装/卸载/存储管理器
│   ├── tools.js                   # 工具注册表（34 个工具定义）
│   ├── menu.js                    # 右键菜单管理
│   ├── inject-tools.js            # 内容脚本注入引擎
│   ├── monkey.js                  # 油猴脚本运行时
│   ├── statistics.js              # 使用统计
│   ├── url-policy.js              # URL 可注入判断
│   └── crx-download.js            # CRX 下载模块
├── static/                        # 全局静态资源
│   ├── js/
│   │   ├── common.js              # MSG_TYPE 消息类型枚举
│   │   ├── dark-mode.js           # 夜间模式
│   │   └── tool-layout.js         # 工具页布局助手
│   ├── css/
│   │   ├── fehelper-tools.css     # 工具页通用样式
│   │   └── fh-ai-inline.css       # AI 内联面板样式
│   ├── img/                       # 图标资源
│   └── vendor/                    # 第三方库（jQuery、Vue.js、CodeMirror、JsBarcode、ZXing、Prism 等）
├── popup/                         # 插件弹窗（Lite/Omni 双模式）
│   ├── index.html                 # Vue.js 驱动
│   ├── index.js                   # 弹窗主逻辑
│   └── theme-boot.js              # 主题预加载（防闪白）
├── options/                       # 设置控制台
│   ├── index.html                 # Vue.js 驱动
│   ├── index.js                   # 工具市场 + 设置面板
│   ├── settings.js                # 设置读写抽象
│   └── theme-boot.js              # 主题预加载
├── dynamic/                       # 沙箱 & 运行时可执行页
│   ├── sandbox.html               # CSP sandbox 页（unsafe-eval）
│   ├── sandbox.js                 # 沙箱消息处理
│   ├── index.html                 # 第三方开发工具渲染页
│   ├── index.js                   # 渲染逻辑
│   ├── runtime.js                 # 运行时工具函数
│   └── native-function.js         # 原生函数桥接
├── aiagent/                       # AI 智能助手
│   ├── fh.ai.js                   # AI 核心（Chrome Built-in AI / Gemini Nano）
│   ├── fh.ai-features.js          # AI 功能定义
│   └── fh.ai-inline.js            # 工具页嵌入式 AI 面板逻辑
├── json-format/                   # JSON 格式化（系统内置工具）
│   ├── index.html                 # 完整编辑器 + 工具栏
│   ├── index.js                   # 格式化主逻辑
│   ├── format-lib.js              # 格式化核心库
│   ├── json-abc.js                # JSON ABC 辅助
│   ├── json-decode.js             # 自动解码检测
│   ├── json-bigint.js             # BigInt 精度支持
│   ├── json-auto-utils.js         # 自动格式化工具
│   ├── json-lint.js               # JSON 语法检查
│   ├── json-worker.js             # Web Worker 加速
│   ├── table-utils.js             # 表格视图
│   ├── content-script.js          # 页面自动格式化注入
│   └── content-script.css         # 页面自动格式化样式
├── en-decode/                     # 信息编解码（24 种编解码方式）
├── qr-code/                       # 二维码/条形码生成与解码
├── code-beautify/                 # 代码美化（JS/CSS/HTML/SQL/XML）
├── code-compress/                 # 代码压缩
├── timestamp/                     # 时间戳转换
├── uuid-gen/                      # UUID/雪花 ID/NanoID 生成
├── password/                      # 随机密码生成
├── html2markdown/                 # Markdown 转换（含 PDF 导出）
├── postman/                       # 简易 Postman（API 调试）
├── websocket/                     # WebSocket 调试
├── regexp/                        # 正则公式速查
├── trans-radix/                   # 进制转换（2~36）
├── trans-color/                   # 颜色 HEX/RGB 互转
├── crontab/                       # Crontab 表达式生成
├── loan-rate/                     # 贷款利率计算器
├── mock-data/                     # 数据 Mock 生成
├── sticky-notes/                  # 便签笔记
├── chart-maker/                   # 图表制作
├── excel2json/                    # Excel/CSV 转 JSON
├── svg-converter/                 # SVG 转 PNG/JPG/WEBP
├── poster-maker/                  # 海报快速生成
├── image-base64/                  # 图片/Base64 互转
├── json-diff/                     # JSON/文本差异对比
├── screenshot/                    # 网页截屏
├── color-picker/                  # 页面取色（无独立页）
├── grid-ruler/                    # 网页栅格标尺（无独立页）
├── page-timing/                   # 网站性能分析
├── byte-unit/                     # 存储单位转换
├── datetime-calc/                 # 时间戳计算器
└── ...
```

---

## 三、核心架构模式

### 3.1 三层通信架构

```
┌─────────────────────────────────────────────────────────┐
│                    Content Scripts                       │
│  (jQuery + evalCore, 注入到所有 http/https/file 页面)     │
│  - 自动 JSON 格式化                                       │
│  - 页面取色、栅格标尺、截屏、油猴脚本                        │
│  - 通过 chrome.runtime.sendMessage 向 SW 通信              │
└──────────────────────┬──────────────────────────────────┘
                       │ chrome.runtime.sendMessage
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Service Worker (background.js)              │
│  - 消息总线（fh-dynamic-any-thing）                        │
│  - 工具页面生命周期管理                                     │
│  - 内容脚本注入调度                                        │
│  - 右键菜单管理                                           │
│  - 统计记录                                              │
│  - 更新检测                                              │
└──────────────────────┬──────────────────────────────────┘
                       │ chrome.tabs.create / scripting
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   Tool Pages (Vue.js)                    │
│  - 每个工具独立 HTML/JS/CSS                              │
│  - 通过 chrome.runtime.sendMessage 发送操作请求            │
│  - 可访问 chrome.tabs、chrome.storage                    │
└─────────────────────────────────────────────────────────┘
```

### 3.2 工具管理模式（按需安装）

工具采用"注册即安装"模式：

1. `tools.js` 定义全部 34 个工具元数据（名称、描述、是否含内容脚本、菜单配置）
2. `awesome.js` 通过 `chrome.storage.local` 中 `DYNAMIC_TOOL:<name>` 键判断安装状态
3. 用户通过 Options 页点击"安装"，写入带时间戳的安装标记
4. 卸载时清理对应存储键 + 内容脚本缓存

**系统内置工具**：`json-format` 标记 `systemInstalled: true`，始终可用且不可卸载。

### 3.3 Popup 双模式设计

| 模式 | 特点 |
|------|------|
| **Lite** | 扁平工具列表，Enter 直接打开，面向高频使用 |
| **Omni** | 分组展示（最近/收藏/全部），支持 Alt+数字快捷键、搜索、收藏 |

### 3.4 内容脚本注入流程

1. `chrome.tabs.onUpdated` 监听页面加载完成
2. `url-policy.js` 判断 URL 是否可注入（http/https/file）
3. `inject-tools.js` 通过 `chrome.scripting.executeScript` 注入文件
4. 页面引用通过 `contentScriptJs` 标记触发对应工具的 `content-script.js`
5. 注入函数在页面上下文中调用 `window.<toolName>ContentScript()` 初始化

### 3.5 Sandbox 隔离机制

`dynamic/sandbox.html` 使用 Chrome MV3 的 `sandbox.pages` 声明：
- CSP: `sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-eval'`
- 用于运行第三方开发工具（devtools），通过 `postMessage` 与 `dynamic/index.html` 通信
- 第三方 JS 通过 `Function()` 构造函数在沙箱内执行

### 3.6 AI 集成架构

FeHelper v2026.7.3 集成了 Chrome Built-in AI（Gemini Nano）：
- `aiagent/fh.ai.js` — AI 核心，检测模型可用性、下载进度
- `aiagent/fh.ai-features.js` — AI 功能定义（JSON 修复、TypeScript 类型生成、Schema 生成等）
- `aiagent/fh.ai-inline.js` — 嵌入各工具页的 AI 面板组件
- AI 功能接入工具：`json-format`（体检/TS类型/Schema/Zod）、`qr-code`（内容生成/质量审计）、`en-decode`（AI解码）

---

## 四、关键技术栈

| 层次 | 技术 |
|------|------|
| UI 框架 | Vue.js 2.x（无构建步骤，直接通过 `<script>` 加载） |
| 模块系统 | ES Modules（`type="module"`） |
| DOM 操作 | jQuery 3.3.1 |
| 代码编辑 | CodeMirror 5.x |
| 二维码 | jQuery.qrcode + JsBarcode + ZXing |
| Markdown | Marked.js |
| 代码美化/压缩 | js-beautify + UglifyJS3 + HTMLMinifier |
| AI | Chrome Built-in AI API (Gemini Nano) |
| 通信 | chrome.runtime.sendMessage（单向）/ chrome.tabs.sendMessage / chrome.storage |
| 存储 | chrome.storage.local + chrome.storage.session |
| 加密/哈希 | 内联 MD5/SHA1/Gzip 实现（en-decode 工具） |

---

## 五、权限用途说明

| 权限 | 用途 |
|------|------|
| `alarms` | 定时检查扩展更新（每 24 小时） |
| `tabs` | 读取当前标签页信息，创建/复用工具页 |
| `scripting` | 注入内容脚本和执行函数 |
| `contextMenus` | 右键菜单工具快捷入口 |
| `activeTab` | 获取当前页面 URL 和内容 |
| `storage` | 工具安装状态、用户设置、便签数据、油猴脚本存储 |
| `notifications` | 操作结果和更新提示 |
| `unlimitedStorage` | 便签/油猴脚本可能需大量存储 |
| `webNavigation` | 监听页面切换，注入油猴脚本和内容工具 |

---

## 六、扩展生命周期

```
安装 (install)
  ├── 打开 Options 控制台
  ├── 记录安装统计
  └── 重建右键菜单

更新 (update)
  ├── 显示 Badge "+1"
  ├── 记录更新统计
  ├── 从 v2019.12.2415 升级时显示特殊通知
  └── 重建右键菜单

启动 (startup)
  └── 重建右键菜单

定时器 (alarms)
  └── fehelper-check-update: 每 1440 分钟（24小时）触发检测更新
```

---

## 七、关键设计要点

1. **按需工具安装**：30+ 工具不全部预装，用户按需安装，减少权限和资源占用
2. **Content Script 控制**：通过 `toolMap` 的 `contentScriptJs/contentScriptCss` 标记精细控制哪些工具需要页面注入
3. **Session Storage 桥接**：工具页面打开时通过 `chrome.storage.session` 传递内容数据（如格式化前的 JSON 原文）
4. **热修复机制**：`fetch-hotfix-json` 从服务器拉取运行时补丁，applied by `fh-get-tool-patch`
5. **离线可用**：所有工具页面本地打包，无外部 CDN 依赖（除热修复 JSON 和统计上报）
6. **双 UI 模式**：Lite（极简）和 Omni（完整）满足不同用户偏好
