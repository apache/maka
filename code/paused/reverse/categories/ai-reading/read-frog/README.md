# 陪读蛙 (Read Frog - Translate & Learn)

> 开源浏览器扩展，帮助用户从任何网站深入学习语言。

## 功能概述

陪读蛙是一款功能丰富的语言学习浏览器扩展，核心功能包括：

- **网页翻译** — 支持双语对照/仅译文模式，可自定义翻译样式
- **划词翻译** — 选中文本弹出工具栏，快速翻译、朗读或执行自定义 AI 指令
- **输入翻译** — 在任意输入框中连按三次空格触发翻译
- **视频字幕翻译** — YouTube 视频字幕实时翻译（双语显示）
- **AI 自定义指令** — 结构化输出（词典、写作改进等），支持笔记库保存
- **文本转语音** — 基于 Edge TTS 的多语言朗读
- **多提供商支持** — 内置 20+ LLM 提供商（OpenAI、DeepSeek、Gemini、Claude 等）和纯翻译服务（Google Translate、Microsoft Translator、DeepLX）
- **配置云同步** — Google Drive 同步（含冲突解决）

## 技术架构

- **框架**: WXT (Web eXtension Toolkit) + React 18
- **构建**: Vite / Rollup
- **UI 组件**: shadcn/ui (Tailwind CSS)
- **状态管理**: nanostores + Jotai
- **认证**: better-auth + Google OAuth2
- **清单版本**: Manifest V3
- **语言**: TypeScript / JavaScript

## 权限清单

| 权限 | 用途 |
|------|------|
| `storage` | 存储配置、翻译缓存、备份 |
| `tabs` | 获取标签页信息用于站点控制 |
| `alarms` | 定时备份、定时任务 |
| `cookies` | 与 readfrog.app 的会话保持 |
| `contextMenus` | 右键菜单翻译/朗读 |
| `identity` | Google OAuth2 登录（Drive 同步） |
| `scripting` | 动态注入翻译脚本 |
| `webNavigation` | 监听页面导航触发自动翻译 |
| `offscreen` | 音频播放（TTS） |
| `sidePanel` | 侧边栏翻译面板 |
| `*://*/*` | 全站点内容脚本注入与翻译 |

## 分析版本

| 日期 | 版本 | 模型 | 说明 |
|------|------|------|------|
| 2026-07-06 | 1.37.2 | dsv4 | 首次逆向分析，含完整架构/数据流/安全审计 |

## 文件结构

```
read-frog/
├── README.md                          # 本文件
└── 2026-07-06-dsv4/
    ├── dist/                          # 可加载到 Chrome 的扩展包
    ├── src/
    │   ├── types/index.ts             # TypeScript 类型定义
    │   └── docs/
    │       ├── ARCHITECTURE.md        # 架构文档
    │       ├── DATA_FLOW.md           # 数据流文档
    │       └── SECURITY_AUDIT.md      # 安全审计报告
    ├── package.json
    ├── tsconfig.json
    └── README.md                      # 本版本分析说明
```

## 相关链接

- Chrome Web Store: 陪读蛙 (Read Frog - Translate & Learn)
- GitHub: https://github.com/mengxi-ream/read-frog
- 官网: https://readfrog.app
