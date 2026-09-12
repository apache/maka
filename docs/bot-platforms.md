---
doc_id: bot.platforms
title: "Bot platforms"
language: en
source_language: en
implementation_status: current
document_status: draft
counterpart: ./bot-platforms.zh-CN.md
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

# Bot platforms

This document describes the capabilities and security boundaries of Maka's
chat-platform bridges. It covers the Runtime bridge after a channel is
configured. QR and other assisted onboarding flows are specified separately in
[IM onboarding runtime architecture](./architecture/bot-onboarding-runtime.zh-CN.md).

## Supported channels and capability matrix

The current `BotProvider` contract contains eight channels:

| Channel | Normal conversation reply | Scheduled bot delivery | Progressive reply stream | Typing indicator | Ephemeral reply cleanup | Non-text message classification |
| --- | --- | --- | --- | --- | --- | --- |
| Telegram | Yes | Yes | Yes | Yes | Yes | Yes |
| WeChat | Yes | Yes | No | No | No | Yes |
| Discord | Yes | Yes | No | Yes | No | No |
| DingTalk | Yes | Yes | No | No | No | No |
| QQ | Yes | Yes | No | Yes | No | No |
| Slack | Yes | Yes | No | No | No | No |
| Feishu / Lark | Yes | No | No | No | No | No |
| WeCom | Yes | No | No | No | No | No |

This table is derived from the current source, not from live provider tests.
"Normal conversation reply" means that the Runtime bridge implements the
shared text-send path. "Scheduled bot delivery" is a narrower product
capability: scheduled tasks currently accept only Telegram, WeChat, Discord,
DingTalk, QQ, and Slack. A `No` in the optional-feature columns means that the
shared Maka bridge does not implement that feature; it does not claim that the
external provider could never support it.

The platform count and the scheduled-delivery set are intentionally separate.
Do not describe the repository as supporting nine platforms, and do not infer
scheduled-task support from the existence of a bridge alone.

## Configuration overview

The settings object uses a small common vocabulary. The exact provider API
names differ, but the Runtime bridge reads the following values:

| Channel | Required or provider-specific values | Runtime transport in Maka |
| --- | --- | --- |
| Telegram | Bot token; optional proxy URL | Long polling |
| WeChat | Bridge URL and, for the iLink path, a bot token | Local bridge or iLink polling |
| Discord | Bot token | Gateway |
| DingTalk | App ID and app secret | Stream/WebSocket |
| QQ | App ID and app secret | Gateway |
| Slack | Bot token and app-level token | Gateway |
| Feishu / Lark | App ID and app secret; optional `domain` selects Feishu or Lark | Official Channel WebSocket |
| WeCom | Bot ID in `appId` and bot secret in `appSecret` | Official AI Bot WebSocket |

Provider setup instructions must name the provider's own console terms and
link to its official documentation. This table only describes what the Maka
Runtime consumes; it is not a claim that the credentials have been validated
against a live provider.

The source of truth for this matrix is the [`BotProvider` and
`BOT_DELIVERY_PROVIDERS`](../packages/core/src/bot-chat-settings.ts) contract,
the shared [`SendCapable`](../packages/runtime/src/bots/types.ts) interface,
the implementations under
[`packages/runtime/src/bots`](../packages/runtime/src/bots), and their focused
[bridge tests](../packages/runtime/src/bots/__tests__). When this document and
the implementation disagree, code and contract tests win.

## Platform setup checklists

These checklists describe the smallest provider-side setup needed before
entering values in Maka. Provider consoles, permission names, app review, and
regional availability can change; follow the linked official documentation for
the current portal sequence. Never put the resulting secrets in this document.

### Telegram

