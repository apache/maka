Rebased @YOUYUDAWANG's fix onto current `upstream/main` (`7e5cebb86`, v0.1.3435): zero conflicts, and `usage/ledger.go`, `sessions/calls.go`, `sessions/antigravity_app.go` have no upstream commits since the reporter's base, so the patch carries over as-is — author unchanged (Chaoyi Liu), this is a verification refresh only. Branch: [`verify/5710-antigravity-step-speed`](https://github.com/ggbdpq/magpie/tree/verify/5710-antigravity-step-speed), head `a6dee3b9f`.

Verification on the new base (darwin):

- Go: `internal/usage` and `internal/sessions` speed/antigravity tests green (`TestSpeed*`, `TestAntigravity*`, `TestReadAntigravity*` families).
- GUI: `usage-antigravity-speed.test.cjs` + `usage-speed.test.cjs` + `usage-speed-count.test.cjs` — 80/80 pass.
- Ablation on the new base: metadata fields 6 and 8 (first token / end) unread → `TestAntigravityAppCallTimes` red; restored → green. (`usage-antigravity-speed.test.cjs` stays green under the same mutation — it witnesses the page layer with its own fixtures, not the parse; the parse-side red above is the load-bearing one.)
- Fresh patch `git am`s clean onto a tree at `7e5cebb86`; sha256[:16] `6ac8b8d0b4328baa`. The reporter's real-device data stays NOT-RUNNABLE here, as posted.

Generated-by: GLM-5.3-Flash (ZCode)
