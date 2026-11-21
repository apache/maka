# Automa — Chrome 扩展逆向工程

> 浏览器自动化扩展 | Manifest V3 | Webpack 5 + Vue 3

## 插件信息

| 属性 | 值 |
|------|-----|
| 名称 | Automa |
| 分类 | developer-tools |
| 功能 | 浏览器自动化 (可视化工作流编辑器) |
| 权限 | `tabs` `proxy` `alarms` `storage` `debugger` `activeTab` `offscreen` `webNavigation` `unlimitedStorage` `scripting` |
| 主机权限 | `<all_urls>` |
| 技术栈 | Vue 3.4.38, Webpack 5, webextension-polyfill, Supabase |
| 官网 | https://www.automa.site/ |
| GitHub | https://github.com/AutomaApp/automa |
| CWS | https://chromewebstore.google.com/detail/automa/infppggnoaenmfagbfknfkancpbljcca |

## 已逆向版本

| 版本 | 日期 | 模型 | 目录 | 状态 |
|------|------|------|------|------|
| [1.30.01](./2026-07-06-dsv4/) | 2026-07-06 | dsv4 | `2026-07-06-dsv4/` | 完成 |

## 核心发现

### 架构亮点

- **两层执行隔离**: Offscreen Document 作为 Debugger/DOM 宿主 + Sandbox Page 作为不安全代码执行沙箱
- **统一 API 抽象**: 50+ Chrome API 通过 BrowserAPI 路径注册表统一代理，支持函数参数序列化
- **多入口 SPA**: 6 个独立 Vue 3 SPA 页面通过 runtime.sendMessage 与 Background Service Worker 通信
- **Web 集成**: 通过 webService content script 实现与 automa.site 网页的双向工作流同步

### 安全关注

- **debugger 权限**授予完整 CDP 控制权 (网络拦截/JS 注入/DOM 访问)
- **`new Function()` 反序列化**在多处用于函数参数传递，存在远程代码执行风险
- **sandbox.html** 无 CSP 限制，任何可访问 iframe 的上下文可注入代码
- **Supabase 集成**静默同步 Google OAuth token 到扩展存储

## 目录结构

```
automa/
├── README.md                    # 本文件 (插件根 README)
└── 2026-07-06-dsv4/             # v1.30.01 逆向产出
    ├── dist/                    # 可加载扩展文件
    ├── src/types/index.ts       # TypeScript 类型定义
    ├── src/docs/ARCHITECTURE.md # 架构文档
    ├── src/docs/DATA_FLOW.md    # 数据流文档
    ├── src/docs/SECURITY_AUDIT.md # 安全审计
    ├── package.json
    └── README.md                # 版本说明
```

## 免责声明

本逆向工程产出**仅供安全研究与学习目的**。原始 Automa 扩展版权归原作者所有。
