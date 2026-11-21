I verified the classification gap on current main and then the candidate branch from the previous comment. I am not posting a duplicate patch; this comment independently backs that candidate.

**Diagnosis confirmed on current main** (`9d08993c`, macOS arm64, code audit)

1. A loopback request carrying a recognizable key enters `identifyCaller` through `lanGuard` (`internal/gateway/lan.go:391`; `callerGuard` at `lan.go:520` shares it for embedded handlers).
2. `access.Check` answers with its generic unknown error — not `*access.Refused` — for a disabled key (`k.Off`, `internal/access/issue.go:247`), a removed secret, a rotated-away value, and a fabricated `sk-magpie-` value. Only an expired key, or one issued under a key that is no longer enabled, gets `Refused` and its 401 (`internal/gateway/lan.go:547-553`). So all four recognizable cases pass through on loopback.
3. `identifyCaller` then overwrites `Authorization` (and `x-api-key`, `x-goog-api-key`, `?key=`) with the ordinary token (`internal/gateway/lan.go:574`).
4. `gatewayOrigin` (`internal/gateway/middleware.go:202`) re-evaluates `managedKey(r)` against the replaced headers — false — and with no `access.Caller` identity falls through to `local`. The contract says a `sk-magpie-` key that didn't authenticate reads `gateway-key`, "on loopback too" (`docs/subsystems/gateway-request-hooks.md`), so implementation and contract disagree exactly as reported.

**Candidate verification** (`feat/nowledge-authenticated-key-id-20261101`, head `265c6f0`, base `da0005df`; Go 1.25.5, Bun 1.4.2)

| Check | Evidence | Result |
| --- | --- | --- |
| Green at the candidate head | `go test -tags nogui -race ./internal/gateway -run 'TestAsyncGatewayUnrecognizedKeyOnLoopback|TestAsyncGatewayOrigin|TestAsyncGatewayThroughProtocols' -count=1` | PASS; `unkeyed` and `ordinary local token` stay `local`; `disabled`/`removed`/`rotated`/`fabricated` read `gateway-key` with no authenticated ID |
| Red without the fix | candidate tests kept, `lan.go`/`middleware.go`/`plugin/gateway.go`/`plugin/host.js` reset to base `da0005df` | the four recognizable cases fail — `gateway_hook_test.go:505: status=200 identity={Origin:local ID:}, want gateway-key with no authenticated ID` — and the two unrecognizable cases still pass, matching the report's reproduction |
| Applies to current main | `git format-patch` of `265c6f0` + `git apply --3way` onto `9d08993c` | clean on all six files; the two targeted origin tests pass on that tree; `gofmt -l` clean on the changed Go files |

**Notes for review** (non-blocking)

- Between `da0005df` and `9d08993c` only `internal/plugin/host.js` changed upstream (59+/7−), and its hunk still applies cleanly three-way; a rebase onto current main before merging would keep the history linear.
- `ctx.callerKeyId` is an addition beyond the filed bug, which is only about `origin` classification. It is self-contained and the docs block carries its own caveats (the ID identifies the credential, not a person; an absent ID authorizes nothing). The classification fix stands on its own without it, so reviewers can judge the extension separately.
- As the author already flags, hooks observe a behavior change for requests they saw as `local` until now. That restores the documented contract, but release notes mentioning it would help plugin authors who relied on the old reading.

**Not verified**: the full `internal/gateway` package suite on the candidate tree (only the three targeted tests; `-race` only on the candidate head, not on the applied-to-main tree); Windows; the author's cross-repo Nowledge harness; whether existing plugins rely on today's `local` classification.

**Attribution**: written with GLM-5.3-Flash (ZCode); I've read the whole diff of the candidate and can answer questions on it myself.
