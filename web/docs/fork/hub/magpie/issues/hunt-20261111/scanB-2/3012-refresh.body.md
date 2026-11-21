Rebased onto current `upstream/main` (`60559ee73`): zero conflicts, head `9bda9aea3`, branch [`fix/3012-kimi-usage-empty`](https://github.com/ggbdpq/magpie/tree/fix/3012-kimi-usage-empty). Same change, refreshed — no redesign. No upstream commits touch the Kimi plan-quota read (`internal/provider/planquota.go`) in this range — the seam is byte-identical to the last base, and the fresh patch's bytes are identical to the last one's (same sha256 below).

Verification on the new base:

- `TestReadKimiCodeEmptyReply` green; the `TestReadKimiCode*` family around it green (`-count=1`).
- Ablation on a detached tree at `60559ee73` carrying only the test file: `--- FAIL: TestReadKimiCodeEmptyReply` (the empty `{}` read as nothing used again); restored → green.
- Full `./internal/provider` suite on this head: 3 failures, all pre-existing at the tip and none from this patch — `TestQuotaSpanCarriesEveryWindowField` and `TestKeptQuotaReportAsksNobody` (the known reds from the `0706d7a35` era), plus `TestAddSameKeyOtherFormat`, which fails identically on a detached tree at `60559ee73` without this patch (it arrived with upstream's OpenCode Go work, `4a7d222dc`).
- `gofmt -l` clean, `go vet` clean, `GOOS=linux` / `GOOS=windows` builds ok.
- Fresh patch `git am`s clean onto a tree at `60559ee73`; sha256[:16] `9f80ceccedf059f1`.

Generated-by: GLM-5.3-Flash (ZCode)
