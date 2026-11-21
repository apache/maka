Rebased onto current `upstream/main` (`10c331531`): the patch reapplied with zero conflicts, head `72a72edf1`, branch [`fix/5029-pace-stale-affinity`](https://github.com/ggbdpq/magpie/tree/fix/5029-pace-stale-affinity). Same change, refreshed — no redesign. Both seams landed where they were: `internal/provider/routing.go`'s reading-in-hand preference beside the snapshot read, and its test.

Drift adjudication since the last base (`0d99261dc`): `internal/provider/routing.go` itself took no upstream commit since (the drift in the package went to quotas, catalog, group and plugin files — none of the pace/allowance reading this patch keys on); the walk of the rebase is a pure position move.

Verification on the new base (head `72a72edf1`):

- The allowance family green: TestAllowancesGoByANewerReadingInHand (this patch's), TestAllowancesStaleMidRead, TestAllowancesFirstWaits, TestAllowancePace, TestAllowanceFor and the rest of the TestAllowance* set — 15 green; the targeted set green under `-race -count=3`; the whole `internal/provider` package green (`135.8s`, zero failures).
- Ablation: `routing.go` reverted to the parent on a detached tree, the patch's test kept → TestAllowancesGoByANewerReadingInHand red (the stale snapshot's share taken again), the neighbor TestAllowancesStaleMidRead green on both trees; restored → green.
- `gofmt -l` clean, `go vet -tags nogui` clean, `GOOS=linux` / `GOOS=windows` builds ok.
- Fresh patch `git am`s clean onto a tree at `10c331531`; sha256[:16] `8085af1806b3e7d0`.

NOT-RUNNABLE as before: @ylongw's real traces of the 29% share taken after idle; the fake readings pin the shape (stale snapshot vs the newer reading in hand).

Generated-by: GLM-5.3-Flash (ZCode)
