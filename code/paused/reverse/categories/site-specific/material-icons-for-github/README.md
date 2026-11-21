# Material Icons for GitHub

**原始名称**: Material Icons for GitHub | **商店版本**: 1.16.2 | **Manifest**: V3

## 功能概述

Material Icons for GitHub 为 GitHub、GitLab、Bitbucket、Gitee 等 10 大 Git 托管平台的文件浏览器注入 Material Design 风格的 SVG 图标，使文件树更直观美观。

核心功能：
- 根据文件名/扩展名自动匹配对应图标
- 10 个图标包（Angular, Nest, NgRx, React, Redux, Roblox, Qwik, Vue, Vuex, Bashly）
- 三级匹配策略（精确文件名 > 文件扩展名 > 默认图标）
- 自定义站点支持
- 深色模式适配

## 技术架构

- **类型**: 纯 Content Script 扩展（无 Service Worker、无 Background）
- **Adapter 模式**: 10 个 Git 平台各有独立 SiteConfig
- **图标库**: 1251 个 Material Design SVG（覆盖数百种文件类型 + 特殊文件夹图标）
- **注入时机**: `document_start`

## 安全

无 `innerHTML`/`eval`、无网络请求、无敏感数据处理，安全风险评级为低。

## 权限

`storage`, `activeTab`, `scripting` + `github.com/gitlab.com/gitee.com/bitbucket.org/...` 等 10 个站点 host

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 1.16.2 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
