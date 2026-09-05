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

**An empty cell means Maka does not implement the capability on that platform.
It does not mean the platform cannot do it.** The WeCom AI Bot SDK, for
instance, ships streaming replies (`replyStream`), media upload
(`uploadMedia`) and template cards; the bridge wires up none of them and sends
plain markdown only. Treat the blanks as a map of unwired surface area, not as
a statement about the vendors.

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

> **Status: Telegram, Feishu/Lark, WeCom and QQ are verified end-to-end. The
> rest are placeholders.** Each remaining section must be walked against a real
> developer account before it lands — the acceptance criteria require tested
> instructions, and untested setup steps are worse than none.
>
> For DingTalk and WeChat, check
> [the onboarding architecture doc](architecture/bot-onboarding-runtime.zh-CN.md)
> first: QR-code onboarding may make most manual steps unnecessary.

Each platform section should cover: where to register, which console fields map
to which Maka setting (see the credentials table above), the minimum scopes or
intents required, how to invite the bot to a chat, and how to confirm the
channel reports `operational`.

### Telegram

The simplest channel to set up, and the most capable one: Telegram is the only
platform where every optional capability in the matrix is implemented.

**1. Create the bot.** Message [@BotFather](https://t.me/BotFather) and send
`/newbot`. It asks for a display name and then a username, which must be
globally unique and end in `bot`. BotFather replies with a token shaped
`<bot_id>:<secret>` — that whole string is Maka's `token`. It is the only
credential this channel takes.

**2. Open the conversation from the user side.** A bot cannot start a chat.
Open `https://t.me/<your_bot_username>`, press **Start**, and send a message.
`getUpdates` only returns messages sent after the bot exists, so until someone
messages it first the channel receives nothing — which looks identical to a
broken connection.

**3. Set a proxy if Telegram is not directly reachable.** The channel's
`proxyUrl` is used for every Bot API call through `proxiedFetch`. Without it,
startup fails at the network layer rather than with an API error.

**4. Verify.** Startup calls `getMe`. Success records the bot's ID, username
and display name, and moves the channel to `credentials_valid` — deliberately
*not* `operational`, because `getMe` proves credentials and reachability but is
not a send/receive smoke test. The channel reaches `operational` on the first
real message. A rejected token surfaces Telegram's own `description` as the
status reason.

**Group messages are invisible by default.** A fresh bot reports
`can_read_all_group_messages: false` — Telegram's privacy mode. In groups it
therefore sees only commands and messages that @-mention it. To let a bot read
all group traffic, disable privacy mode via BotFather (`/setprivacy`) and
re-add the bot to the group; the setting applies from the next join. Direct
chats are unaffected.

**Only `message` updates are requested.** The poll passes
`allowed_updates: ['message']`, so edited messages, callback queries, channel
posts and every other update type are never delivered, regardless of what the
bot is capable of.

**Streaming replies work, in private chats only.** `startReplyStream` returns
`null` when the target is a group, so a group reply always arrives as one final
message. In private chats the bridge drives Telegram's native draft mechanism
(`sendMessageDraft`), which was confirmed available to an ordinary BotFather
bot. If a draft call ever fails the stream latches `nativeDraftAvailable` off
and silently degrades to a single final message, so a bot that stops streaming
mid-session is failing quietly rather than erroring.

**Message limits.** Text is split at 4000 UTF-16 code units per message,
measured in UTF-16 rather than JavaScript string length because Telegram counts
entities that way. Ephemeral replies are clamped between 1 second and 48 hours;
Telegram will not let a bot delete its own direct messages past that window, so
a longer TTL would silently no-op.

`allowedUserIds` holds numeric Telegram user IDs kept as strings, since they
are 64-bit and lose precision as JavaScript numbers.

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

Maka's WeCom channel is the **智能机器人 / AI Bot**, driven through the official
`@wecom/aibot-node-sdk` over a WebSocket long connection. It is **not** a
自建应用 (custom app) and **not** a 群机器人 webhook. The distinction decides
every step below: a custom app would need a corp ID and agent ID, and
`BotChannelSettings` has no field for either.

**1. Create the bot in API mode.** In the WeCom admin console, create a
智能机器人 and choose **API 模式** — *"连接企业自有系统或智能体"*. Do **not**
choose 普通模式 (*"使用企业微信提供的模型与数据"*), and do not use the
one-sentence AI-assisted creation flow, which produces a 普通模式 bot.

In 普通模式 the conversation is answered by WeCom's own hosted models, so
messages are consumed on their side and never reach the long connection. Maka
is the "企业自有系统" that API 模式 exists to connect.

**2. Set 可见范围 / Visibility.** Add the users who will talk to the bot. A
newly created bot has an empty visibility range and cannot be found in the
client.

**3. Copy the credentials.**

| Console field | Maka setting |
| --- | --- |
| Bot ID | `appId` |
| Secret | `appSecret` |

**4. Configure the channel in Maka.** There is nothing else to fill in — no
callback URL, no token, no encoding key. The SDK dials
`wss://openws.work.weixin.qq.com` and authenticates by sending Bot ID and
Secret once the socket is open.

**5. Verify.** A successful handshake moves the channel to
`credentials_valid`. Note that it does **not** go straight to `operational` —
WeCom only reaches `operational` after the first message is actually sent or
received.

Failure reasons distinguish the cases: `no-credentials` means `appId` or
`appSecret` is empty, and an authentication failure leaves readiness at
`configured`. The handshake has a 15-second timeout.

**Addressing replies.** WeCom has no stable per-chat identifier for direct
messages. An inbound single-chat frame carries `chattype: "single"` and **no**
`chatid` at all, so the bridge falls back to the sender's `userid` as the chat
ID; group frames carry a real `chatid`. Consequently a WeCom conversation
cannot be addressed until the bot has received a message in it — there is no
way to open a chat proactively the way Feishu allows.

`allowedUserIds` for this channel holds WeCom user IDs, which are ordinarily
human-readable account names rather than opaque tokens.

Sends return a `req_id`, not a message ID. Nothing in the API accepts that
value as a reply target, which is why this channel has no reply threading.

> **Private deployments are not supported.** The SDK's built-in endpoint is
> fixed, and privately deployed WeCom organizations must use their own
> long-connection address. The bridge exposes no way to override it.

> **The credential test cannot prove WeCom credentials.** Maka's in-app probe
> checks shape only and reports `verified: false`. The sole real check is
> completing the WebSocket handshake, so treat a "passing" WeCom credential
> test as unproven until the channel actually connects.

### WeChat 微信

_TODO — iLink bot plus the local companion bridge on 127.0.0.1._

### QQ

The QQ bridge speaks the gateway protocol directly — no vendor SDK — and
shares its opcode lifecycle with Discord through `GatewayBridgeBase`.

**1. Create the bot** on the QQ open platform and open its credentials page.

| Console field | Maka setting |
| --- | --- |
| AppID | `appId` |
| AppSecret | `appSecret` |
| Token | *unused* |

The console also issues a **Token**. Maka never reads it: that value belongs to
the webhook callback mode, and this bridge authenticates by exchanging AppID
and AppSecret for an app access token instead.

**2. Configure the channel in Maka.** `appId` and `appSecret` are the only
inputs. Startup then runs three steps, and the status reason names whichever
one fails:

1. `POST bots.qq.com/app/getAppAccessToken` → app access token, cached and
   refreshed 5 minutes before expiry. Failure reason: `getAppAccessToken-<status>`.
2. `GET api.sgroup.qq.com/gateway/bot` → the gateway URL. Failure reason:
   `gateway-bot-<status>`.
3. WebSocket connect, then IDENTIFY. Success arrives as a `READY` dispatch
   carrying the bot's ID and username, which promotes the channel to
   `operational`.

**3. Grant the intents.** The bridge requests a fixed mask of `1107300353` —
`GUILDS | DIRECT_MESSAGE | PUBLIC_GUILD_MESSAGES | PUBLIC_MESSAGES`. This is
not configurable. Two close codes are treated as **fatal**, meaning the bridge
stops rather than retrying:

- **4014** — disallowed intent: the console has not granted something in that
  mask.
- **4004** — authentication failed: AppID/AppSecret rejected.

Any other close code reconnects with backoff, so a channel that dies
immediately and stays dead is almost always one of these two.

**Conversation addressing.** QQ is the only platform whose chat IDs carry a
prefix, because its four conversation kinds route to four different REST
endpoints:

| Inbound dispatch | `chatId` stamped | Send route |
| --- | --- | --- |
| `AT_MESSAGE_CREATE` | `channel:<channel_id>` | `/channels/{id}/messages` |
| `DIRECT_MESSAGE_CREATE` | `dm:channel:<channel_id>` | `/channels/{id}/messages` |
| `GROUP_AT_MESSAGE_CREATE` | `group:<group_openid>` | `/v2/groups/{id}/messages` |
| `C2C_MESSAGE_CREATE` | `c2c:<user_openid>` | `/v2/users/{id}/messages` |

A chat ID without one of those prefixes cannot be routed and the send returns
`null` without any network call.

**Guild and group messages require an @-mention.** Only `AT_MESSAGE_CREATE` and
`GROUP_AT_MESSAGE_CREATE` are delivered, so the bot never sees ordinary group
chatter. Direct conversations arrive unprompted.

**Identity is an opaque, bot-scoped openid.** Group and C2C payloads carry no
display name at all, so the bridge falls back to using the openid as the user
name. Expect user IDs like `404C6F91…` rather than anything human-readable, and
note that the same person has a different openid under a different bot.

Typing indicators work **only** for `channel:` chat IDs. Groups and C2C run on
a different messaging stack with no typing endpoint, so the bridge gates on the
prefix and returns `false` rather than emitting a confusing 404.

> **There is no sandbox switch.** The API host is hardcoded to production
> (`api.sgroup.qq.com`). A bot still confined to the sandbox environment cannot
> be exercised through this channel.

## Verifying a channel

The app runs a per-platform credential probe (`bot-test.ts`) covering all eight
providers. A successful probe returns the bot identity and a capability map; a
failure returns an error plus a hint. WeCom is the one platform whose probe
cannot reach a live endpoint, and it reports `verified: false` to say so.

To confirm the bridge layer itself after a change:

```bash
npm run test -- packages/runtime/src/bots
```
