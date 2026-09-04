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

# Bot platform support

Maka connects to instant-messaging platforms through bot bridges in
`packages/runtime/src/bots/`. This page is the support matrix: which platforms
exist, what each one can do, what credentials it needs, and where the gaps are.

Code is the authority. Every capability claim below is stated as the method or
constant that backs it, so a reader can re-derive the table from the tree when
this page drifts.

Related:

- [IM 扫码接入 runtime architecture](architecture/bot-onboarding-runtime.zh-CN.md) —
  the QR-code onboarding flow for DingTalk, Feishu/Lark, WeCom and WeChat,
  including registration endpoints and credential mapping.
- `packages/runtime/src/bots/__tests__/` — contract tests for the behaviors
  described here.

## Supported platforms

Eight providers are registered in `BOT_PROVIDERS`
(`packages/core/src/bot-chat-settings.ts`):

| Provider key | Platform | Bridge |
| --- | --- | --- |
| `telegram` | Telegram | `telegram-bridge.ts` |
| `slack` | Slack | `slack-bridge.ts` |
| `discord` | Discord | `discord-bridge.ts` |
| `dingtalk` | 钉钉 DingTalk | `dingtalk-bridge.ts` |
| `feishu` | 飞书 Feishu **and** Lark | `feishu-bridge.ts` |
| `wecom` | 企业微信 WeCom | `wecom-bridge.ts` |
| `wechat` | 微信 WeChat | `wechat-bridge.ts` |
| `qq` | QQ | `qq-bridge.ts` |

Feishu and Lark share the single `feishu` channel; the account region is
selected by the `domain` setting (`feishu.cn` vs `larksuite.com`) rather than by
a separate provider. Counting them separately yields the "9 platforms" figure
seen elsewhere, but there are eight channels to configure.

## Maturity model

Channel maturity is not prose — it is the `BotReadinessState` enum
(`packages/core/src/bot-chat-settings.ts`), reported per channel in
`BotStatus.readiness`:

| State | Meaning |
| --- | --- |
| `unscaffolded` | No bridge for this provider. |
| `scaffolded` | Bridge exists; channel disabled or credentials missing. |
| `configured` | Credentials present, not yet proven against the platform. |
| `credentials_valid` | Credentials probed successfully. |
| `operational` | Bridge connected and serving traffic. |
| `degraded` | Was connected, currently retrying. |

All eight bridges reach `operational`. Readiness is per-install runtime state,
so it is not a static per-platform grade: use it to judge a deployment, not the
maturity of the code.

`BotStatus.running` reflects only the polling/connection loop and is explicitly
not readiness — see the doc comment on `BotStatus.running` in `types.ts`.

## Feature matrix

Optional capabilities are declared as optional methods on `SendCapable`
(`types.ts`) and dispatched defensively by `BotRegistry`: an unimplemented
method degrades to a no-op or `false` rather than throwing, so a caller never
needs to branch on platform.

