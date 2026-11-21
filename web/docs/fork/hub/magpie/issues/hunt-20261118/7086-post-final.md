Verification of @siml1169's fix (fb7680e on their fork, branch `local-provider-unmasked-on-add`). I carried it onto a branch off upstream/main and verified it independently; the commit author is preserved unchanged, so this is not my patch — what follows is what I ran and saw.

**Read the full diff** (11 files): `internal/provider/unredacted.go` (new `LocalServer`/`UnmaskedOnAdd`, `urlHost`), `internal/cli/providers_cli.go` (`addProvider` gated by `saidUnmasked`, `importCmd`), `internal/cli/provider_unmasked_cli_test.go`, `internal/tui/pages.go` (`addCmd`), `internal/gui/assets/app.js` (`unmaskRow` follows the typed address, `renderImport`, `localURLs`), `internal/gui/core_budget_test.go`, `internal/gui/tests/provider-unmasked-add.test.cjs`, and the three docs. The conflict with upstream since their base was only the byte budgets: upstream had moved them -92 (socketrow out of app.js, +68, +5) since 1318864d1, and the patch's own delta measures exactly +1,104 on both `appScriptBudget` and `coreScriptBudget`, so I carried them as head + 1,104 → 1,089,745 and 1,274,436, keeping upstream's history comment and appending the patch's own entry; `TestCoreScriptBudget` passes with those numbers.

**Claim by claim against the issue:**

- Symptom — a provider added with every address local starts unmasked, and only such a provider: `LocalServer` requires at least one address and every one of Chat/Responses/Anthropic/Gemini/Decide local (`LocalHost`); mixed local+vendor, no address, a signed-in account, a plugin's provider and another magpie all answer false (unit-tested). Confirmed end to end by the CLI test.
- "unticking the box, or `unmasked=no` on the command line, is what is saved": `applyPairs` reads the pair first and `saidUnmasked` skips the default when the command gave it; in the editor the row sets a `chosen` flag on the first tick/untick and sends its own value. Unit-tested (`unmasked=no` case) and browser-tested.
- "a provider already added keeps what it was saved with ... `provider.Add` goes on reading no address at all": `Add` is untouched; the only `Unredacted` writes in the package are the new method itself and two pre-existing copy/merge paths (1137, 1612). New `TestAddReadsNoAddress` covers it. In the editor `follows()` requires `isNew && !draft.copyOf`, and the save handler stores the switch the body sent.
- "a signed-in account, a plugin's provider and another magpie are unchanged": `LocalServer` refuses `Account != nil` — which every plugin provider has (`IsPlugin()` is `Account != nil && Account.plugin != nil`) — and `IsRemoteMagpie`; the GUI keeps the old wording and empty URL list for remote, and `renderImport` skips it by preset.

**Red / ablation** (assertion-level): with the patch's tests kept and `addProvider`'s ask reverted to upstream's file, `go test ./internal/cli/ -run TestAddProviderUnmaskedForALocalServer` fails at `provider_unmasked_cli_test.go:32: a model on this computer was added masked` (`Unredacted:false` on `127.0.0.1`); restored, the same test is green. The other three provider tests (`TestLocalServer`, `TestUnmaskedOnAdd`, `TestAddReadsNoAddress`) compile against the new methods only, so the CLI test is the red that pins the behavior through the public command path.

**Side-effect scan** (`rg` over the call surface): `provider.LocalHost`'s only non-test callers are `LocalServer` and the editor's caution (`/api/local-hosts`); `LocalServer`/`UnmaskedOnAdd` are called only by the four add-time sites; no request path reads either. `showLocal`'s existing callers are unchanged; the two new calls are the Base URL and Server address inputs.

**Matrix** (macOS arm64, go1.26.8): `go vet -tags nogui` on the four touched packages for darwin, linux and windows — clean; `go build -tags nogui ./...` for the same three — clean; `gofmt` on the six changed Go files and `git diff --check` — clean.

| Verification | Result | Environment |
|---|---|---|
| Targeted RED/GREEN (provider 5, cli 1) | all GREEN | defined unit |
| Browser (provider-unmasked-add.test.cjs) | 102/102 pass, chromium & webkit | independent frames |
| Full-package (provider/cli/gui/tui) | provider 1 fail, cli 3 fail, gui 2 fail | exclusive-rerun, base-match |
| `-race` on provider/cli/gui/tui, carrier | exit 1: 8 DATA RACE reports (cli 7, gui 1), tui ok | exclusive window |
| `-race` on the same packages, base `b332ef7ef` without the patch | exit 1: 5 DATA RACE reports (cli 4, gui 1), tui ok | exclusive window |
| gofmt, diff --check, vet×3, build×3 | all clean | early window, uncontaminated |

Environment reds: `TestResolveVia` (documented local-proxy), cli healthcheck/update trio, gui `TestProxyCheckSaysAProxyPassedBy`, `TestSessionReadsRoutes`. These fail identically on upstream/main; none result from the patch. Race reports, corrected after the base run finished: every stack is in files the patch does not touch — `testenv.Zone`/`RunIn` against `provider.sweepStale` (`hold.go`) in the sessions tests, `netproxy/calm.go`, `serve_follow.go`, the plugin host/store in `TestPluginOffAndRemovePutTheAgentBack`/`TestGoneAgentDefault`, `accounts_import_cli_test.go`, and `gui/update.go`. The carrier had 8 reports and the base 5; the extra three are the timer-driven `sweepStale` read against the test zone's write in `TestSessionsRead`/`TestSessionsSearchFlags` and one `testenv` write in `TestSettingsSetGetReset`, and the base had one (`TestGoneAgentDefault`) the carrier did not. I read that as timing-dependent upstream test-environment races, not the patch: none of the 11 changed files appears in any stack. I did not rerun to measure how often each one fires.

One honest note on the ask itself: masking's default-off was set by 0549e5303 for every provider, so flipping the default is the maintainer's call to make; what I can say is the patch does exactly what it claims, touches only the add path, and keeps every user-set value standing.

**Attribution**: The fix, implementation and commit are @siml1169's (author: Webboy998 <limuyang@msn.com>, in the carrier commit 08336543b). The branch preserves the original author and is not my patch. Verification was AI-assisted (Claude 5.5 via ZCode).

Branch: `git fetch https://github.com/ggbdpq/magpie.git verify/7086-local-unmasked-on-add` (head 08336543b)

