# Header Editor Lite - 架构文档 (ARCHITECTURE.md)

## 概述

Header Editor Lite 是一款 Chrome 浏览器扩展 (MV3)，用于修改 HTTP 请求和响应的头部、重定向请求、取消请求以及修改响应体。版本 5.2.12。

## 技术栈

| 组件 | 技术 | 说明 |
|------|------|------|
| 扩展框架 | Chrome Extension Manifest V3 | service_worker 后台、action popup、options page |
| UI 框架 | React 18 + Semi Design | 字节跳动 Semi UI 组件库 (webpack 打包) |
| 代码编辑器 | CodeMirror 6 | 自定义函数和响应体编辑 |
| 日期处理 | dayjs | 云备份时间戳、文件导出命名 |
| 浏览器兼容 | webextension-polyfill | 统一的 browser.* API |
| 事件系统 | EventEmitter3 | 跨组件事件通信 |
| 数据存储 | IndexedDB + chrome.storage | 规则存储 + 偏好设置 |
| 深比较 | lodash (deep-equal fork) | 偏好变更检测 |

## 项目结构

```
header-editor-lite/
├── manifest.json              # MV3 清单文件
├── popup.html                 # 弹出面板入口
├── options.html               # 管理页面入口
├── _locales/                  # 国际化 (en, es, pl, pt_BR, zh_CN, zh_TW)
│   └── {lang}/messages.json
├── _metadata/
│   └── verified_contents.json # Chrome Web Store 签名验证
└── assets/
    ├── css/
    │   └── semi.css           # Semi UI 样式 (~1MB, webpack 打包)
    ├── images/
    │   ├── 128.png            # 启用状态图标
    │   └── 128w.png           # 禁用状态图标 (灰色)
    └── js/
        ├── background.js      # Service Worker 后台 (~60KB)
        ├── popup.js           # 弹出面板逻辑 (~30KB)
        ├── options.js         # 管理页面逻辑 (~120KB)
        ├── semi.js            # Semi UI 组件库 (~600KB)
        ├── lib-react.js       # React + ReactDOM (~130KB)
        ├── codemirror.js      # CodeMirror 编辑器 (~150KB)
        ├── 116.js             # popup chunk (webpack split)
        ├── 121.js             # options chunk (webpack split)
        ├── 402.js             # shared chunk (webpack split)
        └── 475.js             # shared chunk (webpack split)
```

## 核心架构

### 1. 后台 Service Worker (background.js)

后台是整个扩展的大脑，负责：

- **规则存储**: 使用 IndexedDB 数据库 `headereditor`，包含 4 个 object store:
  - `request` - 取消和重定向规则
  - `sendHeader` - 修改请求头规则
  - `receiveHeader` - 修改响应头规则
  - `receiveBody` - 修改响应体规则

- **规则执行引擎**:
  ```
  ┌─────────────────────────────────────────────────┐
  │                  Rule Execution                  │
  │                                                  │
  │  Rule → determineRunner() → DNR or web_request  │
  │                                                  │
  │  DNR mode:                                       │
  │    → declarativeNetRequest.updateSessionRules()  │
  │    (cancel, redirect, modify headers)            │
  │                                                  │
  │  web_request mode:                               │
  │    → chrome.debugger (Fetch domain)              │
  │    (modify response body only)                   │
  └─────────────────────────────────────────────────┘
  ```

- **Runner 选择逻辑** (`I()` 函数):
  - 规则有自定义函数 → `web_request`
  - 规则有 exclude 条件 → `web_request`
  - 规则有 excludeRegex → `web_request`
  - 规则类型为 MODIFY_RECV_BODY → `web_request`
  - 其他情况 → `dnr` (declarativeNetRequest)

- **消息 API**: 通过 `runtime.sendMessage` 暴露以下方法:
  - `check` - 健康检查
  - `open_url` - 打开新标签页
  - `get_rules` - 获取规则列表
  - `save_rule` - 保存/更新规则
  - `del_rule` - 删除规则
  - `update_cache` - 刷新规则缓存
  - `set_pref` - 更新偏好设置
  - `event` - 事件通知 (规则更新/删除)

- **偏好管理** (`N` 对象):
  - 存储在 `chrome.storage.sync`（跨设备同步）
  - 13 个配置项（详见类型定义）
  - 通过 EventEmitter 广播变更

- **响应体修改器** (`ru` 类):
  - 使用 `chrome.debugger` API 附加到标签页
  - 通过 Chrome DevTools Protocol 的 `Fetch` 域拦截和修改响应
  - 支持 Request 和 Response 两个阶段的拦截

