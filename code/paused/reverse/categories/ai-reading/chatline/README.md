# ChatLine：AI 对话增强

**商店版本**: 3.8.0 | **Manifest**: V3 | **作者**: yanchao hou

## 功能概述

ChatLine 是一款增强 ChatGPT、Gemini、Claude、DeepSeek 等 13+ AI 平台对话体验的综合扩展，提供时间线导航、对话导出、代码执行、提示词复用等功能。

核心功能：
- 时间线导航（对话节点标记/虚拟化滚动/滚动同步）
- 对话导出（全文/选择性导出）
- 代码执行器（JS/TS/SQL/HTML/JSON/Markdown/Mermaid 沙箱运行）
- 智能输入框（提示词按钮/智能回车/打字动画）
- 收藏对话管理（文件夹组织）
- LaTeX 公式渲染 / Mermaid 图表 / 代码高亮
- 镜像站点检测与提示词复制

## 技术架构

- **框架**: 纯原生 JavaScript（无模块系统），160+ JS 文件按严格顺序加载
- **核心模式**: Adapter 模式 — 3 组适配器（Timeline/Sidebar/SmartInput）各自覆盖 13 个 AI 平台
- **全局单例**: DOMObserverManager / AIStateMonitor / UrlChangeMonitor / EventDelegateManager / StorageAdapter
- **SPA 路由**: SPA 导航检测 + 指数退避重试
- **跨 World 通信**: MAIN world Fiber Bridge 通过同步 CustomEvent 与 ISOLATED world 通信

## 权限

`storage`, `tabs`, `activeTab`, `scripting`, `downloads`, `clipboardRead` 等

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 3.8.0 | 2026-07-04 | DeepSeek V4 Pro | [2026-07-04-dsv4/](2026-07-04-dsv4/) |
