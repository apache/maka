# uBlock Origin Lite

> **分类:** 浏览器增强 (browser-enhancement)  
> **作者:** Raymond Hill (gorhill)  
> **许可证:** GPL-3.0  
> **Chrome Web Store:** uBlock Origin Lite

## 功能概述

uBlock Origin Lite 是一款高效的 MV3 合规内容拦截器, 是经典 uBlock Origin 的轻量替代版本。它使用 Chrome 的 `declarativeNetRequest` API 实现网络请求过滤, 支持:

- 广告拦截 (基于 EasyList / uBlock filters 等社区规则集)
- 隐私保护 (基于 EasyPrivacy)
- 恶意网站防护 (基于 URLhaus / uBlock badware)
- Cosmetic 过滤 (隐藏页面中的广告占位元素)
- Scriptlet 注入 (阻止反广告拦截脚本)
- Element Picker / Zapper (手动选择页面元素创建过滤规则)
- 严格的阻止页面 (访问已知恶意站点时显示警告)
- URL 跟踪参数剥离

## 技术架构

- **Manifest 版本:** V3
- **模块系统:** 原生 ES Module (无打包器)
- **核心技术:** declarativeNetRequest + scripting API + userScripts API
- **过滤模式:** 4 级 (none / basic / optimal / complete), 按 hostname 精细控制
- **规则集:** 60+ DNR 静态规则集, 支持导入自定义过滤列表

## 权限

| 权限 | 用途 |
|------|------|
| `declarativeNetRequest` | 核心网络请求过滤 |
| `scripting` | 动态注入内容脚本 (cosmetic 过滤) |
| `userScripts` | Scriptlet 注入 (MAIN world) |
| `storage` / `unlimitedStorage` | 配置与过滤器缓存 |
| `alarms` | 定时更新过滤列表 |
| `activeTab` | Element picker/zapper |
| `offscreen` | 过滤器编译 (DOM API) |
| `<all_urls>` (host 权限) | complete 模式的通用过滤 |

## 逆向分析版本

| 版本 | 日期 | 模型 | 安全等级 |
|------|------|------|:------:|
| [2026.628.2035](./2026-07-06-dsv4/) | 2026-07-06 | DeepSeek V4 Pro (dsv4) | 🟢 |

## 安全

uBlock Origin Lite 不收集遥测数据, 不包含分析代码, 不与外部服务器共享浏览数据。所有过滤规则完全在本地处理。详见各版本的 `src/docs/SECURITY_AUDIT.md`。

## 相关链接

- [GitHub 仓库](https://github.com/gorhill/uBlock)
- [Chrome Web Store](https://chromewebstore.google.com/detail/ublock-origin-lite)
- [原版 uBlock Origin](https://github.com/gorhill/uBlock)
