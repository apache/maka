Verified and endorsing the reporter's branch. I applied it onto current `upstream/main` and every check below was run locally on that tree (darwin/arm64, go 1.26.8).

**What the branch does, as measured in the diff** (`93d12c18`, one commit on `ae032794`; all five points match the issue):

| Claim | In the diff | Result |
| --- | --- | --- |
| A ChatGPT account's model with `UltraOn` is offered `priority` + `ultrafast` | `CodexTiers` gains an `ultra map[string]bool` parameter and, on the non-group account branch (`Account.Agent == "codex"`), sets `m.Tiers = []string{codexFastTier, "ultrafast"}` when `UltraOn` holds; both call sites (`codexListed`, `agent.buildModels` for magpie-models.json) read `UltraModels()` once and only when a ChatGPT account's model is in the list | PASS (`TestCodexTiersOfferUltrafastAnAccountHas`) |
| An entry copied from Codex's `models_cache.json` that lacks Ultrafast gets it appended (`withUltrafast`) | `codexcat.entriesAt` calls `withUltrafast(e)` on the cache-copied entry when `m.Tiers` holds `ultrafast`; a built entry gets the `ultrafastTier` beside `fastTier`; `withUltrafast` is idempotent (checks for an existing `ultrafast` id first) | PASS (`TestUltrafastOfferedPastTheSignedInAccountsCache`) |
| Groups are offered Fast alone (their other members would be sent `ultrafast` as it is) | The account branch sits after the group branch's `return`; the group path never reaches it | PASS — the test's group case asserts no `ultrafast` with `Fast` set; `TestGroupUltra` (gateway) also green on the patched tree |
| Relays, remote magpies and plugins keep their own tiers | The remote/plugin passthrough (`m.Tiers = e.Tiers`) and the relay's own-entry tiers are set before the account branch; a relay's model never carries `ultrafast` | PASS — test's relay case; `TestRemoteMagpieFastPick` (gateway) also green |
| No Codex account in the list → `UltraModels` never read, nothing offered Ultrafast | `ultra` stays nil unless a non-group entry with `Account.Agent == "codex"` is present; nil `ultra` makes `UltraOn` false | PASS — test's nil case |

**Ablation (red without the change)** — both tests run against the fix reverted, exactly as reported:

- `TestCodexTiersOfferUltrafastAnAccountHas`: `an account's model offered [priority], want priority and ultrafast` — RED
- `TestUltrafastOfferedPastTheSignedInAccountsCache`: `codex/gpt-6.1-sol offered "priority ", want "priority ultrafast "` (and `gpt-6.2` likewise) — RED

**Verification matrix** (on the branch's own tree and on a 3-way `git am -3` of `format-patch -1 93d12c18` onto `f44fa2ef6`; two conflicts, both mechanical — upstream's new `listed`/`apart` lines in `codexListed` and its `shownName(m)` rename in `entriesAt` — resolved keeping both sides; rebased commit `cf4f17dc4`):

| Check | Result |
| --- | --- |
| Both claimed tests on `93d12c18` and on the rebased tree | PASS |
| Full packages: `go test -tags nogui -count=1 ./internal/provider/ ./internal/codexcat/` | ok 139.8s / ok 11.8s, no failures |
| Gateway tier subset (`TestCodexPoolKeepsUltrafast`, `TestModelsListTiersForEveryClient`, `TestGroupUltra`, `TestUltraIsSentAsMax`, `TestCopilotSolOffersUltra`) | ok |
| `gofmt -l` on touched packages | clean |
| `go vet ./...` (darwin), `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...` | clean (only internal/gui's pre-existing cgo warnings on darwin, present without the patch) |
| Builds: `GOOS=linux go build -tags nogui ./...`, `GOOS=windows go build -tags nogui ./...`, darwin | clean |
| `go test -tags nogui ./internal/agent/` | fails `TestMothX` — same single failure on a pristine `f44fa2ef6` worktree without the patch (pre-existing, MothX agent detection, unrelated to tiers) |

**Boundary check** — the same `CodexTiers` output feeds both `/v1/codex/models` and the `magpie-models.json` magpie writes for a Codex CLI pointed at magpie, so the two lists agree, and the gateway already routes an `ultrafast` ask to an account that offers it (`TestCodexPoolKeepsUltrafast` covers the tier reaching the backend). Not verified here: a live end-to-end against a real ChatGPT Pro account (none on this machine), and the GUI suite — same scope the reporter disclosed.

Direction fresh as of posting: no commit on `upstream/main` mentions #4034, and `internal/provider` / `internal/codexcat` are unchanged in the touched symbols between `ae032794` and `f44fa2ef6`.

Branch: [`3rd-Musketeer/magpie` `codex-ultrafast-tier`](https://github.com/3rd-Musketeer/magpie/tree/codex-ultrafast-tier), head `93d12c18` (base `ae032794`). A rebased copy carrying the same change is on [`ggbdpq/magpie` `fix/4034-ultrafast-tier-verify`](https://github.com/ggbdpq/magpie/tree/fix/4034-ultrafast-tier-verify), head `cf4f17dc4`, applied with `git am -3` preserving the original author.

Attribution: the commit is and stays 3rd-Musketeer's (author Haoyang Wu, kept through the rebase); I only resolved the two merge conflicts and added a `Generated-by` trailer as the rebasing committer.

AI use: verification performed with AI assistance (ZCode); all commands and outputs above were run and read locally.

Thanks @3rd-Musketeer for the report, the precise mechanism write-up, and the ready-to-ship branch.