| Capability | telegram | slack | discord | dingtalk | feishu | wecom | wechat | qq |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Send text (`sendMessage`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Streaming reply (`startReplyStream`) | ✅ | — | — | — | — | — | — | — |
| Typing indicator (`sendTypingIndicator`) | ✅ | — | ✅ | — | — | — | — | ✅ |
| Reply threading (`replyToMessageId`) | ✅ | ✅ | ✅ | — | ✅ | — | — | ✅ |
| Ephemeral auto-delete (`ephemeralTtlMs`) | ✅ | — | — | — | — | — | — | — |
| Inbound attachment kind | ✅ | — | — | — | — | — | ✅ | — |
| Outbound file attachments | — | — | — | — | — | — | — | — |
| Send retry/backoff | ✅ | — | ✅ | ✅ | — | — | — | ✅ |
| User allowlist enforced | ✅ | — | — | — | ✅ | ✅ | — | — |
| Scheduled-task delivery | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | ✅ |

Notes on individual rows:

- **Streaming reply** is Telegram-only. `BotRegistry.startReplyStream` returns
  `null` for every other platform, and callers fall back to a single terminal
  message.
- **Typing indicator** is one-shot and decorative. It returns `false` rather
  than throwing on unsupported platforms, and Telegram clears it after roughly
  five seconds, so sustained indication requires repeated calls.
- **Reply threading** applies to the first chunk only. A long reply split
  across several messages threads its head under the user's message and sends
  the remainder as ordinary sequential messages, so one answer does not fork
  into N replies under the same parent (see `BotSendOptions` in `types.ts`).
- **Outbound file attachments are not supported on any platform.** `SendCapable`
  carries text only. Telegram and WeChat classify *inbound* attachments into a
  `BotAttachmentKind` (`photo`, `voice`, `sticker`, `document`, `video`,
  `audio`, `animation`, `unknown`) so the handler can react to them; the other
  six bridges do not surface attachment metadata at all.
- **Scheduled-task delivery** is gated by `BOT_DELIVERY_PROVIDERS`. Feishu and
  WeCom are excluded from that list, and `scheduled-task-coordinator.ts`
  rejects any bot-channel task whose platform fails `isBotDeliveryProvider`, so
  scheduled tasks cannot target them.

## Transport and connection

`BotStatus.connection` reports the transport, from `connectionKind()` on
`BaseBotAdapter` and the per-bridge overrides:

| Platform | `connection` | Protocol |
| --- | --- | --- |
| telegram | `polling` | Bot API long polling |
| slack | `gateway` | Socket Mode WebSocket |
| discord | `gateway` | Discord gateway opcodes via `GatewayBridgeBase` |
| qq | `gateway` | QQ gateway; identical opcode set to Discord |
| dingtalk | `gateway` | DingTalk Stream WebSocket via `WsBridgeBase` |
| feishu | `gateway` | Lark SDK WebSocket channel |
| wecom | `gateway` | WeCom AI-bot WebSocket |
| wechat | `gateway` | HTTP streaming loops (local bridge + iLink) |

No bridge currently uses the `webhook` connection kind, even though `BotStatus`
allows it — every platform is driven by an outbound connection from the
runtime, so none of them requires a public inbound URL.

Discord and QQ share `GatewayBridgeBase` verbatim: HELLO/HEARTBEAT/DISPATCH
opcode dispatch, jittered heartbeats, missed-ack reconnect, and identify-vs-
resume selection. They differ only in the gateway URL fetch, the identify
payload shape, and event mapping.

Reconnect backoff is shared by every WebSocket bridge: exponential from
`RECONNECT_DELAY_MIN_MS` (1s) to `RECONNECT_DELAY_MAX_MS` (30s) in
`ws-bridge-base.ts`. Send retry, where implemented, is capped at 30s.

WeChat is the outlier. It runs two streaming loops, one of which talks to a
**local companion bridge process** that must be reachable at
`http://127.0.0.1:18400` (or another localhost URL). `normalizeWechatBridgeUrl`
rejects anything that is not plain `http:` on `127.0.0.1`, `localhost` or
`[::1]`, and rejects URLs longer than 256 characters.

## Credentials per platform

These are the fields each bridge actually reads from `BotChannelSettings`.
Field names are generic across providers, so the mapping matters:

| Platform | `token` | `appId` | `appSecret` | Other |
| --- | --- | --- | --- | --- |
| telegram | Bot token from BotFather | — | — | — |
| discord | Bot token | — | — | — |
| slack | Bot User OAuth token (`xoxb-`) | — | **App-level token (`xapp-`)** | — |
| dingtalk | — | ClientID | ClientSecret | — |
| feishu | Fallback for `appSecret` | App ID | App Secret | `domain` picks Feishu vs Lark |
| wecom | — | Bot ID | Secret | — |
| qq | — | App ID | App Secret | — |
| wechat | Bot token | — | — | `webhookUrl` = local bridge URL |

⚠️ Feishu reads `appSecret` **or**, when that is empty, `token` — the two are
interchangeable for this channel, and only one needs to be set. Feishu does not
take three distinct credentials.

⚠️ Slack's `appSecret` holds the **app-level token** used for Socket Mode —
`SlackBotBridge.start()` reads it as `appToken` — not the signing secret. The
field name invites the wrong value.

Changing `enabled`, `token`, `appId`, `appSecret`, `domain` or `webhookUrl`
restarts the bridge; any other settings change is applied in place
(`botSettingsRequireRestart` in `base-adapter.ts`).

Every channel supports `proxyUrl`, and all outbound HTTP goes through
`proxiedFetch`, which honors the active proxy and its bypass list with a 15s
default timeout.

## Message limits

| Platform | Limit | Behavior |
| --- | --- | --- |
| telegram | 4000 UTF-16 units per message | Split into chunks, first chunk threaded |
| discord | 2000 characters per message | Split into chunks |

Other bridges do not declare an explicit chunking constant; they send the text
as one message and surface any platform-side rejection as a send error.

Telegram's limit is measured in UTF-16 code units rather than JavaScript string
length, because Telegram counts entities that way — see
`__tests__/telegram-utf16.test.ts`.

Telegram's ephemeral TTL is clamped to a 1s floor and a 48-hour ceiling.
Telegram does not let a bot delete its own direct messages past 48 hours, so a
longer schedule would silently no-op.

## Known limitations

1. **Streaming replies are Telegram-only.** Every other platform delivers the
   answer as one terminal message.
2. **The user allowlist is enforced by three bridges.** `allowedUserIds` is
   checked in Telegram, Feishu and WeCom. Discord, QQ, DingTalk, Slack and
   WeChat do not consult it — configuring an allowlist on those channels does
   not restrict who can talk to the bot. See the security section.
3. **Scheduled tasks cannot target Feishu or WeCom** (`BOT_DELIVERY_PROVIDERS`).
4. **No platform can send files.** Text out only.
5. **WeChat requires a local companion bridge** on localhost; it cannot run
   against a remote bridge host.
6. **WeCom credentials cannot be pre-verified.** The credential test validates
   shape and non-emptiness only and returns `verified: false`, because the SDK
   proves the credentials only through a WebSocket auth handshake (see
   `BotTestResult.verified` in `types.ts` and the WeCom branch of
   `bot-test.ts`). Callers must not downgrade a working WeCom channel on the
   strength of that probe.
7. **One account per provider.** Onboarding runs a single session per provider;
   there is no multi-account or parallel-onboarding support.

## Security considerations

**Allowlist gaps.** Where `allowedUserIds` is enforced, an unauthorized inbound
message is dropped silently — no acknowledgement is sent back, so a scanner
cannot use bounce behavior to enumerate the bot's policy (`types.ts` on
`allowedUserIds`). On the five bridges that do not enforce it, any user who can
reach the bot can drive it; restrict access at the platform level instead
(private server, closed workspace, internal-only app).

