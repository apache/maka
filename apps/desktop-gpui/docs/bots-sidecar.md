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

# The bot sidecar

Remote access by chat bot: a message sent to the user's Telegram (飞书/Lark,
企业微信, 微信, Discord, 钉钉, QQ, Slack) bot starts or continues a Session on
the local Runtime Host, and the answer goes back to the chat. Source
references point into the Maka checkout at `$MAKA_REPO` (default
`~/code/maka-pin`).

Maka Desktop runs its bots inside the Electron main process with the plain
Node package `@maka/runtime/bots` (`packages/runtime/src/bots`). This client
runs the same package in a Node sidecar, from the same checkout and with the
same Node it launches the Host with, and keeps only the settings file and the
supervision in Rust (`crates/bots`). A Rust port would be one package per
platform; the sidecar reuses all eight.

## Pieces

| File | What it is |
|---|---|
| `sidecars/bots/main.mjs` | Entry point: arguments, stdio, console redirection, exit |
| `sidecars/bots/sidecar.mjs` | `BotRegistry` and the commands, as `runtime-host-boot.ts` assembles them around `new BotRegistry` |
| `sidecars/bots/incoming.mjs` | Chat to Session routing, a port of `apps/desktop/src/main/bot-incoming-main.ts` |
| `sidecars/bots/onboarding.mjs` | QR onboarding, a port of `bot-onboarding-main.ts`, `qq-bot-scan-login.ts` and `wechat-scan-login.ts` |
| `sidecars/bots/session-adapter.mjs` | Sessions and Turns on the Host, a port of `runtime-host-bot-session-adapter.ts` and the parts of `DesktopRuntimeHostClient` it calls |
| `sidecars/bots/host-link.mjs` | The connection to the local Host, reconnecting |
| `sidecars/bots/telegram-api.mjs` | Watches Telegram's answers for 409 Conflict; the test-only API redirect |
| `sidecars/bots/maka.mjs` | Imports every Maka module from the checkout's `dist` |
| `crates/bots` | Settings file, launch checks, supervisor, `BotService` entity |

Nothing is copied from Maka: `maka.mjs` resolves `@maka/runtime/bots`,
`@maka/core/{bot-events,bot-chat-settings,redaction}`,
`@maka/runtime-host/{client,protocol,adapter}` and `@maka/runtime`'s `undici`
with `createRequire(<checkout>/package.json)`. The routing and the adapter
are ports because they live in Desktop's `apps/desktop/src/main`, which is
not a package; their limits and chat copy are Desktop's (a burst of 8
messages per chat, one more every 5 s; 1000 remembered message ids for an
hour; 500 bound chats; receipts for photos, voice and stickers; `help` and
`reset` in direct chats; Sessions named `Telegram 任务`, labelled `bot` and
the platform, created in `mode: 'bot'` and kept in the explore permission
mode). As in Desktop, the chat bindings are in memory and start over with
each Host connection.

## Running it

`bots::prepare_launch` checks, in order:

1. the Host is local (`BotHost::Local`); a remote Host is refused, as Desktop
   refuses bots for guest profiles;
2. the State Root has its marker (`read_root_id`);
3. no other window or client runs this State Root's bots: an exclusive lock on
   `<config>/maka-gpui/bots/<rootId>.lock`, held by the supervisor;
4. the checkout (`MAKA_REPO`, default `~/code/maka-pin`) has
   `packages/runtime/dist/bots/index.js` (built by `build:workspace-deps`,
   see `dev-host.md`);
5. a Node found as for the Host (`MAKA_NODE`, `node` on `PATH`, nvm).

The sidecar's sources are compiled into the binary and written once per build
to `<cache>/maka-gpui/bots-sidecar/<digest>/`, then run as

```sh
node <cache>/maka-gpui/bots-sidecar/<digest>/main.mjs --maka-repo <checkout> --state-root <root>
```

from the checkout. It connects as a local owner through the Host's published
registration (`connectExistingRuntimeHost`, which writes nothing); the
client's windows start the Host, the sidecar never does. A bot message that
arrives while the Host is away waits up to 30 s for the next connection.

The supervisor (`bots::supervise`) restarts a sidecar that exits, after 1 s
doubling to 60 s (a run of 60 s resets the count), gives it 30 s to report
`ready`, and replays the last settings and workspace to each new one. A
sidecar that reports `fatal`, or cannot be started, is not restarted until
`BotHandle::restart`. On shutdown it sends `shutdown`, closes stdin, and kills
the process after 3 s; a sidecar whose stdin closes (the app died) stops by
itself.

`BotService` (one per State Root, created with the window's workbench) runs
the sidecar while the window's Host is known and a channel is enabled, or
while the Remote access settings page holds it so a channel can be tested
before it is enabled; it stops the sidecar when the last channel is disabled
and the page closes, when the window switches to another State Root, and when
the app quits.

## Settings

`bot-chat.json` in the client's config directory (on macOS
`~/Library/Application Support/maka-gpui/`), 0600 in a 0700 directory, holds
Desktop's `BotChatSettings` shape (`packages/core/src/bot-chat-settings.ts`):
`{ "channels": { "telegram": { "provider", "enabled", "token", ... }, ... } }`.
Tokens are in plaintext, as in Desktop's settings file. The client owns the
file; the sidecar only receives it with `apply_settings` and runs Maka's own
normalization on it (`normalizeBotChatSettings` over the defaults, as
`normalizeSettings` does). A channel test is recorded the way
`settings:testBotChannel` records it (`BotChannelSettings::record_test`) and
the settings are applied again.

