# VisBug v0.4.10 — 逆向工程版本说明

## 基本信息

| 项目 | 值 |
|------|-----|
| 插件名 | VisBug |
| 版本 | 0.4.10 |
| Manifest 版本 | 3 |
| 逆向日期 | 2026-07-06 |
| 分析模型 | DeepSeek V4 Pro (dsv4) |
| 源码规模 | 26 个文件 (dist/), ~328KB |
| 安全评级 | 低风险 |

## 产出清单

```
2026-07-06-dsv4/
├── dist/                          ← 可加载的 Chrome 扩展 (26 files)
│   ├── manifest.json
│   ├── visbug.js                  ← Service Worker 入口
│   ├── contextmenu/               ← 右键菜单模块 (3 JS)
│   ├── toolbar/                   ← 内容脚本 + 核心应用 (4 files)
│   ├── icons/                     ← 图标 (3 PNG)
│   └── tuts/                      ← 教程动画 (13 GIF)
├── src/
│   ├── types/index.ts             ← TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md        ← 架构文档 (分层图 + 模块表)
│       ├── DATA_FLOW.md           ← 数据流文档 (Mermaid 序列图)
│       └── SECURITY_AUDIT.md      ← 安全审计报告 (9 维度)
├── package.json                   ← TypeScript 项目配置
└── README.md                      ← 本文件
```

## 架构摘要

VisBug 分为四层:

1. **用户交互层**: 工具栏图标、快捷键 (Alt+Shift+D)、右键菜单
2. **Service Worker 层**: visbug.js 管理每 tab 的 loaded/injected 状态，协调注入/切换/移除
3. **内容脚本层**: inject.js (首次注入), eject.js (隐藏), restore.js (恢复)
4. **核心应用层**: bundle.min.js (~318KB)，以 `<vis-bug>` 自定义元素在页面内运行

完整分析请参见 `src/docs/ARCHITECTURE.md`。

## 已知限制

- **bundle.min.js 未还原**: 主应用代码被压缩为 12 行 (~318KB)，变量名缩短但未混淆。完整还原需反压缩或参考 GitHub 开源仓库 (github.com/GoogleChromeLabs/visbug)
- **SW 状态非持久**: Service Worker 被回收后，loaded/injected 状态丢失，重新激活会执行完整注入
- **无消息回传**: 页面不向 Service Worker 发送消息，所有通信为单向 (SW → 页面)

## 安装与使用

1. 打开 Chrome，访问 `chrome://extensions`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"，选择 `dist/` 目录
4. 点击工具栏 VisBug 图标或按 `Alt+Shift+D` 激活

## 文件完整校验

```bash
# dist/ 与原始 source-code 对比 (排除 _metadata)
# 26 个文件，按原始结构完整复制
find dist/ -type f | wc -l        # 应为 26
```
