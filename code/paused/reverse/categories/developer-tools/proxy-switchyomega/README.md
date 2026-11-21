# Proxy SwitchyOmega (V3)

> 轻松管理和切换多个代理配置的 Chrome 浏览器扩展。

## 功能概述

Proxy SwitchyOmega (V3) 是经典的代理切换管理工具, 支持:

- **多种代理协议**: HTTP / HTTPS / SOCKS4 / SOCKS5 / PAC 脚本
- **智能自动切换**: 基于 URL 通配符、正则、IP、时间等条件自动选择代理
- **快速切换**: 点击浏览器工具栏图标即可切换代理配置
- **在线规则更新**: 支持远程 PAC 脚本和规则列表自动同步
- **备份恢复**: 完整的配置导入导出功能
- **跨设备同步**: Chrome 账号同步 (chrome.storage.sync)

## 技术架构

- **Manifest 版本**: 3 (Service Worker)
- **UI 框架**: AngularJS 1.x + UI-Router
- **代理引擎**: 自研 OmegaPac (PAC 生成 + 条件匹配)
- **存储**: chrome.storage.local + localStorage + IndexedDB

## 逆向分析版本

| 版本号 | 日期 | 工作流 | 说明 |
|---|---|---|---|
| [v3.0.5](2026-07-06-dsv4/) | 2026-07-06 | dsv4 | 完整逆向分析 (types + 架构 + 数据流 + 安全审计) |

## 安全提示

本扩展拥有敏感的 `proxy` 和 `webRequestAuthProvider` 权限, 可控制所有网络流量路由。建议:
- 仅从 Chrome Web Store 官方渠道安装
- 审查所配置的代理服务器的可信度
- 导出配置备份时注意代理密码会以明文暴露

## 相关链接

- 源代码仓库: <https://github.com/mrfanii/SwitchyOmega-V3>
- Chrome Web Store: 扩展 ID `padekgcemlokbadohgkifijomclgjgif`
- 原始许可: GPL-3.0

---

*本目录为逆向工程产出, 仅供学习研究使用。*
