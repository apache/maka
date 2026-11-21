Standing down on this one: the reporter's fix branch covers it, and I verified it locally. No patch from me; this is a verification and endorsement of [the branch](https://github.com/jailbreak07/magpie/tree/kiro-rotation) below.

**Mechanism, as described vs. as measured in the diff** (`3353bda6`, all five points match):

| Claim | In the diff | Result |
| --- | --- | --- |
| The first refusal is kept in its own variable, set in the refusal branch alongside `failRefused` | `var firstRefusal *Try` in `serve`; `if firstRefusal == nil { firstRefusal = &Try{Status: refusedStatus, Error: call.Error} }` at the refusal branch that isn't set aside | PASS |
| Told in the existing end-of-request branch (`f == failQuota || f == failCredit`, `!hw.passing`) when `other` is nil | Condition widened to `(other != nil || firstRefusal != nil)`; `if other == nil { other = firstRefusal }`, then the pre-existing `call.Status, call.Error = other.Status, other.Error` path tells it | PASS |
| As `refusedStatus` (400) with the refusal's own words | `firstRefusal` carries `refusedStatus` + `call.Error`; the test asserts the agent gets 400 with `content_filter` and neither `MONTHLY_REQUEST_COUNT` nor `credits consumed` | PASS |
| The last member is marked `Earlier` | Pre-existing `try.Fail, try.Earlier = f, true` now also runs for the refusal case; the test asserts `Tries[n-1].Earlier` and `Fail == failQuota`/`failCredit` | PASS |
| Hold timing unchanged: the refusal is not put in `other`, so `newHoldWriter` doesn't hold the last member's streamed reply on every request where someone refused | The hold argument at the `newHoldWriter` call reads `other != nil`; `firstRefusal` stays out of it, and the refusal is only told when `!hw.passing` (nothing of the last reply went out, so nothing needed holding) | PASS |

Scope is tight: two hunks in `internal/gateway/gateway.go`, the new `internal/gateway/refusal_earlier_test.go`, and one added passage in `docs/subsystems/gateway-routing.md`. Nothing out of scope.

**Verification** (darwin/arm64, go 1.26.8; on the branch's own tree and on a 3-way `git am -3` of `format-patch -1 3353bda6` onto current `upstream/main` `6d1e3f1e2` — `gateway.go` and the new test merge clean, only `docs/subsystems/gateway-routing.md` conflicted because upstream rewrote items 3–5 since the branch's base, resolved by keeping upstream's text and appending the patch's two sentences to item 5, local commit `63c62472f`):

| Check | Result |
| --- | --- |
| `TestRefusalEarlierWinsOverTheLastAllowance` on `3353bda6` (quota 429 + credit 403 subtests) | ok |
| Ablation: same test with only `gateway.go` reverted to `3353bda6^` (test kept) — "fails without the change" | RED exactly as the commit message says: the agent is handed `429 … "B: usage limit reached: … (MONTHLY_REQUEST_COUNT)"` and `403 … "B: Student plan credits consumed."` — the bug in this issue, reproduced |
| Same test on tip + patch | PASS (both subtests) |
| Full package: `go test -tags nogui -timeout 25m ./internal/gateway/...` | ok 604.0s, no failures |
| `-race` over the `Refus|Earlier|Hold|HandBack|Allowance` subset (the test streams) | ok 81.6s |
| `gofmt` (CRLF-safe `tr -d '\r'`) on both touched .go files | clean |
| `go vet -tags nogui ./internal/gateway/` | clean |

**Boundary check on the self-disclosed "Not covered"** — an Anthropic (Messages API) agent in the earlier-refusal case gets the 400 rather than the vendor refusal body: confirmed in the code, and the disclosure is accurate. `holdWriter.handBack` (#1925) only hands back a refusal the *last* reply held as the vendor's own 200 (`hw.refused`, `status < 400`, a held body), and that branch is tested before the new one and untouched — when the refusal is the last failure, Anthropic agents still get the vendor's 200 with `stop_reason` refusal. In the mixed case this fix covers, the last member's reply is a 429/403, so there is no vendor refusal reply to hand back and the agent gets `refusedStatus` 400 with the refusal's words instead. Consequence unchanged from the disclosure: a Claude Code on that path sees a 400 API error, not a refusal stop reason.

Direction fresh as of posting: no commit on `upstream/main` mentions #4031 and `internal/gateway/` is unchanged between my starting baseline and the tip verified on.

Branch: [`jailbreak07/magpie` `kiro-rotation`](https://github.com/jailbreak07/magpie/tree/kiro-rotation), head `3353bda67adee28140420928f8392c354ec0fae6`. (The branch carries one later commit, `b2e5f2b3` on a resting/probe-window topic; it is not part of this fix and is not verified here.)

Not verified: no live Kiro / Claude Code end-to-end against real vendors — everything above is scripted-provider tests plus code reading.

AI use: verification performed with AI assistance; all commands and outputs above were run and read locally.

Thanks @jailbreak07 for the report and the fix branch.
