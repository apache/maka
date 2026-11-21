# 📥 下载集成

与桌面下载管理器或文档导出功能集成的浏览器扩展。

## 包含插件

| 插件 | 版本 | 功能 | 技术栈 | 最新分析 |
|------|------|------|--------|----------|
| [NeatDownloadManager](neatdownloadmanager/) | 1.9.92 | 下载链接发送到 Neat Download Manager | 原生 JS + 裸 WebSocket | [2026-07-06-dsv4](neatdownloadmanager/2026-07-06-dsv4/) |
| [IDM Integration Module](idm-integration-module/) | 6.43.1 | Internet Download Manager 浏览器集成 | 原生 JS (ROT13 混淆) | [2026-07-05-dsv4](idm-integration-module/2026-07-05-dsv4/) |
| [飞书转存专家](feishu/) | 0.7.27 | 飞书文档多格式导出（PDF/Word/Markdown） | html2canvas + jsPDF + docx | [2026-07-04-dsv4](feishu/2026-07-04-dsv4/) |

## 安全热点

| 等级 | 插件 | 主要风险 |
|:----:|------|------|
| 🔴 | NeatDownloadManager | Cookie 明文经未加密 WebSocket 传输到 localhost，无 nativeMessaging 认证 |
| 🟡 | IDM Integration Module | ROT13 弱混淆，webRequest 拦截范围大 |
| 🟢 | 飞书转存专家 | 仅本地处理，无外部数据外传 |