Settings › Remote access (`crates/settings/src/bot_chat_page.rs`) edits the
file through `BotService` only, and reads a channel as a `ChannelSummary`:
whether each secret is saved, never the secret. Screenshots reach its places
with `--open-settings bot-chat:<provider>[:manual|:lark|:scan|:bridge]`
(`scan` and `bridge` wait until the sidecar runs; `scan` starts a real
onboarding with the provider).

## Stdio protocol (version 1)

One JSON object per line, UTF-8. The client writes commands to the sidecar's
stdin; the sidecar writes answers and events to stdout and nothing else (the
Maka modules' console output becomes `log` events). stderr is free text the
supervisor logs.

### Commands

Every command has a non-negative integer `id`, answered once:
`{"id": 1, "ok": true, ...fields}` or
`{"id": 1, "ok": false, "error": {"code": "...", "message": "..."}}` with code
`invalid_command`, `unknown_command`, `stopping` or `failed`.

| `command` | Fields | Answer fields | Desktop |
|---|---|---|---|
| `apply_settings` | `settings`: `BotChatSettings` | none | `botRegistry.applySettings` |
| `set_workspace` | `workspace`: `WorkspaceTarget` or `null` | none | `currentDesktopWorkspaceTarget` |
| `test_channel` | `provider`, `channel`: `BotChannelSettings` | `result`: `BotTestResult` | `testBotChannel` |
| `restart_listeners` | `provider` (optional) | `statuses` | `settings:bots:restart` |
| `list_statuses` | none | `statuses` | `settings:bots:listStatuses` |
| `onboarding_start` | `provider`, `brand` (Feishu: `feishu` or `lark`) | `snapshot` | `settings:bots:onboarding:start` |
| `onboarding_poll` | `sessionId` | `snapshot`, and `channel` once, when confirmed | `settings:bots:onboarding:poll` |
| `onboarding_finish` | `sessionId` | `snapshot` | the end of `persistCredential` |
| `onboarding_cancel` | `sessionId` | `snapshot` | `settings:bots:onboarding:cancel` |
| `onboarding_url` | `sessionId` | `url` (HTTPS) | `settings:bots:onboarding:open` |
| `wechat_bridge_qr` | `channel`: the WeChat `BotChannelSettings` | `result`: `WechatBridgeQrCodeResult` | `settings:bots:wechatQrCode` |
| `shutdown` | none | none, then exit 0 | `botRegistry.stopAll` |

`statuses` is an array in `BOT_PROVIDERS` order of `{ "status": BotStatus,
"conflict"?: Conflict }`. Until `set_workspace` names one, a bot message is
answered with Desktop's error notice ("Select a project from the Runtime Host
first").

## QR onboarding

钉钉, 飞书/Lark, 企业微信, 微信 (iLink) and QQ can be set up by scanning a code
instead of pasting credentials, as in Desktop's `BotOnboardingService`: the
same endpoints, poll intervals (the provider's, clamped to 1–30 s; +5 s on
`slow_down`), expiry (the provider's, else 10 minutes; DingTalk 2 hours), and
up to five transient failures in a row (timeouts, network errors, 5xx, 429)
retried with 2 s more backoff each before the session fails. A `snapshot` is
Desktop's `BotOnboardingSnapshot` with `qr` in place of the rendered
`qrCodeDataUrl`, on the first snapshot only: `{"text": "<what the code
encodes>"}` or `{"image": "data:image/..."}` when the provider sends an image
(WeChat may); the client draws it. Device codes and credentials never appear
in a snapshot.

The sidecar saves nothing. The poll that sees the scan confirmed answers with
`channel` too: the fields Desktop's `channelPatchFromCredential` writes
(`enabled`, `readiness: "configured"`, the app id and secret, or WeChat's bot
token and iLink base URL). `BotService::poll_onboarding` writes them to
`bot-chat.json`, sends `apply_settings`, and then `onboarding_finish`, which
reads the channel's status as Desktop's `connectionWarning` does: `connected`,
with `warningCode: "saved_not_connected"` and the redacted reason when the
listener is not running. A session cancelled while its confirmation was on the
way saves nothing (Desktop rolls such a write back instead). All requests go
through `proxiedFetch`, WeChat's too, where Desktop uses Electron's session
fetch.

### Events

| `event` | Fields | When |
|---|---|---|
| `ready` | `protocol` (1), `compatibilityEpoch` (the checkout's), `pid` | The modules loaded; commands are accepted |
| `fatal` | `code` (`invalid_arguments`, `checkout_unavailable`), `message` | Before exiting with status 2; retrying cannot help |
| `status` | `status`: `BotStatus`, `conflict`? | A bridge changed state (`onStatusChange`) |
| `host` | `state`: `connected` with `rootId`, `hostEpoch`; or `disconnected` with `reason` | The Host connection changed |
| `log` | `level` (`info`, `warn`, `error`), `message` | Anything logged |

`BotStatus` is `packages/runtime/src/bots/types.ts`'s: `platform`, `running`
(the receive loop only), `readiness` (`scaffolded`, `configured`,
`credentials_valid`, `operational`, `degraded`), `reason` (a stable code),
`startedAt`, `lastEventAt`, `connection`, `identity`.

A smoke run against a 197 Host (abridged):

```text
> {"id":1,"command":"list_statuses"}
< {"event":"ready","protocol":1,"compatibilityEpoch":197,"pid":52953}
< {"id":1,"ok":true,"statuses":[{"status":{"platform":"telegram","running":false,"readiness":"scaffolded","reason":"disabled","connection":"none"}},...]}
< {"event":"host","state":"connected","rootId":"7af36cde…","hostEpoch":"fce3961e-…"}
> {"id":4,"command":"shutdown"}
< {"event":"host","state":"disconnected","reason":"stopped"}
< {"id":4,"ok":true}
```

## Telegram conflicts

Telegram answers `getUpdates` with 409 Conflict when another process polls the
same token, or when the bot has a webhook. The bridge only waits 5 s and polls
again (`pollTelegram`), so Desktop and this client on one token would take
turns receiving messages, each answering some of them in its own Session,
with no sign of it. The sidecar watches undici's diagnostics channels (which
see the bridges' requests without changing them), and on the first 409 stops
its Telegram channel and reports it with a `conflict`:
`{ "kind": "polling" | "webhook", "description": Telegram's text, "detectedAt" }`.
The other client keeps the bot. `restart_listeners` for the channel, or new
credentials in `apply_settings`, try again. Other platforms have no such
signal.

## Tests

- `node --test 'sidecars/bots/test/*.test.mjs'` (with `MAKA_REPO` set to a built
  checkout): routing (redelivery, the burst limit and refill, chat to Session
  reuse, receipts, reset, rebinding, errors), the adapter (create input,
  explore, delta folding, revision retry), the conflict handling against
  the real Telegram bridge and `test/fake-telegram.mjs`, and the onboarding of
  every QR provider against `test/fake-onboarding.mjs` (requests, polling,
  expiry, slow-down, retries, cancellation, the handed-over channel).
  `cargo test -p bots --test sidecar_node` runs them when a built checkout and
  Node are there.
- `cargo test -p bots`: the settings file, the protocol lines, the lock, the
  launch checks, the supervisor against `tests/fixtures/fake-sidecar.sh`, and
  `BotService` against a scripted supervisor and `bots::testing::FakeSidecar`
  (feature `test-support`, which the settings page's tests use too): when it
  runs a sidecar, the channel test, and the onboarding's save.
- The live test, ignored by default:

  ```sh
  MAKA_REPO=~/code/maka-pin cargo test -p bots --test real_telegram -- --ignored --nocapture
  ```

  It serves a Host on a fresh State Root under `target/tmp` with `HOME` set to
  an empty folder there and provider keys removed, points a model connection
  at `scripts/demo-model.py` on a free port, runs the sidecar with
  `MAKA_BOTS_TELEGRAM_API_ORIGIN` at the fake Bot API, sends one private-chat
  message, and checks the threaded reply and the `bot`/`telegram` Session.

The bridge has no setting for the Bot API base URL (`telegramApi` in
`telegram-bridge.ts` and `testTelegram` in `bot-test.ts` write
`https://api.telegram.org` inline), so `MAKA_BOTS_TELEGRAM_API_ORIGIN`
redirects that origin inside the sidecar through undici's global dispatcher.
It accepts only `http://` on a loopback address, so it cannot send a token off
the machine.

## Not here yet

- **Scheduled-task delivery to a bot.** Desktop registers the client
  capability service `maka_scheduled_task_native_effect` version `1` next to
  its other client services (`additionalServices` in `runtime-host-boot.ts`);
  the Host's scheduled-task coordinator calls it with `notify_bot`
  (`platform`, `chatId`, `title`, `body`) or `notify_local`, and marks a task
  `waiting_for_provider` while no connection offers it. For the sidecar to
  deliver, it would call `connection.replaceClientCapabilities` with a
  provider that offers this one service, answer `notify_bot` with
  `botRegistry.sendMessage(platform, chatId, "【定时任务】<title>\n\n<body>")`
  (failing when that returns null), and register again after every
  reconnect. The Host sends each call to the provider with the lowest provider
  id among those offering the contract (`callWorkspaceService` in
  `client-capability-coordinator.ts`), and one service carries both methods,
  so the sidecar would have to own `notify_local` too and forward it to the
  client as a new event, or the client would need its own capability channel
  (class B in `docs/plan/phase-3-parity.md`) and the sidecar would forward
  `notify_bot` to it.
- The user's network proxy: Desktop's bridges read `resolveActiveProxy()`,
  which nothing in Desktop's main process sets at this pin, so neither does
  the sidecar.
