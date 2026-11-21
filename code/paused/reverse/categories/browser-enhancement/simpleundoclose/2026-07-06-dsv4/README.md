# SimpleUndoClose v3.0.1 — 逆向分析 (dsv4)

> 逆向工程日期：2026-07-06  
> 逆向模型：DeepSeek V4 Pro  
> 源码来源：Chrome Web Store CRX 解包  
> 代码可读性：未混淆 (Vanilla JS, 无打包器)

## 版本信息

| 属性 | 值 |
|------|-----|
| 名称 | SimpleUndoClose |
| 版本 | 3.0.1 |
| Manifest | V3 |
| 后台 | Service Worker (`"type": "module"`) |
| 权限 | `tabs`, `storage`, `favicon`, `<all_urls>` |
| 第三方依赖 | **零** (纯 Vanilla JS) |
| 文件数 | 41 (含 8 种语言 i18n + 11 个 PNG 图标) |
| 代码量 | ~550 行 JS (4 个 JS 文件) |

## 核心功能

- 追踪所有打开的标签页，关闭后保存快照
- 弹出面板展示已关闭标签页列表 (按时间倒序)
- 一键恢复已关闭标签页 (左键点击)、后台打开 (中键点击)
- 搜索已关闭标签页 (支持多关键词 AND 逻辑、去元音变音)
- 分页浏览、键盘导航 (方向键 + Enter)
- 长按批量操作模式 (多选打开/删除/新建窗口)
- 快捷键恢复 (Alt+Z / MacCtrl+Z)
- 19 项可定制设置 (主题/样式/分页/搜索/工具栏)
- 8 种语言国际化 (en/es/hu/ja/ru/sr/zh_CN/zh_TW)
- 3 种主题模式 (跟随系统 / 亮色 / 暗色)

## 技术架构

- **前端**: popup.html + popup.js (22 KB, 无框架)
- **设置页**: options.html + options.js (10 KB)
- **后台**: background.js (12 KB, Service Worker)
- **共享**: common.js / il8n.js / theme.js / feedback.js
- **存储**: `chrome.storage.local` — 键/值格式 `"url|!|title"` (管道符作为分隔符)
- **通信**: `chrome.runtime.sendMessage` 消息协议 (6 种 action)

## 文档

| 文档 | 说明 |
|------|------|
| [ARCHITECTURE.md](src/docs/ARCHITECTURE.md) | 架构分层图、模块职责表、技术决策、权限清单 |
| [DATA_FLOW.md](src/docs/DATA_FLOW.md) | 9 个核心业务流的 Mermaid 序列图 + 全局状态表 |
| [SECURITY_AUDIT.md](src/docs/SECURITY_AUDIT.md) | 9 维度安全审计 (综合评级: 🟢 低风险) |

## 目录结构

```
2026-07-06-dsv4/
├── dist/                         ← 完整源码 (可加载到 Chrome)
│   ├── manifest.json
│   ├── background.js
│   ├── popup.{html,js,css}
│   ├── options.{html,js,css}
│   ├── common.js / il8n.js / theme.js / feedback.js
│   ├── about.html / credits.html
│   ├── _locales/ (8 种语言)
│   └── *.png (11 个图标)
├── src/
│   ├── types/index.ts            ← TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md       ← 架构文档
│       ├── DATA_FLOW.md          ← 数据流文档
│       └── SECURITY_AUDIT.md     ← 安全审计
├── package.json
├── tsconfig.json
└── README.md
```

## 使用方式

```bash
# 安装依赖 (仅类型检查)
npm install

# 类型检查
npm run check

# 加载到 Chrome
# 1. 打开 chrome://extensions
# 2. 启用 "开发者模式"
# 3. 点击 "加载已解压的扩展程序"
# 4. 选择 dist/ 目录
```

## 安全评估摘要

| 维度 | 评级 |
|------|------|
| 权限面 | 🟡 中 (`<all_urls>` 声明多余) |
| 数据外传 | 🟢 零网络请求 |
| CSP | 🟢 完全合规 |
| 注入面 | 🟢 所有用户内容经 HTML 转义 |
| 通信安全 | 🟢 仅内部通信 |
| 存储安全 | 🟢 chrome.storage.local |
| 隐私 | 🟡 信息 (favicon API 泄露域名) |
| 依赖 | 🟢 零外部依赖 |
| 合规 | ✅ MV3 合规 |

详见 [SECURITY_AUDIT.md](src/docs/SECURITY_AUDIT.md)。

## 变更历史

| 日期 | 版本 | 模型 | 说明 |
|------|------|------|------|
| 2026-07-06 | 3.0.1 | dsv4 | 初始逆向分析 |