- **DNR 处理器** (`rf` 类):
  - 将扩展规则转换为 `declarativeNetRequest` 规则
  - 使用 `updateSessionRules` 动态注册
  - 规则 ID 编码: `ruleId * 100000 + tableOffset`

### 2. 弹出面板 (popup.js)

```
┌────────────────────────────┐
│       Popup Panel          │
│                            │
│  ┌──Nav──┬──Rules List──┐  │
│  │ Rules │ Group 1       │  │
│  │Manage │  ├─ Rule A   │  │
│  │        │  ├─ Rule B   │  │
│  │        │ Group 2      │  │
│  │        │  └─ Rule C   │  │
│  │        │              │  │
│  │    [ON/OFF Switch]    │  │
│  └────────┴──────────────┘  │
└────────────────────────────┘
```

- 根据 `popup-show-rules` 设置显示规则
- 支持按分组显示、折叠/展开
- 快速编辑按钮（仅 headers 和 redirect 规则）
- 规则预览 tooltip（hover 显示详情）

### 3. 管理页面 (options.js)

完整的规则管理界面，包含 4 个 Tab:

| Tab | 功能 |
|-----|------|
| 规则列表 (rules) | 规则的 CRUD、排序、分组、批量操作 |
| 选项 (options) | 13 项偏好设置、环境信息 |
| 导出导入 (export_and_import) | 本地文件导入导出、URL 下载、云备份 |
| 帮助 (help) | 内嵌 help 文档 iframe |

**规则编辑器**包含 5 个折叠面板:
1. 基本信息 - 名称、类型、分组
2. 匹配类型 - 全部/URL/前缀/域名/正则/方法/资源类型
3. 排除规则 - 排除正则/域名/方法/资源类型
4. 执行设置 - 运行模式、重定向目标、头部编辑、响应体
5. URL 测试 - 实时测试 URL 匹配结果

**批量操作**:
- 全选/取消全选
- 批量启用/禁用
- 批量移动分组
- 批量分享导出
- 批量删除

**导出导入**:
- 本地 JSON 文件导出
- 本地 JSON 文件导入（支持添加/覆盖/丢弃三种模式）
- 在线规则 URL 下载
- 云备份 (chrome.storage.sync, 支持分片存储)

### 4. 国际化 (i18n)

- 默认语言: en (英文)
- 支持 6 种语言: 英文、西班牙语、波兰语、葡萄牙语(巴西)、简体中文、繁体中文
- 使用 `chrome.i18n.getMessage` API

## 数据流

```
┌──────────┐  runtime.sendMessage  ┌─────────────┐
│  Popup   │◄─────────────────────►│  Background  │
│  Popup   │                       │  Service     │
│  Panel   │                       │  Worker      │
└──────────┘                       │              │
                                    │  ┌─────────┐ │
┌──────────┐  runtime.sendMessage  │  │IndexedDB│ │
│  Options │◄─────────────────────►│  │(4 tables)│ │
│  Page    │                       │  └─────────┘ │
│          │                       │  ┌─────────┐ │
│          │                       │  │ Storage  │ │
│          │                       │  │ sync/    │ │
│          │                       │  │ local/   │ │
│          │                       │  │ session  │ │
│          │                       │  └─────────┘ │
└──────────┘                       └──────┬───────┘
                                          │
                              ┌───────────┴───────────┐
                              │                       │
                     declarativeNetRequest    chrome.debugger
                     (cancel/redirect/head)   (modify body)
```

## 关键设计决策

1. **双执行引擎**: DNR 用于高性能的头部修改/取消/重定向；chrome.debugger (CDP) 用于响应体修改（DNR 不支持）
2. **IndexedDB 存储**: 4 个 object store 对应 4 种规则阶段，规则 ID 范围编码
3. **Sync Storage 偏好**: 偏好通过 chrome.storage.sync 跨设备同步；规则通过云备份手动同步
4. **Webpack 代码分割**: background、popup、options 各自独立打包，共享 chunk 通过 webpack 懒加载
5. **事件驱动更新**: 规则/偏好变更通过 EventEmitter 实时广播到所有打开的 UI 页面
6. **Session Storage 消息**: 通知消息存储在 session storage 中，避免占用 sync 配额

## 编码规范

- 规则 ID 通过 `ruleId * 100000 + tableOffset` 编码 DNR 规则 ID
  - request: offset 0
  - sendHeader: offset 100000
  - receiveHeader: offset 200000
  - receiveBody: offset 300000
- 虚拟 key: `{tableName}-{ruleId}` 格式用于 React key
- 特殊 header 值 `_header_editor_remove_` 表示删除该 header
- 云备份分片: 每片不超过 `QUOTA_BYTES_PER_ITEM - 500` 字节
