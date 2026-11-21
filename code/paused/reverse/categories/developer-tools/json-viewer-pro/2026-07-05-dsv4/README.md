# JSON Viewer Pro — 逆向工程 (dsv4)

基于 Chrome 扩展 **JSON Viewer Pro v1.0.6** (Manifest V3) 的完整源码逆向工程分析。

---

## 目录结构

```
json-viewer-pro-dsv4/
├── package.json               # TypeScript 项目配置
├── README.md                  # 本文件
├── dist/                      # 原始扩展文件（未修改）
│   ├── manifest.json
│   ├── index.html
│   ├── options.html
│   ├── js/
│   │   ├── background.js      # Service Worker
│   │   ├── contentScript.js   # 内容脚本
│   │   ├── main.js            # 主应用（React + CodeMirror）
│   │   └── options.js         # 设置页应用（CodeMirror）
│   ├── css/
│   └── images/
└── src/
    ├── types/
    │   └── index.ts           # TypeScript 类型定义
    └── docs/
        ├── ARCHITECTURE.md    # 架构文档
        ├── DATA_FLOW.md       # 数据流文档（含 Mermaid 图）
        └── SECURITY_AUDIT.md  # 安全审计报告
```

---

## 功能概述

JSON Viewer Pro 自动检测页面中的 JSON 内容，并将其渲染为可交互的树形查看器：

- **树形视图**: 折叠/展开 JSON 节点、搜索高亮
- **图表视图**: 对 JSON 数据进行可视化
- **JSON 输入**: 手动输入 JSON 并格式化查看
- **主题切换**: 深色 (dark-pro) / 浅色 (mdn-light)
- **自定义 CSS**: 用户自定义样式覆盖
- **URL 过滤**: 在指定网站禁用扩展
- **右键菜单**: Download JSON / Settings

---

## 技术栈

| 技术 | 版本/说明 |
|------|----------|
| Chrome Extension | Manifest V3 |
| React | 18 (production build, 内嵌于 main.js) |
| CodeMirror | 6 (内嵌于 main.js 和 options.js) |
| chrome.storage.local | 选项持久化 |

---

## 快速开始

```bash
# 安装 TypeScript 类型依赖（仅用于类型检查）
npm install

# 类型检查（无需 build，dist 已包含完整原始文件）
npm run check
```

---

## 文档

- [架构文档](src/docs/ARCHITECTURE.md) — 扩展分层架构、设计决策、权限分析
- [数据流文档](src/docs/DATA_FLOW.md) — 初始化、选项广播、下载流程、消息通信
- [安全审计报告](src/docs/SECURITY_AUDIT.md) — 漏洞发现、风险评级、修复建议

---

## 许可

本项目仅用于逆向工程学习与研究目的。原始扩展版权归原作者所有。

`dist/` 目录中的文件为原始扩展的未修改副本。
