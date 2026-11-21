Verified the fork commit on top of `63be4771` (Windows, Go 1.26.8): cherry-picked deefacd2, ran the whole-number family, and reproduced both regressions with the product files reverted.

**What was verified**

- The patch is my `4c03aaac` carried over with the changed lines verbatim identical — same five files, same +110/−109; the only patch-text differences are blob ids, hunk line numbers, and one context line that upstream grew after this base. It reuses the existing `wholeNums` normalizer (no second implementation), removes `Request.Grok`/`grokServed` with zero leftovers in the tree, keeps `grokModel` for `grok_schema.go`, and the edge cases (2500.5, 2.50, 2.5e3, 1.0e3, the string "4000.0") stay covered by the same `integralCases`.
- Attribution in the commit is present and exact: `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`, with "Adapt ggbdpq 4c03aaacdf0fe0cccab5000e9bdacecc82371f3e with its regression matrix" in the message. Author: vincent.

**Red without the fix** (gateway.go, grok_integral.go, ir.go reverted to base, tests kept):

| Check | Command | Result |
|---|---|---|
| New tests, product files at base | `go test -tags nogui -run '^(TestOtherModelsCallsGetCodexIntegers\|TestToolSearchWholeFloatLimitGivesCodexIntegers)$' ./internal/gateway/` | FAIL |
| Same, fix restored | same command | ok 7.854s |
| Whole family with the fix | 7 tests, `TestWholeNumsAnyCut` through `TestGrokModel` | ok 51.184s |

The failure lines match the report's own evidence:

```
--- FAIL: TestOtherModelsCallsGetCodexIntegers (0.82s)
--- FAIL: TestToolSearchWholeFloatLimitGivesCodexIntegers (0.16s)
    grok_integral_test.go:671: deltas: yield_time_ms is 2500.0 in {"cmd":"...","yield_time_ms":2500.0,"max_output_tokens":4000.0}, want 2500
    grok_integral_test.go:703: deltas: limit is 8.0 in {"query":"exa web search","limit":8.0}, want 8
```

**Drift and landing**: the fork's parent is 475 commits ahead of `63be4771`; two conflicts on this base, both mechanical — `ir.go` (this base predates `LoadedInPlace`, so the resolution drops the `Grok` field and nothing else) and one paragraph in `gateway-routing.md` (this base still has the old Grok-scoped wording; the new paragraph replaces it, later bullets stay as this base has them). Lands with those two adjustments and nothing else. On today's main (`e00fbdbb`, checked 2026-10-23) the commit's whole diff applies clean as is (`apply --3way --check`), and the fix is still absent — the normalizer there still runs only inside the Grok-served gate.

**Gaps**: same as the report states — no real muse-spark turn and no real Codex session on either side; the gathered route (whole-body client of a streaming account) rides the same `passthrough` chain but has no non-Grok test of its own. `gofmt -l` on the four Go files and `go vet -tags nogui ./internal/gateway` are clean. Not run here: the full gateway package.

Thanks — the carry is faithful, and keeping the regression matrix intact made the ablation a two-command check.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
