Verified the proposed diff and its synthetic regression tests against upstream `main`.

## What I verified

| Check | Result |
|---|---|
| Pre-image match | the patch's pre-image blob `87b90e9` is byte-identical to `internal/gateway/gateway.go` at `be002aca` and at the current tip `da6fd87e` |
| Apply | `git apply --3way --check` clean on `be002aca` (5 commits past the stated base `e00fbdbb`) and again on `da6fd87e`; lands with no conflicts, `codexRecheck` computed once at the top of `serve`, `quotaRecheck` wired into the local cap write and the final refusal exit |
| Ablation (product reverted to baseline, tests kept) | RED, exit 1 — `Retry-After` came back `7200`, `900` and `10800` plus an unshortened date form, matching the baseline values stated in the proposal |
| Restore (full diff back) | GREEN, exit 0 — all five tests pass: `TestCodexQuotaRecheckAccountsRecover`, `TestCodexQuotaRecheckHeldKeys`, `TestCodexQuotaRecheckCaps`, `TestCodexQuotaRecheckHeaders` (7/7 subtests), `TestCodexQuotaRecheckKeepsAutoReset` |
| Race | `go test -tags nogui -race -run 'TestCodexQuotaRecheck' -count=1` passes (CGO enabled, mingw64 gcc) |
| Format and vet | `gofmt -l` clean on the three touched files; `go vet -tags nogui ./internal/gateway/` clean |
| Neighbor families | `TestAccountCap*`, `TestCodexAutoReset*`, `TestCodexNoCredits*`, `TestNativeCompaction*`, `TestStrictAffinity*`, `TestDrawCapped*` all pass with the patch applied |

Ablation verbatim (baseline code + the proposed tests only):

```text
codex_quota_recheck_test.go:36: first: 429 Retry-After "7200": {"error":{"code":null,"message":"Codex: The usage limit has been reached","param":null,"type":"rate_limit_error"}}
--- FAIL: TestCodexQuotaRecheckAccountsRecover (0.58s)
codex_quota_recheck_test.go:82: request 0: 429 Retry-After "900": {"error":{"code":null,"message":"mockdead: you have reached your weekly usage limit","param":null,"type":"rate_limit_error"}}
--- FAIL: TestCodexQuotaRecheckHeldKeys (0.18s)
codex_quota_recheck_test.go:102: cap: 429 Retry-After "10800" tried "" spent ""
--- FAIL: TestCodexQuotaRecheckCaps (0.25s)
codex_quota_recheck_test.go:130: 429 Retry-After "Fri, 23 Oct 2026 09:49:36 GMT" after 1 upstream calls; want 429 "60" once
--- FAIL: TestCodexQuotaRecheckHeaders/date_quota (0.16s)
```

Same mechanism shape as the field record at the top of this issue (a fast local 429 that sends Codex to sleep until a remote reset point), and exactly the baseline values the proposal claimed (7200/900/10800 instead of 60). The short vendor delay, rate-limit, credit-error and other-agent cases already pass in the red state, as they should. Restoring the product change turns everything green, including recovery without a renewal event and the preserved real cooldowns.

## Relationship to the diagnosed root cause

The diff covers both refusal paths discussed on this issue: the local all-accounts-held write (`cappedError`, and `checkpointCappedError` — the #2517 compaction-pin exit that shares it) and the routed upstream quota refusal, plus the `quotaHeld` held-response whose `Retry-After` is written in the same final-refusal region. `quotaRecheck` reuses the one existing `retryAfter` parser rather than adding a second dialect, it only touches the `Retry-After` header (reset headers and error bodies are untouched), and the two `restAfterMarked` sites that compute account rests read the vendor's headers before the shortening.

## Drift and landing

The stated base `e00fbdbb` is 5 commits behind `be002aca`; none of them touch `internal/gateway`, and the current tip `da6fd87e` still carries the identical `gateway.go` blob — so the diff applies as-is today with `git apply --3way`. Not run here: the full suite and non-Windows vet/build. I also cannot check the two production log lines (481,803/481,784 s); the synthetic red state above is the mechanism evidence I can reproduce on my side.

## Gaps (naming, not fixing)

- In a conversation that stays strict, the last candidate's rest can be computed after the shortening: the `restAfter` call in the strict-alone corner reads the already-shortened header. The impact is narrow — a quota rest prefers the body's reset time, reset headers and the local window reading over the `Retry-After` fallback, and is capped by the longest quota rest — so it only bites a refusal that states its wait solely via `Retry-After`. The proposed tests cover session affinity only; a strict-mode case would pin this corner.
- The draw path writes its own `Retry-After` from the same capped hold (the `drawOnAccounts` cap back-off) and is not covered — same long-sleep mechanism, already noted from the field report earlier in this issue.
- Gateway-key budget refusals also emit `Retry-After` and are out of scope here. Auth-flood, lane/RPM waits (bounded at about a minute) and the relay busy path are bounded or internal, so leaving them alone looks right.

## Attribution

The proposal is posted as an inline diff; I found no fork branch or commit, so there is no commit metadata to inspect and no trailer exists yet. If it lands, authorship should record guo-yu, for example `Co-authored-by: guo-yu <1269537-guo-yu@users.noreply.github.com>`. I also compared it with the fix branch posted here earlier in the thread: different file, different constant (60 s vs 30 s), different tests — no content is taken from it, so no co-author trailer toward that branch's author is needed for this patch.

Thanks @guo-yu — the routed-upstream half is a real addition to what was diagnosed here, and the ablation values matched exactly.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
