---
doc_id: bot.platforms
title: "Bot 平台"
language: zh-CN
source_language: en
counterpart: ./bot-platforms.md
implementation_status: current
document_status: draft
translation_status: synced
last_verified: 2026-09-09
owners:
  - maka-backend
---
<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Bot 平台

本文档描述 Maka 聊天平台 bridge 的能力与安全边界，覆盖 channel 完成配置后的
Runtime bridge。二维码和其他辅助接入流程另见
[IM onboarding runtime architecture](./architecture/bot-onboarding-runtime.zh-CN.md)。

## 支持的 channel 与能力矩阵

当前 `BotProvider` 契约包含 8 个 channel：

| Channel | 普通对话回复 | 定时 Bot 推送 | 渐进式回复流 | 输入中提示 | 临时回复清理 | 非文本消息分类 |
| --- | --- | --- | --- | --- | --- | --- |
| Telegram | 是 | 是 | 是 | 是 | 是 | 是 |
| 微信 | 是 | 是 | 否 | 否 | 否 | 是 |
| Discord | 是 | 是 | 否 | 是 | 否 | 否 |
| 钉钉 | 是 | 是 | 否 | 否 | 否 | 否 |
| QQ | 是 | 是 | 否 | 是 | 否 | 否 |
| Slack | 是 | 是 | 否 | 否 | 否 | 否 |
| 飞书 / Lark | 是 | 否 | 否 | 否 | 否 | 否 |
| 企业微信 | 是 | 否 | 否 | 否 | 否 | 否 |

这张表来自当前源码，而不是线上平台测试。“普通对话回复”表示 Runtime bridge
实现了共享的文本发送路径。“定时 Bot 推送”是更窄的产品能力：定时任务目前只
接受 Telegram、微信、Discord、钉钉、QQ 和 Slack。可选能力列中的“否”表示
Maka 的共享 bridge 没有实现该能力，不表示外部平台永远不可能支持它。

平台数量和定时推送集合必须分开描述。不要把仓库写成支持 9 个平台，也不要因为
某个平台存在 bridge 就推断它支持定时任务推送。

## 配置概览

设置对象使用一套较小的通用字段。平台 API 的叫法不同，但 Runtime bridge 会读取
以下值：

| Channel | 必需或平台专用的值 | Maka 中的 Runtime 传输 |
| --- | --- | --- |
| Telegram | Bot token；可选代理 URL | 长轮询 |
| 微信 | Bridge URL；iLink 路径还需要 Bot token | 本地 bridge 或 iLink 轮询 |
| Discord | Bot token | Gateway |
| 钉钉 | App ID 和 App Secret | Stream/WebSocket |
| QQ | App ID 和 App Secret | Gateway |
| Slack | Bot token 和 app-level token | Gateway |
| 飞书 / Lark | App ID 和 App Secret；可选 `domain` 用于选择飞书或 Lark | 官方 Channel WebSocket |
| 企业微信 | `appId` 中填写 Bot ID，`appSecret` 中填写 Bot Secret | 官方 AI Bot WebSocket |

平台接入说明应使用平台自己的控制台术语，并链接官方文档。此表只说明 Maka
Runtime 消费什么值，不代表这些凭据已经通过线上平台验证。

这张矩阵的源码依据包括 [`BotProvider` 与
`BOT_DELIVERY_PROVIDERS`](../packages/core/src/bot-chat-settings.ts) 契约、共享的
[`SendCapable`](../packages/runtime/src/bots/types.ts) 接口、
[`packages/runtime/src/bots`](../packages/runtime/src/bots) 下的实现，以及对应的
[bridge 测试](../packages/runtime/src/bots/__tests__)。当本文档与实现不一致时，
以代码和契约测试为准。

## 平台接入清单

下面只列出在 Maka 中填值前所需的最小平台侧准备。平台控制台、权限名称、应用审核
和地区可用性都可能变化；当前操作顺序应以链接的官方文档为准。不要把生成的
secret 写入本文档。

