# 🎯 网站特定

针对特定网站（如 Twitter/X、Bilibili、GitHub、电商平台、语雀）进行功能增强和界面优化的扩展。

## 包含插件

| 插件 | 版本 | 功能 | 技术栈 | 最新分析 |
|------|------|------|--------|----------|
| [CubeSeller](cubeseller/) | 11.1.5 | 65+ 电商平台商品图片视频一键下载 | Vue 3.5 + JSZip + Webpack | [2026-07-06-dsv4](cubeseller/2026-07-06-dsv4/) |
| [yuque-helper](yuque-helper/) | 1.6.0 | 语雀网页转存/编辑/思维导图 | Webpack 4 + Vue 2.6 + Element UI | [2026-07-06-dsv4](yuque-helper/2026-07-06-dsv4/) |
| [BewlyBewly](bewlybewly/) | 0.41.2 | Bilibili 主页重设计与功能增强 | Vue 3 + Vite | [2026-07-05-dsv4](bewlybewly/2026-07-05-dsv4/) |
| [Material Icons for GitHub](material-icons-for-github/) | 1.16.2 | Git 平台文件树 Material Design 图标 | 原生 JS + 1251 SVG | [2026-07-05-dsv4](material-icons-for-github/2026-07-05-dsv4/) |
| [X-Track](xtrack/) | 1.3.1 | Twitter/X 浏览追踪与书签管理 | Vite + Dexie.js | [2026-07-04-dsv4](xtrack/2026-07-04-dsv4/) |

## 安全热点

| 等级 | 插件 | 主要风险 |
|:----:|------|------|
| 🔴 | CubeSeller | cookies + `*://*/*` 全站注入 + DNR Referer 伪造绕过 CDN + 硬编码内网 IP |
| 🟡 | yuque-helper | `<all_urls>` 权限过度、Vue 2.6 CVE-2024-21488、Pexels API Key 硬编码 |
| 🟢 | BewlyBewly, Material Icons for GitHub, X-Track | 权限最小化，仅特定域名注入，无数据外传 |
