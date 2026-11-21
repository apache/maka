Verification of @NightGlowww's fix ([commit `93eb598e`](https://github.com/NightGlowww/magpie/commit/93eb598e16ed2e5f2e35bbb85a06526d16517552) on their fork, branch `codex/codex-models-oauth`, based on `17154e165`): **re-verified against current main, and it holds — VERDICT PASS.** I fetched that exact commit, rebased it onto today's tip (`7199afbb6`) keeping the author, and re-ran the claims myself. Same person as the reporter, so one attribution below covers both.

**The rebase** — branch [`hunt-20261112-t1-5197`](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5197) (head `eddaca1f3`, base `7199afbb6`, Author: NightGlowww preserved). Forty-one commits have touched `internal/gateway/lan.go` / `codex_backend.go` since `17154e165`; none come near `identifyCaller`'s token normalization or `codexModels`, so the code hunks applied as-is — the added lines are byte-identical to the original commit. The only conflict was one docs bullet in `docs/subsystems/gateway-routing.md` that upstream rewrote in place since (`provider.CodexListed` → `CodexListedBeside`); the patch's new paragraph is re-anchored above the updated bullet, saying the same thing.

**Red without the fix, reproduced on the rebase's own base `7199afbb6`** — with the two product files reverted to the parent and the branch's tests kept, all four fail, in the shapes the commit message records:

| test | result on base |
| --- | --- |
| `TestCodexModelsKeepOAuthBesideGatewayKey` | the four keyed subtests fail `model list: 401 {"detail":"invalid client sign-in"}` (the OAuth-less "local OAuth alone" subtest passes on base too — the bug never touched the keyless path) |
| `TestCodexModelsGatewayKeyIsNotOAuth` | fails `status 200, upstream requests 1; want a local 401` — on base a key-only request actually reached ChatGPT carrying the internal token and served the server's list |
| `TestCodexModelsOAuthStillNeedsAnEnabledGatewayKey` | fails — protective, green only with the fix |
| `TestCodexModelsCacheUsesClientOAuth` | fails — protective, green only with the fix |

With the fix restored: all four pass, and `-race -count=20` passes (ok 16.6s) — the claim in the commit message, reproduced.

**Patch mechanics** — `git am` of the rebased commit's format-patch onto `7199afbb6` yields a tree byte-identical to the branch head (SHA-256 first 16 of the exported patch: `fe9d00a9dcea31df`). `gofmt` clean; `go vet ./internal/gateway/` clean (darwin); `go build -tags nogui` clean on linux/amd64 and windows/amd64. Gateway-package full suite on the rebased head: `ok` 988.114s, zero failures.

**Boundary checks I did beyond re-running the tests** (all read from the rebased tree): `identifyCaller` only runs for remote callers or requests carrying a managed key, so a keyless OAuth-only `/models` request never enters the kept-auth path and behaves exactly as before (the passing "local OAuth alone" subtest on unmodified base confirms it); key-only and gateway-token-shaped bearers are refused locally with zero upstream asks; LAN/disabled/expired key guards still 401 with the OAuth present — keeping the bearer does not bypass any gateway check; the kept auth is scoped to `GET <codex>/models` only, one context producer and one consumer, and every other route keeps the internal-token normalization.

**Not verified**: a real ChatGPT backend (the commit's isolated real-catalog probe was theirs; my run is fixture-level); Linux/Windows runtime (build + vet only); GUI/Playwright.

**Attribution**: the fix and its tests are @NightGlowww's — please keep them as the author or add `Co-authored-by: NightGlowww <44762336+NightGlowww@users.noreply.github.com>`. This verification post was written with GLM-5.3-Flash (ZCode).