**Allowlist IDs are strings.** Telegram user IDs are 64-bit and lose precision
as JavaScript numbers, so IDs are stored and compared as strings.

**Credential storage.** Credentials live in the owner-only settings store. The
renderer receives masked values and never sees the secret. At-rest Keychain
encryption is *not* implemented yet — it is listed as a follow-up in the
onboarding architecture doc.

**Error redaction.** Bridge errors pass through `generalizedErrorMessage` before
being logged or surfaced, so tokens embedded in provider error strings are not
written to logs.

**No inbound webhooks.** Because every bridge dials out, no bot channel requires
opening a public inbound endpoint, and there is no webhook signature to verify.
WeChat's `webhookUrl` is a *local* bridge address, not a public callback.

**Outbound requests are proxy-aware.** All bridge HTTP flows through
`proxiedFetch`, so an egress proxy configured for the app also covers bot
traffic.

## Setup

> **Status: Feishu/Lark is verified end-to-end. The rest are placeholders.**
> Each remaining section must be walked against a real developer account before
> it lands — the acceptance criteria require tested instructions, and untested
> setup steps are worse than none.
>
> For DingTalk, WeCom and WeChat, check
> [the onboarding architecture doc](architecture/bot-onboarding-runtime.zh-CN.md)
> first: QR-code onboarding may make most manual steps unnecessary.

Each platform section should cover: where to register, which console fields map
to which Maka setting (see the credentials table above), the minimum scopes or
intents required, how to invite the bot to a chat, and how to confirm the
channel reports `operational`.

### Telegram