### Telegram

1. 使用 [BotFather](https://core.telegram.org/bots#how-do-i-create-a-bot) 的
   `/newbot` 创建 Bot，复制 token。
2. 将 token 填入 Maka 的 `token`；只有 Telegram API 必须通过代理访问时才设置
   `proxyUrl`。
3. 先向 Bot 发送一条私聊文本消息。测试群聊时，将 Bot 加入测试群，并注意
   Telegram 的群隐私和提及规则。

Telegram 是当前唯一同时实现原生渐进式回复、输入中提示和定时临时清理的 bridge。
这些是可选的投递增强能力，普通文本回复才是基础能力。

### Discord

1. 按照 [Discord Bot 文档](https://docs.discord.com/developers/quick-start/getting-started)
   创建 application 和 Bot。
2. 将 Bot token 填入 Maka 的 `token`，把 Bot 安装到私有测试服务器，并只授予
   测试所需的最小消息权限。
3. 开启 **Message Content** 特权 intent。Maka 通过 Gateway 请求 guild message、
   direct message 和 message content；如果未开启所请求的特权 intent，Discord
   可能关闭连接。

Maka 使用 Discord Gateway 接收事件，并使用 REST 调用发送回复；普通 Bot 消息不走
   Discord HTTP interactions endpoint。
如果 Discord 访问需要代理，channel 中的代理设置只覆盖 Bot 凭据认证；Gateway
WebSocket 仍需要系统级路由（例如 TUN），并且需要重启 Maka。

### Slack

1. 在开发 workspace 中创建并安装 Slack app。
2. 开启 [Socket Mode](https://api.slack.com/apis/connections/socket)，创建具有
   `connections:write` 的 app-level token，并取得 app 安装后的 Bot token。
3. 将 Bot token 填入 Maka 的 `token`，将 app-level token 填入 `appSecret`，并为
   workspace 测试订阅所需的消息事件。

Slack 使用 WebSocket 接收事件，使用 Web API client 回复。验证权限和 allowlist
行为时，应使用私有开发 workspace。

### 钉钉

1. 创建自建应用，取得 Client ID 和 Client Secret，并在应用内创建 Bot。可参考
   [官方 Stream Bot 教程](https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/stream/bot/nodejs/create-bot/)。
2. 将消息接收模式设置为 **Stream**。在 Maka 中将 Client ID 填入 `appId`，将
   Client Secret 填入 `appSecret`。
3. 先测试私聊。测试群聊时把 Bot 加入群并 @Bot；钉钉只会向 Bot 投递相关的群聊
   消息。

Bridge 使用钉钉 Stream/WebSocket 接收事件，并通过平台 API 回复。除非另有 bridge
实现，不要把卡片或打字机式更新写成 Maka 已支持的能力。

### QQ

1. 在 [QQ Bot 开放平台](https://q.qq.com/qqbot/) 创建官方 Bot，复制 AppID 和
   AppSecret。
2. 将 AppID 填入 `appId`，将 AppSecret 填入 `appSecret`。
3. 将 Bot 添加到 QQ 平台允许的私有测试场景，只在该 Bot 获准的范围内测试私聊、
   群聊或频道消息。

Maka 使用 QQ Gateway 接收事件，并使用平台 REST API 发送消息。在审核或正式发布
前，平台可能限制可用场景；这种平台策略不等同于 Maka 的 readiness 状态。

### 飞书与 Lark

1. 在[飞书开放平台](https://open.feishu.cn/document/home/index)或
   [Lark Developer](https://open.larksuite.com/document/home/index) 创建企业自建应用。
2. 开启 Bot 以及平台要求的事件/长连接能力，把 App ID 和 App Secret 填入 Maka
   的 `appId` 和 `appSecret`。
3. 对 Lark，将 `domain` 设置为 `larksuite.com`；飞书账号使用默认的飞书域名。
   在私聊或开发群中测试。

飞书和 Lark 共用 Maka 的 `feishu` channel。Bridge 使用平台官方 Channel WebSocket。
该 channel 可以正常回复，但目前不是定时任务通知目标。

### 企业微信

1. 在[企业微信开发者文档](https://developer.work.weixin.qq.com/)创建 AI Bot，
   选择 API 模式和长连接，并复制 Bot ID 与 Secret。
2. 将 Bot ID 填入 Maka 的 `appId`，将 Secret 填入 `appSecret`。
3. 先用私聊验证；如果组织允许，再使用私有测试群。

Maka 使用官方 AI Bot WebSocket。凭据握手成功并不意味着企业微信可以作为定时任务
通知目标。

### 微信

当前实现有两条微信 bridge 路径：

- **本地 bridge：** 在 `webhookUrl` 提供本地 bridge URL，并遵循该 bridge 自己的
  认证/配置契约。
- **iLink：** 在 `webhookUrl` 提供兼容 iLink 的基础 URL，在 `token` 提供 Bot token；
  `botUserId` 可用于标识设置中的 Bot。

使用本地测试 bridge 或平台批准的 iLink 流程，先发送一条私聊文本消息，再测试群聊
提及。Bridge 可以分类多种媒体类型，但不会下载媒体字节作为模型输入。

## 安全与隐私

### 所有进入的消息都是不可信输入

启用的 Bot channel 是一个输入面：私聊或群聊中的文本会进入 Agent context。应像
对待网页、工具结果或粘贴的文件一样谨慎处理。消息声明的作者、指令、链接和附件
都不能授予它读取文件、执行命令、披露数据或修改 Maka 设置的权限。

普通 Session permission mode 与操作系统执行边界仍然是 Agent 行为的权威。Bot
allowlist 只能缩小谁可以发起会话；它不是 sandbox、工具授权系统，也不能替代用户
审查 permission prompt。完整信任模型和报告流程见项目的
[Security Policy](../SECURITY.md)。

### 凭据不能进入 renderer 或公开记录

Bot token、应用 ID 和 secret、Webhook 校验值、device code、poll token 以及原始
provider response 都属于敏感配置。不要将其粘贴到聊天、Issue、PR、截图、测试
fixture 或文档示例中。

Maka 将 renderer 视为半可信。设置读取会返回掩码值；main-process settings API
不能向 renderer 返回明文 Bot token 或应用 secret。辅助接入会把 device code 和
poll credential 保留在 main-process session，只暴露 renderer-safe snapshot。这些
是机密性边界，但不承诺每个平台的凭据都在磁盘上加密：当前 at-rest 保护是仅 owner
可访问的本地设置存储和用户操作系统账户。

修改 bridge 或 onboarding flow 时：

- 在日志或用户诊断到达前，脱敏包含凭据的 URL、header、request body 和 provider error；
- 保持 preload IPC surface 狭窄，不能让 renderer 获得任意访问 provider 的 HTTP 能力
  或 adapter 注入路径；
- 设置表单中的掩码占位符只表示“保留现有值”，不能当成真实凭据。

### 需要时限制谁能联系 Bot

`allowedUserIds` 是可选的按 channel allowlist。缺失或为空时保持现有的开放行为；非空
时，bridge 会静默丢弃其他平台原生用户 ID 的消息，不发送可能帮助未授权发送者探测
策略的拒绝消息。ID 以字符串存储，因为部分平台 ID 超过 JavaScript 安全整数范围。

个人、开发或其他受限 Bot 应配置 allowlist。公共 Bot 只有在所有者有意接受不可信消息
并选择了合适的 Session permission policy 时，才应保持为空。

### 非文本消息不是模型附件

部分 bridge 能识别收到的图片、语音、文档或其他非文本 payload。识别结果用于发送
清晰的文字提示，告诉用户 Maka 无法处理这些内容；它不会下载二进制、把内容提供给
模型，也不会建立多模态输入边界。

因此，文档和 UI 应写“非文本消息检测”，而不是“文件附件支持”，除非某个平台有明确
且经过审查的二进制输入链路。

### 疑似漏洞应私下报告

凭据泄露、缺失认证或签名校验、IPC 暴露 secret，或绕过既定安全边界的问题，不要通过
公开 Issue 报告。请按照 [SECURITY.md](../SECURITY.md#reporting-a-vulnerability) 的
私下报告流程，提供 bridge、最小复现和 Maka 版本或 commit。

## 运行状态与限制

Runtime 使用明确状态而不是单一布尔值报告 channel 健康：`scaffolded`、`configured`、
`credentials_valid`、`operational` 和 `degraded`。已配置不等于已连接，凭据检查成功
也不证明端到端回复已经送达。UI 和接入文档应保留这个区别。

当前共享 Bot 契约以文本为主：

- 文本消息可以进入 Session 并收到文本回复；
- 部分 bridge 会分类非文本消息，让用户收到限制提示；
- bridge 不会让模型获得图片、语音消息或文档字节；
- 可选能力必须按 channel 描述，不能从 provider 的一般产品能力推断。

定时推送也比 channel 支持范围更窄。Bridge 可以支持实时对话，但仍可能不能作为
定时任务通知目标。定时任务 UI 和协议应使用 core contract 中的 6 个投递平台，而不是
所有已配置 channel。

## 验证状态

本文档的能力矩阵和配置概览来自源码，并与当前 provider contract、bridge 实现和
Runtime 聚焦测试核对过。它不是线上凭据记录，也不保证每个平台账号在每个地区都能
创建。

### 线上实测

飞书（中国区账号，手动配置）已于 2026-09-10 完成实测。Channel 成功连接；
私聊文本消息收到一条回复；在群聊中 @Maka 发送文本消息后收到一条回复，且正文
内容保持正确；重启 Maka 后再次发送群消息仍收到一条回复。实测没有记录凭据、用户
ID 或平台原始 payload。本次仅验证普通文本对话和重启恢复，能力矩阵中的可选能力
仍以源码验证为准。

Discord（中国大陆网络，手动配置）已于 2026-09-10 使用 Discord 网页版完成实测。
在测试服务器群聊中 @Maka 发送文本消息后，消息成功到达 bridge，Bot 在同一 Discord
频道返回一条回复，且指定正文保持正确。本次实测需要可用的系统级 TUN 路由来承载
Gateway WebSocket。实测没有记录凭据、用户 ID 或平台原始 payload；本条仅验证一次
普通群消息收发，尚未验证重启恢复、重复消息抑制或定时推送。

Telegram（中国大陆网络，手动配置）已于 2026-09-10 完成实测。私聊中的 `/start` 和
文本测试消息成功到达 bridge，Bot 返回一条回复，且测试正文保持正确。实测没有记录
凭据、用户 ID 或平台原始 payload；本条仅验证一次普通私聊收发，尚未验证重启恢复、
群聊行为、重复消息抑制或定时推送。

微信目前标记为“源码验证，未线上实测”。聚焦测试覆盖了 iLink/本地 bridge 地址限制、
二维码登录取消、消息映射、媒体分类和 SSE 解析，但没有真正调用 iLink
`sendmessage` 完成收发闭环。当前 iLink bridge 也没有保留入站消息的 `context_token`，
出站回复固定发送空 token；因此在修复并完成真实收发验证前，不应把微信描述为“已验证可用”。
这只是实现风险说明，不代表对平台账号限制或封号风险作出结论。

后续其他平台完成线上验证时，只记录以下脱敏后的 smoke check 结果，不记录凭据或原始
provider payload：

1. channel 配置达到预期 readiness 状态；
2. 一条私聊文本消息到达 Maka 并收到一条回复；
3. bridge 不回复自己的 echo 消息；
4. 重启或重连不会重复发送回复；
5. 只有定时投递集合中的平台才测试定时推送。

在这些检查完成前，平台专属接入文档应使用“源码验证”，而不是“线上验证”。