1. Use [BotFather](https://core.telegram.org/bots#how-do-i-create-a-bot) to
   create a bot with `/newbot` and copy its token.
2. Put the token in Maka's `token` field. Set `proxyUrl` only when the Telegram
   API must be reached through a proxy.
3. Send the bot a direct text message first. For a group smoke test, add the
   bot to a test group and account for Telegram group privacy and mention rules.

Telegram is the only current bridge with native progressive reply streaming,
typing indicators, and scheduled ephemeral cleanup. These features are
optional delivery enhancements; a normal text reply remains the baseline.

### Discord

1. Create an application and bot in the [Discord developer
   documentation](https://docs.discord.com/developers/quick-start/getting-started).
2. Copy the bot token into Maka's `token` field, install the bot into a private
   test server, and grant the minimum message permissions needed for the test.
3. Enable the privileged **Message Content** intent. Maka requests guild
   messages, direct messages, and message content over the Gateway; Discord can
   close the connection when a requested privileged intent is not enabled.

Maka uses Discord's Gateway for inbound events and REST calls for sends. It
does not use Discord's HTTP interactions endpoint for ordinary bot messages.
When Discord access requires a proxy, the channel proxy setting covers Bot
authentication only; the Gateway WebSocket still requires a system-level route
such as TUN, followed by an app restart.

### Slack

1. Create and install a Slack app in a development workspace.
2. Enable [Socket Mode](https://api.slack.com/apis/connections/socket), create
   an app-level token with `connections:write`, and obtain the bot token from
   the app installation.
3. Enter the bot token in Maka's `token` field and the app-level token in
   `appSecret`. Subscribe the app to the message events required by the
   workspace test.

Slack uses a WebSocket connection for events and a Web API client for replies.
Keep the app in a private development workspace while validating scopes and
allowlist behavior.

### DingTalk

1. Create a self-built application, obtain its Client ID and Client Secret,
   and create a bot in the application. The [official Stream bot
   tutorial](https://opensource.dingtalk.com/developerpedia/docs/explore/tutorials/stream/bot/nodejs/create-bot/)
   describes this flow.
2. Choose **Stream** as the message reception mode. Enter the Client ID in
   `appId` and the Client Secret in `appSecret`.
3. Test direct messages first. In a group, add the bot and mention it; DingTalk
   only delivers the relevant group messages to the bot.

The bridge uses DingTalk Stream/WebSocket for inbound events and platform API
calls for replies. Do not document card or typing-style updates as Maka
capabilities unless a separate bridge implementation adds them.

### QQ

1. Create an official QQ bot in the [QQ bot developer
   portal](https://q.qq.com/qqbot/) and copy its AppID and AppSecret.
2. Enter AppID in `appId` and AppSecret in `appSecret`.
3. Add the bot to a private test scene permitted by the QQ platform, then
   exercise direct, group, or channel messages only where that bot is allowed.

Maka uses QQ's Gateway for inbound events and the platform REST API for sends.
The platform may restrict which scenes are available before review or release;
that platform policy is not a Maka readiness state.

### Feishu and Lark

1. Create an enterprise self-built app in the [Feishu Open
   Platform](https://open.feishu.cn/document/home/index) or [Lark Developer
   site](https://open.larksuite.com/document/home/index).
2. Enable the bot and the event/long-connection capabilities required by the
   provider, then copy the App ID and App Secret into Maka's `appId` and
   `appSecret`.
3. For Lark, set `domain` to `larksuite.com`; keep the default Feishu domain
   for Feishu accounts. Test in a private conversation or development group.

Feishu and Lark share the `feishu` Maka channel. The bridge uses the provider's
official Channel WebSocket. The channel can handle normal replies, but it is
not currently a scheduled-task notification target.

### WeCom

1. Create an AI Bot in the [WeCom developer
   documentation](https://developer.work.weixin.qq.com/), choose API mode with
   a long connection, and copy the Bot ID and Secret.
2. Enter Bot ID in Maka's `appId` and Secret in `appSecret`.
3. Validate with a direct message first, then use a private test group if the
   organization permits the bot there.

Maka uses the official AI Bot WebSocket. The bridge's successful credential
   handshake does not make WeCom a scheduled-task notification target.

### WeChat

WeChat has two bridge paths in the current implementation:

- **Local bridge:** provide the local bridge URL in `webhookUrl` and use the
  bridge's own authentication/configuration contract.
- **iLink:** provide the iLink-compatible base URL in `webhookUrl` and the bot
  token in `token`; `botUserId` may identify the bot in the channel settings.

Use a local test bridge or the provider-approved iLink flow, send a direct text
message, and only then test a group mention. The bridge can classify several
media kinds, but it does not download their bytes for model input.

## Security and privacy

### Every inbound message is untrusted input

An enabled bot channel is an input surface: text from a direct message or a
group conversation becomes agent context. Treat it with the same care as a web
page, tool result, or pasted file. In particular, a message's claimed author,
instructions, links, and attachments do not grant it permission to read files,
run commands, disclose data, or change Maka settings.

The normal Session permission mode and its operating-system execution boundary
remain the authority for agent actions. A bot allowlist narrows who may start a
conversation; it is not a sandbox, an authorization system for tools, or a
substitute for reviewing permission prompts. See the project
[Security Policy](../SECURITY.md) for Maka's trust model and reporting process.

### Keep platform credentials out of the renderer and out of public records

Bot tokens, application IDs and secrets, webhook verification values, device
codes, poll tokens, and raw provider responses are sensitive configuration. Do
not paste them into a chat, issue, pull request, screenshot, test fixture, or
documentation example.

Maka treats the renderer as semi-trusted. Settings reads project masked values;
the renderer must not receive a cleartext bot token or application secret from
main-process settings APIs. Assisted onboarding keeps device-code and polling
credentials in the main-process session and exposes only a renderer-safe
snapshot. These are confidentiality boundaries, not a promise that every
platform's credential is encrypted at rest: the current at-rest protection is
the owner-only local settings store and the user's operating-system account.

When changing a bridge or an onboarding flow:

- redact credential-bearing URLs, headers, request bodies, and provider errors
  before they reach logs or user-facing diagnostics;
- keep the preload IPC surface narrow; renderer code must not gain arbitrary
  HTTP access to a bot provider or an adapter-injection path; and
- use masked placeholders in settings forms to mean "keep the existing value",
  never as a real credential value.

### Restrict who can contact a bot when the deployment needs it

`allowedUserIds` is an optional per-channel allowlist. When it is absent or
empty, the bridge preserves the existing unrestricted behavior. When it is
non-empty, a bridge silently drops messages from other platform-native user
IDs; it does not send a rejection that could help an unauthorized sender probe
the policy. IDs are stored as strings because some platform identifiers exceed
JavaScript's safe integer range.

Configure an allowlist for a personal, development, or otherwise restricted
bot. For a public bot, leave it empty only when the owner intentionally accepts
untrusted messages and has chosen an appropriate Session permission policy.

### Non-text messages are not model attachments

Some bridges can recognize an incoming photo, voice message, document, or
other non-text payload. Recognition is used to send a clear textual notice that
Maka cannot process that content. It does not download the binary, make it
available to the model, or establish a multimodal-input trust boundary.

Documentation and UI must therefore say "non-text message detection" rather
than "file attachment support" unless a platform has an explicit, reviewed
binary-ingestion path.

### Report a suspected vulnerability privately

Do not use a public issue for a leaked credential, missing authentication or
signature verification, an IPC secret-exposure path, or a bypass of a stated
security boundary. Follow the private reporting channel in
[SECURITY.md](../SECURITY.md#reporting-a-vulnerability), including the affected
bridge, a minimal reproduction, and the Maka version or commit.

## Operational status and limitations

The Runtime reports channel health with explicit states rather than a single
boolean: `scaffolded`, `configured`, `credentials_valid`, `operational`, and
`degraded`. A configured channel is not necessarily connected, and a successful
credential check is not proof that an end-to-end reply was delivered. UI and
setup documentation should preserve that distinction.

The current shared Bot contract is text-first:

- text messages can enter a Session and receive a text reply;
- some bridges classify non-text messages so the user receives a helpful
  limitation notice;
- the bridge does not make photos, voice messages, or document bytes available
  to the model; and
- optional features must be described per channel, not inferred from the
  provider's general product capabilities.

Scheduled delivery is also deliberately narrower than channel support. A
bridge can support a live conversation while remaining unavailable as a
scheduled-task notification target. The scheduled-task UI and protocol should
use the six-provider delivery set from the core contract rather than all
configured channels.

## Verification status

This document's capability matrix and configuration overview are source-derived
and were checked against the current provider contract, bridge implementations,
and focused Runtime tests. They are not a record of live credentials or a
promise that every provider account can be created in every region.

### Live smoke check

Feishu (mainland China account, manually configured) was live-tested on
2026-09-10. The channel connected successfully; a direct text message received
one reply; a group text message mentioning Maka received one reply with its
content preserved; and a second group message still received one reply after
Maka was restarted. No credentials, user IDs, or provider payloads were
recorded. This validates normal text conversation and restart recovery only;
the optional capabilities in the matrix remain source-derived.

Discord (mainland China network, manually configured) was live-tested on
2026-09-10 using the Discord web client. A group message mentioning Maka
reached the bridge and the bot sent one reply back to the same Discord channel
with the requested text preserved. The test required a working system-level
TUN route for the Gateway WebSocket. No credentials, user IDs, or provider
payloads were recorded. This validates one normal group-message round trip;
restart recovery, duplicate suppression, and scheduled delivery remain
untested for this live entry.

Telegram (mainland China network, manually configured) was live-tested on
2026-09-10. Direct messages, including `/start` and a text smoke marker,
reached the bridge and the bot sent one reply back with the marker preserved.
No credentials, user IDs, or provider payloads were recorded. This validates
one normal direct-message round trip; restart recovery, group behavior,
duplicate suppression, and scheduled delivery remain untested for this live
entry.

WeChat is currently **source-verified, not live-verified**. The focused tests
cover iLink/local-bridge URL restrictions, QR-login cancellation, message
mapping, media classification, and SSE parsing. They do not exercise a real
iLink `sendmessage` round trip. The current iLink adapter also does not retain
the inbound `context_token` and sends an empty token on outbound replies, so
the reply path needs an implementation fix and a live round-trip check before
WeChat is described as verified. This is an implementation-risk note, not a
claim about provider account restrictions or ban safety.

Any additional live-validation entry should record only whether the
following smoke checks passed, without including credentials or raw provider
payloads:

1. channel configuration reaches the expected readiness state;
2. a direct text message reaches Maka and receives one reply;
3. the bridge does not answer its own echoed message;
4. a restart or reconnect does not duplicate the reply; and
5. scheduled delivery is tested only for platforms in the scheduled-delivery
   set.

Until those checks are performed, use "source-verified" rather than "live
verified" in platform-specific setup documentation.
