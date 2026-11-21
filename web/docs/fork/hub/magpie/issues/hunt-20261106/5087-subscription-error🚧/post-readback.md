Rework per @yetone's review

Your review of the first patch blocked it because "a failed `/v1/billing/subscription` read is ignored … A failed read means 'unknown'": the windows stood on, `Aside` false, no error — so a pay-as-you-go org whose API month is spent showed a spent card that stops the key, though Mistral serves past the budget from the prepayment. The same shape is in the two Mistral commits now on main (8216592a8, 1c45645b5): `mistralKeyWindows` takes the subscription only when it answers, and `readMistralBudget` with a nil `payg` leaves `Aside` false — so the rework below is a patch against those, and your requested test (`/v1/billing/budget` 200 with a spent API budget, `/v1/billing/subscription` 500) is red on main as it stands.

**The fix**

Whether what goes past the budget is billed is the subscription's to tell (`payg_enabled` for a Studio month, `vibe_payg_enabled` for Vibe, the budget's own over them). So a read of it that fails is unknown, an error now, and no window of that read stands on it: `mistral subscription: …`, the ask named with what Mistral said in it (`mistral subscription: 500: boom`, `… 401 Unauthorized: Invalid API Key`), as whoami's `no plan_type` already is. A failed read is never "spent stops the key" any more. The keyed-plan family takes the error from there, unchanged: a card read before keeps its last reading, pay-as-you-go's state with it (`keepReading`), a first failed read says why (`PlanQuotas`, `sure` false), and routing never goes by a failed read at all (`readKeyAllowance` keeps the last allowance and retries in a minute — "a failed read is not known, never empty"), which is the "keep the last known pay-as-you-go state" of your review, through the cache that already stands. Point 2 of the review (`Payg` parsed, never used) went by with the rework's target: main's `mistralBudgetDetail.PaygEnabled` decides `Aside` whenever the budget names it, so the dead field of the first patch has no counterpart here.

Point 1's test is in, as asked, and red before the fix: `TestMistralSubscriptionUnread` asks the budget of a spent API month (100 of 15 USD, its own `payg_enabled` unnamed — the load-bearing shape) and the subscription a 500, a 401, and a body that isn't the reply; before, all three returned the spent window, `Aside` false, no error.

