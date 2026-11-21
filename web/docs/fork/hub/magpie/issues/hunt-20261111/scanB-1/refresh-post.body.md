Rebased onto current `upstream/main` (`af3334533`) — same patch, not redesigned. The old base was from before two changes this patch has to answer:

1. **The core-script budget gate now counts code, not comments** (`6cc182339`, #5918): the caps were reset to a `codeBytes` measure and the chain-in-comments is gone (the history is `git log -L` of the file now). The editor's addition is re-measured that way: **1,104 bytes of code** over the core's scripts — `app.js` itself stays within its own cap (its 5,653 of room absorbs the editor sections) — so `coreScriptBudget` is raised to **1,264,437, with no room added**, and the commit message says why.
2. **Conflict adjudication on the new base**:
   - `internal/gui/core_budget_test.go`: the gate's new shape kept as is (the old chain entries it replaced are gone with it); only the core cap moves.
   - `internal/gui/assets/app.js`, three union merges: `draftOf` and the save body gain upstream's newer fields (`billing`, `clientCert`/`clientKey`/`serverCA`/`serverPin`, `socket`, `upstreamProviders`, `passUserAgent`) beside this patch's `hiddenSpeech`/`hiddenEmbeddings`; the editor's speech and embedding sections go in beside upstream's subscription warm-up/check-in/resets row (`provPrefsField`). Everything else of the 91KB applied clean — `servingObjects`, `ServingOf`, `PluginServing` and the editor's own new sections were untouched by upstream in this window.

**Re-verification on the new base** (darwin/arm64, Go 1.25.5, head `4a14707c7`):

| Check | Result |
| --- | --- |
| `TestSpeechAndEmbeddingModelsHidden` (gui), `TestPluginServingMapsWhatThePluginSays` (provider), `TestModelsListServingKindsWhenAsked`, `TestHiddenServingModelStillServes`, `TestModelsListMediaOnlyWhenAsked` (gateway) | PASS |
| `TestCoreScriptBudget` (the new code-only gate) | PASS at 1,264,437 |
| The wider kind family (`TestKindGroupsServeEachAPIByRoute`, `TestVideoKindGroupByTheModelsID`, `TestKindGroupHoldsTheExactModel`, `TestKindlessListFetchedOnce`, `TestFetchKeepsModelsOfOtherAPIs`, `TestVideoModelsHidden`, `TestImageModelsHidden`, `TestPluginModelSayingNoTextLeavesTheChatList`, `TestPluginAccountListLeavesTheSpeechlessOut`) | PASS |
| Targeted `-race` of the four new tests | PASS |
| Ablation (a): the hidden-skip `continue` in `servingObjects` dropped | `TestModelsListServingKindsWhenAsked` red — `serving_kind_test.go:97: the hidden speech model still listed`, `:100: the hidden embedding still listed` — while `TestHiddenServingModelStillServes` stays green (it pins the "still serves" half); restored, green |
| Ablation (b): the save-keep branches (`in.HiddenSpeech == nil && old != nil`, `HiddenEmbeddings` likewise) dropped | `TestSpeechAndEmbeddingModelsHidden` red — `speech_hidden_test.go:70: a Save that left them out changed them: [], []`; restored, green |
| Full `go test -tags nogui ./internal/provider` | 3 FAILs, none this patch's: `TestAddSameKeyOtherFormat` is red on clean `af3334533` too — upstream's own (your LESSONS entry of 11-11 records it red on main, fixed by `7e8214d60` which landed after this base); `TestQuotaSpanCarriesEveryWindowField` and `TestKeptQuotaReportAsksNobody` are the house reds that `7e8214d60` also fixes upstream |
| Full `go test -tags nogui ./internal/gui` | 2 FAILs, both house reds (`TestProxyCheckSaysAProxyPassedBy`, `TestSessionReadsRoutes`) |
| Full `go test -tags nogui ./internal/gateway` | 1 FAIL, the house red `TestKeyLimitReservationsStayInTheirWindow`; everything else ok (1263.8s) |
| `gofmt -l` / `go vet -tags nogui` of the three packages | clean / clean |
| `go build -tags nogui` darwin, `GOOS=linux`, `GOOS=windows` | clean |

Sibling scan vs the rebase base: upstream's window touched `app.js` (the Usage period, the settings head, the price guards, `#6135`'s video input — new files, nothing in `servingObjects`) and the budget gate itself; none of it touches `servingObjects`, `ServingOf`, the editor's save-keep, or `PluginServing`, which this patch owns.

At POST time `upstream/main` had moved again (`a6d84e13a`): `7e8214d60` is the test-only fix for the provider reds above; the others (`7e3e0fec4` restore-on-quit, `2bb201162` env-lines paste, `319753d89` key masking, `fc615339f` Alibaba quota, `a6d84e13a` LAN HTTPS) edit `app.js`/`i18n.js`/provider files in regions this patch doesn't own. This branch stays on `af3334533`, where it is verified and the budget adjudication is measured; the fresh patch also `git am`s clean onto a fresh checkout of the newest tip `a6d84e13a` (tried before posting).

Patch URL (not inlined at this size): https://github.com/ggbdpq/magpie/commit/4a14707c76dcdae842b3b9e88bb8f5778ce98384.patch

Branch: [`fix/5418-provider-kind-sections`](https://github.com/ggbdpq/magpie/tree/fix/5418-provider-kind-sections) (head `4a14707c7`), sha256[:16] of the `.patch`: `05b24a9b30004001` (56,607 bytes)

Attribution: 分析与补丁由 GLM-5.3-Flash (ZCode) 协助完成
Generated-by: GLM-5.3-Flash (ZCode)
