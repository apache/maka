# Clearly Reader 逆向工程归档说明

## 归档信息

- **归档日期**: 2026-07-06
- **原扩展名称**: Clearly Reader - Your AI Reading Assistant
- **原扩展版本**: 4.7.0
- **Manifest 版本**: 3
- **原扩展 ID**: 未知 (从 `_metadata/verified_contents.json` 可获取)
- **打包工具**: rspack 1.7.11

## 源文件来源

扩展源文件从 Chrome 本地扩展目录提取，位于:

```
E:\guahub\scripts\reverse-engineer\temp\2026-07-05\clearly-reader-source-code\
```

文件清单 (80 个文件):

```
7202509e591effb6.ttf          # Web 字体 (hash 命名)
819143a0a2e5844a.ttf          # Web 字体 (hash 命名)
ac7d4c9b4701205e.ttf          # Web 字体 (hash 命名)
e8a145e6e713ac6d.ttf          # Web 字体 (hash 命名)
app.bundle.js                 # 阅读器 UI 主应用
app.bundle.js.map             # App source map
background.bundle.js          # Service Worker
content.bundle.js             # Content Script
content.bundle.js.map         # Content source map
content.css                   # Content Script 样式
content.css.map               # Content CSS source map
contentStyles.css             # 占位文件 (空)
manifest.json                 # 扩展清单
onboarding.bundle.js          # 引导页
onboarding.html               # 引导页 HTML
skim.bundle.js                # Skim 面板

_locales/                     # 多语言文件 (13 种语言)
  ar/messages.json            # 阿拉伯语
  de/messages.json            # 德语
  en/messages.json            # 英语 (默认)
  es/messages.json            # 西班牙语
  fr/messages.json            # 法语
  hi/messages.json            # 印地语
  in/messages.json            # 印尼语
  ja/messages.json            # 日语
  ko/messages.json            # 韩语
  ru/messages.json            # 俄语
  zh/messages.json            # 中文
  zh_CN/messages.json         # 简体中文
  zh_TW/messages.json         # 繁体中文

_metadata/
  verified_contents.json      # Chrome Web Store 签名验证数据

assets/
  fonts/
    CrimsonText-Bold.ttf      # Crimson Text 粗体
    CrimsonText-Regular.ttf   # Crimson Text 常规
    Lora-Bold.ttf             # Lora 粗体
    Lora-Regular.ttf          # Lora 常规
    NotoSerif-Bold.ttf        # Noto Serif 粗体
    NotoSerif-Regular.ttf     # Noto Serif 常规
    Roboto-Bold.ttf           # Roboto 粗体
    Roboto-Regular.ttf        # Roboto 常规
    remixicon/                # Remix Icon 图标库

  icons/
    default/                  # 默认图标 (16/32/48/128px)
    active/                   # 已激活图标
    disable/                  # 已禁用图标
    readable/                 # 可读页面图标

  img/                        # UI 图片资源
    aged.jpg
    share-bg.jpg
    snowmoutain.jpg
    texture.jpg

  styles/                     # CSS 及 source map
    app.css / app.css.map
    content.css / content.css.map
    onboarding.css / onboarding.css.map
    skim.css / skim.css.map

  theme/
    kraft.jpg                 # 主题背景

  ic_add_width.svg            # UI 图标
  ic_close.svg
  ic_del_width.svg
  ic_success.svg
  ic_theme.svg
  ic_translate.png
  ic_warn.svg
```

## Source Map 分析结果

### content.bundle.js.map 源文件列表

| # | 源文件路径 | 说明 |
|---|-----------|------|
| 1 | `webpack:///./lib/config.js` | 共享配置常量 |
| 2 | `webpack:///./lib/print.js` | 打印功能 |
| 3 | `webpack:///./pages/app/Settings/Clip.jsx` | 剪藏设置 React 组件 |
| 4 | `webpack:///../../../node_modules/marked/lib/marked.esm.js` | marked Markdown 库 |
| 5 | `webpack:///./pages/app/index.jsx` | App 入口 React 组件 |
| 6 | `webpack:///./pages/content/page-highlighter.js` | 页面高亮功能 |
| 7 | `webpack:///../../../node_modules/browser-or-node/lib/index.js` | 环境检测 |

### app.bundle.js.map 源文件列表

| # | 源文件路径 | 说明 |
|---|-----------|------|
| 1 | `webpack:///./lib/config.js` | 共享配置常量 |
| 2 | `webpack:///./lib/print.js` | 打印功能 |
| 3 | `webpack:///./pages/app/Settings/Clip.jsx` | 剪藏设置 React 组件 |
| 4 | `webpack:///../../../node_modules/marked/lib/marked.esm.js` | marked Markdown 库 |
| 5 | `webpack:///./pages/app/index.jsx` | App 入口 React 组件 |

### 原始项目结构推断

从 source map 路径可推断原始开发目录结构:

```
clearly-reader/
├── lib/
│   ├── config.js              # 共享配置
│   └── print.js               # 打印逻辑
├── pages/
│   ├── app/
│   │   ├── index.jsx          # App 入口
│   │   └── Settings/
│   │       └── Clip.jsx       # 剪藏设置
│   └── content/
│       └── page-highlighter.js # 页面高亮
├── background/                 # Service Worker (无 source map)
├── content/                    # Content Script 入口 (推测)
├── onboarding/                 # 引导页 (无 source map)
└── node_modules/
    ├── marked/
    │   └── lib/marked.esm.js
    └── browser-or-node/
        └── lib/index.js
```

## 产出物说明

本逆向工程产出以下文档:

| 文件 | 内容 |
|------|------|
| `README.md` | 项目总览，包含功能矩阵和技术要点 |
| `src/types/index.ts` | 完整 TypeScript 类型定义 (~400 行) |
| `src/docs/ARCHITECTURE.md` | 架构分析，含组件结构图 |
| `src/docs/DATA_FLOW.md` | 数据流文档，含 9 个 Mermaid 时序图 |
| `src/docs/SECURITY_AUDIT.md` | 安全审计报告，含漏洞评级和修复建议 |
| `package.json` | Node.js 项目配置 |

## 已知限制

1. **background.bundle.js 无 source map**: Service Worker 的原始源码结构无法完整还原
2. **skim.bundle.js**: 203 字节的极简引导文件，实际逻辑可能在 content 或 app bundle 中
3. **依赖版本**: 由于是打包产物，无法确认 marked、React 和 browser-or-node 的确切版本
4. **minified 代码**: 所有 bundle 均被压缩，函数名和变量名已混淆

## 变更日志

| 日期 | 变更 |
|------|------|
| 2026-07-06 | 初始归档，创建完整的逆向分析文档 |
