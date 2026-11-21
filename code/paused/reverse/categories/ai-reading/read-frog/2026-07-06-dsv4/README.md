# 陪读蛙 v1.37.2 — dsv4 逆向分析

## 版本信息

- **扩展名称**: 陪读蛙 (Read Frog - Translate & Learn)
- **分析版本**: 1.37.2
- **清单版本**: Manifest V3
- **分析日期**: 2026-07-06
- **分析方法**: dsv4 标准工作流
- **源文件数**: 143

## 技术摘要

| 项目 | 详情 |
|------|------|
| 框架 | WXT + React 18 + Vite/Rollup |
| UI 库 | shadcn/ui (Tailwind CSS) |
| 状态管理 | nanostores + Jotai |
| 认证 | better-auth + Google OAuth2 |
| 模式验证 | Zod |
| 混淆程度 | 打包但可读（保留原始标识符） |
| 本地化 | 9 种语言（en, zh_CN, zh_TW, ja, ko, es, ru, tr, vi） |

## 核心模块

- **background.js** (307KB): 统一后台服务，集成所有核心逻辑
- **chunks/** (70+ 文件): WXT 懒加载模块（翻译引擎、存储迁移、API 提供商标识、UI 组件等）
- **content-scripts/** (9 文件): 页面注入脚本（翻译注入、划词工具、输入翻译、YouTube 字幕）
- **_locales/**: 9 语言国际化消息文件

## 关键发现

1. **83 版配置迁移链** — 扩展从 v001 到 v083 共有 83 个配置迁移脚本，显示其长期迭代历史
2. **20+ LLM 提供商集成** — 支持几乎所有主流 LLM API（OpenAI、Anthropic、Google、DeepSeek 等）和纯翻译 API
3. **完整的云同步方案** — 通过 Google OAuth2 + Drive API 实现配置备份与多设备同步，包含冲突解决 UI
4. **批量翻译优化** — 使用令牌桶（token bucket）限流和批量合并减少 API 调用成本
5. **MAIN world 注入** — input-injector.js 和 interceptor.js 注入到页面的 MAIN world 以实现输入拦截和网络拦截
6. **结构化 AI 输出** — 自定义 AI 指令支持结构化 JSON 输出（Zod schema），可映射到远程笔记库

## 安全关注点

详见 `src/docs/SECURITY_AUDIT.md`。重点关注：
- `cookies` 权限的使用场景
- `*://*/*` 全站点内容脚本注入
- API Key 在 chrome.storage.local 中的存储方式
- MAIN world 脚本的安全边界
- 20+ 外部 API 的数据外传风险

## 产出物清单

- [x] `dist/` — 可加载扩展包（143 文件完整复制）
- [x] `src/types/index.ts` — TypeScript 类型定义
- [x] `src/docs/ARCHITECTURE.md` — 架构文档（含 Mermaid 分层图）
- [x] `src/docs/DATA_FLOW.md` — 数据流文档（含 Mermaid 序列图）
- [x] `src/docs/SECURITY_AUDIT.md` — 安全审计报告（9 维度评估）
- [x] `package.json` — npm 包配置
- [x] `tsconfig.json` — TypeScript 编译配置
