# Header Editor Lite - 逆向工程文档

## 概述

本仓库是对 **Header Editor Lite** Chrome 扩展 (v5.2.12, MV3) 的逆向工程分析成果。Header Editor Lite 是一款用于修改 HTTP 请求/响应头部、重定向请求、取消请求以及修改响应体的浏览器扩展。

- 扩展主页: https://he.firefoxcn.net
- 原始项目: https://github.com/FirefoxBar/HeaderEditor
- 分析版本: 5.2.12 (Chrome Web Store 分发版)

## 目录结构

```
header-editor-lite-dsv4/
├── dist/                          # 原始扩展文件 (从 Chrome Web Store 提取)
│   ├── manifest.json              # MV3 清单
│   ├── popup.html                 # 弹出面板
│   ├── options.html               # 管理页面
│   ├── _locales/                  # 6 种语言国际化
│   ├── _metadata/                 # Chrome Web Store 签名
│   └── assets/
│       ├── css/semi.css           # Semi UI 样式
│       ├── images/                # 图标
│       └── js/                    # 所有 JS (webpack 打包)
│           ├── background.js      # Service Worker
│           ├── popup.js           # 弹出面板
│           ├── options.js         # 管理页面
│           ├── semi.js            # Semi UI 组件库
│           ├── lib-react.js       # React 18
│           ├── codemirror.js      # CodeMirror 6
│           └── {116,121,402,475}.js  # webpack chunks
│
├── src/
│   ├── types/
│   │   └── index.ts               # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md        # 架构文档 (中文)
│       ├── DATA_FLOW.md           # 数据流文档 (中文, 含 Mermaid 图表)
│       └── SECURITY_AUDIT.md      # 安全审计报告 (中文)
│
├── package.json                   # npm 配置 (仅用于类型检查)
└── README.md                      # 本文件
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 扩展框架 | Chrome Extension Manifest V3 |
| UI 框架 | React 18 + Semi Design (字节跳动) |
| 代码编辑器 | CodeMirror 6 |
| 日期处理 | dayjs |
| 浏览器兼容 | webextension-polyfill |
| 事件系统 | EventEmitter3 |
| 数据存储 | IndexedDB + chrome.storage (sync/local/session) |
| 构建工具 | Webpack 5 (代码分割) |

## 核心功能

1. **HTTP 请求/响应头修改**: 添加、修改、删除 HTTP header
2. **请求取消**: 阻止匹配的请求发出
3. **请求重定向**: 将请求重定向到指定 URL
4. **响应体修改**: 通过 Chrome DevTools Protocol 替换响应内容
5. **规则分组管理**: 支持分组、折叠、标记常用规则
6. **批量操作**: 批量启用/禁用/移动/删除规则
7. **导入导出**: JSON 文件导入导出、URL 下载、云备份 (chrome.storage.sync)
8. **规则快速切换**: 历史记录，一键切换 header 配置
9. **URL 匹配测试**: 实时测试规则匹配结果
10. **多语言**: 支持英文、西班牙语、波兰语、葡萄牙语(巴西)、简繁中文

## 核心 API (通过 runtime.sendMessage)

| 方法 | 说明 |
|------|------|
| `check` | 健康检查 (IndexedDB 是否可用) |
| `open_url` | 打开新标签页 |
| `get_rules` | 获取规则列表 (支持过滤) |
| `save_rule` | 保存/更新规则 |
| `del_rule` | 删除规则 |
| `update_cache` | 刷新规则内存缓存 |
| `set_pref` | 更新偏好设置 |

## 规则执行模式

- **DNR 模式** (declarativeNetRequest): 用于 cancel / redirect / modify headers (高性能，API 级执行)
- **Web Request 模式** (chrome.debugger + CDP Fetch): 用于 modify response body (功能更强大，但需要 devtools 调试权限)

## 数据存储

| 存储 | 用途 |
|------|------|
| IndexedDB (`headeditor`) | 规则主存储 (4 个 object store: request, sendHeader, receiveHeader, receiveBody) |
| `chrome.storage.sync` | 偏好设置 + 云备份 |
| `chrome.storage.local` | 规则切换历史、常用规则标记 |
| `chrome.storage.session` | 通知消息缓存 |

## 快速开始 (类型检查)

```bash
cd header-editor-lite-dsv4
npm install
npm run check-types
```

## 免责声明

本仓库仅用于学习和研究目的。源代码版权归原作者所有。请勿将本分析结果用于任何违反原软件许可协议的用途。

## 许可

本分析文档使用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可。原始扩展代码的许可状态请参照原项目仓库。
