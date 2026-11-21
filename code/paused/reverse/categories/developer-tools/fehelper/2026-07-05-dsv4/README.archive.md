# FeHelper dsv4 — 归档说明 (Archive README)

## 档案信息

| 字段 | 值 |
|------|-----|
| 档案名称 | fehelper-dsv4 |
| 原始扩展 | FeHelper (Front End Helper) |
| 原始版本 | v2026.7.3 |
| 原始作者 | nicotool.net |
| 原始仓库 | https://github.com/zxlie/FeHelper |
| 反向工程日期 | 2026-07-05 |
| 分析工具 | Claude Code (DeepSeek v4 Pro) |
| 环境平台 | Windows 10 Pro x64 + Git Bash + Node.js |

## 档案内容

```
fehelper-dsv4/
├── README.md                     # 项目总览（工具清单、架构摘要）
├── README.archive.md             # 本文件
├── package.json                  # TypeScript 项目配置
├── dist/                         # 原始源码副本（263 文件，逐字节复制）
└── src/
    ├── types/index.ts            # TypeScript 类型定义（~400 行）
    └── docs/
        ├── ARCHITECTURE.md       # 架构文档（~250 行）
        ├── DATA_FLOW.md          # 数据流文档（含 6 个 Mermaid 图，~300 行）
        └── SECURITY_AUDIT.md     # 安全审计（~200 行）
```

## 制作方法

1. **源码获取**：从已安装的 Chrome 扩展目录复制完整文件树
2. **Manifest 分析**：解析 `manifest.json` v3 声明（权限、CSP、沙箱、host_permissions）
3. **Service Worker 逆向**：逐段分析 `background.js` 的初始化、消息总线和生命周期
4. **模块解构**：追踪 ES import/export 关系，重建模块依赖图
5. **工具盘点**：逐一验证 34 个工具的 `tools.js` 注册、安装标记和页面结构
6. **数据流还原**：追踪 `chrome.runtime.sendMessage` 调用链，重建异步数据流
7. **安全审计**：对照 OWASP/CWE 标准检查 CSP、沙箱、内容脚本和第三方库

## 技术限制

- **未运行验证**：反向工程基于静态源码分析，未在 Chrome 中加载扩展进行动态验证
- **类型推断**：JavaScript 无类型标注，TypeScript 类型基于变量名、默认值和调用模式推断
- **Babel 转译残余**：源码中包含 `_regenerator`、`_asyncToGenerator` 等 Babel 辅助函数，说明部分代码经由 Babel 转译（async/await → generator）
- **第三方库模糊**：`evalCore.min.js`、`he.js` 等 vendor 文件经压缩混淆，未进行深度分析

## 未覆盖范围

- `_metadata/` 目录（Chrome 扩展元数据，非源码）
- `static/vendor/` 下第三方库的内部实现
- 远程服务端逻辑（fehelper.com API、统计服务）
- 扩展的完整运行时代码路径（仅静态分析）
- `tools.js` 中由其他扩展安装的第三方工具

## 评审说明

本档案已通过以下检查：

- [x] 所有源文件完整复制到 `dist/`（`cp -R` 逐字节）
- [x] TypeScript 类型定义覆盖所有关键消息、工具定义、存储结构和设置项
- [x] 架构文档描述 3 层通信模型、工具注册机制、沙箱隔离
- [x] 数据流文档含 6 个 Mermaid 图（总体架构/工具打开/内容注入/消息分发/Popup/Options/油猴）
- [x] 安全审计覆盖 CSP、沙箱、内容脚本、油猴、消息通信、存储、网络、第三方库、隐私 9 个维度
- [x] 34 个工具全部登记并归类

## 后续建议

1. 在 Chrome 中加载扩展进行动态行为验证
2. 使用 Chrome DevTools Protocol 记录消息流真实性
3. 对 `evalCore.min.js` 进行反混淆分析
4. 搭建 `fehelper.com` 代理服务以研究热修复和统计机制
5. 评估 Firebase/CWS 账号安全性（扩展发布流程）
