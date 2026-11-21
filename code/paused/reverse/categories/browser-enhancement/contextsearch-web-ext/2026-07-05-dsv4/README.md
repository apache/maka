# ContextSearch web-ext 逆向工程

> 原始扩展: [ContextSearch web-ext](https://github.com/ssborbis/ContextSearch-web-ext) v1.48.4.13
> 逆向日期: 2026-07-05

## 目录结构

```
contextsearch-web-ext-dsv4/
├── dist/                        # 原始源码完整副本 (73 文件)
│   ├── manifest.json            # MV3 清单
│   ├── background.js            # Service Worker (~1887行)
│   ├── init_content.js          # Content Script 入口
│   ├── inject*.js               # 页面注入模块系列
│   ├── contextMenu.js           # 右键菜单构建
│   ├── searchEngineManager.js   # 搜索引擎管理 UI
│   ├── options.html/js          # 设置页面
│   ├── quickmenu.html/js        # 快捷菜单
│   ├── searchbar.html/js        # 搜索栏 Popup
│   ├── findbar.html/js          # 查找栏
│   ├── lib/                     # 第三方依赖
│   ├── _locales/                # 国际化
│   └── icons/                   # 图标资源
│
├── src/
│   ├── types/
│   │   └── index.ts             # 完整 TypeScript 类型定义
│   │                           #   (SearchEngine, ContextMenuRule,
│   │                           #    QuickMenuConfig, UserOptions 等)
│   └── docs/
│       ├── ARCHITECTURE.md      # 架构文档 (中文)
│       ├── DATA_FLOW.md         # 数据流文档 (中文, 含 Mermaid 图)
│       └── SECURITY_AUDIT.md    # 安全审计报告 (中文)
│
├── package.json                 # npm 配置 (TypeScript 类型检查)
└── README.md                    # 本文件
```

## 扩展功能概览

ContextSearch web-ext 是一款浏览器搜索引擎集成增强工具，核心功能：

| 功能模块 | 入口 | 说明 |
|----------|------|------|
| 右键菜单搜索 | `contextMenu.js` | 选中文本 → 右键 → 选择搜索引擎 |
| Quick Menu 悬浮菜单 | `inject_quickmenu.js` | 选中文本 → 自动弹出搜索引擎面板 |
| 搜索栏 Popup | `searchbar.html` | 点击工具栏图标弹出搜索栏 |
| 侧边栏 | `inject_sidebar.js` | 页面侧边搜索引擎列表 |
| 查找栏+高亮 | `findbar.js` + `inject_highlight.js` | 搜索结果页关键词高亮与导航 |
| Page Tiles | `inject_pagetiles.js` | 拖拽搜索词到屏幕边缘触发搜索引擎网格 |
| Omnibox | `omnibox.js` | 地址栏输入 `cs` 触发搜索 |
| 快捷键 | `Shortcuts.js` | 自定义键盘快捷键搜索 |
| 外部程序 | Native Messaging | 调用本地命令行程序处理搜索词 |

## 技术特征

- **平台**: Chrome Extension MV3 + Firefox WebExtension
- **架构**: Service Worker + Content Script + Iframe UI
- **加载方式**: Service Worker 使用 `importScripts` 批量加载 (非 ES Module)
- **节点树**: 搜索引擎/文件夹/脚本以树状结构存储，支持拖拽排序
- **上下文感知**: 7 种页面上下文 (selection/link/image/audio/video/page/frame) 通过位掩码过滤
- **延迟注入**: Content Script 仅在用户交互时触发主逻辑注入
- **Shadow DOM**: Quick Menu UI 通过 Shadow Root 与宿主页面隔离

## 类型定义使用

```bash
npm install
npx tsc --noEmit   # 检查类型定义完整性
```

```typescript
import type {
  SearchEngine,
  FolderNode,
  UserOptions,
  QuickMenuConfig,
  NodeTree,
} from './src/types';
```

## 注意事项

- 本仓库为逆向工程产物，原始版权归属 [ssborbis/ContextSearch-web-ext](https://github.com/ssborbis/ContextSearch-web-ext)
- TypeScript 类型定义基于源码分析推导，可能与运行时行为存在细微差异
- 安全审计报告仅基于静态分析，未经动态运行时验证
- `dist/` 目录为原始源码的完整副本，可加载为未打包扩展进行调试
