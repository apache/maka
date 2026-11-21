# CubeSeller (魔方卖家助手) — 逆向工程档案 (dsv4)

> **源扩展**: CubeSeller v11.1.5 — 电商平台商品图片视频下载助手
> **扩展 ID**: ddicoofdkbcdkkeecgafcoabogcgicfp
> **逆向日期**: 2026-07-06
> **逆向产物**: 本仓库
> **构建工具**: Webpack + Vue 3.5.27 (生产构建, 无 source map)

---

## 项目结构

```
cubeseller-dsv4/
├── dist/                              # 原始构建产物 (从 CRX 提取)
│   ├── manifest.json                  # MV3 清单文件
│   ├── background.js                  # Service Worker (规则引擎 + API 代理, 236KB)
│   ├── content/
│   │   ├── extract.js                 # 主提取引擎 (Vue 3 + JSZip, 785KB)
│   │   ├── extract.css                # 提取面板样式
│   │   ├── message.js                 # 采集结果通知弹窗
│   │   ├── message.css                # 通知样式
│   │   ├── translate.js               # 翻译/抠图页面通信桥
│   │   └── windowDataMessage.js       # MAIN world 数据提取桥
│   ├── popup/
│   │   ├── popup.html                 # 扩展弹窗入口
│   │   ├── popup.js                   # 弹窗 Vue 3 SPA (346KB)
│   │   └── popup.css                  # 弹窗样式
│   ├── extract/
│   │   ├── extract.html               # 提取结果独立页面
│   │   ├── extract.js                 # 结果页面 Vue 3 SPA (682KB)
│   │   └── extract.css                # 结果页面样式
│   ├── _locales/                      # 国际化 (en/zh/zh_CN)
│   ├── _metadata/                     # Chrome Web Store 签名元数据
│   └── assets/                        # 静态资源 (图标/Logo)
├── src/
│   ├── types/index.ts                 # 逆向提取的类型定义
│   └── docs/
│       ├── ARCHITECTURE.md            # 架构文档
│       ├── DATA_FLOW.md               # 数据流文档 (含 Mermaid 图)
│       └── SECURITY_AUDIT.md          # 安全审计报告
├── package.json                       # TypeScript 项目配置
└── README.md                          # 本文件
```

## 技术栈

| 组件 | 版本 | 用途 |
|------|------|------|
| Vue 3 | 3.5.27 | UI 框架 (runtime-dom + shared) |
| JSZip | 3.10.1 | ZIP 打包下载 |
| Element Plus Icons | 2.3.2 | 图标组件库 |
| Webpack | — | 构建工具 (已剥离) |
| regenerator-runtime | — | async/await 转译运行时 |

## 核心发现

1. **配置驱动架构**: 65+ 平台提取规则以 JSON 配置形式嵌入 background.js, 通过 URL 正则自动匹配平台
2. **三层架构**: Background (规则引擎 + API 代理) + Content Script ISOLATED world (Vue UI + DOM 抓取) + MAIN world 桥接 (window 数据提取)
3. **跨域图片代理**: 通过 Background Worker 的 `fetch` + DNR Referer 伪造实现跨域图片抓取, 转为 base64 回传
4. **Cookie 管理**: 使用 `chrome.cookies` API 读写平台 Cookie 维持登录态
5. **本地客户端集成**: 与本地桌面客户端 (`192.168.1.105:3100`) 配合使用, 提供完整的卖家工作流
6. **翻译/抠图集成**: 与 ushangtech.com 的在线图片处理工具集成

## 文档索引

- [架构文档](./src/docs/ARCHITECTURE.md) — 模块分解、权限分析、平台覆盖清单
- [数据流文档](./src/docs/DATA_FLOW.md) — 含 Mermaid 时序图和流程图 (11 张)
- [安全审计报告](./src/docs/SECURITY_AUDIT.md) — 权限、Cookie、合规性、威胁模型、改进建议
- [类型定义](./src/types/index.ts) — 提取规则、消息通信、存储模式 TypeScript 类型

## 权限清单

| 权限 | 用途 | 风险 |
|------|------|------|
| `scripting` | 动态注入 window 数据提取脚本 | 中 |
| `activeTab` | 获取当前标签页信息 | 低 |
| `downloads` | 批量下载图片/视频 | 中 |
| `declarativeNetRequest` | 动态修改 Referer/Origin 头 | 中 |
| `storage` | 保存用户设置和提取规则 | 低 |
| `cookies` | 读写电商平台 Cookie (登录态) | **高** |
| `unlimitedStorage` | 大量资源缓存 | 低-中 |
| `*://*/*` (host) | 全站 Content Script 注入 + 跨域请求 | **高** |

## 安全概要

- **最高风险**: `cookies` + `*://*/*` 组合可读取任意网站 HttpOnly Cookie
- **合规关切**: 电商平台数据批量采集涉及版权/服务条款/IP 问题
- **Referer 伪造**: DNR 规则绕过 CDN 防盗链机制
- **本地服务**: 硬编码内网 IP 暴露内部网络拓扑
- 详见 [安全审计报告](./src/docs/SECURITY_AUDIT.md)

## 平台覆盖

支持 65+ 平台: 1688, 淘宝, 天猫, 京东, 拼多多, 苏宁, 唯品会, 考拉, Shopee, Lazada, Alibaba, Aliexpress, Amazon, Wish, Shein, Temu, Etsy, Coupang, Instagram, Pinterest, Google, Bing, 百度, Pixiv, 微博, 抖音, 微信公众平台 等

## 注意事项

- 本仓库仅包含**逆向工程分析产物** (类型定义、文档、原始构建产物), 不包含可运行的源码
- JS 文件均为 Webpack 生产构建的 **minified** 产物, 无 source map, 不可直接阅读
- 类型定义基于 manifest 声明、消息 API 分析和规则配置结构反推, 可能与原始源码有差异
- 安全审计基于静态分析, 未经动态验证
- 提取规则配置以 JSON 字符串嵌入 background.js, 65+ 为手动计数的近似值
