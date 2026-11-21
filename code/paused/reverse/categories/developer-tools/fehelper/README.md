# FeHelper (前端助手)

**原始名称**: FeHelper - JSON格式化、编解码、二维码、开发者工具箱 | **商店版本**: 2026.7.3 | **Manifest**: V3

## 功能概述

FeHelper 是国内最流行的 Chrome 开发者工具集之一，包含 30+ 个独立工具，按需安装使用。

核心工具集：
- **编解码**: JSON 格式化 / Base64 / URL / Unicode / Gzip / JWT
- **生成器**: 二维码 / 条形码 / UUID / 雪花 ID
- **转换**: 时间戳 / FILETIME / 进制转换 / 颜色拾取
- **文本**: 代码美化 / 正则测试 / 差异对比 / Markdown 预览
- **网络**: Postman 类工具 / CRX 下载器
- **AI**: Chrome Built-in AI (Gemini Nano) 集成
- **自动化**: 油猴脚本引擎 / 页面截图

## 技术架构

- **框架**: 原生 ES Module，Service Worker 消息总线
- **UI**: Vue.js（工具页面）+ jQuery（Content Script）
- **通信**: `fh-dynamic-any-thing` 消息承载 20+ 种操作类型
- **存储**: chrome.storage.local 管理 34 个工具的安装状态
- **安全**: MV3 sandbox 页面支持 `unsafe-eval`

## 权限

`alarms`, `tabs`, `scripting`, `contextMenus`, `activeTab`, `storage`, `notifications`, `unlimitedStorage`, `webNavigation` + `http/https/file` hosts

## 分析版本

| 版本 | 日期 | 模型 | 文档 |
|------|------|------|------|
| 2026.7.3 | 2026-07-05 | DeepSeek V4 Pro | [2026-07-05-dsv4/](2026-07-05-dsv4/) |
