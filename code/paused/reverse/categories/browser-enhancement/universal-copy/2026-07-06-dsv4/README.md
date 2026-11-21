# 网页万能复制 (Universal Copy - Enable Copy) v1.0.28

> 逆向还原日期: 2026-07-06 | 分析模型: dsv4 | Manifest V3

## 插件简介

"网页万能复制"是一款 Chrome 浏览器扩展,核心功能是解除网页上的各种复制限制——包括禁止右键、禁止选择、禁止复制、禁止粘贴和禁止全选。采用经典的 Service Worker + Content Script + Popup 三层架构,支持 50 种语言,在 Chrome Web Store 上拥有大量用户。

## 目录结构

```
2026-07-06-dsv4/
├── dist/                       # 还原的扩展构建产物 (97 文件)
│   ├── manifest.json           # MV3 清单
│   ├── js/
│   │   ├── background.js       # Service Worker (控制中心)
│   │   ├── content-script.js   # 内容脚本 (页面注入层)
│   │   ├── normal.js           # 通用破解引擎
│   │   └── docText.js          # 道客巴巴文本提取
│   ├── css/                    # 样式表 (8 个)
│   ├── img/                    # 图标与图片 (10 个)
│   ├── fonts/                  # 字体文件 (6 个)
│   └── _locales/               # 50 种语言 i18n
├── src/
│   ├── types/
│   │   └── index.ts            # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md     # 系统架构分析
│       ├── DATA_FLOW.md        # 数据流分析
│       └── SECURITY_AUDIT.md   # 安全审计报告
├── package.json                # Node.js 包清单
└── README.md                   # 本文件
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 扩展框架 | Chrome Extension Manifest V3 |
| 后台进程 | Service Worker (Webpack 打包) |
| 内容注入 | Content Script (jQuery 3.6.0 + clipboard.js 2.x) |
| Popup UI | Vue 2 + Element UI |
| 选项页 | jQuery + Bootstrap 3 |
| 遥测系统 | 阿里云 SLS (Logtail) |
| 压缩 | LZ4 |
| 多语言 | Chrome i18n API (50 种语言) |

## 核心机制

### 1. 复制限制解除

通过三层策略解除复制保护:
- **CSS 层**: 注入 `user-select: text !important` 覆盖页面样式
- **事件层**: 移除所有复制相关事件 (`oncopy`, `oncut`, `onpaste`, `oncontextmenu`, `onselectstart` 等)
- **拦截层**: 在 capture 阶段拦截事件,阻止原始处理器执行
- **定时重执行**: 以多级延迟 (1.2s, 3.2s, 5.0s, 9.9s) 重复应用破解,对抗动态 DOM

### 2. 站点适配器

针对三大文库平台的特殊处理:
- **百度文库** (`wenku.baidu.com`): 隐藏付费遮罩,注入全文复制按钮,通过 SEO 爬虫请求绕过反爬
- **豆丁网** (`docin.com`): 注入浮动复制按钮
- **道客巴巴** (`doc88.com`): 通过背景页代理获取平台 JS,解析文本路径,注入 `docText.js` 动态提取

### 3. 域名白名单自动破解

用户在选项页添加的域名会存储到 `chrome.storage.local`,页面加载完成时自动触发破解,无需手动点击。

## 权限与隐私

### 声明的权限

```
tabs, storage, scripting, declarativeNetRequestWithHostAccess
host_permissions: http://*/*, https://*/*
```

### 数据收集

扩展向阿里云 SLS (`us-west-1.log.aliyuncs.com`) 发送遥测数据,包括:
- 用户 UUID、公网 IP、国家/城市/地区
- 操作系统、浏览器类型、语言
- 当前浏览页面 URL
- 操作行为 (破解/复制/点击推广等)

详细安全分析见 `src/docs/SECURITY_AUDIT.md`。

## 安全评级

**总体: C+ (中等风险)**

| 维度 | 评级 |
|------|------|
| 数据隐私 | D |
| 权限最小化 | D |
| 代码完整性 | B |
| 传输安全 | B |
| 第三方依赖 | C |

> 评级说明: 扩展权限过大(全站注入),收集并向第三方发送用户浏览数据,且备用 IP 定位使用明文 HTTP。

## 还原说明

本目录为从 Chrome Web Store 下载的 CRX 文件解包并分析后的还原产物。所有 JS 文件均为原始 Webpack 打包格式(未反混淆/未格式化),保留了原始变量名和逻辑结构。

- `dist/` — 原始扩展文件 (仅移除 `_metadata` 签名目录)
- `src/types/` — 根据代码分析还原的 TypeScript 类型定义
- `src/docs/` — 人肉分析 + 模型辅助的深度分析文档

## 版本历史

| 日期 | 版本 | 模型 | 事件 |
|------|------|------|------|
| 2026-07-06 | 1.0.28 | dsv4 | 初次逆向 |

## 延伸阅读

- [系统架构分析](src/docs/ARCHITECTURE.md)
- [数据流分析](src/docs/DATA_FLOW.md)
- [安全审计报告](src/docs/SECURITY_AUDIT.md)
- [类型定义](src/types/index.ts)
