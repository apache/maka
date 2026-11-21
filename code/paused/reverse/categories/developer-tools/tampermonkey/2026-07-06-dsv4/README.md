# Tampermonkey v5.5.0 — dsv4 逆向工程

## 基本信息

| 项目 | 值 |
|------|------|
| 插件名称 | 篡改猴 (Tampermonkey) |
| 版本 | 5.5.0 |
| Manifest | 3 |
| 逆向日期 | 2026-07-06 |
| 逆向模型 | DeepSeek V4 Pro |
| 工作流 | dsv4 |
| 源文件数 | 86 |
| 总大小 | ~2.2 MB |

## 目录结构

```
2026-07-06-dsv4/
├── dist/                  # 可加载的扩展（source-code完整副本）
│   ├── manifest.json      # MV3 manifest
│   ├── background.js      # Service Worker (Webpack bundle, 614KB)
│   ├── content.js         # Content Script (45KB)
│   ├── extension.js       # 页面逻辑 + JSZip (535KB)
│   ├── editor.js          # CodeMirror 6 编辑器 (410KB)
│   ├── offscreen.js       # Offscreen Document (55KB)
│   ├── page.js            # Page Script (50KB)
│   ├── lint.js            # ESLint 规则 (14KB)
│   ├── cache.js           # 缓存管理 (2KB)
│   ├── style.css          # 样式 (435KB)
│   ├── vendor/            # 第三方库 (ESLint/jsdiff/FileSaver)
│   ├── _locales/          # 33种语言
│   ├── _metadata/         # Chrome商店元数据
│   └── images/            # 图标资源
├── src/
│   ├── types/
│   │   └── index.ts       # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md   # 架构文档
│       ├── DATA_FLOW.md      # 数据流文档
│       └── SECURITY_AUDIT.md # 安全审计报告
├── package.json           # NPM 配置
├── tsconfig.json          # TypeScript 配置
└── README.md              # 本文件
```

## 技术栈

| 技术 | 用途 |
|------|------|
| Webpack 5 | 模块打包 |
| CodeMirror 6 | 脚本编辑器 |
| JSZip 3.5.0 | 脚本压缩/解压 |
| ESLint | 用户脚本语法校验 |
| jsdiff | 脚本差异对比 |
| FileSaver.js | 脚本导出保存 |
| IndexedDB | 脚本本地存储 |
| chrome.storage | 设置持久化 |

## 核心架构

```
User Script (MAIN world)
    ↕ GM_* API (via Vault sandbox)
Page Context Bridge
    ↕ DOM CustomEvent + postMessage
Content Script (ISOLATED world)
    ↕ chrome.runtime.Port
Service Worker (background.js)
    ↕ IndexedDB / chrome.storage
Storage Layer
```

## 安全评估

- **总体等级**: 🔴 高风险
- **关键风险**: webRequestBlocking + <all_urls> 可拦截所有流量；userScripts 任意注入；cookies 完全访问
- **缓解措施**: @grant 权限白名单、Vault 沙箱、@connect 网络白名单
- **详见**: `src/docs/SECURITY_AUDIT.md`

## 关键发现

1. **Vault 沙箱**: content.js 中缓存 50+ 个原生函数引用（Object.call, JSON.parse, Function, Promise, XMLHttpRequest 等）在闭包中，防止页面代码通过原型链污染篡改 GM API
2. **模块化打包**: 6个独立 Webpack bundle 对应 6 个入口点，每个仅包含所需模块
3. **Port 通信**: Content Script 与 Service Worker 使用响应式长连接，支持断线重连和消息队列
4. **脚本压缩**: 所有脚本通过 JSZip 压缩后存入 IndexedDB，节省存储空间
5. **云同步**: 支持 5 种云服务同步，使用 OAuth 认证
6. **ESLint 集成**: 内置 15+ 个自定义 ESLint 规则专门用于用户脚本校验

## 许可证

本项目仅用于学习研究。原始扩展版权归其作者所有。
