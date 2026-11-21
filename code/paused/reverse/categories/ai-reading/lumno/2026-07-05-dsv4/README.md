# Lumno - 聚焦搜索新标签页 逆向工程文档

> Chrome 扩展 v0.9.14 | Manifest V3 | 逆向分析项目
> 原始作者: Kubai087 | 分析日期: 2026-07-05

## 项目概述

本项目是对 **Lumno - 聚焦搜索新标签页** Chrome 扩展的逆向工程文档。原始扩展已从 Chrome Web Store 解包获取，本项目提供了完整的源码副本、架构分析、数据流文档和安全审计报告。

## 扩展功能

| 功能 | 说明 |
|------|------|
| 新标签页 | 替换浏览器默认新标签页，提供搜索、书签、常用网站 |
| 覆盖层搜索 | 在任意网页上按 `Ctrl+Shift+K` 弹出搜索面板 |
| 标签页切换器 | 按 `Alt+Q` 快速切换最近使用的标签 |
| 壁纸系统 | 内置 20 张精美术壁纸，支持半色调/ASCII 特效 |
| 自动画中画 | 自动检测视频播放并触发画中画模式 |
| 站点搜索 | 内置 23 个站点搜索（含 ChatGPT/DeepSeek 等 AI 站点） |
| 快捷方式 | 浏览器内部页面快捷搜索（如 "扩展" → extensions/） |

## 项目结构

```
lumno-dsv4/
├── dist/                        # 解包扩展原始源码 (140 文件)
│   ├── manifest.json            # Manifest V3 清单
│   ├── src/                     # 扩展核心代码
│   │   ├── background/          # Service Worker (background.js + 模块)
│   │   ├── newtab/              # 新标签页 (HTML + JS + 壁纸系统)
│   │   ├── overlay/             # 覆盖层搜索系统
│   │   ├── content/             # 内容脚本 (热键监听 + 自动 PiP)
│   │   ├── shared/              # 共享模块 (设置/搜索/UI 组件)
│   │   ├── options/             # 设置页面
│   │   └── onboarding/          # 引导页面
│   ├── assets/                  # 静态资源
│   │   ├── wallpapers/          # 壁纸图片 (webp)
│   │   ├── images/              # 图标/标志
│   │   ├── data/                # 配置文件 (site-search, shortcut-rules)
│   │   ├── fonts/               # Open Sans 字体
│   │   ├── remixicon/           # Remix Icon 图标库
│   │   └── vendor/              # 第三方库 (pinyin-pro)
│   └── _locales/                # 多语言文件 (zh_CN, zh_TW, ja, en)
├── src/
│   ├── types/
│   │   └── index.ts             # TypeScript 类型定义
│   └── docs/
│       ├── ARCHITECTURE.md      # 架构文档
│       ├── DATA_FLOW.md         # 数据流文档 (含 Mermaid 图)
│       └── SECURITY_AUDIT.md    # 安全审计报告
├── package.json                 # 项目配置 (TypeScript 类型检查)
└── README.md                    # 本文件
```

## 技术栈

- **Manifest V3** — Service Worker 架构
- **importScripts** — 模块化加载 (globalThis 命名空间)
- **Shadow DOM** — 覆盖层样式隔离
- **CSS 自定义属性** — 主题切换 (light/dark)
- **CSS Houdini** — 超椭圆形状 (`corner-shape`)
- **Backdrop Filter** — 毛玻璃效果
- **Canvas** — 壁纸特效渲染
- **pinyin-pro** — 中文拼音搜索匹配

## 关键架构设计

1. **覆盖层系统** — Shadow DOM + z-index:2147483647 最大层级注入任意页面
2. **搜索算法** — 意图分类 + 多维度相关性评分 + 选择历史学习
3. **标签切换器** — 指数衰减频次排序 + 缩略图缓存
4. **PiP 管理** — 全局所有权令牌 + MAIN world 脚本注入

## 权限分析

| 权限 | 用途 | 风险 |
|------|------|------|
| `scripting` | 注入覆盖层 | 中 |
| `tabs` | 标签管理 | 中 |
| `history` | 历史搜索 | 中 |
| `bookmarks` | 书签管理 | 低 |
| `storage` | 设置存储 | 低 |
| `search` | 搜索引擎建议 | 低 |
| `favicon` | 网站图标 | 低 |
| `topSites` | 常用网站 | 低 |
| `<all_urls>` | 全局热键 | 高 (有严格 URL 守卫) |

## 安全结论

**整体安全等级: 低风险**。详细审计见 `src/docs/SECURITY_AUDIT.md`。

- 无数据外发行为
- 无外部 CDN 依赖
- 无凭据存储
- 权限使用有 URL 守卫
- 已清理废弃的 AI 密钥存储键

## 免责声明

本项目仅用于学习和研究目的。原始扩展的版权归原作者 (Kubai087) 所有。本逆向工程文档不包含任何破解、篡改或恶意用途的代码。使用者应遵守 Chrome Web Store 的相关条款和适用法律。

## 文档

- [架构文档](./src/docs/ARCHITECTURE.md) — 模块结构和职责说明
- [数据流文档](./src/docs/DATA_FLOW.md) — 核心功能的数据流图 (Mermaid)
- [安全审计](./src/docs/SECURITY_AUDIT.md) — 权限、通信、存储安全分析
- [类型定义](./src/types/index.ts) — TypeScript 类型定义
