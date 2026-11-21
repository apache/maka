Verified the fork commit on top of `63be4771` (Windows, Go 1.26.8) as far as this machine reaches: cherry-picked 15759adb, checked the renderer change line by line against my `579942e6`, and ran the Go-side budget gate. The browser regression itself I could not run — no Playwright or browsers installed here, and installing them is outside what I'll do to this checkout unasked.

**What was verified**

- The renderer change matches my patch: the four `p.text` → `balanceText(p)` call sites and the `balanceMeter` body (`quotaLeft ? 100 - used : used`, nearly-full colour keyed to the used share) are verbatim mine. Left still means the meter fills with the remaining share and the warning colour still follows usage — no behavior fork there.
- `balanceText` is the one rewrite: mine computed the complement by hand (`t("{n} left", ...)`), this one delegates to the existing `quotaText`. I checked `quotaText` field by field — same clamp, same `100 - used`, same integer/`toFixed(1)` rounding, same `{n} left`/`{n} used` wording; its `unlimited` and `quotaCount` branches can't fire on `{used: percent}`. Output-equivalent, and the reuse is the better shape.
- Attribution in the commit is present and exact: `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`, with "Adapt ggbdpq/magpie 579942e679de66090299ba73f8c071a9f9bfb89c" in the message. Author: vincent.
- The expanded regression is real: same file grown 123 → 136 lines, five languages (en, zh, zh-TW, ja, de) where mine had two, two Usage/panel width pairs where mine had one, and a `/api/settings/quota-left` route so the test clicks the actual panel switch instead of seeding the setting.

**Drift and landing**: the fork's parent is 478 commits ahead of `63be4771`. Two conflicts on this base. `app.js` is a mis-alignment only (this base already has `balanceShown`; the resolution keeps the one-line comment and the merged body). `core_budget_test.go` is substantive: the commit raises `appScriptBudget` by 100 because on the fork's base app.js is ~85 KB larger and the new renderer pushed it 57 bytes over. On this base that raise is not needed — with the original `1_250_000` kept, `go test -tags nogui -run '^TestCoreScriptBudget$' ./internal/gui/` passes (`ok` 1.252s), so landing here keeps this base's budget values and drops the commit's two budget comment lines; the renderer code itself lands as written. The doc paragraph in `gui-shell.md` lands as written. On today's main (`e00fbdbb`, checked 2026-10-23) the commit's whole diff applies clean (`apply --3way --check`); landing there should still keep main's current `appScriptBudget` — the +100 raise is the fork base's need only.

| Check | Command | Result |
|---|---|---|
| Budget gate with this base's values | `go test -tags nogui -run '^TestCoreScriptBudget$' ./internal/gui/` | ok 1.252s |
| Merged app.js parses | `node --check internal/gui/assets/app.js` | ok |
| Vet / gofmt | `go vet -tags nogui ./internal/gui/`; `gofmt -l core_budget_test.go` | clean |

**Gaps**: the red/green evidence for the behavior itself is the report's and mine from the original patch (its regression waits 5s for "91.1% left" on the old renderer), both unverified on this machine — the ablation here would need Playwright, which this checkout doesn't have. `TestProxyCheckSaysAProxyPassedBy` in the full gui package is red on this machine at the base too (pre-existing, matches the report's note); I did not run the full package. WebKit and real balance endpoints remain unverified on both sides.

Thanks — the quotaText reuse is the right call, and the wider language/viewport coverage plus the real-switch click close the gaps my test left.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
