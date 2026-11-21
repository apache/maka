Verification refresh of @cometee's fix (Haoyang Wu, author unchanged) on current `main` (`6f3e7662`) — refreshed, not redesigned: same patch, rebased with two conflicts resolved to keep both sides (`CodexSeals` beside the `ultra`-carrying `CodexTiers`; the docs table row).

What the patch adds is still missing from `main`: routing already reads Ultrafast from any Codex account's list (`UltraModels`, #1954), but the list magpie hands Codex itself (`/v1/codex/models`, `models.json`) builds its tiers from the entry of the one account Codex last fetched with — sign in with an account without Ultrafast and the tier drops off every account's model.

**Red without the fix** (bare `6f3e7662`, the tests from the branch): `TestUltrafastOfferedPastTheSignedInAccountsCache` (internal/codexcat) fails on the cache-copied entry; `TestCodexTiersOfferUltrafastAnAccountHas` (internal/provider) calls the branch's 4-arg `CodexTiers`, so on the base it was run against the baseline signature with the same five assertions — it fails as the branch's commit message quotes:

```
an account's model offered [priority], want priority and ultrafast
```

With the patch: both `ok`.

**Verification** (all on `6f3e7662`, darwin/arm64):
| What | Result |
| --- | --- |
| `go test ./internal/provider -run TestCodexTiersOfferUltrafastAnAccountHas` | ok |
| `go test ./internal/codexcat -run TestUltrafastOfferedPastTheSignedInAccountsCache` | ok |
| full `go test ./internal/provider ./internal/codexcat` | ok (157.5s / 2.3s), zero failures |
| `go test -race` (both packages) | one failure, `TestSignInDoneOnceTheAccountIsBack` — red under `-race` on the bare base too (timing); nothing new |
| `gofmt` / `go vet` | clean |
| `GOOS=linux/windows go build -tags nogui` | ok |
| ablation (the `withUltrafast(e)` call dropped from the cache copy, tests kept) | red again; restored, green |
| `git am` on detached `6f3e7662` | applies as is; tree identical to the branch head |