<details>
<summary>Patch (0001-plan-a-Mistral-key-s-spent-month-stands-only-when-its-subscription-was-read.patch)</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Fri, 6 Nov 2026 21:06:54 +0800
Subject: [PATCH] plan: a Mistral key's spent month stands only when its
 subscription was read (#5087)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

8216592a8, and 1c45645b5's Studio month after it, ask
billing/subscription beside the budget and take it only when it
answers: a read that failed (a timeout, a 5xx, a 401 on a key without
the dashboard scope) left the budget windows standing with
pay-as-you-go unknown, and unknown stood for off — a pay-as-you-go
organization whose API month is spent showed a spent card, and routing
held the key (readKeyAllowance keeps the window read whole), though
Mistral serves what goes past the budget from the prepayment then
(yetone's review of #5087).

Whether what goes past the budget is billed is the subscription's to
tell, so its read failing is unknown, an error now, naming the ask with
what Mistral said in it ("mistral subscription: 500: boom"), as
whoami's no-plan_type is; no window of a read that couldn't say so
stands on it. The keyed-plan family takes it from there: a card read
before keeps its last reading, pay-as-you-go's state with it
(keepReading), a first failed read says why, and readKeyAllowance never
routes by a failed read — a failed read is not known, never empty.

TestMistralSubscriptionUnread asks the budget of a spent API month and
the subscription a 500, a 401 and a body that isn't the reply: red
three ways before (a spent window, no error), green now;
TestMistralVibeBudget's "the window stands, with no plan name" flips
with it. The subsystem doc's sentence says so too.

Run (mote): go test ./internal/provider -tags nogui -count=1 (whole
package, ok); go test ./internal/gateway -tags nogui -count=1 (ok);
TestMistral and TestPlanQuota under -race (ok); gofmt -l clean;
go vet -tags nogui ./internal/provider ./internal/gateway and
GOOS=linux the same, clean; go build -tags nogui ./... and GOOS=linux
the two packages, ok.
Broken by hand: with the subscription's error swallowed again,
TestMistralSubscriptionUnread and TestMistralVibeBudget go red — the
spent card is back, Aside false.
Not tried: a real pay-as-you-go Mistral organization; ninondev's
readings (#5087) are the only real ones, of a plan, not of payg.

Fixes #5087
Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/providers-accounts.md  |  2 +-
 internal/provider/mistral_plan.go      | 32 ++++++---
 internal/provider/mistral_plan_test.go | 98 +++++++++++++++++++++++++-
 3 files changed, 118 insertions(+), 14 deletions(-)

diff --git a/docs/subsystems/providers-accounts.md b/docs/subsystems/providers-accounts.md
index a55156105..2862f705e 100644
--- a/docs/subsystems/providers-accounts.md
+++ b/docs/subsystems/providers-accounts.md
@@ -71,7 +71,7 @@ keys and accounts per request is in [Gateway routing and fallback](gateway-routi
 | Codex's free auto-review | OpenAI made Codex's Auto-review free for users signed in through a ChatGPT account (silverzhou on Discord), so a `codex-auto-review` call through the Codex subscription is priced at nothing (`ListPrice` → `codexReviewFree`, `provider.ChatGPTReviewFree`), not at GPT-5.6 Luna's price (`pricedNames`), and the Requests list names no model it is priced as (`PricedNameFor`). Not on a Free plan, where it spends the allowance (cybercaius), read from the plan Codex is signed in to now; a Codex signed out since counts as a paid plan, as the gateway's caps take it (`freeOnChatGPT`). The same model through an API key, the ChatGPT API subscription or a relay, and a review that followed the session to another model, keep their price; a price the user set wins. Every call is priced as it is read, so rows logged before are free too; the price views' cache keys on each account's plan (`usagePriceCacheKey`). Guarded by `TestAutoReviewFreeOnChatGPTSignIn` and `usage.TestAutoReviewFreeOnChatGPT`. |
 | A lab's models | models.dev keeps two catalogs: `api.json`, each provider's models with that host's prices, and `models.json`, each lab's models with only what is the model's on every host (name, window, reply limit, thinking, inputs, release), no price. `Sync` keeps the second beside the first as `labs.json` (`LabsPath`, `syncLabs`: best effort, through a rename, a failed fetch keeping the last; a catalog with none beside it is `Stale` once a process, so it comes at the next look). A model only a lab lists, no provider (models.dev took the gated Claude Mythos 5.1 out of anthropic's list in #11327 and kept its lab file), is voted into the same tables as a listed one (`loadGen`, `labs`), so `ContextOf`, `OutputOf`, `NameOf`, `Thinks`, `SeesImages` and every entry built on them know it wherever a vendor's or an account's list has it; a thinking one with no levels takes the levels of the newest of its family a provider gives them (`labKinEfforts`: Mythos 5.1 takes Mythos 5's). A model a provider lists keeps what providers say of it. `catalog.Describe` builds a model from these for a list that names an id alone. `TestLabOnlyModelIsKnown`, `TestLabsLeaveListedModels`, `TestSyncKeepsLabs`, `TestAnthropicKeyGatedModelDescribed` (iebb on Discord). | [`labs.go`](../../internal/catalog/labs.go), [`catalog.go`](../../internal/catalog/catalog.go) |
 | A Claude account's models | magpie never asks Anthropic with a Claude sign-in, so a Claude account's list is models.dev's anthropic list and what Anthropic told the account's Claude Code beyond it. Claude Code keeps that in its `.claude.json` from its own bootstrap: `additionalModelOptionsCache` (models its /model picker offers beyond its own; a `null` value or a `disabled` one is not a model), `modelAccessCache` (`entitled` per API id) and `additionalModelCostsCache` (Anthropic's prices). `claudeModels` reads the file of Claude Code's own sign-in (`claudeProfilePath`) and of each saved account's directory (`claudeAccountDir`), through `filememo`, and adds each model none of them lists, described by `catalog.Describe` and priced as Anthropic told it. `Account.Lists` for a Claude account goes by its own file (`claudeLists`: the saved directory's, or Claude Code's own when its `oauthAccount` is that account, the one Anthropic answered last): a model it isn't entitled to is out, so routing tries the accounts entitled to a gated model first; with no file, every model is taken to be in, as before. `ListPrice` of a provider whose catalogs include anthropic falls back to that price after every catalog (`claudeCodePrice`). The agent's own Claude Code model picker (`claudeOwn`) offers what `ClaudeCodeModels` gives for the account signed in here; a WSL distro's keeps the catalog's. Not done: a Claude Code that never started on a saved account has no file, so its gated models show only once it has run there. `TestClaudeAccountListsGatedModels`. | [`claude_code_models.go`](../../internal/provider/claude_code_models.go), [`account.go`](../../internal/provider/account.go), [`codex_models.go`](../../internal/provider/codex_models.go), [`claude.go`](../../internal/agent/claude.go) |
-| A key's own windows | A sub2api key given a spending limit per 5 hours, day or 7 days answers its `/v1/usage` with `rate_limits` and no `remaining` (`readSub2APIKeyLimits`). With the Balance URL set to it, the key's card shows them as the windows *5 hours*, *1 day*, *7 days*, in USD, beside a balance field the user wrote; *Check balance* and `magpie provider show` give what its fullest window has left (`Balance`). A Balance URL at an account query left without its token (a sub2api panel's `/api/v1/user/profile`, new-api's `/api/user/self`, after the token was removed) asks the same panel's query for the key instead, the saved URL untouched (`keyQueryOf`, `BalanceQuery`), unless the user's Headers carry an Authorization or Cookie of their own. A Balance URL of the user's own is asked with GET, or with POST and no body when the provider's `BalanceMethod` says so (#2368: an endpoint that answers only a POST; the editor's GET/POST beside the URL, `balance.method=` on the command line); any other method is refused before anything is sent (`balanceMethodOf`). `KeyAllowance` gives routing the same windows: never waited for, read in the background at most once a minute, a failed read keeping the last, and seeded from the card's last reading (`quotas.json`) after a restart.  A key bought as a plan (Kimi Code, GLM Coding Plan and Z.ai, MiniMax Coding Plan, OpenCode Go, Command Code, Ollama Cloud, Mistral: `planQuotaSourceOf`) gives routing its card's windows the same way (`planKeyWindows`, Zhipu's team quota behind a key with none of its own); the Usage page's read of its card is taken at once (`noteKeyAllowance`), and a key there that turns out pay-as-you-go, with no windows, is asked again only every 30 minutes (`keyNoWindowsAge`). Kimi Code's `/usages` (`readKimiCode`) is read as kimi-cli and kimi-code read it: the week's `usage` and each `limits[]` window as counts, and the shares in `usages` (`limit_5h`, `limit_7d`, and `limit_month_total` as a *Month* window renewing at its `reset_time`, lidazi2016 on Discord); a window told both ways is the share's, and `limit_month_code`, the part of the month code used, is no window. `TestReadKimiCode`, `TestReadKimiCodeMonth`. A Command Code plan's key has its month of credits as a *Credits* window beside the 5-hour and weekly ones, as the signed-in subscription's card has (`cmdKeyWindows`, #2451): billing/credits leaves the plan out, so it is the key's billing/subscriptions plan, asked at most every ten minutes and the last one kept while it can't be read; the same reply's period end is the Credits window's reset, left off once it has passed (#2454); a key whose plan was never read has its two windows alone. On Go, GOAT and Pro the month is counted in Command Code's usage-value credits, not dollars (GOAT's 70 are $100 of a model like DeepSeek V4.1 Flash, $70 of GLM-5.2), so the window says "28.80 / 70.00 credits" with bought credits as "+ $5.00 extra" beside it; Max, Ultra and Teams Pro keep the CLI's dollar pool, and Provider, pay as you go, has no month (`cmdPlans`, as the plugin since 0.1.20, plugins #556). Ollama Cloud's `ollama.com/api/balance` (#1888, `readOllamaPlan`) tells the plan's included allowance as one window in USD, *Month* when its period is a month long, renewing at `period.until`, and Aside while credits bought on top are left; those credits are the key's balance card (`readOllamaCredits`), and a reply that names none has no balance card rather than $0. A Mistral key is told its organization's month at `api.mistral.ai/v1/billing/budget`, as Mistral's Vibe CLI reads it (`mistral_plan.go`, dhanyqaz on Discord). The budget is the organization's, so every key of it gets the same `vibe_budget` and `api_budget`; which one a key spends is its kind, asked once a key of `console.mistral.ai/api/vibe/whoami` (`plan_type`). A Vibe key (`chat`) has `vibe_budget` as one *Month* window, a Studio key made in the console (`api`) has `api_budget` as *API · Month*, so the accounts' strip never adds the two; each is in the currency billing names (none when it names none), Aside while pay-as-you-go is on (the budget's own, else the subscription's `vibe_payg_enabled` for Vibe and `payg_enabled` for Studio), with the plan's name from `billing/subscription` (EDU is Student). A key whoami can't place (a failed read, no `plan_type`, Mistral Code's key) or whose budget is 0 has no card, and Le Chat's own message limits are told nowhere. ModelScope's API-Inference token is told its 魔粒 at the OpenAPI's `modelscope.cn/openapi/v1/magicubes/balance` (`readModelScope`, jiabubu on Discord): `available_balance`, which leaves out what running tasks have frozen, as the balance card; the page's daily list (`/magicubes/transactions`) isn't in the OpenAPI, so what is spent a day is the card's own trend. StepFun's Step Plan is read through a platform sign-in, not the key, and isn't one of them: the sign-in is the provider's own, kept by provider id in `stepfun-auth.json` (two StepFun providers on one site can be two accounts, #2384), one card per signed-in provider; a file from before that, kept by site, is given on read to the StepFun providers on that site (`stepfunBySite`), and copies of one sign-in are renewed together. Nor are Volcengine Ark's Coding Plan and Agent Plan (#1427): their 5-hour, weekly and monthly windows are told only to the account's access key (`AccessKeyID`, `SecretAccessKey`), asked of `open.volcengineapi.com` (`GetCodingPlanUsage`, `GetAFPUsage`) and signed as Volcengine's own SDK signs (`volcSign`), so they are cards on the Usage page (`volcPlanQuotas` in `PlanQuotas`), never routing's windows. Nor is Tencent Cloud's Token Plan 企业版 (#1574): what a team plan has used of its cycle's credits (专业套餐) or tokens (轻享套餐) is told only to the account's SecretId and SecretKey (kept as `AccessKeyID`, `SecretAccessKey`), asked of `tokenhub.tencentcloudapi.com` (`DescribeTokenPlanList`, `DescribeTokenPlan`, version 2026-03-22) and signed TC3-HMAC-SHA256 (`tc3Sign`), one card per team plan (`tencentPlanQuotas`). | [`sub2api_usage.go`](../../internal/provider/sub2api_usage.go), [`key_allowance.go`](../../internal/provider/key_allowance.go), [`volcengine_usage.go`](../../internal/provider/volcengine_usage.go), [`tencent_usage.go`](../../internal/provider/tencent_usage.go) |
+| A key's own windows | A sub2api key given a spending limit per 5 hours, day or 7 days answers its `/v1/usage` with `rate_limits` and no `remaining` (`readSub2APIKeyLimits`). With the Balance URL set to it, the key's card shows them as the windows *5 hours*, *1 day*, *7 days*, in USD, beside a balance field the user wrote; *Check balance* and `magpie provider show` give what its fullest window has left (`Balance`). A Balance URL at an account query left without its token (a sub2api panel's `/api/v1/user/profile`, new-api's `/api/user/self`, after the token was removed) asks the same panel's query for the key instead, the saved URL untouched (`keyQueryOf`, `BalanceQuery`), unless the user's Headers carry an Authorization or Cookie of their own. A Balance URL of the user's own is asked with GET, or with POST and no body when the provider's `BalanceMethod` says so (#2368: an endpoint that answers only a POST; the editor's GET/POST beside the URL, `balance.method=` on the command line); any other method is refused before anything is sent (`balanceMethodOf`). `KeyAllowance` gives routing the same windows: never waited for, read in the background at most once a minute, a failed read keeping the last, and seeded from the card's last reading (`quotas.json`) after a restart.  A key bought as a plan (Kimi Code, GLM Coding Plan and Z.ai, MiniMax Coding Plan, OpenCode Go, Command Code, Ollama Cloud, Mistral: `planQuotaSourceOf`) gives routing its card's windows the same way (`planKeyWindows`, Zhipu's team quota behind a key with none of its own); the Usage page's read of its card is taken at once (`noteKeyAllowance`), and a key there that turns out pay-as-you-go, with no windows, is asked again only every 30 minutes (`keyNoWindowsAge`). Kimi Code's `/usages` (`readKimiCode`) is read as kimi-cli and kimi-code read it: the week's `usage` and each `limits[]` window as counts, and the shares in `usages` (`limit_5h`, `limit_7d`, and `limit_month_total` as a *Month* window renewing at its `reset_time`, lidazi2016 on Discord); a window told both ways is the share's, and `limit_month_code`, the part of the month code used, is no window. `TestReadKimiCode`, `TestReadKimiCodeMonth`. A Command Code plan's key has its month of credits as a *Credits* window beside the 5-hour and weekly ones, as the signed-in subscription's card has (`cmdKeyWindows`, #2451): billing/credits leaves the plan out, so it is the key's billing/subscriptions plan, asked at most every ten minutes and the last one kept while it can't be read; the same reply's period end is the Credits window's reset, left off once it has passed (#2454); a key whose plan was never read has its two windows alone. On Go, GOAT and Pro the month is counted in Command Code's usage-value credits, not dollars (GOAT's 70 are $100 of a model like DeepSeek V4.1 Flash, $70 of GLM-5.2), so the window says "28.80 / 70.00 credits" with bought credits as "+ $5.00 extra" beside it; Max, Ultra and Teams Pro keep the CLI's dollar pool, and Provider, pay as you go, has no month (`cmdPlans`, as the plugin since 0.1.20, plugins #556). Ollama Cloud's `ollama.com/api/balance` (#1888, `readOllamaPlan`) tells the plan's included allowance as one window in USD, *Month* when its period is a month long, renewing at `period.until`, and Aside while credits bought on top are left; those credits are the key's balance card (`readOllamaCredits`), and a reply that names none has no balance card rather than $0. A Mistral key is told its organization's month at `api.mistral.ai/v1/billing/budget`, as Mistral's Vibe CLI reads it (`mistral_plan.go`, dhanyqaz on Discord). The budget is the organization's, so every key of it gets the same `vibe_budget` and `api_budget`; which one a key spends is its kind, asked once a key of `console.mistral.ai/api/vibe/whoami` (`plan_type`). A Vibe key (`chat`) has `vibe_budget` as one *Month* window, a Studio key made in the console (`api`) has `api_budget` as *API · Month*, so the accounts' strip never adds the two; each is in the currency billing names (none when it names none), Aside while pay-as-you-go is on (the budget's own, else the subscription's `vibe_payg_enabled` for Vibe and `payg_enabled` for Studio), with the plan's name from `billing/subscription` (EDU is Student); that read failing is unknown — an error, the last reading kept over it — never a spent month that stops a key Mistral bills past its budget. A key whoami can't place (a failed read, no `plan_type`, Mistral Code's key) or whose budget is 0 has no card, and Le Chat's own message limits are told nowhere. ModelScope's API-Inference token is told its 魔粒 at the OpenAPI's `modelscope.cn/openapi/v1/magicubes/balance` (`readModelScope`, jiabubu on Discord): `available_balance`, which leaves out what running tasks have frozen, as the balance card; the page's daily list (`/magicubes/transactions`) isn't in the OpenAPI, so what is spent a day is the card's own trend. StepFun's Step Plan is read through a platform sign-in, not the key, and isn't one of them: the sign-in is the provider's own, kept by provider id in `stepfun-auth.json` (two StepFun providers on one site can be two accounts, #2384), one card per signed-in provider; a file from before that, kept by site, is given on read to the StepFun providers on that site (`stepfunBySite`), and copies of one sign-in are renewed together. Nor are Volcengine Ark's Coding Plan and Agent Plan (#1427): their 5-hour, weekly and monthly windows are told only to the account's access key (`AccessKeyID`, `SecretAccessKey`), asked of `open.volcengineapi.com` (`GetCodingPlanUsage`, `GetAFPUsage`) and signed as Volcengine's own SDK signs (`volcSign`), so they are cards on the Usage page (`volcPlanQuotas` in `PlanQuotas`), never routing's windows. Nor is Tencent Cloud's Token Plan 企业版 (#1574): what a team plan has used of its cycle's credits (专业套餐) or tokens (轻享套餐) is told only to the account's SecretId and SecretKey (kept as `AccessKeyID`, `SecretAccessKey`), asked of `tokenhub.tencentcloudapi.com` (`DescribeTokenPlanList`, `DescribeTokenPlan`, version 2026-03-22) and signed TC3-HMAC-SHA256 (`tc3Sign`), one card per team plan (`tencentPlanQuotas`). | [`sub2api_usage.go`](../../internal/provider/sub2api_usage.go), [`key_allowance.go`](../../internal/provider/key_allowance.go), [`volcengine_usage.go`](../../internal/provider/volcengine_usage.go), [`tencent_usage.go`](../../internal/provider/tencent_usage.go) |
 | A relay's balance found | A provider added by hand, or from a relay's preset, with a key and no Balance URL, at no host magpie knows a query for, is asked where relays tell a key its balance: the base's origin's `/v1/usage` (sub2api, `$remaining`), then `/api/usage/token` (new-api, `$data.total_available / 500000`), with the key's own auth and headers (`probesBalance`, `probeBalance`). A 200 whose field reads is the query; it is kept in memory for the origins and key for 24 hours and then looked for again, so a relay that moved to other software is not read at a query that now means something else. When the look finds nothing, the old query stays while it turns the key away (401/403, so the card says so) or the relay is down. Finding none is kept for 6 hours (5 minutes when the relay couldn't be reached). Nothing is written to the provider: the card reads the found URL, `BalanceQuery` names it, and the editor shows it under the Balance URL (`BalanceFound`, `balanceFound` in /api/providers and the check's reply; `balfound.js`), with Use to copy it into the fields so a wrong amount can be put right. None found means no card (`errNoBalance`) and, from the editor's check, *No balance at /v1/usage or /api/usage/token*. Never asked: a model vendor's or local server's preset host, this computer, OpenCode and the Cline API (`noProbeHosts`), a plan's windows (`planQuotaSourceOf`). A hand-added yylx.io relay showed no balance until its operator had the user import it again (11-05). | [`balance_probe.go`](../../internal/provider/balance_probe.go) |
 | Account names and seats | `AccountNames` (by the account, in lower case, like `AccountCaps`) are names the user gives accounts, set by `SetAccountName` (GUI `provider/accountname`, `magpie accounts alias`); they live in providers.json only, never in a vendor's or plugin's sign-in. A name picks its account wherever the account's own name does (`AccountByName`): the CLI's `accountNamed` (switch, forget, alias), the pool's `--accounts`, and `accountRef` (caps, models, weights, concurrency) after an exact name. It is refused when two accounts have it or it is another account's email or name, so it never picks by guess; `accountRef` then finds no account, as the GUI passes exact names (StringKe in #4532, `TestAccountsAliasPicksTheAccount`). A GLM Coding Plan read with a key (`glmPlan`) and a ZCode account (built-in or `zcode-plugin`) whose windows' resets agree are one seat (`seatMatch`, #90/#953), shown once, on the account's card (`seatCards`, used by `quotas`, `Allotted` and `CachedCards`). A match is remembered in `seats.json` beside `quotas.json`: a failed read or a window with no reset yet is unknown and keeps the key's card off while the account is signed in; windows that disagree forget it (#1515). Cards carry `Seat` (the key provider's name, and the key's when it has several) and `Alias` (the user's name, else the plugin's, else `Seat`) with `Named` when it is the user's own, which Hide accounts leaves in sight (#3656), as `/v1/magpie/quotas`, `magpie quota` and `magpie accounts` do. Records (a trace's `who`, usage's `ProviderAccount`) keep the vendor's name, the key the user's name is kept by, and every list of them looks the name up as it is shown (`AccountShown`, `AccountShownOf`, `AccountRef.Shown`), so a request from before a rename reads by the new name too: the Routing page's accounts and requests (`userShown` in `plugins/routing/client.js`, from `/api/providers`' `accountNames`), its Several accounts pools (`onOf`), the Usage page's Accounts and the request log's Account filter (`usageapi`), `magpie usage`, and a gateway key's accounts (`AccountNames`, `/api/caller-keys`). Before plugins#310 (a renamed Kiro account read by its old name on every request after) those showed the vendor's name. An account with no name of the user's own goes by the name its plugin's `usage()` gives it (`PluginUserOf`, the `user` of its last read: `loginUsageCache`, else `quotas.json`), else by its id: a Huawei Cloud CodeArts account kept by its IAM id `iam::<domain>:user:<name>` reads as the masked phone its card shows (#4416). `AccountShown`, `AccountShownOf` and `AccountLabelOf` (cards' `Alias`, `magpie accounts`, usageapi's Account filter, the quota alert) apply it, and the GUI has it as `/api/providers`' `accountUsers` (`accountShownOf` in app.js: the editor's rows, the per-account proxy lines, Routing's `userShown`, Hide accounts). The id stays the key everything is kept by; nothing stored changes. A read that fails keeps the last good `user`; nothing read yet, or a plugin whose windows are all model pools (not kept in `quotas.json`) after a restart, is its id until the next read. | [`account_names.go`](../../internal/provider/account_names.go), [`account_seats.go`](../../internal/provider/account_seats.go) |
 | Last served | `served.json` records when each account, plan or key last answered, shown as `lastServedAt` (#570) on `/v1/magpie/quotas` and on the Usage page's own cards (`Quotas` → `cardsServed`, this computer's cards only, the caches left alone). The Usage page and the tray panel show the last-answered account in full, and a menu bar card that follows the account in use (`codex|*`) takes the one that answered within the last hour, else `InUseLogin`'s guess, else the one that answered last at all (a plugin's accounts, #1516) (`trayInUseCard`; okingkee on X: A spent, B answering, the menu bar stayed on A). `NoteServed` calls `OnServedMoved` when a provider's answers move to another account or key, and `SwitchLogin` after a switch, so the menu bar reads its cards again at once. | [`served.go`](../../internal/provider/served.go), [`trayusage.go`](../../internal/gui/trayusage.go) |
diff --git a/internal/provider/mistral_plan.go b/internal/provider/mistral_plan.go
index b9e9b9436..6e2dd5883 100644
--- a/internal/provider/mistral_plan.go
+++ b/internal/provider/mistral_plan.go
@@ -142,10 +142,13 @@ func readMistralPlan(b []byte) (string, []QuotaWindow, error) {
 }
 
 // mistralKeyWindows is readMistralBudget's window for the key's kind, with
-// the plan it is on, asked only of a key that has a budget; the card
-// stands without its name when billing/subscription can't be read. A key
-// whose kind whoami doesn't tell has no card read: the organization's
-// budget alone doesn't say which of its two it spends.
+// the plan it is on, asked only of a key that has a budget. The
+// subscription's read failing is unknown, an error — the last reading
+// stands over it (a card read before keeps its, as a vendor failing a
+// while does) — never a spent window that stops a key Mistral bills past
+// its budget (#5087). A key whose kind whoami doesn't tell has no card
+// read: the organization's budget alone doesn't say which of its two it
+// spends.
 func mistralKeyWindows(ctx context.Context, src planQuotaSource, key string) (string, []QuotaWindow, error) {
 	kind, err := mistralKeyKind(ctx, key)
 	if err != nil {
@@ -162,14 +165,23 @@ func mistralKeyWindows(ctx context.Context, src planQuotaSource, key string) (st
 	if err != nil || len(ws) == 0 {
 		return "", ws, err
 	}
+	// whether what goes past the budget is billed is the subscription's
+	// to tell, so its read failing is unknown, an error, and no window of
+	// this read stands on it (#5087): the ask is named, with what
+	// Mistral said in it, as whoami's is
 	var sub mistralSubscription
-	if sb, err := planBody(ctx, planQuotaSource{url: mistralSubscriptionURL, bearer: true}, key); err == nil && json.Unmarshal(sb, &sub) == nil {
-		payg := sub.VibePaygEnabled
-		if kind == mistralAPIKey {
-			payg = sub.PaygEnabled
-		}
-		ws, _ = readMistralBudget(b, kind, payg)
+	sb, err := planBody(ctx, planQuotaSource{url: mistralSubscriptionURL, bearer: true}, key)
+	if err != nil {
+		return "", nil, fmt.Errorf("mistral subscription: %s", err)
+	}
+	if err = json.Unmarshal(sb, &sub); err != nil {
+		return "", nil, fmt.Errorf("mistral subscription: %s", err)
+	}
+	payg := sub.VibePaygEnabled
+	if kind == mistralAPIKey {
+		payg = sub.PaygEnabled
 	}
+	ws, _ = readMistralBudget(b, kind, payg)
 	name := strings.ToUpper(strings.TrimSpace(sub.PlanName))
 	plan := mistralPlanTitles[name]
 	if plan == "" {
diff --git a/internal/provider/mistral_plan_test.go b/internal/provider/mistral_plan_test.go
index f5d82666d..5b6d32214 100644
--- a/internal/provider/mistral_plan_test.go
+++ b/internal/provider/mistral_plan_test.go
@@ -94,10 +94,12 @@ func TestMistralVibeBudget(t *testing.T) {
 		t.Errorf("pro, payg: %q %+v %v", plan, ws, err)
 	}
 
-	// the subscription unread: the window stands, with no plan name
+	// the subscription unread: unknown, so an error naming the ask —
+	// the last reading stands over it, never a spent window that stops
+	// the key (#5087)
 	budget, sub = reply{200, vibe}, reply{500, `{"message":"boom"}`}
-	if plan, ws, err := read(); err != nil || plan != "" || len(ws) != 1 || ws[0].Used != 42.5 {
-		t.Errorf("no subscription: %q %+v %v", plan, ws, err)
+	if plan, ws, err := read(); err == nil || !strings.Contains(err.Error(), "mistral subscription") || len(ws) != 0 {
+		t.Errorf("no subscription: %q %+v %v, want an error naming the ask", plan, ws, err)
 	}
 
 	// a key with no Vibe budget: no windows, so no card, and nothing more asked
@@ -120,6 +122,96 @@ func TestMistralVibeBudget(t *testing.T) {
 	}
 }
 
+// A spent API budget with the subscription unread is unknown, not a spent
+// month that stops a key: whether what goes past the budget is billed is
+// the subscription's pay-as-you-go to tell (yetone on #5087: a
+// pay-as-you-go organization's spent budget would hold a key Mistral
+// keeps serving), so a read of it that fails is an error the last reading
+// stands over, with what Mistral said in it.
+func TestMistralSubscriptionUnread(t *testing.T) {
+	type reply struct {
+		status int
+		body   string
+	}
+	// one organization's budgets, the API month spent, its own
+	// payg_enabled unnamed: the subscription's is the one that decides
+	const spent = `{"vibe_budget":{"usage_percentage":0.43,"initial_budget":150.0,"currency":"USD","reset_at":"2026-12-01T00:00:00Z","payg_enabled":false},"api_budget":{"usage_percentage":100.0,"initial_budget":15.0,"currency":"USD","reset_at":"2026-12-01T00:00:00Z"}}`
+	who := reply{200, `{"plan_type":"API","plan_name":"INDIVIDUAL"}`}
+	budget := reply{200, spent}
+	sub := reply{500, `{"message":"boom"}`}
+	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		var rep reply
+		switch r.URL.Path {
+		case "/api/vibe/whoami":
+			rep = who
+		case "/v1/billing/budget":
+			rep = budget
+		case "/v1/billing/subscription":
+			rep = sub
+		default:
+			http.NotFound(w, r)
+			return
+		}
+		w.Header().Set("Content-Type", "application/json")
+		w.WriteHeader(rep.status)
+		w.Write([]byte(rep.body))
+	}))
+	t.Cleanup(srv.Close)
+	addr := srv.Listener.Addr().String()
+	old := http.DefaultClient.Transport
+	http.DefaultClient.Transport = &http.Transport{
+		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
+			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, addr)
+		},
+		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
+	}
+	t.Cleanup(func() { http.DefaultClient.Transport = old })
+	mistralKeyKinds.Clear()
+	t.Cleanup(mistralKeyKinds.Clear)
+
+	p := Provider{ID: "mistral", Chat: "https://api.mistral.ai/v1", Key: "spent-key"}
+	src, ok := planQuotaSourceOf(p)
+	if !ok {
+		t.Fatalf("source: %+v %v", src, ok)
+	}
+	read := func() (string, []QuotaWindow, error) {
+		plan, ws, _, err := planKeyWindows(context.Background(), p, src, p.Key)
+		return plan, ws, err
+	}
+
+	// the subscription unread (a 500, a key without its scope, a body
+	// that isn't the reply): an error naming the ask, Mistral's words in
+	// it, and no window read — never a spent month that stops the key
+	for _, bad := range []reply{
+		{500, `{"message":"boom"}`},
+		{401, `{"message":"Invalid API Key"}`},
+		{200, `<html>not the reply</html>`},
+	} {
+		sub = bad
+		plan, ws, err := read()
+		if err == nil || plan != "" || len(ws) != 0 {
+			t.Errorf("%d %q: %q %+v %v, want an error and no windows", bad.status, bad.body, plan, ws, err)
+			continue
+		}
+		if !strings.Contains(err.Error(), "mistral subscription") {
+			t.Errorf("%d: %v, want the ask named", bad.status, err)
+		}
+		if bad.status == 500 && !strings.Contains(err.Error(), "boom") {
+			t.Errorf("500: %v, want what Mistral said", err)
+		}
+		if bad.status == 401 && !strings.Contains(err.Error(), "Invalid API Key") {
+			t.Errorf("401: %v, want what Mistral said", err)
+		}
+	}
+
+	// read whole: the plan's name, and pay-as-you-go leaving a spent
+	// month going, as it is billed past the budget
+	sub = reply{200, `{"plan_name":"INDIVIDUAL","payg_enabled":true,"vibe_payg_enabled":false,"enterprise":false}`}
+	if plan, ws, err := read(); err != nil || plan != "Pro" || len(ws) != 1 || !ws[0].Aside || ws[0].Used != 100 || ws[0].Amount != 15 {
+		t.Errorf("whole: %q %+v %v", plan, ws, err)
+	}
+}
+
 // A Studio key (made in console.mistral.ai, whoami's plan_type "API") of
 // the same organization is told the same budget body as its Vibe key, and
 // spends the api_budget, not the Vibe month (dhanyqaz on Discord: the
-- 
2.50.1 (Apple Git-155)

```

</details>

SHA-256 (first 16): `fa4e11ca2c4459f5`

**Verification**

| Check | Result |
| --- | --- |
| **Not verified** — a real pay-as-you-go Mistral organization's failure shapes: what `/v1/billing/subscription` says to a key without the dashboard scope, and that a real spent month's body carries no `payg_enabled` of its own, are @ninondev's to confirm — my reply shapes are main's own fixtures | left to the reporters |
| Yetone's asked test — budget 200, spent API month, subscription 500 (`TestMistralSubscriptionUnread`) | red on main (spent window, `Aside` false, no error); green after |
| 401 without the scope, and a reply that isn't JSON — the ask named, Mistral's words kept (`TestMistralSubscriptionUnread`) | ok |
| The old silent stand flips (`TestMistralVibeBudget`, "the subscription unread") | was "window stands, no plan name, no error"; now an error naming the ask |
| Both endpoints answering — behavior unchanged: plan name titled, `payg_enabled` leaves a spent month going (`TestMistralSubscriptionUnread` whole; `TestMistralVibeBudget`, `TestMistralStudioBudget`) | ok |
| Ablation: the error hunk swallowed again (main's `err == nil &&`) | `TestMistralSubscriptionUnread`, `TestMistralVibeBudget` red; restored, green |
| `go test ./internal/provider -tags nogui -count=1` (whole package) | ok (108s) |
| `go test ./internal/gateway -tags nogui -timeout 25m -count=1` | ok (774s) |
| `TestMistral`, `TestPlanQuota` under `-race` | ok |
| `gofmt -l`; `go vet -tags nogui ./internal/provider ./internal/gateway` darwin and GOOS=linux; `go build -tags nogui ./...` and GOOS=linux the two packages | clean, ok |
| `git am -3` on a clean tree at upstream/main 4ef47b3f4 | applies as is |

**Sibling faces checked, none touched**: `planKeyWindows`'s Mistral case passes the error through as the Command Code case does; `PlanQuotas`'s `err != nil && !sure` is the keep-last-reading pipe the error now feeds, unchanged; `readKeyAllowance` already refuses to route by a failed read, unchanged; `readMistralPlan` (the source's reader without a key) never asks the subscription — no kind, no windows, back before it — unchanged; the balance route has no Mistral entry and keeps none; the GUI merges cards by window name and colors icons, and parses no card error string; `planBody`/`vendorSaid` are shared and untouched, the wrap composing on what they return. `docs/subsystems/providers-accounts.md`'s Mistral sentence gains the failure semantics.

**Not verified**

Nothing was asked of a real Mistral organization in pay-as-you-go — I have none. ninondev's live readings (#5087) are of a plan, both endpoints 200; what the subscription says to a key without the dashboard scope, and whether a real spent API budget names its own `payg_enabled`, are the confirmations this still waits for.

AI use: this patch was written by GLM-5.3-Flash (ZCode) on ggbdpq's behalf; keep its author ggbdpq (or add Co-authored-by: ggbdpq <ggbdpq@gmail.com>) when applying.

Branch: https://github.com/ggbdpq/magpie/tree/fix/5087-subscription-error (head 01cd1393461fe2f2ac456b49e0d684b07216bdbf, on upstream/main 4ef47b3f4; `git am -3` of the patch tested on a clean tree at that tip, applies as is)

