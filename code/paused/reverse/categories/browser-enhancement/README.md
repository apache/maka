# 🔧 浏览器增强

增强 Chrome 浏览器原生交互体验的扩展，涵盖手势操作、标签页管理、快捷键、右键搜索、字体渲染、Cookie 管理、剪贴板等。

## 包含插件

| 插件 | 版本 | 功能 | 技术栈 | 最新分析 |
|------|------|------|--------|----------|
| [OneTab](onetab/) | 2.18 | 标签页一键收纳入列表，62 语言 | 自研 virtual-DOM，无框架 | [2026-07-06-dsv4](onetab/2026-07-06-dsv4/) |
| [Shortkeys](shortkeys/) | 5.0.1 | 自定义键盘快捷键/宏/JS 执行 | Vite + Mousetrap.js | [2026-07-06-dsv4](shortkeys/2026-07-06-dsv4/) |
| [SimpleUndoClose](simpleundoclose/) | 3.0.1 | 撤销关闭标签页 + 弹出预览 | 纯 Vanilla JS 零依赖 | [2026-07-06-dsv4](simpleundoclose/2026-07-06-dsv4/) |
| [Tab Session Manager](tab-session-manager/) | 7.3.0 | 标签页会话保存/恢复/云端同步 | React 16 + Webpack 5 + Google Drive | [2026-07-06-dsv4](tab-session-manager/2026-07-06-dsv4/) |
| [uBlock Origin Lite](ublock-origin-lite/) | 2026.628.2035 | 轻量广告/内容拦截器 | 原生 ES Module 无打包 | [2026-07-06-dsv4](ublock-origin-lite/2026-07-06-dsv4/) |
| [复制链接到剪贴板](copy-link-to-clipboard/) | 15.1.3 | 16 种格式链接复制，DOMPurify 净化 | 30+ ES Module 零打包 | [2026-07-06-dsv4](copy-link-to-clipboard/2026-07-06-dsv4/) |
| [网页万能复制](universal-copy/) | 1.0.28 | 解除网页复制限制，四层破解策略 | Vue Popup + Service Worker | [2026-07-06-dsv4](universal-copy/2026-07-06-dsv4/) |
| [crxMouse](crxmouse/) | 7.0.5 | 鼠标手势/超级拖拽/自定义光标 | Webpack + jQuery | [2026-07-05-dsv4](crxmouse/2026-07-05-dsv4/) |
| [iTab](itab/) | 2.1.17 | 组件化卡片桌面新标签页 | Vue 3 + Element UI + Tailwind | [2026-07-04-dsv4](itab/2026-07-04-dsv4/) |
| [ContextSearch web-ext](contextsearch-web-ext/) | 1.48.4.13 | 右键多引擎搜索/QuickMenu | 原生 JS + importScripts | [2026-07-05-dsv4](contextsearch-web-ext/2026-07-05-dsv4/) |
| [Chrome Font Super Enhancer](chrome-font-super-enhancer/) | 2.25 | 字体渲染增强（text-shadow 抗锯齿） | 原生 JS | [2026-07-05-dsv4](chrome-font-super-enhancer/2026-07-05-dsv4/) |
| [EditThisCookie V3](editthiscookie-v3/) | 3.0.5 | Cookie 查看/编辑/导入导出 | jQuery + ES Module | [2026-07-05-dsv4](editthiscookie-v3/2026-07-05-dsv4/) |

## 安全热点

| 等级 | 插件 | 主要风险 |
|:----:|------|------|
| 🔴 | Shortkeys, 网页万能复制, crxMouse | debugger + userScripts + SSRF、阿里云 SLS 遥测 + 全站注入、webRequest + clipboard + bookmarks 组合 |
| 🟡 | OneTab, Tab Session Manager, EditThisCookie | innerHTML 使用面大、IndexedDB 明文存储、Cookie 敏感数据处理 |
| 🟢 | SimpleUndoClose, uBlock Origin Lite, 复制链接到剪贴板, iTab, ContextSearch, Chrome Font | 权限最小化，大多数零外部网络请求 |
