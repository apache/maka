# Wappalyzer - Technology profiler

网站技术栈识别工具，通过分析页面信号自动识别 CMS、框架、分析工具、CDN 等 Web 技术。

## 功能概述

- 自动检测网站使用的 Web 技术栈（CMS、JavaScript 框架、分析工具、CDN 等）
- 覆盖 8,500+ 条技术指纹，111 个技术分类
- 支持通过 JavaScript 全局变量链、DOM 属性、HTTP 头、Cookie 等多维度检测
- Wappalyzer Plus 增值服务：公司/联系人详情、CSV 导出
- 34 种语言国际化支持
- 暗色/亮色主题切换

## 技术架构

- **Manifest V3**，Service Worker + Content Script
- 手写纯 JavaScript，零打包器，零 npm 依赖
- 核心模式匹配引擎可独立运行（支持 Node.js）
- 通过 `<script>` 注入突破 Chrome 扩展隔离世界限制
- 多浏览器兼容（Chrome / Firefox / Safari）

## 权限

| 权限 | 说明 |
|------|------|
| cookies | 读取浏览器 Cookie |
| storage | 本地存储设置与缓存 |
| tabs | 管理标签页 |
| webRequest | 监听网络流量 |
| http/https all | 全站 Content Script |

## 分析版本

| 日期 | 版本 | 工作流 | 备注 |
|------|------|--------|------|
| [2026-07-06](2026-07-06-dsv4/) | 6.12.3 | dsv4 | 首次逆向还原 |