**Siblings**: `CodexTiers`' two callers (`agent/route.go:438`, `codex_models.go:944`) both carry the `ultra` argument; the routing-side readers of `UltraModels`/`UltraOn` (`gateway/codex_tier.go`, `agent/route.go`, `fastpick.go`) are upstream's own (#1954) and untouched — this patch fills the listing side they already assume.

**Branch with the commit**: [hunt-20261111-rf-4034](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-4034) (head `bfe0cc56beaa1139`).

**Not verified**: a real ChatGPT account pair (one with, one without Ultrafast) — the reporter's shapes are pinned by the two tests.

**Attribution**: patch by Haoyang Wu (@cometee), verification refreshed by AI-written tooling; please keep the author (`Haoyang Wu`) or add them as `Co-authored-by`.

**Patch**: <details><summary>patch: codex: an account's model is offered Ultrafast past the signed-in account's cache (#4034, author Haoyang Wu) — git am applies it as is; SHA-256 first 16: e69994f58264a719</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Haoyang Wu <riafmz@gmail.com>
Date: Wed, 28 Oct 2026 17:17:43 +0800
Subject: [PATCH] codex: an account's model is offered Ultrafast past the
 signed-in account's cache

Codex is offered `ultrafast` on a ChatGPT account's model when one of
Codex's accounts lists it there (`UltraOn` over `UltraModels`), not only
when the account Codex last fetched its catalog with did: that cache was
the only source, so signing Codex in with an account without Ultrafast
took it off every account's model, and Codex 0.165 drops a tier its list
doesn't name. `CodexTiers` sets it for `/v1/codex/models` and the
models.json magpie writes; `codexcat` appends it to an entry copied from
the cache that lacks it. Groups stay Fast alone, relays and keys keep
their own tiers.

Verified: TestCodexTiersOfferUltrafastAnAccountHas (internal/provider)
and TestUltrafastOfferedPastTheSignedInAccountsCache (internal/codexcat)
fail with the change reverted ("offered [priority]", "offered
\"priority \"") and pass with it. gofmt, go vet (darwin, linux nogui,
windows) and the three builds are clean. go test -tags nogui ./... fails
the same ten tests in gateway, gui, pii and update on ae032794 without
this change, or passes them on rerun (timing, a live magpie on the
machine). Not run: the GUI suite, Windows itself.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/providers-accounts.md      |  2 +-
 internal/agent/route.go                    | 11 ++++-
 internal/codexcat/codexcat.go              | 28 ++++++++++++
 internal/codexcat/ultra_tier_test.go       | 53 ++++++++++++++++++++++
 internal/provider/codex_models.go          | 20 +++++++-
 internal/provider/codex_ultra_tier_test.go | 43 ++++++++++++++++++
 6 files changed, 153 insertions(+), 4 deletions(-)
 create mode 100644 internal/codexcat/ultra_tier_test.go
 create mode 100644 internal/provider/codex_ultra_tier_test.go

diff --git a/docs/subsystems/providers-accounts.md b/docs/subsystems/providers-accounts.md
index dec946c5b..3932fc5f6 100644
--- a/docs/subsystems/providers-accounts.md
+++ b/docs/subsystems/providers-accounts.md
@@ -66,7 +66,7 @@ keys and accounts per request is in [Gateway routing and fallback](gateway-routi
 | Routing groups | User-made groups from the Routing view, and auto-found groups of the same model across providers (derived, never stored). The same model is the same id as vendors agree on it (`sameModel`): lowercase, without a vendor's prefix, a version's dot as `-`, a run of spaces, `_` and `-` as one `-` (a relay listing its display name as the id, `GPT-6 Sol`, joins `gpt-6-sol`, Chill on Discord: `TestSameModelDisplayNameAsID`), and without a YYYYMMDD or Ark YYMMDD snapshot date. Every word still counts (`gpt-6`, `gpt-6-mini` and `gpt-6-sol` stay apart), as do a `:variant`, a four-digit release and OpenAI's dashed date (`gpt-4o-2024-08-06`, a pinned snapshot whose group id agents may already name). A provider kept "Only through routing groups" joins them the same way. Members are `provider/model[:effort]`. A group can nest another (`group/<id>`); `SaveGroup` refuses loops. A group given another id (`agent.RenameGroup`: the Routing groups page, `magpie groups rename`, the TUI) moves every agent field on `group/<old>` to `group/<new>`, spelled as the agent spells it, through the same `renameRefs` a provider's rename uses, then `SyncCatalog`; before, the agents stayed on a group magpie no longer had (lucis0116 on X, `TestRenameGroupMovesTheAgentsOnIt`). A provider's or group's display name needs no move: `store` and `SaveGroup` drop the catalog, and `SyncCatalog` writes the new labels into every agent's list. `Match` takes a glob or `re:` pattern (#766), both matched in any case (`compilePattern`; `(?-i)` inside a `re:` makes case matter). What a pattern matches follows the members named, in the catalog's order, until the user drags it elsewhere (usrname1833 on Discord): `Placed` keeps the whole order, named and matched alike, and the group is read and routed in it (`placedIn`); a model matched since goes last, one no longer matched drops out, a save that sends the named members only leaves the matched where they were (`placedOver`), and a provider's or group's rename carries it (`TestGroupPatternMembersKeepTheirPlace`, `group-member-drag.test.cjs`). A found group follows the providers magpie has: one removed leaves it, while one switched off stays in it (`foundGroups`, `heldOffEntries`; one without a key, such as a plugin not signed in, finds no group), skipped by `membersIn`, left off a found group's card, logos and TUI line with a count of those switched off (XYenon on Discord: `routing-provider-off.test.cjs`, `TestFoundGroupLineLeavesASwitchedOffProviderOut`) and said as switched off in its editor and the TUI's group page, so switching one of two providers off for a while doesn't take the group away from the agents, rules and groups set to it; it is back in its place once on again (#2671: `TestFoundGroupStaysWithAProviderOff`, `TestFoundGroupWithAProviderOff`, `TestReseatKeepsAFoundGroupWithAProviderOff`, `TestFoundGroupMemberOfASwitchedOffProvider`). A found group the user changed (an `auto-…` id stored) is read without the members of providers magpie no longer has (`withoutRemoved`, not written back, so a provider back under its id is back in it), except a manual group's pick, a rule's model, or all of them when none would be left. It keeps following its model as a found group does (Kxsg79bEYFP4 on X: a third provider with the model, a plugin's, had stayed out of a group the user had changed): `SaveGroup` stores, for an `auto-…` id, what it had seen (`Group.Seen`: the models magpie found in it by that save, and those the user named, as `provider/model`), and a provider that serves the model since joins it as it is read, after the user's own members (`joined`, not written back), unless kept out of found groups. A model seen and not a member is one the user took out, and stays out; a provider's rename or a fold carries `Seen` (`mapModelRefs`), and a shared group leaves it behind. A found group changed before `Seen` was kept takes in nothing, as nothing says which of its models the user took out; its next save sees what is found then (`TestChangedFoundGroupTakesInANewProvider`, `TestChangedFoundGroupFromBeforeKeepsItsMembers`, `TestChangedFoundGroupTakesInAPluginProvider`). A switched-off provider's members stay in it, skipped by `membersIn`, and the Routing groups page says them as switched off (`memberJSON.providerOff`). The user's own groups keep their members. Three templates make a group in one click from the models the user has (`provider.Templates`, `AddTemplate`; the Routing groups page's cards before a first group and its Templates menu after, `magpie group template [kind] [name]`): `smart` sends a hard turn to the strongest model and an easy one or a compaction to a cheap one, asked by a classifier (the decision API when there is one, else the cheapest priced model that doesn't reason); `thrifty` starts on two cheap models of different providers and sends high reasoning to the strongest; `steady` fails over between the strongest model of up to three providers. A model is weighed by its maker's list price when known, else what its provider charges, else by its id's size words (`sizeOf`); one over `tooDear` (USD 100 a million output tokens) is never picked. A template that can't be made says what is missing (`Need`). It is saved under a name and id no group has (`freeGroupName`, shared with `CopyGroup`), never over one. A group is shared as text (`ShareGroup`, a group row's Copy to share): JSON marked `"magpie": "routing-group"` with a format `version` (`ShareVersion`), holding the group's members as it names them, patterns, routing, rules, classifier and settings. A group holds only `provider/model` ids, never a key, account or address, and the derived matches, found/hidden/off flags and the rules that hold by a folder (a path on the sharer's machine, `Rule.Folders`) stay behind; a pasted one is left out too. `ImportGroup` (the Routing groups page's Import, `POST /api/groups/import`) reads it with words or a code fence around it, refuses another text, a newer format or none (`ShareError`, said in the reader's language). A member whose provider the importer has is kept; else the same model (`AutoGroupOf`) under the first provider of theirs that serves it (`Instead`); else it is left out and named (`Missing`), with the rules that send to it, its place among the off and fast members, and a classifier gone takes the intent rules and auto effort with it. Nothing is added when no member is left; what is added gets a free name, never replacing a group. A group of patterns only that match nothing now (a plugin's models not listed) has no members: `/api/groups` says them, and an unmakeable template's, as `[]`, never `null`; the Routing groups page reads the response through `groupsFrom` and draws a group it still can't draw as one row saying so, so one bad group never hides the rest (#1585). | [`group.go`](../../internal/provider/group.go), [`grouptemplate.go`](../../internal/provider/grouptemplate.go), [`group_share.go`](../../internal/provider/group_share.go) |
 | Allowance | `Quotas` asks every vendor at once: subscription windows (`SubscriptionUsage`), key-bought plans (`PlanQuotas`) and key balances (`KeyBalances`). The Usage page, `magpie quota --json` and `GET /v1/magpie/quotas` read it, each window with its whole-window estimate (`Holds`/`HoldsWhy`, `usage.WithWindowHolds`, which `quotaReport` reaches through the `ReckonHolds` hook since package provider can't import usage, #2333). A Remote magpie's cards (`GET /v1/magpie/quotas/cards`, `writeCards`) carry the estimate too, for the owner or a key with no limits on what it sees, since the computer reading them has none of the remote's calls to reckon from (linkaww on Discord: a Docker magpie's ChatGPT Pro week showed no whole on the other computer; `TestRemoteMagpieCardsCarryTheirWholes`). A Codex card's estimate counts the calls of a ChatGPT API account (`chatgpt-api`) that is the same ChatGPT account, whose plan limits they share: the tokens of both must name the same `chatgpt_account_id` and `chatgpt_user_id`, never matched by name, so two Team seats of one email stay apart (`SamePlanAccounts` in [`chatgpt_same_plan.go`](../../internal/provider/chatgpt_same_plan.go), jctaoo on Discord, `TestWindowHoldsCountsTheSameChatGPTAccountThroughTheAPI`). A single card can be read again on its own (#840). A remote magpie's cards come from what it has kept (`CachedCards`, `GET /v1/magpie/quotas/cards`) and are never read there for this computer except by a card's refresh (`POST /v1/magpie/quotas/refresh`, throttled per card). What it has kept is the Usage page's cards with the readings made behind the requests since laid over them, a later one over an earlier by `readSeq` (`cards_kept.go`): each account's `LoginUsage` reading (the used-up switch, the Codex warm-up, routing's `Allowances`), and each key's `KeyAllowance` windows on its plan or balance card. A Claude account's windows Claude Code told as it answered (`NoteClaudeLimits`, kept in `claudeUsage` with their own `heardSeq`, which drops the account's `LoginUsage` reading) stand on its card over any reading started before them (`withHeardClaude`, #2206), so a magpie only requests reach still tells them. An account or key read that way and never on the page gets a card from that reading, and after a restart, before either is read again, the cards come from `quotas.json`, dated (`AsOf`). A magpie serving only other magpies has nobody on its page (#1313). What it has kept includes its own Remote magpies' cards as it last read them (`passedOnCards`, no remote asked), so a chain passes every card on (yuyong_id on Discord: magpie3 → magpie2 → magpie1 showed none of magpie1's Codex at magpie3), named after each magpie (`magpie2/magpie1/codex`, "Codex · magpie1 · magpie2"); the card standing for a remote and its keys' limits stay the reader's own. Each card carries `via`, the `catalog.Self` of each magpie it went through, and a reader leaves out one that loops (`catalog.Loops`, as a model's `magpie_via`). A refresh of such a card is passed to the magpie it came from (`quotaCardsRefresh` takes a card id this magpie has from a remote); a Codex reset is offered on the magpie next door only, and quota history isn't passed on. The status line's kept report (`KeptQuotaReport`) has a remote's cards the same way. A ChatGPT account's card has an *Image generation* row (`WithImageLane`, [`image_lane.go`](../../internal/provider/image_lane.go), `Lane` `images`, Text and Aside so routing, holds and history never see it; hqqqqqqqh on X, #6160): ChatGPT's images have a quota apart from the 5-hour and weekly windows, and neither `/wham/usage` (`additional_rate_limits` is null) nor the reply headers (`x-codex-primary-*`, `x-codex-secondary-*`) tell it. So the row says *Used up* with the reset time while the image model is resting on that account after a refusal (`ImageRest`, the gateway's `restingUntil`, whose time is the refusal's `resets_at`, #2244) and *Unknown* otherwise, never a share or a count (`TestWithImageLaneOnlyReadCodexCards`, `TestCodexImageRowIsTheRefusalsResetTime`, `codex-image-row.test.cjs`). Not done: the count of images made in the window. Each key of a remote-magpie provider also gets a card of its own, under `<remote>/~keys`, one section per key (#1547, `remoteKeyCards` in `remote_key_limits.go`): the gateway key's limit as that magpie holds it, read from `GET /v1/magpie/limit` asked with that key alone, so a key never sees another's numbers. It shows a window per cap (tokens, spend) named for the period, used against the cap, with its reset, plus `GatewayKey` (what is left, calls, a cycle of days, used up); a key held to no limit shows `Unlimited`. It is kept for `remoteCardsFor` like the remote's cards and read again by the card's refresh (`?provider=<remote>/~keys&user=<key name>`). A read that fails keeps the last numbers, dated (`AsOf`); with none the card says why, never zero or no limit. A remote from before `/v1/magpie/limit` (404) says it is too old to tell (`errRemoteNoKeyLimit`). A remote's Codex card keeps its `Resets` (not a GLM team's, `ByWindow`), and its check-ins are dropped: **Use one…** there goes through `/api/usage/codex-reset` with the card's `provider`, and `UseRemoteCodexReset` asks the remote's `POST /v1/magpie/quotas/codex-reset?user=` with the provider's key (#3850). The remote spends it with `SpendCodexReset`, the same function as the Usage page (`UseCodexResetCard`, then `AwaitAllowance`). The account is always named. A 403 `gateway_key_read_only` is told as a read-only key there, and a 404 as a remote too old. No answer within `RemoteResetWait` says the reset may have been used, and it is never asked again by itself. A remote that holds the key to a budget, models or accounts answers its cards 403 `gateway_key_held` (#1981, `errKeyHeld`): the cards kept from before are dropped, and beside the key's own card the remote's card says it tells this key no quotas, and that on that computer Quotas is turned on for the key and it is let use every model of a provider whose usage it is to see (`errRemoteHeld`; yi_time on Discord saw the remote's Claude vanish from every page with no word). Its owner can let the key be told the cards of what it may use (#2216, `magpie gateway-key quotas <id> on`); the remote then answers those, and 403 held as before when that is none (`writeCards`), so that key shows the same card. A remote's cards are kept by provider and key (`remoteCardsID`), so a changed key never shows what the old one was told, and a read is kept only over one asked before it (`keepRemoteCards`). Cursor, Grok and a Kiro key keep the page's cards only. With Settings → Allowances → *Allowance reads* at *When I ask* (`QuotaReads == "asked"`, #1518: magpie started at login before the proxy app read by itself, direct), only a read the user asked for goes out: the Usage page or the tray panel's Allowances opened (no more than once in 30s, `quotasOpened`, #1588) or refreshed (`?asked=1`), a card's refresh (`RefreshUsage`), `magpie quota`, `magpie accounts`, `magpie quota wait` and the TUI's quotas (`Asked`). Any other read (`quotaReading` → `holdUnasked`) carries `netproxy.Hold`, so its requests fail before they leave, and every reader gives back what it last read, dated, or "not read yet" (`errNotAsked`): routing, the used-up switch, the menu bar and alerts go by that. An account refused for its quota (`StaleAllowance` → `markStaleRead`) or a key refused (`StaleKeyAllowance` → `refused`) is still read, once (`unheld`). Warm-up and check-in are not reads and are unchanged. A plugin's window may carry a prepaid wallet's `balance` in its `unit` and no share (`QuotaWindow.Balance`, #3950): the card and `magpie quota` show the figure (`BalanceText`), and routing reads it through `Allowance.Left`. | [`cards_kept.go`](../../internal/provider/cards_kept.go), [`quotas.go`](../../internal/provider/quotas.go), [`subscription_usage.go`](../../internal/provider/subscription_usage.go), [`planquota.go`](../../internal/provider/planquota.go), [`balance.go`](../../internal/provider/balance.go), [`quota_refresh.go`](../../internal/provider/quota_refresh.go), [`remote_quotas.go`](../../internal/provider/remote_quotas.go), [`remote_key_limits.go`](../../internal/provider/remote_key_limits.go), [`quota_asked.go`](../../internal/provider/quota_asked.go) |
 | A remote magpie's prices | A local magpie asks a remote magpie's `/v1/models` with `X-Magpie-Prices` (`PricesHeader`, sent by `listHeaders`). The remote answers each model's `magpie_price`: what its own Usage page counts the model at (`EntryPriceIn`: the price its user set, else its provider's list price at its price rate; a routing group only when every member costs the same). It tells it only to a request from its own computer or one let in with a gateway key (`local` or `sharedWith`); a list that didn't ask gets no `magpie_price` (a remote request without a valid key never reaches the list: `lanGuard` refuses it); every list told to those callers also carries the same price as OpenRouter's `pricing`, for agents ([gateway routing](gateway-routing.md)). The local keeps the price with the fetched list (`catalog.Model.Price`; a value that isn't a price, or has a negative part, is dropped, the model kept) and uses it as that provider's list price (`ListPrice` → `remotePrice`). A price the local user set (`provider/model`, `provider/*`, `*/model`) still comes first, and the local provider's own price rate still applies on top. A remote from before this sends no field and the models stay priced as before; an older local sends no header and is sent nothing new. The model editor says the greyed price is the other magpie's (`remoteList`). | [`remote_magpie.go`](../../internal/provider/remote_magpie.go), [`models.go`](../../internal/provider/models.go), [`gateway.go`](../../internal/gateway/gateway.go) (`models`), [`live.go`](../../internal/catalog/live.go) |
-| A remote magpie's service tiers | A remote magpie's `/v1/models` gives each model the `service_tiers` its own Codex is offered on it (`codexTiers` → `codexcat.ServiceTiers`, from the same `CodexCatalog` and `codexcat.Entries` as its `/v1/codex/models`: Fast on a ChatGPT account's GPT model, the tiers of Codex's own entry on a relay's, none on a model it offers none). The local keeps the ids (`catalog.Model.Tiers` → `Entry.Tiers`), `codexListed` hands them on for the remote's models, and `codexcat.Entries` offers them to the local Codex with Codex's own names (`namedTiers`). The gateway sends the tier Codex asks for to a remote magpie as it was asked (`Request.OwnTier`, as for a provider added by its address; dropped and not sent again if refused), and the remote serves it as its own Codex's turn (#1234). An agent's picker offers the bolt on a remote's model whose tiers hold `priority` (`provider.CanFast` reads them with `RemoteTiers`; Ultrafast too where they hold `ultrafast`, `UltraOn`), and a fast pick of one goes on with `service_tier` `priority` on the remote's Chat or Responses: an agent on Messages, whose fast is Claude's `speed`, has it turned into the tier the remote offers (`forwardTranslated`), so Claude Code's pick reaches the remote's vendor too (littlekk88 on Discord; `TestRemoteMagpieFastPick`, red without either half). A remote from before this sends no tiers, and its models are offered none, as before. The list gives every client the tiers, not only a magpie asking with `X-Magpie-Drawers`: Cindy shows its Fast switch on a model whose `service_tiers` hold `priority` (#1914, `TestModelsListTiersForEveryClient`). | [`codexcat.go`](../../internal/codexcat/codexcat.go), [`codex_models.go`](../../internal/provider/codex_models.go), [`codex_catalog.go`](../../internal/gateway/codex_catalog.go), [`gateway.go`](../../internal/gateway/gateway.go), [`live.go`](../../internal/catalog/live.go) |
+| A remote magpie's service tiers | A remote magpie's `/v1/models` gives each model the `service_tiers` its own Codex is offered on it (`codexTiers` → `codexcat.ServiceTiers`, from the same `CodexCatalog` and `codexcat.Entries` as its `/v1/codex/models`: Fast on a ChatGPT account's GPT model, and Ultrafast beside it where one of Codex's accounts lists it on the model (`provider.CodexTiers` with `UltraModels`; also added to an entry copied from Codex's `models_cache.json`, which holds only the account Codex last fetched with, `withUltrafast`; a group is offered Fast alone, since its other members would be sent `ultrafast` as it is; `TestCodexTiersOfferUltrafastAnAccountHas`, `TestUltrafastOfferedPastTheSignedInAccountsCache`), the tiers of Codex's own entry on a relay's, none on a model it offers none). The local keeps the ids (`catalog.Model.Tiers` → `Entry.Tiers`), `codexListed` hands them on for the remote's models, and `codexcat.Entries` offers them to the local Codex with Codex's own names (`namedTiers`). The gateway sends the tier Codex asks for to a remote magpie as it was asked (`Request.OwnTier`, as for a provider added by its address; dropped and not sent again if refused), and the remote serves it as its own Codex's turn (#1234). An agent's picker offers the bolt on a remote's model whose tiers hold `priority` (`provider.CanFast` reads them with `RemoteTiers`; Ultrafast too where they hold `ultrafast`, `UltraOn`), and a fast pick of one goes on with `service_tier` `priority` on the remote's Chat or Responses: an agent on Messages, whose fast is Claude's `speed`, has it turned into the tier the remote offers (`forwardTranslated`), so Claude Code's pick reaches the remote's vendor too (littlekk88 on Discord; `TestRemoteMagpieFastPick`, red without either half). A remote from before this sends no tiers, and its models are offered none, as before. The list gives every client the tiers, not only a magpie asking with `X-Magpie-Drawers`: Cindy shows its Fast switch on a model whose `service_tiers` hold `priority` (#1914, `TestModelsListTiersForEveryClient`). | [`codexcat.go`](../../internal/codexcat/codexcat.go), [`codex_models.go`](../../internal/provider/codex_models.go), [`codex_catalog.go`](../../internal/gateway/codex_catalog.go), [`gateway.go`](../../internal/gateway/gateway.go), [`live.go`](../../internal/catalog/live.go) |
 | Two magpies each the other's remote | The list a magpie gives another magpie (`X-Magpie-Drawers`) names, as `magpie_via`, the magpies each model passes through to its vendor, itself last (`catalog.ViaHere`, `viaOf`; a routing group's are its members' together, so a group with the other magpie's own group of the model in it is left out there too). Each process has a random id (`catalog.Self`). A fetched list leaves out a model whose `magpie_via` has this magpie and another one (it went out of here and came back), or more than `MaxVia` (8), so two magpies that are each other's remote no longer list each other's models back one level deeper on every 10-minute fetch, without end, each level another member of the found `auto/` group and another trip round the two (cdredfox on Discord, 100-200% CPU). A remote that is this magpie itself (sync carries a Remote magpie provider to the computer it names, hanslin1666) has its models through this id alone, taken once; one through this id twice or more is left out. Such a remote is found by its own list: a fetch whose models' `magpie_via` ends with this magpie's own `Self` is kept, by provider id and the address it answered at, in `remote-self.json` (`noteSelf`; another lister, or a list with no via, takes it away; an empty list or a failed fetch changes nothing; this computer's own file, never in a backup or a sync). The provider is then left out (`SelfLeftOut` in `On`, `SwitchedOff`, `remoteMagpies`): its models are not listed beside this magpie's own nor in a found group, and a request naming one, an agent's pick sync brought from the other computer, is served here with the remote's id taken off the front (`ThroughSelf` in `Resolve` and `ResolveRoute`), not passed through the gateway again. The Providers row says *This magpie* (greyed while left out) and its editor says why, with **Use it anyway** (`KeepSelf`, `provider/keepself`, `SetKeepSelf`), the user's to set (hanslin1666): kept, it is served as any remote, each request twice through this magpie. `KeepSelf` is this computer's own like `KeepLogin` (`Mirror`, `Restore`, blanked in davsync's `hashes`), since the other computer's copy points at this one, which is not itself (`TestRemoteMagpieThatIsThisOneIsLeftOut`, `TestRemoteSelfRecord`, `remote-self.test.cjs`). Each request passed on to a Remote magpie says how many magpies it went through (`X-Magpie-Hops`, `passOnCaller`); one that arrives having passed `MaxVia` is answered 508 Loop Detected (`withCaller`), read only from a magpie's request and taken off every request as it arrives. A magpie older than the field sends none, and its models are taken as they were. The quota cards a Remote passes on follow the same ways (X on 0.1.3678: A → B → C → A told Kiro and Codex by `remote-B/kiro` and `remote-B/remote-C/remote-A/remote-B/remote-C/kiro`, hours apart, to a Remote enabled for one local model): a card's `via` that names any magpie twice is a loop too, so one that came round after this magpie restarted (its old `Self` is no longer this one's) is left out (`catalog.Loops`), and isn't kept in `remoteCardCache` (`keepRemoteCards`). A Remote's cards are shown, and passed on, only for the providers it is enabled for: the card's provider id must be the provider path of an exposed model there (its id less the last part, or a parent of it, whole parts only: relay/strata enabled tells relay/strata, never relay/kiro; `remoteCardWanted`, `cardWantedFor`, `TestRemoteCardWantedByWholePath`, 748975219 on X), unknown, so all shown, while its list isn't read. One subscription account's copies (same provider, same `user`) are one card, the newest complete reading, then the shorter way (`oneCardPerAccount`, in `RemoteCards` and `CachedCards`; a key's cards, whose `user` is a name two keys may share, are not merged) (`TestRemoteCardsFollowEnabledModelsAndDedupe`, `TestLoopsOnARepeatedMagpie`). | [`magpie_via.go`](../../internal/catalog/magpie_via.go), [`live.go`](../../internal/catalog/live.go), [`gateway.go`](../../internal/gateway/gateway.go), [`remote_magpie.go`](../../internal/provider/remote_magpie.go), [`remote_self.go`](../../internal/provider/remote_self.go), [`remote_quotas_scope.go`](../../internal/provider/remote_quotas_scope.go) |
 | A remote magpie that moved | Computer A's router hands it a new address now and then (luckymanjc on Discord), and B's Remote magpie, saved at the old one, reached nothing. When B can't connect to it at all (a dial error, `unconnected`), its list fetch (`fetch` in [`models.go`](../../internal/provider/models.go)) and the gateway's request (`forward` in [`gateway.go`](../../internal/gateway/gateway.go)) call `SeekMoved` ([`remote_moved.go`](../../internal/provider/remote_moved.go)): every address of the old one's /24 and of up to four of B's own private /24s is dialled at A's port (500ms each, 128 at once, `lanNeighbours`). Whatever takes the connection there may be anyone's (a café's network, A switched off), so it is sent neither the key nor the provider's headers until it proves it holds the key (`proves`): B POSTs a nonce of its own and `RemoteKeyID` (the key's sha256, hex) to `RemoteProvePath` (`/v1/magpie/prove`) with no key and no proxy, and checks with `hmac.Equal` that the answer is `RemoteProof`: HMAC-SHA256 under the key of the nonce and the address B dialled. A answers it ([`remote_prove.go`](../../internal/gateway/remote_prove.go)) for an enabled gateway key of that id (`access.ProveSecret`: constant-time compares over every key, then `Check`) at the address the connection reached it on (`http.LocalAddrContextKey`), so a host passing B's nonce on to A elsewhere hands back a proof for A's address, not its own; 404 for a key it hasn't or has turned off. Only an address that proved is asked `/v1/models` with the key, and the first that lists 200 and whose list this magpie didn't make (`magpie_via`) is saved as the provider's address and asked again. A magpie from before the route, one behind a port forward or NAT (it is reached at another address than its own), or one behind a proxy that needs the provider's headers, is not found, and the user types the new address. A name or a public address is never looked around, an address the user changed meanwhile stands, and a provider is looked for once a minute at most, callers at once sharing the look (`TestRemoteMagpieKeyGoesToNoNeighbour`: an impostor that lists 200 for anything, one with a proof under another key, one with a garbled proof and one relaying to the real magpie are sent no key or header and not saved, and the real one is; `TestRemoteProof`, `TestRemoteMagpieFoundMoved`, `TestRemoteMagpieNotFoundStays`, `TestRemoteMagpieMovedIsFound`, `TestRemoteProveAnswersOnlyTheKeysHolder`). |
 | A relay's Codex entries | A provider the user added by its address with a Responses URL may list its models in Codex's own shape (`slug`, `supported_reasoning_levels`, `shell_type`, `base_instructions`: `catalog.CodexEntry`), plainly or when asked with Codex's `client_version`, as sub2api does (ctopsc on Discord: GPT-6.1 Terra was handed models.dev's 922000 window where the relay said 272000). `fetchOne` keeps such a row whole (`catalog.Model.Codex`, with its window, max window and inputs read off it), and when the plain list has none it asks the same URL once more with `client_version` (`codexEntries`): only where the list is fetched (add, key change, Refresh), never per Codex poll. The answer only adds entries to models the plain list has; one that fails or can't be read keeps the last list's entries (failed read = unknown), one that answers plainly says there are none. `codexcat.listedEntry` hands Codex the relay's entry as given, `base_instructions` included, with magpie's slug, name, priority and " via magpie" description; the user's window, compaction, levels and image setting still win (levels keep the relay's descriptions). A saved list from before is enriched at its next Refresh. `TestCodexListedEntry`, `TestCodexListedEntryInPlainList`. | [`codex_entries.go`](../../internal/provider/codex_entries.go), [`live.go`](../../internal/catalog/live.go), [`codexcat.go`](../../internal/codexcat/codexcat.go) |
diff --git a/internal/agent/route.go b/internal/agent/route.go
index 4e5949153..90667b1e5 100644
--- a/internal/agent/route.go
+++ b/internal/agent/route.go
@@ -377,6 +377,15 @@ func buildModels(agent string) []catalog.Model {
 		_, ms, _ := find(id)
 		return ms
 	}
+	// read once for the list, and only when a ChatGPT account's model is
+	// in it (provider.CodexTiers)
+	var ultra map[string]bool
+	for _, e := range shown {
+		if e.Group == "" && e.Provider.Account != nil && e.Provider.Account.Agent == "codex" {
+			ultra = provider.UltraModels()
+			break
+		}
+	}
 	for i, e := range shown {
 		efforts := e.Efforts
 		if agent == "codex" {
@@ -426,7 +435,7 @@ func buildModels(agent string) []catalog.Model {
 		// the service tiers Codex is offered on it, as the gateway's own
 		// lists offer them: Fast in the Codex CLI magpie writes
 		// magpie-models.json for (#1530)
-		provider.CodexTiers(&m, e, members)
+		provider.CodexTiers(&m, e, members, ultra)
 		if agent == "codex" {
 			provider.CodexSeals(&m, e, members)
 		}
diff --git a/internal/codexcat/codexcat.go b/internal/codexcat/codexcat.go
index 546da879e..e43693e1a 100644
--- a/internal/codexcat/codexcat.go
+++ b/internal/codexcat/codexcat.go
@@ -361,6 +361,12 @@ func entriesAt(ms []catalog.Model, after int, effort string) []any {
 	for i, m := range ms {
 		if raw, ok := own[strings.TrimPrefix(m.ID, "codex/")]; ok && strings.HasPrefix(m.ID, "codex/") {
 			e := ownEntry(raw, m.ID, shownName(m), after+i+1)
+			// the cache is the one account Codex last fetched it with; a
+			// model another account offers Ultrafast on gets it too
+			// (provider.CodexTiers)
+			if slices.Contains(m.Tiers, "ultrafast") {
+				withUltrafast(e)
+			}
 			// the window as magpie resolves it — the one the user set,
 			// else the account's list's — not the cache's, which is what
 			// magpie last handed Codex (#674)
@@ -393,6 +399,11 @@ func entriesAt(ms []catalog.Model, after int, effort string) []any {
 		// GPT models
 		if slug, ok := strings.CutPrefix(m.ID, "codex/"); m.Fast || ok && strings.HasPrefix(slug, "gpt-") {
 			e.Tiers = append(e.Tiers, fastTier)
+			// and Ultrafast where an account offers it on the model
+			// (provider.CodexTiers)
+			if !m.Fast && slices.Contains(m.Tiers, "ultrafast") {
+				e.Tiers = append(e.Tiers, ultrafastTier)
+			}
 		} else if m.OwnTier && (len(m.Tiers) == 0 || len(ownTiers(own, m)) > 0) {
 			e.Tiers = ownTiers(own, m)
 		} else if len(m.Tiers) > 0 {
@@ -633,6 +644,23 @@ func ownTiers(own map[string]map[string]any, m catalog.Model) []tier {
 // fastTier is Fast as Codex's own catalog writes it on its GPT models.
 var fastTier = tier{ID: "priority", Name: "Fast", Description: "1.5x speed, increased usage"}
 
+// ultrafastTier is Ultrafast as Codex's own catalog writes it (models_cache
+// of a Pro account, Codex 0.165).
+var ultrafastTier = tier{ID: "ultrafast", Name: "Ultrafast", Description: "The fastest available responses for latency-sensitive work."}
+
+// withUltrafast adds Ultrafast to an entry copied from Codex's cache that
+// doesn't list it, after the tiers it has.
+func withUltrafast(e map[string]any) {
+	raw, _ := e["service_tiers"].([]any)
+	for _, r := range raw {
+		if o, _ := r.(map[string]any); o["id"] == ultrafastTier.ID {
+			return
+		}
+	}
+	ts := slices.Clone(raw)
+	e["service_tiers"] = append(ts, map[string]any{"id": ultrafastTier.ID, "name": ultrafastTier.Name, "description": ultrafastTier.Description})
+}
+
 // namedTiers are the tiers ids name, each as Codex's own catalog writes it
 // on any of its models, else by its id: Fast's "priority" as Codex names it.
 func namedTiers(own map[string]map[string]any, ids []string) []tier {
diff --git a/internal/codexcat/ultra_tier_test.go b/internal/codexcat/ultra_tier_test.go
new file mode 100644
index 000000000..879ffdefd
--- /dev/null
+++ b/internal/codexcat/ultra_tier_test.go
@@ -0,0 +1,53 @@
+package codexcat
+
+import (
+	"encoding/json"
+	"testing"
+
+	"github.com/yetone/magpie/internal/catalog"
+)
+
+// Codex's cache is the list of the account it last fetched with: a Plus or
+// Pro Lite one's has no Ultrafast. A ChatGPT account's model another
+// account offers Ultrafast on (catalog.Model.Tiers, set by
+// provider.CodexTiers) is offered it all the same, in the entry copied from
+// the cache and in one magpie writes itself; a group isn't.
+func TestUltrafastOfferedPastTheSignedInAccountsCache(t *testing.T) {
+	v1Home(t, `{"etag":"W/\"a\"","models":[{"slug":"gpt-6.1-sol","base_instructions":"x","service_tiers":[{"id":"priority","name":"Fast","description":"2x speed, increased usage"}]}]}`)
+	ms := []catalog.Model{
+		{ID: "codex/gpt-6.1-sol", Name: "a", Tiers: []string{"priority", "ultrafast"}},
+		{ID: "codex/gpt-6.2", Name: "b", Tiers: []string{"priority", "ultrafast"}},
+		{ID: "codex/gpt-5.5", Name: "c", Tiers: []string{"priority"}},
+		{ID: "group/r", Name: "d", Fast: true},
+	}
+	var got struct {
+		Models []struct {
+			Slug  string `json:"slug"`
+			Tiers []struct {
+				ID          string `json:"id"`
+				Description string `json:"description"`
+			} `json:"service_tiers"`
+		} `json:"models"`
+	}
+	if err := json.Unmarshal(Catalog(ms), &got); err != nil {
+		t.Fatal(err)
+	}
+	ids := map[string]string{}
+	for _, m := range got.Models {
+		s := ""
+		for _, x := range m.Tiers {
+			s += x.ID + " "
+			if x.ID == "ultrafast" && x.Description == "" {
+				t.Errorf("%s: Ultrafast without Codex's description", m.Slug)
+			}
+		}
+		ids[m.Slug] = s
+	}
+	want := map[string]string{"codex/gpt-6.1-sol": "priority ultrafast ", "codex/gpt-6.2": "priority ultrafast ",
+		"codex/gpt-5.5": "priority ", "group/r": "priority "}
+	for k, v := range want {
+		if ids[k] != v {
+			t.Errorf("%s offered %q, want %q", k, ids[k], v)
+		}
+	}
+}
diff --git a/internal/provider/codex_models.go b/internal/provider/codex_models.go
index 91fcb9257..3981b4c7f 100644
--- a/internal/provider/codex_models.go
+++ b/internal/provider/codex_models.go
@@ -929,13 +929,19 @@ func codexListedIf(shown []Entry, members func(id string) []Member, listed func(
 	s := settings.Load().ForAgent("codex")
 	find := func(id string) (Group, []Member, bool) { return Group{}, members(id), true }
 	apart := codexApart(shown, labels, listed)
+	// read once for the list, and only when a ChatGPT account's model is
+	// in it: UltraModels reads every Codex account's model list
+	var ultra map[string]bool
 	for i, e := range shown {
+		if ultra == nil && e.Group == "" && e.Provider.Account != nil && e.Provider.Account.Agent == "codex" {
+			ultra = UltraModels()
+		}
 		if !listed(e) {
 			continue
 		}
 		m := catalog.Model{ID: e.ID, Name: labels[i], Efforts: CodexEfforts(e), Images: e.Images || seen, Context: e.Context, AgentsV2: e.AgentsV2, Codex: e.Codex, Apart: apart[i]}
 		m.Compact = CompactFor(s, e, find)
-		CodexTiers(&m, e, members)
+		CodexTiers(&m, e, members, ultra)
 		CodexSeals(&m, e, members)
 		ms = append(ms, m)
 	}
@@ -1020,7 +1026,8 @@ func codexApart(shown []Entry, labels []string, listed func(Entry) bool) []strin
 // (codexcat.Entries turns them into the entry's service_tiers): one source
 // for every list Codex is handed, the gateway's and the models.json file
 // magpie writes for a Codex CLI that names magpie its provider (#1530).
-func CodexTiers(m *catalog.Model, e Entry, members func(id string) []Member) {
+// ultra is UltraModels, read once by the caller; nil offers no Ultrafast.
+func CodexTiers(m *catalog.Model, e Entry, members func(id string) []Member, ultra map[string]bool) {
 	// a provider the user added by its address is sent the tier Codex
 	// asks for as it is (hsiangron on X)
 	m.OwnTier = e.Group == "" && e.Provider.Preset == "" && e.Provider.Account == nil && e.Provider.ID != ""
@@ -1051,6 +1058,15 @@ func CodexTiers(m *catalog.Model, e Entry, members func(id string) []Member) {
 		}
 		return
 	}
+	// a ChatGPT account's GPT model is offered Ultrafast beside Fast where
+	// one of Codex's accounts lists it on the model: Codex sends only a
+	// tier its list names, and the gateway sends an ultrafast ask to an
+	// account that offers it, priority to the others. A group isn't, since
+	// its other members would be sent ultrafast as it is.
+	if a := e.Provider.Account; a != nil && a.Agent == "codex" && UltraOn(e.Provider, e.Model, ultra) {
+		m.Tiers = []string{codexFastTier, "ultrafast"}
+		return
+	}
 	// so is a model of its own that has one, which no tier above names
 	// (an Anthropic key's Opus, an OpenAI key's GPT, a Cursor account's)
 	if len(m.Tiers) == 0 && CanFast(e.Provider, e.Model) {
diff --git a/internal/provider/codex_ultra_tier_test.go b/internal/provider/codex_ultra_tier_test.go
new file mode 100644
index 000000000..cce306292
--- /dev/null
+++ b/internal/provider/codex_ultra_tier_test.go
@@ -0,0 +1,43 @@
+package provider
+
+import (
+	"slices"
+	"testing"
+
+	"github.com/yetone/magpie/internal/catalog"
+)
+
+// Codex is offered Ultrafast on a ChatGPT account's GPT model when one of
+// Codex's accounts lists it on the model, whichever account Codex itself is
+// signed in to: Codex sends only a tier its list names, and the gateway
+// sends an ultrafast ask to an account that offers it. Not on a model no
+// account offers it on, and not on a group, whose other members would be
+// sent ultrafast as it is.
+func TestCodexTiersOfferUltrafastAnAccountHas(t *testing.T) {
+	acct := Provider{ID: "codex", Account: &Account{Agent: "codex"}}
+	relay := Provider{ID: "company"}
+	ultra := map[string]bool{"gpt-6.1-sol": true}
+	members := func(string) []Member {
+		return []Member{{Provider: relay, Model: "gpt-6.1-sol"}, {Provider: acct, Model: "gpt-6.1-sol"}}
+	}
+	tiers := func(e Entry, ultra map[string]bool) catalog.Model {
+		var m catalog.Model
+		CodexTiers(&m, e, members, ultra)
+		return m
+	}
+	if m := tiers(Entry{ID: "codex/gpt-6.1-sol", Model: "gpt-6.1-sol", Provider: acct}, ultra); !slices.Equal(m.Tiers, []string{"priority", "ultrafast"}) {
+		t.Errorf("an account's model offered %v, want priority and ultrafast", m.Tiers)
+	}
+	if m := tiers(Entry{ID: "codex/gpt-5.5", Model: "gpt-5.5", Provider: acct}, ultra); slices.Contains(m.Tiers, "ultrafast") {
+		t.Errorf("a model no account offers Ultrafast on offered %v", m.Tiers)
+	}
+	if m := tiers(Entry{ID: "codex/gpt-6.1-sol", Model: "gpt-6.1-sol", Provider: acct}, nil); slices.Contains(m.Tiers, "ultrafast") {
+		t.Errorf("no accounts read, offered %v", m.Tiers)
+	}
+	if m := tiers(Entry{ID: GroupPrefix + "r", Model: "gpt-6.1-sol", Provider: acct, Group: "r"}, ultra); slices.Contains(m.Tiers, "ultrafast") || !m.Fast {
+		t.Errorf("a group offered %v (fast %v), want Fast alone", m.Tiers, m.Fast)
+	}
+	if m := tiers(Entry{ID: "company/gpt-6.1-sol", Model: "gpt-6.1-sol", Provider: relay}, ultra); slices.Contains(m.Tiers, "ultrafast") {
+		t.Errorf("a relay's model offered %v", m.Tiers)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```
</details>
