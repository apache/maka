# i微信读书 (WeRead Helper)

微信读书网页版增强工具，支持划线摘抄/导出到Flomo/Notion/飞书/同步/换肤等。

- **商店版名称**: i微信读书
- **Slug**: weread-helper
- **最新分析版本**: [2026-07-06-dsv4](./2026-07-06-dsv4/) (v0.9.22)
- **Manifest 版本**: MV2
- **打包方式**: Webpack 5 + React 17

---

## 功能概述

| 功能 | 说明 |
|------|------|
| 划线摘抄 | 选中文本后一键同步到 Flomo |
| 书签卡片 | 划线内容生成精美分享图片(html2canvas) |
| 笔记导出 | Markdown 格式导出划线/笔记到剪切板 |
| Readwise 同步 | 批量同步笔记到 Readwise |
| Notion 同步 | 批量同步笔记到 Notion (经中转代理) |
| 飞书文档 | 创建飞书文档 (已废弃/未启用) |
| 换肤/主题 | 5 种阅读背景色 |
| 纸张纹理 | 10 种纸张纹理 (transparenttextures.com) |
| 字体切换 | 5 种中文字体 (楷体/行楷/最右/手写/宋体) |
| 代码高亮 | highlight.js 代码块语法高亮 |
| 宽度调节 | 页面宽度自定义 |
| 右键菜单 | 解除微信读书图片右键菜单限制 |

## 技术架构

| 项目 | 详情 |
|------|------|
| 架构模式 | 三层注入 (Background → Content Script → Inject Script) |
| UI 框架 | React 17 (Class + Function Component) |
| 打包工具 | Webpack 5 |
| 存储方案 | store2 (localStorage, namespace: iwr) |
| 错误监控 | Sentry |
| 行为追踪 | 百度统计 |

## 权限分析

| 权限 | 用途 |
|------|------|
| `webRequest` / `webRequestBlocking` | 移除 CSP、注入 CORS 头 |
| `*://weread.qq.com/*` | 微信读书主站 |
| `*://flomoapp.com/*` | Flomo API 同步 |
| `*://api.notion.com/*` | Notion API (声明但未直接使用) |
| `*://open.feishu.cn/*` | 飞书开放平台 |
| `*://*.tencent.com/*` | 腾讯云 CPS 推广 |

## 分析版本

| 版本 | 分析日期 | 模型 | 备注 |
|------|---------|------|------|
| [0.9.22](./2026-07-06-dsv4/) | 2026-07-06 | dsv4 | 首个分析版本 |

## 安全评分

**3.5/10 (低安全水平)** — 详情见各版本安全审计报告。主要风险：硬编码 API 凭据、Notion Token 中转、CSP 完全移除。

## 免责声明

本项目仅用于技术研究和学习目的。原始扩展版权归原作者所有。