<details>
<summary>Patch (git am format, 99810 bytes, SHA-256 first 16: 3dd93ec372481bf4)</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Webboy998 <limuyang@msn.com>
Date: Wed, 18 Nov 2026 11:16:31 +0100
Subject: [PATCH] provider: a provider added with every address local starts
 unmasked (#7086)

What changed: a provider being added whose every address is on this
computer or on the local network -- a local preset at its own or at a
typed address, a custom provider whose URLs are local, a magpie://import
link naming one -- now starts with Send requests unmasked on, and the
editor's switch follows a Base URL or a Server address typed until the
user sets it their own way. Provider.LocalServer says such a provider
from its addresses, read the way the editor's caution reads them
(provider.LocalHost; no request ever asks); Provider.UnmaskedOnAdd turns
the switch on for one and is asked only where a provider is added:
addProvider (unless the command itself gives unmasked=) and importCmd
(internal/cli), addCmd (internal/tui), unmaskRow and renderImport
(internal/gui/assets/app.js). Nothing else changes: provider.Add reads
no address, so a saved provider keeps the switch it was saved with
whatever its address is and a copy keeps its source's; a signed-in
account, a plugin's provider and another magpie never qualify; and the
user's own word stands over the default, `unmasked=no` on the command
line and a tick or untick in the editor. Docs updated (reference.md,
subsystems/gateway-routing.md, subsystems/providers-accounts.md); the
app.js and core-script byte budgets are raised +1,104 each for the
window's part.

Run: go test ./internal/cli/ -run TestAddProviderUnmaskedForALocalServer
-count=1 -- red with addProvider's ask reverted ("a model on this
computer was added masked"), green with it restored; go test
./internal/provider/ -run
'TestLocalServer|TestUnmaskedOnAdd|TestAddReadsNoAddress|TestSkipsRedaction|TestLocalHost'
-count=1; go test ./internal/gui/ -run TestCoreScriptBudget -count=1;
go test -tags nogui -timeout=45m -count=1 ./internal/provider/
./internal/cli/ ./internal/gui/ ./internal/tui/ and the same with -race
-- green except tests that fail the same way on upstream/main here
(TestResolveVia, the cli healthcheck/update trio, gui
TestProxyCheckSaysAProxyPassedBy and TestSettingsSaveKeepsWhatItDoesNotSend,
documented local-proxy and environment reds); go vet -tags nogui on
darwin, linux and windows; go build -tags nogui ./... on darwin, linux
and windows; git diff --check and gofmt clean. Browser
provider-unmasked-add.test.cjs 102/102 (chromium and webkit, five
languages, 900 and 440 px, the API faked).

The fix is @siml1169's (fb7680e on their fork), carried here with the
author unchanged.
---
 docs/reference.md                             |   7 +
 docs/subsystems/gateway-routing.md            |   4 +-
 docs/subsystems/providers-accounts.md         |   2 +-
 internal/cli/provider_unmasked_cli_test.go    |  78 ++++++++
 internal/cli/providers_cli.go                 |  23 +++
 internal/gui/assets/app.js                    |  58 +++++-
 internal/gui/core_budget_test.go              |   4 +-
 .../gui/tests/provider-unmasked-add.test.cjs  | 168 ++++++++++++++++++
 internal/provider/unredacted.go               |  64 ++++++-
 internal/provider/unredacted_test.go          |  99 +++++++++++
 internal/tui/pages.go                         |   5 +
 11 files changed, 501 insertions(+), 11 deletions(-)
 create mode 100644 internal/cli/provider_unmasked_cli_test.go
 create mode 100644 internal/gui/tests/provider-unmasked-add.test.cjs

diff --git a/docs/reference.md b/docs/reference.md
index bf7b6fef9..adccaca57 100644
--- a/docs/reference.md
+++ b/docs/reference.md
@@ -376,6 +376,13 @@ separate Responses endpoint, `catalog=` to borrow a models.dev list, and
 `models=` to name the models to expose. Anything a preset does not know can
 be overridden the same way.
 
+One added at this computer or on the local network — a local preset, or a
+custom provider whose URLs are local — starts with *Send requests unmasked*
+on: magpie's masking keeps nothing from a machine of your own, and its first
+request would otherwise arrive masked for it. `unmasked=no` says otherwise,
+and so does the editor's switch, which wins over the address either way; a
+provider already here keeps the switch it was saved with.
+
 A model whose vendor answers that it is deprecated or retired (OpenCode
 Zen's 410 "Model exo-free has been deprecated.") leaves that provider's
 models in `magpie models`, `/v1/models` and every agent's list, even while
diff --git a/docs/subsystems/gateway-routing.md b/docs/subsystems/gateway-routing.md
index ff743e7cf..9e49287fe 100644
--- a/docs/subsystems/gateway-routing.md
+++ b/docs/subsystems/gateway-routing.md
@@ -1307,7 +1307,9 @@ OpenAI shape can't carry. GET, POST, PUT, PATCH and DELETE
   serve such a key. A model the user switched off, named in a JSON body's
   `model`, is refused.
 - **Masking.** With Settings › Privacy masking and a provider not set to
-  go unmasked, the body is decoded as JSON (numbers exact, `UseNumber`)
+  go unmasked (`provider.SkipsRedaction`: the switch the user set, which a
+  provider just added at this computer or on the local network already has,
+  `provider.UnmaskedOnAdd`), the body is decoded as JSON (numbers exact, `UseNumber`)
   and its strings masked (fails closed); a body that isn't JSON is a 415,
   as nothing unmasked may go. Only a request something was masked in has
   its answer read through `restoring`, which holds a JSON answer whole to
diff --git a/docs/subsystems/providers-accounts.md b/docs/subsystems/providers-accounts.md
index 66accdf6c..bb97f060d 100644
--- a/docs/subsystems/providers-accounts.md
+++ b/docs/subsystems/providers-accounts.md
@@ -88,7 +88,7 @@ keys and accounts per request is in [Gateway routing and fallback](gateway-routi
 | Account names and seats | `AccountNames` (by the account, in lower case, like `AccountCaps`) are names the user gives accounts, set by `SetAccountName` (GUI `provider/accountname`, `magpie accounts alias`); they live in providers.json only, never in a vendor's or plugin's sign-in. A name picks its account wherever the account's own name does (`AccountByName`): the CLI's `accountNamed` (switch, forget, alias), the pool's `--accounts`, and `accountRef` (caps, models, weights, concurrency) after an exact name. It is refused when two accounts have it or it is another account's email or name, so it never picks by guess; `accountRef` then finds no account, as the GUI passes exact names (StringKe in #4532, `TestAccountsAliasPicksTheAccount`). A GLM Coding Plan read with a key (`glmPlan`) and a ZCode account (built-in or `zcode-plugin`) whose windows' resets agree are one seat (`seatMatch`, #90/#953), shown once, on the account's card (`seatCards`, used by `quotas`, `Allotted` and `CachedCards`). A match is remembered in `seats.json` beside `quotas.json`: a failed read or a window with no reset yet is unknown and keeps the key's card off while the account is signed in; windows that disagree forget it (#1515). Cards carry `Seat` (the key provider's name, and the key's when it has several) and `Alias` (the user's name, else the plugin's, else `Seat`) with `Named` when it is the user's own, which Hide accounts leaves in sight (#3656), as `/v1/magpie/quotas`, `magpie quota` and `magpie accounts` do. Records (a trace's `who`, usage's `ProviderAccount`) keep the vendor's name, the key the user's name is kept by, and every list of them looks the name up as it is shown (`AccountShown`, `AccountShownOf`, `AccountRef.Shown`), so a request from before a rename reads by the new name too: the Routing page's accounts and requests (`userShown` in `plugins/routing/client.js`, from `/api/providers`' `accountNames`), its Several accounts pools (`onOf`), the Usage page's Accounts and the request log's Account filter (`usageapi`), `magpie usage`, and a gateway key's accounts (`AccountNames`, `/api/caller-keys`). Before plugins#310 (a renamed Kiro account read by its old name on every request after) those showed the vendor's name. An account with no name of the user's own goes by the name its plugin's `usage()` gives it (`PluginUserOf`, the `user` of its last read: `loginUsageCache`, else `quotas.json`), else by its id: a Huawei Cloud CodeArts account kept by its IAM id `iam::<domain>:user:<name>` reads as the masked phone its card shows (#4416). `AccountShown`, `AccountShownOf` and `AccountLabelOf` (cards' `Alias`, `magpie accounts`, usageapi's Account filter, the quota alert) apply it, and the GUI has it as `/api/providers`' `accountUsers` (`accountShownOf` in app.js: the editor's rows, the per-account proxy lines, Routing's `userShown`, Hide accounts). The id stays the key everything is kept by; nothing stored changes. A read that fails keeps the last good `user`; nothing read yet, or a plugin whose windows are all model pools (not kept in `quotas.json`) after a restart, is its id until the next read. | [`account_names.go`](../../internal/provider/account_names.go), [`account_seats.go`](../../internal/provider/account_seats.go) |
 | Last served | `served.json` records when each account, plan or key last answered, shown as `lastServedAt` (#570) on `/v1/magpie/quotas` and on the Usage page's own cards (`Quotas` → `cardsServed`, this computer's cards only, the caches left alone). The Usage page and the tray panel show the last-answered account in full, and a menu bar card that follows the account in use (`codex|*`) takes the one that answered within the last hour, else `InUseLogin`'s guess, else the one that answered last at all (a plugin's accounts, #1516) (`trayInUseCard`; okingkee on X: A spent, B answering, the menu bar stayed on A). `NoteServed` calls `OnServedMoved` when a provider's answers move to another account or key, and `SwitchLogin` after a switch, so the menu bar reads its cards again at once. | [`served.go`](../../internal/provider/served.go), [`trayusage.go`](../../internal/gui/trayusage.go) |
 | Partners | Services that pay to be listed first in the add sheet, under a heading of their own ("Partners · magpie's sponsors"). The list is `site/partners.js`, served at `usemagpie.ai/api/partners`: a change reaches users with a deploy, not a release. `Partners` never waits: it returns what was fetched last and fetches again behind the call on a process's first ask, whatever the kept list's age, and hourly after (10 minutes after a failure), keeping the list in `partners.json` in the cache folder. The magpie serving the gateway fetches it when it starts and whenever it is due, asked for or not (`KeepPartnersFresh`), so an app left open on another page still learns of a partner added. The file also says when the last fetch started (`tried`) and, when it failed, why (`error`, logged once until a fetch gets the list again), so a list that stops changing tells a fetch that fails from one that never came back (`tried` after `at`, no error) and from none asked (#3362). Each entry is checked again on every read (`validPartners`): its own id, never a built-in preset's, a name, an endpoint, https only, at most 12; what only magpie's presets may set (a decision API, no key, a user endpoint) is cleared. Its logo is fetched through `FetchIcon` and kept as an uploaded icon, used as it is while its `iconUrl` stays the same; the prune after a save of `providers.json` (`pruneIcons`) leaves the logos of the partners listed now (`keptPartnerIcons`), as it leaves a plugin's. A partner is a preset to the rest of magpie (`Preset`, `FromPreset`, the editor), and one no longer listed still is to the providers added from it (`Seen`), without the sponsored mark. The window lists a partner in the languages it names (`langs`) only and shows its tagline in the page's language (`notes`, else `en`). `MAGPIE_PARTNERS` points it elsewhere, `off` lists none; tests list none unless they name a list. How often each listed partner was shown, opened (its row, its key page) and added is counted per UTC day (`CountPartner`, capped at 20 of each and 5 adds, kept in `partner-counts.json` in the cache folder) and sent with the next day's stats event as `magpie partner` events (`internal/stats`); nothing is counted with the stats or their usage part off. A listed partner the add sheet (or the TUI's, or `magpie providers presets`) hasn't shown yet is new (`NoticePartners` keeps those shown, as `noticed` in `partners.json`, whatever the stats); the window's add button carries a small dot for it, with its name in the title, until the sheet shows it. | [`partners.go`](../../internal/provider/partners.go), [`partner_events.go`](../../internal/provider/partner_events.go), [`site/partners.js`](../../site/partners.js) |
-| Local servers | A preset of `KindLocal` (Ollama, LM Studio, oMLX, MLX-Serve) is at its server's default port on this machine. Another address — a port, or another computer — is given in the window's editor, in its Server address field, shown first above the key and never folded (a folded one read as an LM Studio whose base URL can't be changed, mengxiangziyou on X), or in the TUI (asked on adding, `w` after); on the command line with `address=` (`atAddress` in `providers_cli.go`: every URL moves, from the preset's when the provider was saved with none, and `address=` alone puts a local server back at its preset's), or the URLs themselves (`url=`, `anthropic=`, `responses=`). `AtAddress` replaces only each URL's scheme, host and port, each API keeping its path; `AddressOf` is the address an editor starts from. The window sends the URLs moved only when the address was changed, so a Save doesn't move URLs set apart (another app's import). A provider of the user's own (no preset) has `w` in the TUI too: each base URL it has is asked in turn, typed in as it is, Enter alone keeping one (`customURLsAsk`). | [`local_address.go`](../../internal/provider/local_address.go), [`providers_cli.go`](../../internal/cli/providers_cli.go) |
+| Local servers | A preset of `KindLocal` (Ollama, LM Studio, oMLX, MLX-Serve) is at its server's default port on this machine. Another address — a port, or another computer — is given in the window's editor, in its Server address field, shown first above the key and never folded (a folded one read as an LM Studio whose base URL can't be changed, mengxiangziyou on X), or in the TUI (asked on adding, `w` after); on the command line with `address=` (`atAddress` in `providers_cli.go`: every URL moves, from the preset's when the provider was saved with none, and `address=` alone puts a local server back at its preset's), or the URLs themselves (`url=`, `anthropic=`, `responses=`). `AtAddress` replaces only each URL's scheme, host and port, each API keeping its path; `AddressOf` is the address an editor starts from. The window sends the URLs moved only when the address was changed, so a Save doesn't move URLs set apart (another app's import). A provider of the user's own (no preset) has `w` in the TUI too: each base URL it has is asked in turn, typed in as it is, Enter alone keeping one (`customURLsAsk`). One added at this computer or on the local network — a preset's at its own or a given address, or the user's own with local URLs — starts with *Send requests unmasked* on (`Provider.UnmaskedOnAdd`, `Provider.LocalServer` in [`unredacted.go`](../../internal/provider/unredacted.go): an address, and every address it has, on a local host; a signed-in account's, a plugin's and another magpie's never are): it is their own machine, which holds whatever they say to it, so masking keeps nothing from it there, and its first request would otherwise arrive masked for it. The switch the user set stands over that default — `unmasked=no` on the command line, and a tick or an untick in the editor, which sends its own value — and a saved provider keeps what it was saved with whatever its address is, a copy keeping its source's, because `Add` reads no address at all: only whoever adds one asks (`addProvider` and `importCmd` in [`providers_cli.go`](../../internal/cli/providers_cli.go), `addCmd` in the TUI, `unmaskRow` in app.js, which follows a Base URL or a Server address typed until the user sets the switch their own way, and `renderImport` for a `magpie://import` link that names local URLs). A name of the user's own DNS is looked up once, at that moment, as the editor's caution does (`LocalHost`), never on a request. | [`local_address.go`](../../internal/provider/local_address.go), [`providers_cli.go`](../../internal/cli/providers_cli.go), [`unredacted.go`](../../internal/provider/unredacted.go) |
 | Protocol detection | Works out which of Chat, Responses, Anthropic Messages and Gemini generateContent a base URL speaks when a provider is added. Each is asked at the URL as it takes it (`DetectBase`); Gemini's at the `…/v1beta` beside a typed `…/v1` or bare host, a Gemini model from the list picked for it, with the key in `x-goog-api-key` (#1346). Each API is asked with a model that chats, if the list has one; an embedding or rerank model (`catalog.ServesOf`) is asked only on Chat's URL, at its `/embeddings` or `/rerank` with the smallest body and no extra body, as the gateway's `retrieve` asks it, and the other APIs say why they weren't asked (heatonz on Discord: a vendor of only those detected nothing, asked to chat; `TestDetectEmbeddingOnly`). A saved provider whose list has nothing to chat with tests on such a model (`testModel`, `TestTestEmbeddingOnly`), and its editor and the add form's Fetch models say the models need no pick (`retrieval` in the list's answer and the provider's JSON, `provider-retrieval-only.test.cjs`). A model's test (Test models, a model's right-click, `magpie provider test`) asks the account or key a request for it goes to: `provider.AccountsFor` and `provider.KeysFor` ([`route_accounts.go`](../../internal/provider/route_accounts.go)), which the gateway's `perKeyEvery` routes by too, its usage and spend caps aside (one the user lets serve it, `AccountModels`; whose own list or plan has it, `Account.Lists`, `PlanServing`, `Serving`; in the user's order, `AccountsOn`), so a pool whose accounts list different models (a newapi plugin's) asks the one whose list has it, and one every account is barred from isn't asked. The provider's Test picks each endpoint's model from every account's and asks it of the account that serves it (`routedTo`), and with keys the first key with a model of its own to test (`testWith`). The request log's row names the account asked (`loggedAs`; #4992, `TestModelTestAsksTheAccountThatServesIt`). A model's right-click *Test on account…* (tmr11235 on X; a provider with two or more accounts or keys that are on, `TestPicks`) pins its test to one of them (`TestOn`, `accountNamed`, `keyNamed`, the GUI's `account`; `TestModelTestPinnedToAKey`, `TestModelTestPinnedToAnAccount`, `model-test-account.test.cjs`), and every result names the account or key it went to (`Result.Account`, `testedAccount`), so the status line says which one answered. Test models and `magpie providers` still test with routing's pick. Detection, endpoint tests and model tests share `probe`, which adds `anthropic-version` only for Anthropic Messages; OpenAI probes omit that default so a relay that refuses it can answer. A Chat or Responses URL typed without its version (CRS's `…/openai`, Cyrus_4433 on X: CRS serves `/openai/v1/chat/completions` and `/openai/responses`, and answers anything else 404 `Not Found`) that is answered 404 is asked once more under `/v1` (`missingV1`, not for an account, Azure, Bedrock or Vertex); answered there, the saved provider's URL takes the `/v1` (`setV1`), the result carries it (`Result.V1`), Detect hands it on as the base, and the editor's URL field follows (`draft.onV1`), so Save doesn't put it back. A model's own 404 at both stays a 404 and changes nothing. CRS lists at `/api/v1/models`, which `catalog.RelayOpenAIList` adds to an unversioned `…/openai` base's list URLs, and a list answered there adds `/v1` as `fixV1` does (`TestCRSOpenAIBaseTestsUnderV1`, `TestCRSOpenAIBaseListsAtAPI`, `TestCRSOpenAIBaseDetectsV1`, `TestModel404KeepsBase`, `provider-test-v1.test.cjs`). A model's test that the vendor turns away with its word that the model is served on another API (`catalog.WrongEndpoint`, the gateway's words) asks the next API the provider has a URL for, as the gateway's `usable` takes it (the model's picked or listed API, else each API it isn't named-only on), with a key that sees the model there (`keySeeing`); that API's answer is the model's, and with none left, or every one saying it, the first stays. As Codex the next API is asked with Codex's headers, as the gateway sends them on Responses and Chat; as Claude Code it isn't, since the gateway sends Claude Code's on Messages alone (#3766, `TestTestModelsMovesToTheAPIServingIt`, `TestTestModelsKeepsAModelOnItsAPI`, `TestTestModelsAsAClientMovesAsTheGatewayDoes`). User-supplied headers still apply through `Sign`. The editor asks with the form as it stands, before any Save (#1545): the URL, key and models typed (`picked`, else the saved picks, else the vendor list); a key not typed again is the saved provider's, or for an unsaved copy the copied one's (`copyOf`). The probe writes nothing and adds no provider, and the route stays behind `magpie web`'s key. An endpoint or model test fails fast and can be stopped (RIck on Discord: 测试模型 took long to fail and couldn't be cancelled): a probe on magpie's own client that has no connection in `connectWait` (10s) fails then (`connecting`, an httptrace `GotConn`), and a host that couldn't be reached (no connection, DNS, refused, a bad certificate) fails the run's other models at once (`withUnreached`, `TestTestModelsUnreachedHostFailsOnce`); a stream that breaks off before an answer is a failure. While a test runs its Test models and endpoints' Test read Stop, which aborts the window's request and posts `provider/teststop` with the test's `run`, ending the vendor's request on the server too (`testRuns` in [`providers.go`](../../internal/gui/providers.go), since WebView2 doesn't end the request when a fetch is aborted; `TestProviderTestStops`, `model-test-stop.test.cjs`). | [`detect.go`](../../internal/provider/detect.go), [`test.go`](../../internal/provider/test.go) |
 | A pasted curl command | A curl command from a vendor's docs pasted into a custom provider's Base URL or API key fills the editor in (@mark_li21 on X). `curlOf` reads it as a shell would (lines joined by `\`, cmd's `^` or PowerShell's backtick; `curl.exe`; quotes and escapes), and takes: the API its URL's endpoint names (`…/chat/completions` Chat, `…/messages` Anthropic Messages, `…/responses` Responses) with the base URL before it, spelled as that API wants it (`respellURL`: Anthropic at its root, `/v1` after a bare host); the key from `Authorization: Bearer`, `x-api-key` or `api-key`, unless it only stands for one (`$OPENAI_API_KEY`, `${X}`, `%X%`, `<token>`, `YOUR_API_KEY`), when the key's box is left empty and focused; and the `model` of its JSON body, added to a new provider's models (a saved one's picks are left alone, since adding to none would narrow what it serves). A preset's editor takes only the key. A note (`editorError`, kind `note`) says what was taken, a placeholder like `{WorkspaceId}` left in the URL, and a URL with no known endpoint. Text that isn't a curl command pastes as before, several keys included. Tested on the docs' own examples (`fixtures/curl`). | [`app.js`](../../internal/gui/assets/app.js) (`curlOf`, `fromCurl`), [`provider-curl-paste.test.cjs`](../../internal/gui/tests/provider-curl-paste.test.cjs) |
 | Saved proxies | `settings.Proxies` holds named proxies (`NamedProxy`: id, name, address, optional login), kept in Settings › Network. Wherever a proxy is chosen (global, plugin downloads, app updates, a provider, a key, a Claude account) the value is "" (inherit), `direct`, an address as typed, or `@<id>` for a saved one (@tsingchao on X). Addresses as typed are untouched. App updates take a proxy of their own, Settings › Network › App updates (`settings.UpdateProxy`, `magpie settings set updateProxy <url|direct>`; moonlityu on X: models direct, updates through a proxy): "" follows the global proxy as before, a proxy given to one `magpie update --proxy` run comes first, and it covers the feed, the notes and the release's file (`updateProxy` in [`update.go`](../../internal/update/update.go); `TestUpdateTakesItsOwnProxy`, `settings-update-proxy.test.cjs`). Per-model proxies within one provider are not offered: a proxy belongs to a provider, an account or a key, and a model that needs the other route is a second provider on the same URL. `netproxy.Parse`, `Resolve`, `Redact`, `EnvWith` and `Dispatch` resolve an `@id` at the lowest layer, so an edit reaches every user at the next request; a Claude Code `settings.json` env is a snapshot and is rewritten after an edit (`provider.ProxyEdited`). An `@id` this computer lacks fails closed (`netproxy.DeadProxy`, the request error and the provider row say "Proxy missing: {name}", `provider.ProxyGone`); it never goes direct. The password is written to settings.json (0600) and never read back by the page (nor sent in `/api/state`'s settings, with the LAN key, Bark key and GitHub token: `stateSettings`, `TestStateSendsNoCredentials`), logged or put in `Settings` sync; the list rides with the providers part of a sync (`backup.Bundle.Proxies`, `settings.MergeProxies`, passwords only with keys). A proxy in use cannot be deleted (409). A saved proxy can be an SSH server (`ssh://host:port`, a user, a password and/or a private key; @laiuuui on X, whose VPS gives only SSH): magpie logs in itself with golang.org/x/crypto/ssh, no ssh command, and resolves the `@id` to a SOCKS5 server of its own on loopback (`socks5h://magpie:<random>@127.0.0.1:<port>`, which takes only that login), carrying each CONNECT as a direct-tcpip channel, as `ssh -D` does. It logs in on the first request, keeps the connection with keepalive@openssh.com every 20s (15s with no answer ends it), and logs in again once when a channel finds it dead (`sshTunnel` in [`ssh.go`](../../internal/netproxy/ssh.go)). Save logs in first, so a refused login is said there and nothing is kept; the host key is trusted on first use and kept as `HostKey` (authorized_keys form, the page shows its SHA256 fingerprint), and a server showing another key is refused (`HostKeyChangedError`) until Advanced › Trust a new key. The key is a secret as the password is: `WithoutProxyPasswords`, `MergeProxies`, `KeepSecretsOf`. An `ssh://` typed as an address is refused: its login belongs to a saved proxy. Every request to the server needs it to allow forwarding: macOS 27's sshd hangs up on a forward (also with OpenSSH's own `ssh -W`), and that is said as "won't forward connections" (`SSHForwardWhy`). A failed proxy says why (`netproxy.Why`: an English template the page translates, its `{addr}`, `{was}`, `{now}` filled; `fail` in api.go sends it as `code: proxy_why`, a check as `why`/`addr`): `Explain` reads Go's error, and `ExplainServer`, for a check the user asked for only, reads the server's first bytes when the text can't tell, since Go reads a real OpenSSH banner ("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.20") as an HTTP status line with a bad code. Each save is tested at once. A Test (Settings, and the provider editor's Saved mode) asks Cloudflare's trace page through the proxy, only on a click: its latency runs from the request written to the answer's first byte, so a new connection's dial, tunnel and TLS don't count and a second Test reads like the first, and the exit's region is named in the reader's language (IcyLiqu1d on X). An editor opened before Settings was read draws its picker again once the saved proxies are in. `TestSavedProxyLatencyIsTheRoundTrip`, `provider-proxy-pick-test.test.cjs`, `TestSavedProxyChoice`, `TestDanglingProxyReferenceFailsClosed`, `TestSavedProxiesTravelWithProviders`, `TestSSHProxyCarriesRequests`, `TestSSHProxyRefusesAChangedHostKey`, `TestSSHProxySaysWhyItFailed`, `TestProxyFailureNamesAnSSHServer`, `TestSavedSSHProxyAPI`, `TestSavedSSHProxyThatWontForward` (an SSH server in the test, `netproxy/sshtest`, never the network), `saved-proxies.test.cjs`, `saved-ssh-proxy.test.cjs`, `provider-proxy-missing.test.cjs`. | [`proxies.go`](../../internal/settings/proxies.go), [`netproxy.go`](../../internal/netproxy/netproxy.go), [`ssh.go`](../../internal/netproxy/ssh.go), [`why.go`](../../internal/netproxy/why.go), [`proxies.go`](../../internal/gui/proxies.go) |
diff --git a/internal/cli/provider_unmasked_cli_test.go b/internal/cli/provider_unmasked_cli_test.go
new file mode 100644
index 000000000..a8fe25087
--- /dev/null
+++ b/internal/cli/provider_unmasked_cli_test.go
@@ -0,0 +1,78 @@
+package cli
+
+import (
+	"net/http"
+	"net/http/httptest"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// The user's own model at their own computer adds itself with the masking
+// switch on (provider.UnmaskedOnAdd, the owner 11-18): `magpie provider add
+// mybox chat=http://127.0.0.1:8080/v1`, and a local preset at the address it
+// is given. `unmasked=no` is their word for it and stands, whatever the
+// address says; a vendor's provider is added masked, as before.
+func TestAddProviderUnmaskedForALocalServer(t *testing.T) {
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	box := localModels(t)
+	if err := addProvider([]string{"mybox", "chat=" + box.URL + "/v1"}); err != nil {
+		t.Fatal(err)
+	}
+	p, err := provider.Find("mybox")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if !p.Unredacted {
+		t.Fatalf("a model on this computer was added masked: %+v", p)
+	}
+	if p.Chat != box.URL+"/v1" {
+		t.Fatalf("chat %q, want %s/v1", p.Chat, box.URL)
+	}
+
+	// a local preset, moved to the server by the address it is added with
+	studio := localModels(t)
+	if err := addProvider([]string{"lmstudio", "address=" + strings.TrimPrefix(studio.URL, "http://")}); err != nil {
+		t.Fatal(err)
+	}
+	if p, err = provider.Find("lmstudio"); err != nil {
+		t.Fatal(err)
+	}
+	if !p.Unredacted {
+		t.Fatal("a local preset at the address it was added with came in masked")
+	}
+
+	// the switch said in the command is the user's, and nothing reads the
+	// address over it
+	quiet := localModels(t)
+	if err := addProvider([]string{"quiet box", "chat=" + quiet.URL + "/v1", "unmasked=no"}); err != nil {
+		t.Fatal(err)
+	}
+	if p, err = provider.Find("quiet-box"); err != nil {
+		t.Fatal(err)
+	}
+	if p.Unredacted {
+		t.Fatal("unmasked=no was overridden by the address")
+	}
+}
+
+// localModels is a local server answering a model list, as one on this
+// computer does.
+func localModels(t *testing.T) *httptest.Server {
+	t.Helper()
+	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		w.Header().Set("Content-Type", "application/json")
+		if r.URL.Path == "/v1/models" {
+			_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"qwen3.5-9b","object":"model","owned_by":"organization_owner"}]}`))
+			return
+		}
+		http.NotFound(w, r)
+	}))
+	t.Cleanup(srv.Close)
+	return srv
+}
diff --git a/internal/cli/providers_cli.go b/internal/cli/providers_cli.go
index 68748c0cf..b5f6d2fc9 100644
--- a/internal/cli/providers_cli.go
+++ b/internal/cli/providers_cli.go
@@ -861,6 +861,13 @@ func addProvider(rest []string) error {
 	if err := applyPairs(&p, rest); err != nil {
 		return err
 	}
+	// the user's model at their own computer or on their local network goes
+	// in with "Send requests unmasked" already on (provider.UnmaskedOnAdd);
+	// `unmasked=yes|no` in the command is their word for it, whatever the
+	// address says, and stands
+	if !saidUnmasked(rest) {
+		p = p.UnmaskedOnAdd()
+	}
 	// adding a preset that is already here adds another of it (deepseek-2),
 	// for another key or another header, rather than replacing the first
 	id, err := provider.Add(p)
@@ -874,6 +881,17 @@ func addProvider(rest []string) error {
 	return announce(id)
 }
 
+// saidUnmasked says the command gave the masking switch itself, which is
+// then the answer and nothing is read off the address.
+func saidUnmasked(pairs []string) bool {
+	for _, kv := range pairs {
+		if k, _, ok := strings.Cut(kv, "="); ok && strings.ToLower(k) == "unmasked" {
+			return true
+		}
+	}
+	return false
+}
+
 // saveNew saves a provider the user just added, then asks the vendor for
 // its models.
 func saveNew(p provider.Provider) error {
@@ -1845,6 +1863,11 @@ func importCmd(args []string) error {
 	if p.Key == "" && !p.Ready() {
 		fmt.Println(amber.Render("!"), "the link has no key · magpie provider key", p.ID, "<key>")
 	}
+	// the link says nothing of the masking switch, so the address is what
+	// there is to read: the user's model at their own computer or on their
+	// local network starts unmasked, as an add of one does
+	// (provider.UnmaskedOnAdd)
+	p = p.UnmaskedOnAdd()
 	return saveNew(p)
 }
 
diff --git a/internal/gui/assets/app.js b/internal/gui/assets/app.js
index 7fc1313a7..3ba9f8bea 100644
--- a/internal/gui/assets/app.js
+++ b/internal/gui/assets/app.js
@@ -9722,16 +9722,38 @@ function drawEditor(p, presetID) {
     return renderRouting(p);
   };
 
+  // A provider being added at the user's own computer or on their local
+  // network starts with the switch on (the owner, 11-18): their machine,
+  // which holds whatever they say to it, so masking keeps nothing from them
+  // there, and its first request would otherwise arrive masked for it. It
+  // follows the address typed until they set the switch their own way, which
+  // then stands over it. A saved provider keeps what it was saved with, a
+  // copy keeps its source's, an account's and a plugin's vendor is
+  // elsewhere, and another magpie's addresses are that other computer's,
+  // which masks by its own Settings › Privacy (provider.UnmaskedOnAdd reads
+  // the same thing for the CLI and the TUI).
   const unmaskRow = (hint, urls) => {
+    let chosen = false; // the user's word about the switch, once they give it
+    const follows = () => isNew && !draft.copyOf && !!urls && !chosen;
+    const localOnly = () => localURLs(urls ? urls() : []);
+    // set before the tick is drawn, so it is what Add sends; Advanced stays
+    // folded as the editor draws it (a default opens no fold), and the
+    // saved provider opens on it the next time it is edited
+    if (follows()) draft.unredacted = localOnly();
     const [ltk, lcb] = tick(t("Send requests unmasked"), !!draft.unredacted);
+    ltk.classList.add("unmasked");
     const row = field(t("Masking"), ltk, hint), note = el("div", "hint unmasked-away");
     row[1].append(note);
     showLocal = () => {
+      const local = follows() ? localOnly() : null;
+      if (local !== null && local !== !!draft.unredacted) draft.unredacted = lcb.checked = local;
       const host = draft.unredacted && (urls ? awayHost(urls()) : p.name);
       note.hidden = !(note.textContent = host ? t("{host} isn't on this computer or your local network: turned on, requests go to it unmasked.", { host }) : "");
-      if (draft.unredacted && urls) askLANNames(urls(), showLocal);
+      // a name is asked about once, a moment after it is typed: for the
+      // caution, and to know which way a provider being added goes
+      if (urls && (draft.unredacted || follows())) askLANNames(urls(), showLocal);
     };
-    lcb.onchange = () => { draft.unredacted = lcb.checked; showLocal(); };
+    lcb.onchange = () => { chosen = true; draft.unredacted = lcb.checked; showLocal(); };
     showLocal();
     return row;
   };
@@ -9843,7 +9865,7 @@ function drawEditor(p, presetID) {
     if (draft.chat === undefined) { draft.chat = p?.chat || ""; draft.responses = p?.responses || ""; }
     endpoint = input(draft.chat || draft.responses || "", pr.endpoint, "url");
     endpoint.classList.add("endpoint");
-    endpoint.oninput = () => { draft.chat = draft.responses = endpoint.value.trim(); refreshEndpoints(); showCompaction(); showSocket(); };
+    endpoint.oninput = () => { draft.chat = draft.responses = endpoint.value.trim(); refreshEndpoints(); showLocal(); showCompaction(); showSocket(); };
     ed.append(...field(t("Endpoint"), endpoint, pr.endpointHint ? t(pr.endpointHint) : ""));
   }
 
@@ -9864,6 +9886,7 @@ function drawEditor(p, presetID) {
     address.oninput = () => {
       draft.address = address.value;
       refreshEndpoints();
+      showLocal();
       const du = ed.querySelector("input.decide-url");
       if (du && draft.decide === draft.addressFrom.decide) du.value = movedURLs(draft)?.decide || draft.decide;
     };
@@ -10089,7 +10112,14 @@ function drawEditor(p, presetID) {
   const addressOf = (k) => (draft[k] ?? (isNew && pr ? pr[k] : "")) || "";
   // another magpie masks by its own Settings (CrazyMouse_TT on X)
   const remote = (p?.preset || pr?.id) === "remote-magpie";
-  advIn.append(...unmaskRow(t(remote ? "The other magpie gets requests as written and masks them by its own Settings › Privacy. Off, they are masked here first." : "For a model running on this computer or your local network: secrets, personal data and your masked words go to it as written. Leave it off for a local relay or proxy that passes requests on to a vendor."), () => remote ? [] : ["chat", "responses", "anthropic", "gemini", "decide"].map(addressOf)));
+  // a local server's address field moves each URL to the address typed
+  // (provider.AtAddress), so that is where it is asked at, not where the
+  // preset put it
+  const atURLs = () => {
+    const moved = address ? movedURLs(draft) : null;
+    return ["chat", "responses", "anthropic", "gemini", "decide"].map((k) => (moved && k in moved ? moved[k] : addressOf(k)));
+  };
+  advIn.append(...unmaskRow(t(remote ? "The other magpie gets requests as written and masks them by its own Settings › Privacy. Off, they are masked here first." : "For a model running on this computer or your local network: secrets, personal data and your masked words go to it as written. Leave it off for a local relay or proxy that passes requests on to a vendor."), () => remote ? [] : atURLs()));
 
   // a user's provider whose certificate nothing trusts (#2383, provider.TakesInsecureTLS)
   const tlsTakes = () => custom && (!p || !!p.takesInsecureTLS);
@@ -11091,12 +11121,21 @@ function renderImport(im) {
   // icon= over the catalog's or preset's, fetched once the dialog is open
   if (p.iconUrl) fetchImportIcon(p, h, ed);
 
+  // a link that names a server on this computer or the local network adds it
+  // unmasked, as one added by hand is (provider.UnmaskedOnAdd): a name of the
+  // user's own DNS is asked about as the editor's caution asks, and another
+  // magpie's addresses are that other computer's, which masks by its own
+  // Settings › Privacy
+  const linkURLs = () => [p.chat, p.responses, p.anthropic, p.gemini, p.decide].filter(Boolean);
+  if (p.preset !== "remote-magpie") askLANNames(linkURLs(), () => {});
+
   const addBtn = el("button", "text primary", t(im.replaces ? "Replace" : "Add"));
   const add = () => {
     const n = (im.name ?? p.name).trim();
     if (!n) { name.focus(); return status(t("Give it a name"), "warn"); }
     saving(addBtn, t(im.replaces ? "Replacing…" : "Adding…"));
-    providerAction("save", { ...p, name: n, key: (im.key ?? p.key ?? "").trim() }, t("{name} added", { name: n }));
+    const body = { ...p, name: n, key: (im.key ?? p.key ?? "").trim(), unredacted: !!p.unredacted || (p.preset !== "remote-magpie" && localURLs(linkURLs())) };
+    providerAction("save", body, t("{name} added", { name: n }));
   };
   addBtn.onclick = add;
   bar.append(addBtn);
@@ -20621,6 +20660,15 @@ function awayHost(urls) {
   return "";
 }
 
+// localURLs: whether there is an address among urls, and every address is on
+// this computer or the local network (a name of the user's own DNS once
+// askLANNames has answered). A provider being added at one is added unmasked
+// (unmaskRow, renderImport); nothing else asks it.
+function localURLs(urls) {
+  const hs = urls.map(urlHost).filter((h) => h);
+  return hs.length > 0 && hs.every((h) => localIP(h) === true || lanNames.get(h) === true);
+}
+
 function urlHost(u) {
   try { return new URL((u || "").trim()).hostname.toLowerCase().replace(/^\[|\]$|\.$/g, ""); } catch { return null; }
 }
diff --git a/internal/gui/core_budget_test.go b/internal/gui/core_budget_test.go
index 656f9d3dd..e834a9e3c 100644
--- a/internal/gui/core_budget_test.go
+++ b/internal/gui/core_budget_test.go
@@ -17,8 +17,8 @@ import (
 // never what pays for a change (#5918); the history of each number is in
 // `git log -L` of this file.
 const (
-	appScriptBudget  = 1_088_641 // app.js: 1,080,614 at 8016205e3, with the 5,653 of room it had; +123 for a sidebar list folded from its page's row (hkwok06 on X), its chevron and fold in navicons.js, imported with the first list; +57 for each account of a provider's Usage card in a card of its own (normalcoder_ on X), past the 24 of room left; +17 for an allowance card's wallet line under its rings (apple_test_src on X), the one filter shared with its text line; +338 for the Daily update channel (fishmagic80 on X): its segment, its line under Update channel and the version row's two Up to date on Daily words, packed to the shortest form (one t() per choice); Settings › About and renderUpdate draw them on every window, so there is no page to move them to; +35 for Baidu Qianfan's Token Plan sign-in (yuushabu_buyinn on X, #5860): its field in qianfanplan.js, imported when such a provider's editor opens, drawn by renderStepPlan now told whose sign-in it brings, and what is left is the import and two quotaError lines, past the room there was; quotaError reads every card's error, so there is no page to move it to; +27 for Windows' title bar (258a14 on X): the caption buttons, their clicks, the bar's double click and what keeps them over a dialog in wincap.js, imported in Windows' window alone, the header's room for them in app.css, and what is left is the one line that imports it, past the 29 of room there was; that window's frame is drawn on every start, so there is no page to move it to; +107 for the pages in the reader's own order (chet030714 on X): the order, the sidebar and tab bar put in it, and the menu's drag and keys in navorder.js and navpages.js, imported once an order is kept or Settings draws, and what is left is the one line in navHides that imports it; navHides runs on every start, so there is no page to move it to; +275 for the grants Alibaba's Token Plan asks of a RAM user's AccessKey in the reader's language (MetalHqa on X): one string (ALI_RAM) shown under the editor's AccessKey ID and on the card that names them, less the 48 of the wrong "a RAM user that may use Model Studio is enough" it replaces; the editor and quotaError draw them on every window, so there is no page to move them to; +135 for a model test its vendor queued shown queued and not green (sufeng1894 on X): queuedSaid, one string shared by the chip's title, Test models' and Test this model's status, and the chip's amber dot; renderModels draws the provider editor's chips, so there is no page to move it to; +66 for AstrLink Guard's row saying an x64 magpie runs it under Windows on Arm's emulation until the next update installs the Arm build (EV_John_Liu on X), the Rosetta line's sibling, one line in pmSub; the Privacy rows draw it, so there is no page to move it to; +864 for Use on a Claude setup-token account, which switches Claude Code itself to it in its settings.json, and Use back on its signed-in account (liukaybee on X): one swUse helper shared by both buttons, packed to the shortest form; renderAccounts draws every account row, so there is no page to move it to; +1 for the classifier timeout's unset default, 15 and not 8 (ESern29751 on X): its second digit in the Settings row's fallback, which renderReplies draws, so there is no page to move it to; +457 for Kimi Code's subagent pool and its effort (XiaoLing_Arisa on X): the Subagents line and its pool menu in kimisub.js, imported before a Kimi Code row's Details first slides open so it measures the line, and what is left is that import, the line's place, the three fields kept out of the row's squares and the picker's note that Kimi's subagents run on the lead's model, packed to the shortest form; renderAgents draws every row, so there is no page to move it to; +354 for Images per request (#6849, Yuu_jiang_ on X): its field and parse are in maximages.js, imported as the editor draws Max output, and what stays is the import, the two saves' lines and the check that the editor is still open when it and keyrates.js land, no page to move them to; +499 for Speed beside Model and Effort in an agent's opened row (Tengs999 on X): the line, its menu and what decides the speed in agentspeed.js, imported before a fast model's Details first slides open so it measures the line, and what is left is that import and the line's place in the panel's and the window's rows, packed to one helper; renderAgents draws every row, so there is no page to move it to; -1,529: each ChatGPT account's own warm-up time (renderWarmAtOwn) moved into autoresetown.js, imported when its rows first draw, paying for a provider's editor opening Advanced when its warm-up or check-in is on (ChrisYagao on X), and the room left over given back; +103 for the sidebar foot that holds Settings' tabs marked by a class, not :has(), which Safari before 15.4 can't parse (#5919): no page's code small enough to move was left (modelInfo serves two plugins); +52 for a proxy's failure said in the reader's language (laiuuui on X): proxyWhy is in proxies.js, imported when Settings draws its saved proxies, and what is left is api()'s one line handing the reply to it; api() reads every error, so there is no page to move it to; +485 for which effort a Claude Code tier runs at (lightwlh on X): an unset tier's effort reads follows session, a set one's title says the session's effort and /effort don't change it, and New sessions' effort says a tier with its own runs at that one, one ownSaid shared by both titles, packed to the shortest form; connectPanel and the effort slider draw every agent's Details, so there is no page to move it to; -165: the provider editor's WebSocket row moved into socketrow.js, imported as the editor draws, paying for its tick opening ticked on OpenAI's own API (KawaiiZapic on X), and the room left over given back; +68 for the version row saying a version newer than its channel's waits until the channel passes it (realfxw on X): one t() for both channels and the Every version tail shared with Up to date, packed to the shortest form; renderUpdate draws it on every window, so there is no page to move it to; +5 for the Version row's Restart named Restart only (realfxw on X restarted again and again on a bare Restart beside Check, waiting for an update): the one word more, short enough that the row's line doesn't wrap at 420; renderUpdate draws it on every window, so there is no page to move it to
-	coreScriptBudget = 1_273_332 // every core script at 8016205e3, the old measure 682 over its cap there (#5918); +367 for the model test on a chosen account (tmr11235), no page left to move it to; +151 for the provider menu's "Only on this device" item and its four translations; +458 for Settings › About's Report a problem row and its translations; +113 for withScheme, the one rule every typed address goes through (eachg0 on X), cut to the shortest form that keeps it whole; +10 for the kept whole's tooltip (Musikrv77852 on X), the past-cycle line reused for it, no page left to move it to; +1,112 for Codex's Open button and its Open Codex with menu (Yink88564391 on X), packed to the shortest form, no page left to move them to; +168 for Discover's long lists drawn in part (the owner, 11-13), after the rest of its hook moved into plugingrid.js, imported when Plugins first draws; +296 for the cap toggle and Smart sentences that say what they do and the Sign in on another computer row (Wing8Aqua on X), packed to the shortest form, no page left to move them to; +333 for In turn's figure in a provider's editor and its words naming the message that goes round (Wing8Aqua on X), the figure itself in rotfig.js, imported when In turn is first shown, the hook packed to the shortest form; +236 for a lone capped Codex account's row saying its turns go to the fallbacks when Codex is connected (not_4O4 on X), the two helpers inlined, no page left to move it to; +717 for omp's advisor (Awad_Yoo on X, #6408): its three rows moved into ompadvisor.js, imported when an omp's settings show, and what is left is the import, the role's " · off" and the Settings line's name, packed to the shortest form; +468 for a plugin's own file import (auth.import) in the import sheet, in the plugin's words (marchen_cc on X), packed to one statement; importSay is read as the Providers rows draw, so it has no lazy page to go to, and nothing else was moved out; +180 for Claude Magpie's own Claude Code folder (xMopf7RF on X, #6459): its Advanced fold in claudemagpie.js, imported when it first shows, and what is left is the import and the fold's place in the Separate app line, 216 bytes packed to the shortest form, less the 36 of room there was; +81 for the Use Claude Magpie button on Claude Desktop's row (xMopf7RF on X), drawn by claudemagpie.js too, what is left the one line that places it (#2710); +225 for the Hermes row's Other profiles lines (Norethcy on X), which 1d60b165c took out while each profile had a row and c96f33d65 left with no place at all, packed to the shortest form; the dead hermes# Default note went with it, and the Agents rows draw it, so there is no page to move it to; +397 for a key's own price rate (tnt12231 on X): its lines, check and placeholder in keyrates.js, imported when a provider with two or more keys opens, and what is left is the import, the draft's copy, Advanced opening for it, the save's one line and proxyLines drawing another kind of line; +316 for an image or video model's chip saying what it makes from its right-click (iceloon on X): the chat chip's Makes… now shared with it, and the media chip's Copy model ID left out, packed to the shortest form; the provider's editor draws it, so there is no page to move it to; +67 for the Claude Code · Claude Magpie row saying it is on magpie through Claude Magpie (xMopf7RF on X), one line in connectLine with the shortest words that say it; the Agents rows draw it, so there is no page to move it to; +12 for AIGoCode's logo in pngIcons (MindfulReturn on X), the list every drawn icon is looked up in; +491 for each cost in the tray panel's and Requests' chart and ranking in its own provider's currency (onkashiko on X): ledProv and the provider passed through, packed to the shortest form; drawLedColumns and drawLedRank are shared by the panel, so there is no page to move it to; +326 for the Qwen AI platform's Token Plan sign-in (imthe99galaxy on X): its field, sign-in and wait in qianwenplan.js, imported when such a provider's editor opens, and what is left is the import and one quotaError line for its two refusals, packed to the shortest form; quotaError reads every card's error, so there is no page to move it to; +72 for Copy all keys (emilochen on X): its row in keyrates.js, imported when a provider with two or more keys opens through keyRateField, now told which of its parts to draw, and what is left is the one line that places it; +83 for the page saying it has gone from view, so what its Sessions and Usage pages keep goes in 30 s and not 7 minutes (P0 memory): folded into the visibilitychange listener every window has, packed to the shortest form, so there is no page to move it to; +270 for Providers' Select, to remove several at once (eiyuuzaki2333 on X): its rows, bar, removal and keys in pvpick.js, imported when Select is first clicked, and what is left is pvSel, the button's click and two lines in renderProviders, which draws the list, so there is no page to move it to; +81 for each account of a provider's Usage card in a card of its own (normalcoder_ on X): one line that makes the box, its brief look left to CSS, and renderQuotas, which draws every card, so there is no page to move it to; +17 for Kimi Code's booster balance under an allowance card's rings in the tray panel (apple_test_src on X): the card's text line and the wallet line share one filter, packed to the shortest form; panelQuotaCard draws every card, so there is no page to move it to; +51 for what a failed plugin install left in plugins/, listed under Installed with a Remove (CHENGJIAHEGOXIS on X): its section in plugininstalled.js as pmLeftovers, imported when Plugins first draws, and what is left is the one call after drawInstalled; draw is what draws the page, so there is no page to move it to; +123 for a sidebar list folded from its page's row (hkwok06 on X): the chevron, its click and the fold kept per page in navicons.js, imported with the first list, and what is left is the folded list read beside the hidden pages' (navList, which navMine now shares) and the two rows' clicks asking navFold first; navSubs draws every list, so there is no page to move it to; +338 for the Daily update channel (fishmagic80 on X): its segment, its line under Update channel and the version row's two Up to date on Daily words, packed to the shortest form (one t() per choice); Settings › About and renderUpdate draw them on every window, so there is no page to move them to; +35 for Baidu Qianfan's Token Plan sign-in (yuushabu_buyinn on X, #5860): its field in qianfanplan.js, imported when such a provider's editor opens, drawn by renderStepPlan now told whose sign-in it brings, and what is left is the import and two quotaError lines, past the room there was; quotaError reads every card's error, so there is no page to move it to; +27 for Windows' title bar (258a14 on X): the caption buttons, their clicks, the bar's double click and what keeps them over a dialog in wincap.js, imported in Windows' window alone, the header's room for them in app.css, and what is left is the one line that imports it, past the 29 of room there was; that window's frame is drawn on every start, so there is no page to move it to; +107 for the pages in the reader's own order (chet030714 on X): the order, the sidebar and tab bar put in it, and the menu's drag and keys in navorder.js and navpages.js, imported once an order is kept or Settings draws, and what is left is the one line in navHides that imports it; navHides runs on every start, so there is no page to move it to; +275 for the grants Alibaba's Token Plan asks of a RAM user's AccessKey in the reader's language (MetalHqa on X): one string (ALI_RAM) shown under the editor's AccessKey ID and on the card that names them, less the 48 of the wrong "a RAM user that may use Model Studio is enough" it replaces; the editor and quotaError draw them on every window, so there is no page to move them to; +135 for a model test its vendor queued shown queued and not green (sufeng1894 on X): queuedSaid, one string shared by the chip's title, Test models' and Test this model's status, and the chip's amber dot; renderModels draws the provider editor's chips, so there is no page to move it to; +66 for AstrLink Guard's row saying an x64 magpie runs it under Windows on Arm's emulation until the next update installs the Arm build (EV_John_Liu on X), the Rosetta line's sibling, one line in pmSub; the Privacy rows draw it, so there is no page to move it to; +189 for Let magpie set it on a Codex card locked by config.toml's own compact limit or background threshold (sufeng1894 on X), and Undo for a background share taken over: the shared send posts it, packed to the shortest form; adviceRow draws every card, so there is no page to move it to; +864 for Use on a Claude setup-token account, which switches Claude Code itself to it in its settings.json, and Use back on its signed-in account (liukaybee on X): one swUse helper shared by both buttons, packed to the shortest form; renderAccounts draws every account row, so there is no page to move it to; +1 for the classifier timeout's unset default, 15 and not 8 (ESern29751 on X): its second digit in the Settings row's fallback, which renderReplies draws, so there is no page to move it to; +457 for Kimi Code's subagent pool and its effort (XiaoLing_Arisa on X): the Subagents line and its pool menu in kimisub.js, imported before a Kimi Code row's Details first slides open so it measures the line, and what is left is that import, the line's place, the three fields kept out of the row's squares and the picker's note that Kimi's subagents run on the lead's model, packed to the shortest form; renderAgents draws every row, so there is no page to move it to; +354 for Images per request (#6849, Yuu_jiang_ on X): its field and parse are in maximages.js, imported as the editor draws Max output, and what stays is the import, the two saves' lines and the check that the editor is still open when it and keyrates.js land, no page to move them to; +499 for Speed beside Model and Effort in an agent's opened row (Tengs999 on X): the line, its menu and what decides the speed in agentspeed.js, imported before a fast model's Details first slides open so it measures the line, and what is left is that import and the line's place in the panel's and the window's rows, packed to one helper; renderAgents draws every row, so there is no page to move it to; -1,529: each ChatGPT account's own warm-up time moved into autoresetown.js, paying for Advanced opening on a warm-up or check-in that is on (ChrisYagao on X), the room left over given back; +103 for the same .with-sub foot (#5919); +52 for the Advisor kind of an advisor call's own usage row (#6977, Refeccd on Discord): its entry in the generated purposes.js; the kinds are read wherever Usage and Routing draw a row, so there is no page to move it to; +54 for a proxy's failure said in the reader's language (laiuuui on X): proxyWhy is in proxies.js, imported when Settings draws its saved proxies, and what is left is api()'s one line handing the reply to it; api() reads every error, so there is no page to move it to; +843 for which effort a Claude Code tier runs at (lightwlh on X): an unset tier's effort reads follows session, a set one's title says the session's effort and /effort don't change it, and New sessions' effort says a tier with its own runs at that one, one ownSaid shared by both titles, packed to the shortest form; connectPanel and the effort slider draw every agent's Details, so there is no page to move it to; -165: the provider editor's WebSocket row moved into socketrow.js, imported as the editor draws, paying for its tick opening ticked on OpenAI's own API (KawaiiZapic on X), and the room left over given back; +68 for the version row saying a version newer than its channel's waits until the channel passes it (realfxw on X): one t() for both channels and the Every version tail shared with Up to date, packed to the shortest form; renderUpdate draws it on every window, so there is no page to move it to; +5 for the Version row's Restart named Restart only (realfxw on X restarted again and again on a bare Restart beside Check, waiting for an update): the one word more, short enough that the row's line doesn't wrap at 420; renderUpdate draws it on every window, so there is no page to move it to
+	appScriptBudget  = 1_089_745 // app.js: 1,080,614 at 8016205e3, with the 5,653 of room it had; +123 for a sidebar list folded from its page's row (hkwok06 on X), its chevron and fold in navicons.js, imported with the first list; +57 for each account of a provider's Usage card in a card of its own (normalcoder_ on X), past the 24 of room left; +17 for an allowance card's wallet line under its rings (apple_test_src on X), the one filter shared with its text line; +338 for the Daily update channel (fishmagic80 on X): its segment, its line under Update channel and the version row's two Up to date on Daily words, packed to the shortest form (one t() per choice); Settings › About and renderUpdate draw them on every window, so there is no page to move them to; +35 for Baidu Qianfan's Token Plan sign-in (yuushabu_buyinn on X, #5860): its field in qianfanplan.js, imported when such a provider's editor opens, drawn by renderStepPlan now told whose sign-in it brings, and what is left is the import and two quotaError lines, past the room there was; quotaError reads every card's error, so there is no page to move it to; +27 for Windows' title bar (258a14 on X): the caption buttons, their clicks, the bar's double click and what keeps them over a dialog in wincap.js, imported in Windows' window alone, the header's room for them in app.css, and what is left is the one line that imports it, past the 29 of room there was; that window's frame is drawn on every start, so there is no page to move it to; +107 for the pages in the reader's own order (chet030714 on X): the order, the sidebar and tab bar put in it, and the menu's drag and keys in navorder.js and navpages.js, imported once an order is kept or Settings draws, and what is left is the one line in navHides that imports it; navHides runs on every start, so there is no page to move it to; +275 for the grants Alibaba's Token Plan asks of a RAM user's AccessKey in the reader's language (MetalHqa on X): one string (ALI_RAM) shown under the editor's AccessKey ID and on the card that names them, less the 48 of the wrong "a RAM user that may use Model Studio is enough" it replaces; the editor and quotaError draw them on every window, so there is no page to move them to; +135 for a model test its vendor queued shown queued and not green (sufeng1894 on X): queuedSaid, one string shared by the chip's title, Test models' and Test this model's status, and the chip's amber dot; renderModels draws the provider editor's chips, so there is no page to move it to; +66 for AstrLink Guard's row saying an x64 magpie runs it under Windows on Arm's emulation until the next update installs the Arm build (EV_John_Liu on X), the Rosetta line's sibling, one line in pmSub; the Privacy rows draw it, so there is no page to move it to; +864 for Use on a Claude setup-token account, which switches Claude Code itself to it in its settings.json, and Use back on its signed-in account (liukaybee on X): one swUse helper shared by both buttons, packed to the shortest form; renderAccounts draws every account row, so there is no page to move it to; +1 for the classifier timeout's unset default, 15 and not 8 (ESern29751 on X): its second digit in the Settings row's fallback, which renderReplies draws, so there is no page to move it to; +457 for Kimi Code's subagent pool and its effort (XiaoLing_Arisa on X): the Subagents line and its pool menu in kimisub.js, imported before a Kimi Code row's Details first slides open so it measures the line, and what is left is that import, the line's place, the three fields kept out of the row's squares and the picker's note that Kimi's subagents run on the lead's model, packed to the shortest form; renderAgents draws every row, so there is no page to move it to; +354 for Images per request (#6849, Yuu_jiang_ on X): its field and parse are in maximages.js, imported as the editor draws Max output, and what stays is the import, the two saves' lines and the check that the editor is still open when it and keyrates.js land, no page to move them to; +499 for Speed beside Model and Effort in an agent's opened row (Tengs999 on X): the line, its menu and what decides the speed in agentspeed.js, imported before a fast model's Details first slides open so it measures the line, and what is left is that import and the line's place in the panel's and the window's rows, packed to one helper; renderAgents draws every row, so there is no page to move it to; -1,529: each ChatGPT account's own warm-up time (renderWarmAtOwn) moved into autoresetown.js, imported when its rows first draw, paying for a provider's editor opening Advanced when its warm-up or check-in is on (ChrisYagao on X), and the room left over given back; +103 for the sidebar foot that holds Settings' tabs marked by a class, not :has(), which Safari before 15.4 can't parse (#5919): no page's code small enough to move was left (modelInfo serves two plugins); +52 for a proxy's failure said in the reader's language (laiuuui on X): proxyWhy is in proxies.js, imported when Settings draws its saved proxies, and what is left is api()'s one line handing the reply to it; api() reads every error, so there is no page to move it to; +485 for which effort a Claude Code tier runs at (lightwlh on X): an unset tier's effort reads follows session, a set one's title says the session's effort and /effort don't change it, and New sessions' effort says a tier with its own runs at that one, one ownSaid shared by both titles, packed to the shortest form; connectPanel and the effort slider draw every agent's Details, so there is no page to move it to; -165: the provider editor's WebSocket row moved into socketrow.js, imported as the editor draws, paying for its tick opening ticked on OpenAI's own API (KawaiiZapic on X), and the room left over given back; +68 for the version row saying a version newer than its channel's waits until the channel passes it (realfxw on X): one t() for both channels and the Every version tail shared with Up to date, packed to the shortest form; renderUpdate draws it on every window, so there is no page to move it to; +5 for the Version row's Restart named Restart only (realfxw on X restarted again and again on a bare Restart beside Check, waiting for an update): the one word more, short enough that the row's line doesn't wrap at 420; renderUpdate draws it on every window, so there is no page to move it to; +1,104 for a provider added at the user's own computer or on the local network starting with *Send requests unmasked* on (asked 11-18): the switch follows the URLs typed until the user sets it their own way, in the editor and in an import link, one localURLs shared by the two and packed to the shortest form, past the room there was; the editor's Advanced and the import sheet are app.js's own rows, so there is no page to move it to
+	coreScriptBudget = 1_274_436 // every core script at 8016205e3, the old measure 682 over its cap there (#5918); +367 for the model test on a chosen account (tmr11235), no page left to move it to; +151 for the provider menu's "Only on this device" item and its four translations; +458 for Settings › About's Report a problem row and its translations; +113 for withScheme, the one rule every typed address goes through (eachg0 on X), cut to the shortest form that keeps it whole; +10 for the kept whole's tooltip (Musikrv77852 on X), the past-cycle line reused for it, no page left to move it to; +1,112 for Codex's Open button and its Open Codex with menu (Yink88564391 on X), packed to the shortest form, no page left to move them to; +168 for Discover's long lists drawn in part (the owner, 11-13), after the rest of its hook moved into plugingrid.js, imported when Plugins first draws; +296 for the cap toggle and Smart sentences that say what they do and the Sign in on another computer row (Wing8Aqua on X), packed to the shortest form, no page left to move them to; +333 for In turn's figure in a provider's editor and its words naming the message that goes round (Wing8Aqua on X), the figure itself in rotfig.js, imported when In turn is first shown, the hook packed to the shortest form; +236 for a lone capped Codex account's row saying its turns go to the fallbacks when Codex is connected (not_4O4 on X), the two helpers inlined, no page left to move it to; +717 for omp's advisor (Awad_Yoo on X, #6408): its three rows moved into ompadvisor.js, imported when an omp's settings show, and what is left is the import, the role's " · off" and the Settings line's name, packed to the shortest form; +468 for a plugin's own file import (auth.import) in the import sheet, in the plugin's words (marchen_cc on X), packed to one statement; importSay is read as the Providers rows draw, so it has no lazy page to go to, and nothing else was moved out; +180 for Claude Magpie's own Claude Code folder (xMopf7RF on X, #6459): its Advanced fold in claudemagpie.js, imported when it first shows, and what is left is the import and the fold's place in the Separate app line, 216 bytes packed to the shortest form, less the 36 of room there was; +81 for the Use Claude Magpie button on Claude Desktop's row (xMopf7RF on X), drawn by claudemagpie.js too, what is left the one line that places it (#2710); +225 for the Hermes row's Other profiles lines (Norethcy on X), which 1d60b165c took out while each profile had a row and c96f33d65 left with no place at all, packed to the shortest form; the dead hermes# Default note went with it, and the Agents rows draw it, so there is no page to move it to; +397 for a key's own price rate (tnt12231 on X): its lines, check and placeholder in keyrates.js, imported when a provider with two or more keys opens, and what is left is the import, the draft's copy, Advanced opening for it, the save's one line and proxyLines drawing another kind of line; +316 for an image or video model's chip saying what it makes from its right-click (iceloon on X): the chat chip's Makes… now shared with it, and the media chip's Copy model ID left out, packed to the shortest form; the provider's editor draws it, so there is no page to move it to; +67 for the Claude Code · Claude Magpie row saying it is on magpie through Claude Magpie (xMopf7RF on X), one line in connectLine with the shortest words that say it; the Agents rows draw it, so there is no page to move it to; +12 for AIGoCode's logo in pngIcons (MindfulReturn on X), the list every drawn icon is looked up in; +491 for each cost in the tray panel's and Requests' chart and ranking in its own provider's currency (onkashiko on X): ledProv and the provider passed through, packed to the shortest form; drawLedColumns and drawLedRank are shared by the panel, so there is no page to move it to; +326 for the Qwen AI platform's Token Plan sign-in (imthe99galaxy on X): its field, sign-in and wait in qianwenplan.js, imported when such a provider's editor opens, and what is left is the import and one quotaError line for its two refusals, packed to the shortest form; quotaError reads every card's error, so there is no page to move it to; +72 for Copy all keys (emilochen on X): its row in keyrates.js, imported when a provider with two or more keys opens through keyRateField, now told which of its parts to draw, and what is left is the one line that places it; +83 for the page saying it has gone from view, so what its Sessions and Usage pages keep goes in 30 s and not 7 minutes (P0 memory): folded into the visibilitychange listener every window has, packed to the shortest form, so there is no page to move it to; +270 for Providers' Select, to remove several at once (eiyuuzaki2333 on X): its rows, bar, removal and keys in pvpick.js, imported when Select is first clicked, and what is left is pvSel, the button's click and two lines in renderProviders, which draws the list, so there is no page to move it to; +81 for each account of a provider's Usage card in a card of its own (normalcoder_ on X): one line that makes the box, its brief look left to CSS, and renderQuotas, which draws every card, so there is no page to move it to; +17 for Kimi Code's booster balance under an allowance card's rings in the tray panel (apple_test_src on X): the card's text line and the wallet line share one filter, packed to the shortest form; panelQuotaCard draws every card, so there is no page to move it to; +51 for what a failed plugin install left in plugins/, listed under Installed with a Remove (CHENGJIAHEGOXIS on X): its section in plugininstalled.js as pmLeftovers, imported when Plugins first draws, and what is left is the one call after drawInstalled; draw is what draws the page, so there is no page to move it to; +123 for a sidebar list folded from its page's row (hkwok06 on X): the chevron, its click and the fold kept per page in navicons.js, imported with the first list, and what is left is the folded list read beside the hidden pages' (navList, which navMine now shares) and the two rows' clicks asking navFold first; navSubs draws every list, so there is no page to move it to; +338 for the Daily update channel (fishmagic80 on X): its segment, its line under Update channel and the version row's two Up to date on Daily words, packed to the shortest form (one t() per choice); Settings › About and renderUpdate draw them on every window, so there is no page to move them to; +35 for Baidu Qianfan's Token Plan sign-in (yuushabu_buyinn on X, #5860): its field in qianfanplan.js, imported when such a provider's editor opens, drawn by renderStepPlan now told whose sign-in it brings, and what is left is the import and two quotaError lines, past the room there was; quotaError reads every card's error, so there is no page to move it to; +27 for Windows' title bar (258a14 on X): the caption buttons, their clicks, the bar's double click and what keeps them over a dialog in wincap.js, imported in Windows' window alone, the header's room for them in app.css, and what is left is the one line that imports it, past the 29 of room there was; that window's frame is drawn on every start, so there is no page to move it to; +107 for the pages in the reader's own order (chet030714 on X): the order, the sidebar and tab bar put in it, and the menu's drag and keys in navorder.js and navpages.js, imported once an order is kept or Settings draws, and what is left is the one line in navHides that imports it; navHides runs on every start, so there is no page to move it to; +275 for the grants Alibaba's Token Plan asks of a RAM user's AccessKey in the reader's language (MetalHqa on X): one string (ALI_RAM) shown under the editor's AccessKey ID and on the card that names them, less the 48 of the wrong "a RAM user that may use Model Studio is enough" it replaces; the editor and quotaError draw them on every window, so there is no page to move them to; +135 for a model test its vendor queued shown queued and not green (sufeng1894 on X): queuedSaid, one string shared by the chip's title, Test models' and Test this model's status, and the chip's amber dot; renderModels draws the provider editor's chips, so there is no page to move it to; +66 for AstrLink Guard's row saying an x64 magpie runs it under Windows on Arm's emulation until the next update installs the Arm build (EV_John_Liu on X), the Rosetta line's sibling, one line in pmSub; the Privacy rows draw it, so there is no page to move it to; +189 for Let magpie set it on a Codex card locked by config.toml's own compact limit or background threshold (sufeng1894 on X), and Undo for a background share taken over: the shared send posts it, packed to the shortest form; adviceRow draws every card, so there is no page to move it to; +864 for Use on a Claude setup-token account, which switches Claude Code itself to it in its settings.json, and Use back on its signed-in account (liukaybee on X): one swUse helper shared by both buttons, packed to the shortest form; renderAccounts draws every account row, so there is no page to move it to; +1 for the classifier timeout's unset default, 15 and not 8 (ESern29751 on X): its second digit in the Settings row's fallback, which renderReplies draws, so there is no page to move it to; +457 for Kimi Code's subagent pool and its effort (XiaoLing_Arisa on X): the Subagents line and its pool menu in kimisub.js, imported before a Kimi Code row's Details first slides open so it measures the line, and what is left is that import, the line's place, the three fields kept out of the row's squares and the picker's note that Kimi's subagents run on the lead's model, packed to the shortest form; renderAgents draws every row, so there is no page to move it to; +354 for Images per request (#6849, Yuu_jiang_ on X): its field and parse are in maximages.js, imported as the editor draws Max output, and what stays is the import, the two saves' lines and the check that the editor is still open when it and keyrates.js land, no page to move them to; +499 for Speed beside Model and Effort in an agent's opened row (Tengs999 on X): the line, its menu and what decides the speed in agentspeed.js, imported before a fast model's Details first slides open so it measures the line, and what is left is that import and the line's place in the panel's and the window's rows, packed to one helper; renderAgents draws every row, so there is no page to move it to; -1,529: each ChatGPT account's own warm-up time moved into autoresetown.js, paying for Advanced opening on a warm-up or check-in that is on (ChrisYagao on X), the room left over given back; +103 for the same .with-sub foot (#5919); +52 for the Advisor kind of an advisor call's own usage row (#6977, Refeccd on Discord): its entry in the generated purposes.js; the kinds are read wherever Usage and Routing draw a row, so there is no page to move it to; +54 for a proxy's failure said in the reader's language (laiuuui on X): proxyWhy is in proxies.js, imported when Settings draws its saved proxies, and what is left is api()'s one line handing the reply to it; api() reads every error, so there is no page to move it to; +843 for which effort a Claude Code tier runs at (lightwlh on X): an unset tier's effort reads follows session, a set one's title says the session's effort and /effort don't change it, and New sessions' effort says a tier with its own runs at that one, one ownSaid shared by both titles, packed to the shortest form; connectPanel and the effort slider draw every agent's Details, so there is no page to move it to; -165: the provider editor's WebSocket row moved into socketrow.js, imported as the editor draws, paying for its tick opening ticked on OpenAI's own API (KawaiiZapic on X), and the room left over given back; +68 for the version row saying a version newer than its channel's waits until the channel passes it (realfxw on X): one t() for both channels and the Every version tail shared with Up to date, packed to the shortest form; renderUpdate draws it on every window, so there is no page to move it to; +5 for the Version row's Restart named Restart only (realfxw on X restarted again and again on a bare Restart beside Check, waiting for an update): the one word more, short enough that the row's line doesn't wrap at 420; renderUpdate draws it on every window, so there is no page to move it to; +1,104 for the unmasked default of a provider added at the user's own computer or on the local network (asked 11-18), drawn in app.js's own editor and import rows, so it has no page to move to either
 )
 
 // codeBytes is how many bytes of b are code: its blank lines, its lines
diff --git a/internal/gui/tests/provider-unmasked-add.test.cjs b/internal/gui/tests/provider-unmasked-add.test.cjs
new file mode 100644
index 000000000..159496ddc
--- /dev/null
+++ b/internal/gui/tests/provider-unmasked-add.test.cjs
@@ -0,0 +1,168 @@
+// Run with Node's test runner and Playwright on the module path; see README.md.
+// A provider added at the user's own computer or on their local network
+// starts with "Send requests unmasked" already on (the owner, 11-18): their
+// machine holds whatever they say to it, so masking keeps nothing from them
+// there. The switch is on, under Advanced, for a local preset as its editor
+// opens and as a custom provider's Base URL turns local, and it is what Add
+// sends; a vendor's stays off, the user's own untick stands over the
+// default, and a saved provider keeps what it was saved with. English,
+// Chinese (Simplified and Traditional), Japanese and German; no backend, the
+// API is faked here.
+const assert = require("node:assert/strict");
+const fs = require("node:fs/promises");
+const path = require("node:path");
+const { test } = require("node:test");
+const { chromium, webkit } = require("playwright");
+
+const assets = path.resolve(__dirname, "../assets");
+const presets = [
+  { id: "openai", name: "OpenAI", icon: "openai", kind: "vendor", chat: "https://api.openai.com/v1", added: false },
+  { id: "ollama", name: "Ollama", icon: "ollama", kind: "local", chat: "http://localhost:11434/v1", anthropic: "http://localhost:11434", noKey: true, note: "your local models", added: false },
+];
+// one provider already added, so the list is not the empty welcome
+const base = {
+  icon: "generic", chat: "", responses: "", anthropic: "", catalog: "",
+  models: [{ id: "qwen3", name: "Qwen3", on: true }], agents: [], fallback: [], headers: {},
+  key: { set: false, masked: "", optional: true }, keyList: [], balanceToken: { takes: false, set: false }, proxy: "", searches: false, unredacted: false,
+};
+const home = { ...base, id: "relay", name: "Relay", chat: "https://api.relay.example/v1" };
+
+function server(lang, saves, asked, linked) {
+  const list = { providers: [home], presets, excluded: [], gateway: { running: true, window: true } };
+  return async (route) => {
+    const url = new URL(route.request().url());
+    const json = (data) => route.fulfill({ json: data });
+    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:false};` });
+    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
+    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light" } });
+    if (url.pathname === "/api/providers") return json(list);
+    if (url.pathname === "/api/provider/save") { saves.push(route.request().postDataJSON()); return json(list); }
+    // a magpie://import link, fetched once and shown for the user to add
+    if (url.pathname === "/api/import/link1") return json({ provider: linked });
+    // a name is asked about once, a moment after it is typed
+    if (url.pathname === "/api/local-hosts") { asked.push(route.request().postDataJSON()); return json({ local: {} }); }
+    if (url.pathname === "/api/groups") return json({ groups: [], pools: [] });
+    if (url.pathname === "/api/gateway/trace") return json({ routes: [] });
+    if (url.pathname.startsWith("/api/")) return json({});
+    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
+    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
+    try { await route.fulfill({ body: await fs.readFile(file), contentType }); } catch { await route.fulfill({ status: 404, body: "" }); }
+  };
+}
+
+for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
+  test(engine + ": a provider added on this computer or the local network starts unmasked", async (t) => {
+    const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
+    t.after(() => browser.close());
+    for (const lang of ["en", "zh", "zh-TW", "ja", "de"]) {
+      for (const width of [900, 440]) {
+        // a page on the Providers view with the Add sheet closed
+        const open = async (t, { query = "", linked } = {}) => {
+          const saves = [], asked = [];
+          const page = await (await browser.newContext({ viewport: { width, height: 760 }, reducedMotion: "reduce" })).newPage();
+          page.setDefaultTimeout(5000);
+          page.setDefaultNavigationTimeout(60000);
+          const errors = [];
+          page.on("pageerror", (e) => errors.push(e.message));
+          t.after(() => page.context().close());
+          await page.route("**/*", server(lang, saves, asked, linked));
+          await page.goto("http://magpie.test/?view=providers" + query);
+          const ed = page.locator(".editor.new");
+          const box = ed.locator("label.tick.unmasked input");
+          // the editor's own bar: a new one's last button is Add
+          const pressAdd = async () => {
+            const n = saves.length;
+            await ed.locator(".bar button").last().click();
+            for (let i = 0; i < 50 && saves.length === n; i++) await page.waitForTimeout(50);
+            assert.equal(saves.length, n + 1, "Add sent a Save");
+            return saves.at(-1);
+          };
+          return { page, ed, box, saves, asked, errors, pressAdd };
+        };
+        const unfold = async (ed) => {
+          const adv = ed.locator("details.advanced");
+          await adv.waitFor({ state: "attached" });
+          if (!(await adv.evaluate((d) => d.open))) await adv.locator(":scope > summary").click();
+          return adv;
+        };
+
+        await t.test(`${lang} ${width}: a local preset opens with the switch on, and is added so`, async (st) => {
+          const { page, ed, box, asked, errors, pressAdd } = await open(st);
+          await page.locator("#addProvider").click();
+          await page.locator("#addSheet .tile .n", { hasText: /^Ollama$/ }).click();
+          await ed.locator(".ehead b", { hasText: "Ollama" }).waitFor();
+          // under Advanced, which stayed folded: the default hides nothing
+          assert.equal(await box.evaluate((c) => !!c.closest("details.advanced")), true, "the switch is under Advanced");
+          assert.equal(await ed.locator("details.advanced").evaluate((d) => d.open), false, "Advanced stays folded");
+          assert.equal(await box.isChecked(), true, "opens with the switch on");
+          const saved = await pressAdd();
+          assert.equal(saved.preset, "ollama");
+          assert.equal(saved.unredacted, true);
+          assert.equal("chat" in saved, false, "the preset's own URLs, nothing moved");
+          assert.deepEqual(asked, [], "localhost is known local: nothing is asked about it");
+          assert.deepEqual(errors, []);
+        });
+
+        await t.test(`${lang} ${width}: a custom provider at a local URL is added unmasked`, async (st) => {
+          const { page, ed, box, asked, errors, pressAdd } = await open(st);
+          await page.locator("#addProvider").click();
+          await page.locator("#addSheet .row-head .custom").click();
+          await ed.locator("input").first().fill("Strata");
+          await ed.locator("input.base-url").fill("http://127.0.0.1:8080/v1");
+          assert.equal(await box.isChecked(), true, "the switch turns on with the local URL");
+          const saved = await pressAdd();
+          assert.equal(saved.name, "Strata");
+          assert.equal(saved.chat, "http://127.0.0.1:8080/v1");
+          assert.equal(saved.unredacted, true);
+          assert.deepEqual(asked, [], "an IP is known local: nothing is asked about it");
+          assert.deepEqual(errors, []);
+        });
+
+        await t.test(`${lang} ${width}: a custom provider at a vendor's is added masked`, async (st) => {
+          const { page, ed, box, errors, pressAdd } = await open(st);
+          await page.locator("#addProvider").click();
+          await page.locator("#addSheet .row-head .custom").click();
+          await ed.locator("input").first().fill("Relay");
+          await ed.locator("input.base-url").fill("https://api.vendor.example/v1");
+          assert.equal(await box.isChecked(), false, "a vendor's stays masked");
+          const saved = await pressAdd();
+          assert.equal(saved.chat, "https://api.vendor.example/v1");
+          assert.equal(saved.unredacted, false);
+          assert.deepEqual(errors, []);
+        });
+
+        await t.test(`${lang} ${width}: a local one the user unticks is added masked`, async (st) => {
+          const { page, ed, box, errors, pressAdd } = await open(st);
+          await page.locator("#addProvider").click();
+          await page.locator("#addSheet .tile .n", { hasText: /^Ollama$/ }).click();
+          await ed.locator(".ehead b", { hasText: "Ollama" }).waitFor();
+          await unfold(ed);
+          assert.equal(await box.isChecked(), true);
+          await box.uncheck();
+          assert.equal(await box.isChecked(), false);
+          const saved = await pressAdd();
+          assert.equal(saved.preset, "ollama");
+          assert.equal(saved.unredacted, false, "the user's word about it, whatever the address");
+          assert.deepEqual(errors, []);
+        });
+
+        // a magpie://import link is an add too: one naming a local server is
+        // added unmasked, and one naming a vendor's stays masked
+        await t.test(`${lang} ${width}: an import link goes in as its addresses say`, async (st) => {
+          const local = await open(st, { query: "&import=link1", linked: { id: "box", name: "Box", chat: "http://127.0.0.1:8080/v1" } });
+          await local.page.locator(".editor.import").waitFor();
+          const added = await local.pressAdd();
+          assert.equal(added.chat, "http://127.0.0.1:8080/v1");
+          assert.equal(added.unredacted, true, "a link to a local server is added unmasked");
+          assert.deepEqual(local.errors, []);
+
+          const away = await open(st, { query: "&import=link1", linked: { id: "relay", name: "Relay", chat: "https://api.vendor.example/v1" } });
+          await away.page.locator(".editor.import").waitFor();
+          const other = await away.pressAdd();
+          assert.equal(other.unredacted, false, "a link to a vendor's is added masked");
+          assert.deepEqual(away.errors, []);
+        });
+      }
+    }
+  });
+}
diff --git a/internal/provider/unredacted.go b/internal/provider/unredacted.go
index efe676d5b..ab9011dbb 100644
--- a/internal/provider/unredacted.go
+++ b/internal/provider/unredacted.go
@@ -2,6 +2,7 @@ package provider
 
 import (
 	"net"
+	"strings"
 
 	"github.com/yetone/magpie/internal/netproxy"
 )
@@ -33,11 +34,55 @@ func (p Provider) SkipsRedaction() bool {
 	return false
 }
 
+// LocalServer says p is the user's model at their own computer or on their
+// local network: it has an address, and every address it has is a local
+// host (LocalHost, so a name of the user's own DNS is looked up). A
+// signed-in account and a plugin's provider never are, since their vendor
+// is where they go, and neither is another magpie, whose addresses are
+// that other computer's and which masks by its own Settings › Privacy.
+// Only adding one asks (UnmaskedOnAdd); a request never does.
+func (p Provider) LocalServer() bool {
+	if p.Account != nil || p.IsRemoteMagpie() {
+		return false
+	}
+	n := 0
+	for _, raw := range []string{p.Chat, p.Responses, p.Anthropic, p.Gemini, p.Decide} {
+		h := urlHost(raw)
+		if h == "" {
+			continue
+		}
+		n++
+		if !LocalHost(h) {
+			return false
+		}
+	}
+	return n > 0
+}
+
+// UnmaskedOnAdd is p as it goes in where the user adds it: their model at
+// their own computer or on their local network starts with "Send requests
+// unmasked" already on (the owner, 11-18) — their machine, which holds
+// whatever they say to it, so masking has nothing there to keep from them,
+// and its first request would otherwise be masked for it. Nothing they
+// said is changed: the switch already on, and one left off, stand over it
+// (the editor sends its own value; `unmasked=no` says so). Only whoever
+// adds a provider asks, and only then: a saved provider keeps what it was
+// saved with whatever its address is, and a copy, a sync and a gateway all
+// go through Add, so nothing is read off an address in Add itself
+// (SkipsRedaction is the user's word alone).
+func (p Provider) UnmaskedOnAdd() Provider {
+	if p.Unredacted || !p.LocalServer() {
+		return p
+	}
+	p.Unredacted = true
+	return p
+}
+
 // LocalHost says host is on this machine or the local network: localhost,
 // a .local name, a loopback, private or link-local IP, or a name every
 // address of which is one (netproxy.LocalName, looked up now and kept a
-// minute; one that doesn't resolve isn't). Only the editor's caution asks
-// it (/api/local-hosts), never a request.
+// minute; one that doesn't resolve isn't). Only the editor's caution and
+// adding a provider ask it (UnmaskedOnAdd), never a request.
 func LocalHost(host string) bool {
 	if local(host) {
 		return true
@@ -47,3 +92,18 @@ func LocalHost(host string) bool {
 	}
 	return netproxy.LocalName(host)
 }
+
+// urlHost is the host a stored URL is asked at, "" for anything that isn't
+// one. A URL saved with no scheme is taken as http, as the editors take
+// what is typed for an address, and a name is compared in lower case, as
+// the editor's own reading of one does (localIP in app.js).
+func urlHost(raw string) string {
+	raw = strings.TrimSpace(raw)
+	if raw == "" {
+		return ""
+	}
+	if !strings.Contains(raw, "://") {
+		raw = "http://" + raw
+	}
+	return strings.ToLower(hostParts(raw).name)
+}
diff --git a/internal/provider/unredacted_test.go b/internal/provider/unredacted_test.go
index d35d727d7..15d5c039b 100644
--- a/internal/provider/unredacted_test.go
+++ b/internal/provider/unredacted_test.go
@@ -3,6 +3,7 @@ package provider
 import (
 	"context"
 	"net"
+	"path/filepath"
 	"testing"
 
 	"github.com/yetone/magpie/internal/netproxy"
@@ -69,6 +70,104 @@ func TestLocalHost(t *testing.T) {
 	}
 }
 
+// LocalServer, asked only of a provider being added (UnmaskedOnAdd), reads
+// its addresses the way the editor does: the user's own model at their own
+// computer or on their local network, at every address it has. A name that
+// doesn't resolve and a vendor's aren't, so nothing is asked on the network
+// here either.
+func TestLocalServer(t *testing.T) {
+	fakeDNS(t, map[string][]string{
+		"llm.corp.lan":   {"192.168.1.20"},
+		"vendor.example": {"203.0.113.7"},
+	})
+	cases := []struct {
+		name string
+		p    Provider
+		want bool
+	}{
+		{"loopback", Provider{Name: "My box", Chat: "http://127.0.0.1:8080/v1"}, true},
+		{"no scheme saved", Provider{Name: "My box", Chat: "127.0.0.1:8080/v1"}, true},
+		{"localhost, as the local presets have it", Provider{Name: "Ollama", Preset: "ollama", Chat: "http://localhost:11434/v1", Anthropic: "http://localhost:11434"}, true},
+		{"on the LAN", Provider{Name: "vLLM box", Chat: "http://192.168.1.20:8000/v1"}, true},
+		{"https on the LAN", Provider{Name: "Lab", Responses: "https://10.0.0.4:8443/v1"}, true},
+		{"a LAN name", Provider{Name: "Corp LLM", Chat: "http://llm.corp.lan:8000/v1"}, true},
+		{"a vendor", Provider{Name: "DeepSeek", Chat: "https://api.deepseek.com/v1"}, false},
+		{"a public IP", Provider{Name: "VPS", Chat: "http://203.0.113.7:8000/v1"}, false},
+		{"a name that doesn't resolve", Provider{Name: "Typo", Chat: "http://llm.corp.lanx:8000/v1"}, false},
+		{"local and a vendor among them", Provider{Name: "Relay", Chat: "http://127.0.0.1:8080/v1", Anthropic: "https://vendor.example"}, false},
+		{"no address", Provider{Name: "Nothing"}, false},
+		{"a signed-in account at a local address", Provider{Name: "Codex", Chat: "http://127.0.0.1:4321/v1", Account: &Account{Agent: "codex"}}, false},
+		{"another magpie on the LAN", Provider{Name: "Office", Preset: RemoteMagpiePreset, Anthropic: "http://192.168.1.5:3425"}, false},
+	}
+	for _, tc := range cases {
+		if got := tc.p.LocalServer(); got != tc.want {
+			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
+		}
+	}
+}
+
+// UnmaskedOnAdd, which whoever adds a provider by command asks of it (the
+// editor reads the same thing for its own switch): a local server goes in
+// with the switch on and nothing else about it changes. What the user said
+// stands over it — a vendor they set anyway keeps the switch — and one with
+// nothing local about it goes in as it came. Leaving a local one masked is
+// the adder's to say before asking: the CLI's unmasked=no and the editor's
+// switch left off never come here at all.
+func TestUnmaskedOnAdd(t *testing.T) {
+	fakeDNS(t, map[string][]string{"llm.corp.lan": {"192.168.1.20"}})
+	cases := []struct {
+		name string
+		p    Provider
+		want bool
+	}{
+		{"a box on this computer", Provider{Name: "My box", Chat: "http://127.0.0.1:8080/v1"}, true},
+		{"a local preset", Provider{Name: "Ollama", Preset: "ollama", Chat: "http://localhost:11434/v1"}, true},
+		{"a box on the LAN", Provider{Name: "vLLM box", Chat: "http://192.168.1.20:8000/v1"}, true},
+		{"a LAN name", Provider{Name: "Corp LLM", Chat: "http://llm.corp.lan:8000/v1"}, true},
+		{"one the user already set", Provider{Name: "My box", Chat: "http://127.0.0.1:8080/v1", Unredacted: true}, true},
+		{"a vendor, left masked", Provider{Name: "DeepSeek", Chat: "https://api.deepseek.com/v1"}, false},
+		{"a vendor the user set anyway", Provider{Name: "Vendor", Chat: "https://api.deepseek.com/v1", Unredacted: true}, true},
+		{"no address", Provider{Name: "Nothing"}, false},
+		{"a signed-in account", Provider{Name: "Codex", Chat: "http://127.0.0.1:4321/v1", Account: &Account{Agent: "codex"}}, false},
+		{"another magpie on the LAN", Provider{Name: "Office", Preset: RemoteMagpiePreset, Anthropic: "http://192.168.1.5:3425"}, false},
+	}
+	for _, tc := range cases {
+		got := tc.p.UnmaskedOnAdd()
+		if got.Unredacted != tc.want {
+			t.Errorf("%s: %v, want %v", tc.name, got.Unredacted, tc.want)
+		}
+		if got.Chat != tc.p.Chat || got.Name != tc.p.Name || got.Preset != tc.p.Preset {
+			t.Errorf("%s: the provider itself changed: %+v", tc.name, got)
+		}
+	}
+}
+
+// Add reads no address: what a saved provider does is only what it was
+// saved with, so a copy, a sync, and everything the gateway adds keep the
+// switch as it was given (UnmaskedOnAdd is the adder's to ask).
+func TestAddReadsNoAddress(t *testing.T) {
+	isolate(t)
+	home := t.TempDir()
+	t.Setenv("HOME", home)
+	t.Setenv("USERPROFILE", home)
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
+	id, err := Add(Provider{Name: "Box", Chat: "http://127.0.0.1:8000/v1", Key: "sk-box", Models: []string{"m"}})
+	if err != nil {
+		t.Fatal(err)
+	}
+	p, err := Find(id)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if p.Unredacted {
+		t.Fatal("Add turned the switch on from the address: only whoever adds the provider asks UnmaskedOnAdd")
+	}
+	if !p.LocalServer() {
+		t.Fatal("the box at 127.0.0.1 isn't a local server")
+	}
+}
+
 // fakeDNS has names resolve to m's addresses and no other name resolve,
 // so no test looks a name up on the network.
 func fakeDNS(t *testing.T, m map[string][]string) {
diff --git a/internal/tui/pages.go b/internal/tui/pages.go
index 0ceff331c..56c4be757 100644
--- a/internal/tui/pages.go
+++ b/internal/tui/pages.go
@@ -670,6 +670,11 @@ func vertexProjectAsk(p provider.Provider) ask {
 // addCmd adds p, a preset's provider, and says what came of asking its
 // vendor for its models.
 func addCmd(p provider.Provider) tea.Cmd {
+	// the user's model at their own computer or on their local network goes
+	// in with "Send requests unmasked" already on, as the app's editor
+	// leaves it for one (provider.UnmaskedOnAdd); another magpie's address
+	// is that computer's, not this one's, so it is asked and answers not
+	p = p.UnmaskedOnAdd()
 	return func() tea.Msg {
 		id, err := provider.Add(p)
 		if err != nil {
-- 
2.50.1 (Apple Git-155)

```
</details>


