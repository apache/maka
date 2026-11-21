# 网页万能复制 (Universal Copy - Enable Copy)

> 分类: browser-enhancement | Manifest V3 | Chrome Web Store

## 简介

"网页万能复制"是一款解除网页复制限制的 Chrome 扩展。它可以绕过网站设置的禁止右键、禁止选择、禁止复制、禁止粘贴等限制,让用户在任何网页上自由复制文本内容。

- **Chrome Web Store 链接**: [网页万能复制](https://chrome.google.com/webstore/detail/hmlmncgagbkggdfpklpmhjcmbjadpkdo)
- **扩展 ID**: `hmlmncgagbkggdfpklpmhjcmbjadpkdo`
- **权限**: tabs, storage, scripting, declarativeNetRequestWithHostAccess
- **Host 权限**: `http://*/*`, `https://*/*`

## 核心功能

- 解除禁止右键、禁止选择、禁止复制、禁止粘贴
- 域名白名单自动破解
- 针对百度文库、豆丁网、道客巴巴的特殊适配
- 50 种语言国际化支持

## 安全评估

| 版本 | 安全等级 | 审计概要 |
|------|---------|---------|
| 1.0.28 | C+ | 全站注入权限、向第三方发送浏览数据、部分 HTTP 明文传输 |

## 逆向版本

| 日期 | 版本 | 模型 | 目录 |
|------|------|------|------|
| 2026-07-06 | 1.0.28 | dsv4 | [2026-07-06-dsv4/](./2026-07-06-dsv4/) |

## 项目结构

```
universal-copy/
├── README.md                  # 本文件 (通用介绍)
└── 2026-07-06-dsv4/           # 版本 1.0.28 逆向产出
    ├── dist/                  # 还原的扩展产物
    ├── src/
    │   ├── types/index.ts     # TypeScript 类型定义
    │   └── docs/
    │       ├── ARCHITECTURE.md
    │       ├── DATA_FLOW.md
    │       └── SECURITY_AUDIT.md
    ├── package.json
    └── README.md              # 版本特定说明
```

## 技术亮点

- **三层破解策略**: CSS 注入 + 事件清除 + Capture 拦截
- **定时重执行**: 多级延迟对抗动态 DOM 修改
- **站点适配器模式**: 针对特定平台的定制破解逻辑
- **SEO 绕过**: 利用 declarativeNetRequest 伪装爬虫 User-Agent 获取完整内容
- **遥测系统**: 基于阿里云 SLS 的完整用户行为分析管道