_TODO — register via BotFather, single `token`._

### Discord

_TODO — developer portal application, bot token, gateway intents._

### Slack

_TODO — Socket Mode app; note the two distinct tokens (`xoxb-` and `xapp-`)._

### DingTalk 钉钉

_TODO — internal app, Stream mode, ClientID/ClientSecret._

### Feishu 飞书 / Lark

Maka's Feishu channel opens a **WebSocket long connection** from the runtime
(`transport: 'websocket'` in `feishu-bridge.ts`). There is no public callback
URL to expose and no inbound port to open, so this works from a laptop behind
NAT. The console must be configured for long-connection event delivery, not for
webhook delivery.

**1. Create a custom app.** Open the developer console —
[open.feishu.cn](https://open.feishu.cn/) for Feishu, or
[open.larksuite.com](https://open.larksuite.com/) for Lark — and create a
*企业自建应用 / Custom app*. From the app's credentials page, copy:

| Console field | Maka setting |
| --- | --- |
| App ID (`cli_…`) | `appId` |
| App Secret | `appSecret` |

Feishu and Lark are separate consoles with separate accounts. Create the app in
the console matching the account you will actually chat from.

**2. Add the bot capability.** *添加应用能力 / Add features* → *机器人 / Bot*.
Without this the app has no chat identity and no message can be sent or
received.

**3. Grant the permission scopes.** At minimum, to receive direct messages:

- `im:message.p2p_msg:readonly` — required for `im.message.receive_v1`.

Group chats and outbound sending need their own scopes; grant the message-send
scope for the bot, and the group-message read scope if the bot will serve group
chats rather than DMs only.

**4. Subscribe to events over the long connection.** *事件与回调 / Events &
callbacks* → set the delivery mode to *长连接 / Long connection* (**not**
*将事件发送至开发者服务器 / Send to developer server*), then add the event:

- `im.message.receive_v1` — 接收消息 / Receive message.

**5. Publish a version.** *版本管理与发布 / Version management & release*.
Scopes and event subscriptions do not take effect for a tenant until a released
version is approved, and the *可用范围 / Availability* of that version must
include the users who will talk to the bot.

**6. Configure the channel in Maka.** Enter `appId` and `appSecret`. Leave
`domain` empty for Feishu; set it to `larksuite.com` for Lark — the bridge
selects `Domain.Lark` only on that exact string and falls back to
`Domain.Feishu` otherwise, so a typo silently points a Lark app at the Feishu
endpoint.

Optionally set `allowedUserIds` to the open IDs (`ou_…`) permitted to use the
bot. Feishu is one of the three platforms that enforce this list. Note that the
Lark SDK's own policy gate only covers DMs, so the bridge re-checks the
allowlist locally to catch group messages too.

**7. Verify.** The channel should reach `operational`. If it does not, the
reason string on the status distinguishes the failure:
`missing-feishu-credentials` means `appId` or `appSecret`/`token` is empty,
while a handshake failure leaves readiness at `configured` with the underlying
error as the reason.

> **A connected channel does not mean a reachable bot.** The long connection
> handshake succeeds using app credentials alone. If the app version has not
> been released, or the availability range excludes you, the channel reports a
> healthy connection while no user can find the bot to message it — the bridge
> simply receives nothing. When a channel looks connected but silent, check the
> release status before debugging the runtime.
>
> The quickest way out of that state is to have the bot open the conversation
> itself: sending a direct message to a user's open ID creates the P2P chat and
> makes it appear in that user's client.

### WeCom 企业微信

_TODO — AI bot, Bot ID and Secret; note the unverifiable credential test._

### WeChat 微信

_TODO — iLink bot plus the local companion bridge on 127.0.0.1._

### QQ

_TODO — QQ open platform app, App ID and App Secret._

## Verifying a channel

The app runs a per-platform credential probe (`bot-test.ts`) covering all eight
providers. A successful probe returns the bot identity and a capability map; a
failure returns an error plus a hint. WeCom is the one platform whose probe
cannot reach a live endpoint, and it reports `verified: false` to say so.

To confirm the bridge layer itself after a change:

```bash
npm run test -- packages/runtime/src/bots
```
