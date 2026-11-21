Verified https://github.com/skygunner/magpie/commit/a016fcee20251311b7a71b90474cc4d2f07a2445 by cherry-picking it onto upstream/main `63be4771` and ablating the product change on Windows (Go with pinned GOPATH/GOMODCACHE/GOCACHE).

The implementation lands on the diagnosed root cause: `CodexNativePicked` (`internal/provider/codex_models.go`) now treats `ServesNone()` as a narrowing before the empty-picks fallback, so Usage only drops the account's visible models from `/backend-api/codex/models` through the existing `codexModels` filter — the same single mechanism as the proposed fix, no second judgment. The only textual difference from the proposed patch is `return nil, true` where the proposal had `return map[string]bool{}, true`; the function's only caller (`codex_backend.go`: `if keep, narrowed := provider.CodexNativePicked(); narrowed`) reads a nil map exactly like an empty one, so the behavior is identical. Hidden internal entries stay and a switched-off provider keeps its native list, both covered by the new table-driven test.

Ablation, `go test -tags nogui -count=1 -run TestCodexUsageOnlyCatalog ./internal/gateway`:

With the product file reverted to `63be4771` (fix removed, test kept):

```
--- FAIL: TestCodexUsageOnlyCatalog (1.20s)
    --- FAIL: TestCodexUsageOnlyCatalog/usage_only (0.09s)
        codex_usage_only_test.go:71: models = [codex-auto-review fake/m1 gpt-5.5 gpt-6-sol gpt-reserve], want [codex-auto-review fake/m1 gpt-reserve]
```

Exactly the failure the commit message reports: only Usage only fails, with `gpt-6-sol` and `gpt-5.5` remaining beside the internal jobs and `fake/m1`.

With the fix restored:

```
ok  	github.com/yetone/magpie/internal/gateway	1.898s
```

Attribution, checked in the commit itself: Author `vincent <webmaster@palmit.com.au>`, and the message carries exactly `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`. Confirmed.

Drift and landing: the commit's parent (`2bddfe10`) is 488 commits ahead of `63be4771`, 16 of them touching `internal/provider/codex_models.go` or `internal/gateway/codex_backend.go`. Cherry-picking onto `63be4771` applies the product and test hunks cleanly; only the "Model picks" row of `docs/subsystems/providers-accounts.md` conflicts, from that evolution. On a main near the author's base the commit should land as is; on an older one only the docs row needs a hand merge, the code needs nothing. As of today's main (`e00fbdbb`): the fix is still absent, and the commit's whole diff passes `git apply --3way --check` there.

Siblings: `rg "CodexNativePicked\(" --type go` finds one caller (`codexModels` in `codex_backend.go`), covered because the fix sits in the shared function. `CodexNativeUnlisted` (routing groups, #1602) and `CodexNativeHidden` (#1867) are separate filters with their own tests, deliberately unchanged.

Ran here: the RED/GREEN above; with the fix, `TestCodexModelList*` and `TestCodexModelsEtagTagged` together with the new test: `ok`. Not run here: `-race` (the author ran `-race -count=5` on native Linux; this Windows box has no C compiler, so cgo is unavailable), the full 69-package acceptance sweep, and anything needing a real ChatGPT account or a Codex Desktop refresh — the author lists those as not checked too.

Thanks for the fix and for the co-author credit.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
