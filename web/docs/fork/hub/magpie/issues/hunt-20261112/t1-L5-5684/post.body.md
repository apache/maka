Independent verification of @skygunner's branch ([`fix/5684-dsh-trailing-sentinels`](https://github.com/skygunner/magpie/tree/fix/5684-dsh-trailing-sentinels), commit [`dab6c4f8`](https://github.com/skygunner/magpie/commit/dab6c4f8dad134341b7e6e94d0fdb5a5e01d0f9e), based on `ed0ab567`): **this fix is correct for the reported scenario, and I'd endorse taking it.** What I ran and read, on a clean fetch of that exact commit:

**Reproduction and fix, at the branch's own commits**

- On the unmodified base `ed0ab567` with only the branch's new test (`internal/agent/dsh_sentinel_test.go`) added, `go test ./internal/agent/ -run TestDshSyncKeepsAdjacentManagedBlock` fails at `dsh_sentinel_test.go:55: block or route comment changed` — the real `Sync` path moves the One Memory sentinel, the reported symptom.
- At the branch head `dab6c4f8` the same test passes (ok 1.230s). The one test covers the whole claim set: the adjacent managed block stays byte-for-byte (sentinels at column 0), a comment inside the route is retained, the route still works (a new model lands in it), a second `Sync` is byte-identical (idempotent), and clearing the model removes the route without losing the block.

**Why it lands cleanly**

`dshPutRoute` is byte-identical between `ed0ab567` and current `upstream/main` — the 14 commits that have touched `internal/agent/dsh.go` since the branch's base don't come near this function, so there is no rebase work between the branch and tip. I also read the mechanism to check it does what the commit says: `dshPutRoute` splits the trailing run of blank/`#` lines off the route's entry before parsing it into a YAML node and re-appends them verbatim after the encoded lines (`dshWrite` writes each item's lines as they are), so the encoder never sees — and never re-indents — another tool's sentinel; on delete it leaves a shell item carrying only those lines, which is what keeps the block when the route goes away.

**The stated scope limits check out**

The two limits @skygunner declares are the real edges of this shape, not oversights: a comment in the middle of a route's fields is still part of the node the encoder re-emits (only the trailing run is protected), and line endings are still normalized on write (`dshWrite` joins with `\n`). Neither is touched by the reported file, which is LF with the sentinel at column 0 after the route's last field.

**Not verified**: real DSH + One Memory integration (fixture-level, like the branch's own test); the branch's `-race`/vet/build claims re-run by me (I re-ran the sentinel test at both commits, the drift check, and the read of the write path); re-adding a route after a removal that kept a shell item (ordering beyond the reported scenario).

**Attribution**: the fix and its test are @skygunner's (author preserved on their commit; please keep them as author or add `Co-authored-by`); this verification post was written with GLM-5.3-Flash (ZCode).
