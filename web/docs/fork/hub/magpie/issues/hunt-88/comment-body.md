Confirming the findings in the verification above independently — the sibling defect is real, and the complete fix should be taken from that branch.

**The sibling defect, verified in code.** On our patch's logic (`c0edbe7e`, same diff as `137d1b8a`), `readKeyAllowance` writes `e.at = now` on every completed read, failed or not (`internal/provider/key_allowance.go:144`), and `keep` then takes `startedAgain`'s comparison origin from `e.at` (`:173`, `old, wasAt := e.a, e.at`). The origin is therefore the latest attempt, not the last successful reading: a reset that elapsed between two successful readings fails `l.Resets.After(wasAt)` and never reaches `OnStarted` — with or without a failed read in between — and a failed read also leaves `e.a` and `e.at` out of step. Upstream `main` has no `startedAgain`/`OnStarted` at all yet (checked `c158b043`; `git log -S startedAgain` on `origin/main` is empty), so this face exists only inside the community patch and needs the sibling fix to be complete.

**Cross-check of the regression test** (Windows, go 1.26.8, `-tags nogui`, head `e8116214`):

- With `d132dacb`'s product file reverted wholesale, `TestKeyAllowanceElapsedResetStartsAgain` cannot compile against the unfixed logic — the test asserts the `aAt` field the fix introduces, so test and fix are coupled by design.
- With only `keep`'s comparison origin reverted to the attempt time (`e.at` where the fix reads `e.aAt`), the test fails as recorded:

```
--- FAIL: TestKeyAllowanceElapsedResetStartsAgain (2.17s)
    key_allowance_started_test.go:93: the reset passed since the last successful reading: OnStarted was told nothing
```

- With the fix restored: green, together with both gateway regressions and the full `internal/provider` package except this host's pre-existing failures — the same ten tests (the Codex keychain family, `TestCodexListTagKeptWhileNothingChanged`, `TestSavedButSignedOut`) fail identically on untouched `main` `c158b043` here, so they are environmental, not the patch's:

```
--- PASS: TestKeyAllowanceElapsedResetStartsAgain (0.23s)
--- PASS: TestReadingKeepsARefusalsRest (2.35s)
--- PASS: TestAutoVisionKeepsOffARefusedAccount (2.47s)
```

`-race` skipped: no gcc on this host.

**Taking the complete fix.** Please take the branch head `e8116214` (https://github.com/Edward4226/magpie/tree/codex/issue-2718-elapsed-reset) as the one coherent patch: our core commit is in it with authorship retained as `137d1b8a` (its diff is byte-identical to our `c0edbe7e`, author `ggbdpq`), plus the sibling fix `d132dacb` and the regression. Accordingly, the patch block in my earlier update post (https://github.com/yetone/magpie/issues/2718#issuecomment-6398777970) is superseded by that head — amending the older block would ship the key-path sibling unfixed. The head sits on `main` `7499ebb5`; current `main` has moved to `c158b043`, but none of the nine files the patch touches changed in between, and `git merge-tree` reports no conflicts. The sibling fix itself reads as a minimal repair inside plan point 1: it only repairs when `OnStarted` may fire for keys, what lifts what is untouched, `renewedNow` still tells both hooks, and points 3 and 4 of the plan remain unclaimed.

**Attribution**: written with GLM-5.3-Flash (ZCode); no new code in this comment.
