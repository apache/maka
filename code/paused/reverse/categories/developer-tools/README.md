# 🛠 开发者工具

面向 Web 开发者的生产力工具，涵盖 JSON 处理、CSS 检查、HTTP 调试、代码格式化、框架调试、网页转 Markdown 等场景。

## 包含插件

| 插件 | 版本 | 功能 | 技术栈 | 最新分析 |
|------|------|------|--------|----------|
| [ADB](adb/) | 0.9.8 | Android Chrome 远程调试引导（已废弃） | 原生 JS (~130 行) | [2026-07-06-dsv4](adb/2026-07-06-dsv4/) |
| [Automa](automa/) | 1.30.01 | 浏览器自动化工作流编辑器 | Vue 3.4 + Webpack 5 | [2026-07-06-dsv4](automa/2026-07-06-dsv4/) |
| [Octotree](octotree/) | 8.3.0 | GitHub 代码树侧边栏/文件预览 | jQuery + jsTree + keymaster | [2026-07-06-dsv4](octotree/2026-07-06-dsv4/) |
| [Proxy SwitchyOmega](proxy-switchyomega/) | 3.0.5 | 代理切换管理，8 种 Profile 类型 | AngularJS 1.x + OmegaPac 引擎 | [2026-07-06-dsv4](proxy-switchyomega/2026-07-06-dsv4/) |
| [React Context DevTool](react-context-devtool/) | 4.4 | React Context/useReducer 调试 | Webpack + CodeMirror | [2026-07-06-dsv4](react-context-devtool/2026-07-06-dsv4/) |
| [React Developer Tools](react-developer-tools/) | 7.0.1 | React 组件树/Fiber 调试 | Webpack 5 + 4 层通信 | [2026-07-06-dsv4](react-developer-tools/2026-07-06-dsv4/) |
| [Redux DevTools](redux-devtools/) | 3.2.10 | Redux 状态调试/时间旅行 | React 18 + jsan 序列化 | [2026-07-06-dsv4](redux-devtools/2026-07-06-dsv4/) |
| [Tampermonkey](tampermonkey/) | 5.5.0 | 用户脚本管理器，1000万+用户 | Webpack + Vault 沙箱 | [2026-07-06-dsv4](tampermonkey/2026-07-06-dsv4/) |
| [VisBug](visbug/) | 0.4.10 | 开源浏览器可视化设计工具 | `<vis-bug>` 自定义元素 | [2026-07-06-dsv4](visbug/2026-07-06-dsv4/) |
| [Wappalyzer](wappalyzer/) | 6.12.3 | 网站技术栈识别，8500+ 指纹 | 原生 JS (手写) | [2026-07-06-dsv4](wappalyzer/2026-07-06-dsv4/) |
| [JSON Viewer Pro](json-viewer-pro/) | 1.0.6 | JSON 格式化/树形查看/图表 | React 18 + CodeMirror 6 | [2026-07-05-dsv4](json-viewer-pro/2026-07-05-dsv4/) |
| [FeHelper](fehelper/) | 2026.7.3 | 30+ 开发者工具箱 | 原生 ES Module + Vue.js | [2026-07-05-dsv4](fehelper/2026-07-05-dsv4/) |
| [WebInk](webink/) | 0.5.1 | 网页转 Markdown + Monaco Editor | Plasmo + Parcel + Turndown | [2026-07-04-dsv4](webink/2026-07-04-dsv4/) |
| [CSS Peeper](css-peeper/) | 1.2.2 | CSS 样式提取与检查 | Plasmo + React | [2026-07-05-dsv4](css-peeper/2026-07-05-dsv4/) |
| [Get CRX](get-crx/) | 1.51 | 下载任意 Chrome 扩展 CRX | 原生 JS (64 行) | [2026-07-05-dsv4](get-crx/2026-07-05-dsv4/) |
| [Header Editor Lite](header-editor-lite/) | 5.2.12 | HTTP 请求头/响应体修改 | React + Semi Design | [2026-07-05-dsv4](header-editor-lite/2026-07-05-dsv4/) |

## 安全热点

| 等级 | 插件 | 主要风险 |
|:----:|------|------|
| 🔴 | Tampermonkey, Proxy SwitchyOmega, Automa | userScripts + webRequestBlocking + `<all_urls>`、analytics 追踪外传、debugger + new Function 远程代码执行 |
| 🟡 | Octotree, React Context/DevTools, Redux DevTools, Wappalyzer | PAT Token 明文存储、postMessage 无 origin 校验、externally_connectable 过度开放 |
| 🟢 | ADB, VisBug, JSON Viewer Pro, WebInk, Get CRX, Header Editor Lite, FeHelper, CSS Peeper | 权限最小化，无数据外传 |

## 技术栈快照

- **Webpack**: Tampermonkey, Automa, Octotree, Redux DevTools, React Context/DevTools, Header Editor Lite
- **Vite/Rollup**: (无)
- **Parcel**: CSS Peeper, WebInk
- **Plasmo**: CSS Peeper, WebInk
- **原生/手写 JS**: ADB, VisBug, Wappalyzer, Get CRX, FeHelper
- **AngularJS 1.x**: Proxy SwitchyOmega
