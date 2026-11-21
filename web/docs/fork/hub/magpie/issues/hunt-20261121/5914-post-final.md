Rebased onto current main (`18cfe278b`) and re-verified — the lock design this patch is moves with the setters' current shapes, and the rebase surfaced one divergence to put in front of you (below). Author kept (`yjqi`, the fix is theirs; I carried it and re-ran the checks).

**What the rebase had to adapt** (each disclosed, none silent):

1. **Upstream's setters are whole-provider Saves now.** `SetRouting`, `SetAffinity`, `SetSink`, `SetCapStop`, `SetCapCareful`, `SetCountFree`, `SetKeepLogin`, `SetSwitchOnly`, `SetRestartApp` were editFound-style setters at the base this patch was built on; current main writes each through `Save(*p)` — the caller's read written whole. Under this patch's lock that shape loses whatever changed meanwhile (a key's limit set during a routing set reads back 0 — `TestProvidersKeyLimitKeepsRoutingSetMeanwhile` pins exactly that loss, green here, red on a tree where the setter is a whole-Save). This patch keeps those nine as editFound setters, which is the design the lock is: one setting changed writes one setting. If you have moved away from that on purpose, the nine are the lines to weigh.
2. **`SetRouting`/`SetAffinity` keep their refusal of an unknown value.** Current main clears an unknown value at `normalize` inside `Save` instead; under the lock the refusal is what keeps a value nothing reads out of the file. Their unknown-value tests now pin the refusal.
3. **RenameGroup composed with upstream's refs-based picks.** Upstream's current code builds `refs := groupRefs(g)` and calls `renameGroupPicks(from, refs, now)`; the lock's `renameGroupRead` now returns those refs — taken before the rename, under the lock — and `RenameGroup` hands them on. `GroupRefs` stays public for the callers upstream added.
4. **The From header spells the author's name "yjqi at YjdeMacBook-Pro.localdomain".** Their git name itself carries an `@` (the machine's local domain), and `git am` reads such a display name as the email — the patch's author line came out with the real email lost. Spelled with "at", the am keeps name and email (`yanjie@5466053088715162.onaliyun.com`) whole; the branch commit carries their original string.

| Element | Evidence (darwin/arm64, upstream/main `18cfe278b` + this commit) |
| --- | --- |
| Lock tests | `TestProvidersKeyLimitKeepsRoutingSetMeanwhile`, `TestUnknownRoutingRefused` and the whole `providers_setters_lock_test.go`/`providers_lock_test.go` families green; red on a tree where the nine setters are whole-Saves (the pin above) |
| Rename tests | upstream's `TestRenameGroupKeepsPicks`, `TestRenameFoundGroupKeepsItsPicks` green on the composed `RenameGroup` |
| Touched package, full | `go test ./internal/provider -count=1` → 169.6s, one red: `TestResolveVia` — the known local proxy red (base same) |
| `-race` | the lock and rename tests green under `-race` (6.7s) |
| gofmt / `git diff --check` | clean |
| vet ×3 / build ×3 | darwin / linux / windows (`nogui`) clean |
| git am | the patch at the URL below applies cleanly on `18cfe278b`; the replayed tree `5d4e4a56f54b863769ef739fe063c1cd7c6616e0` equals the branch head's tree; author kept |

NOT-RUNNABLE here: two real magpies' cross-process contention on one `providers.json` — `filelock.Strict`'s refusal paths are covered by `providers_busy_test.go` and `strict_test.go` with a second process simulated.

**Branch with the commit**: [`hunt-20261111-rf-5914`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5914) (head `ee002237830e6ac7a2b9895a493d3d578297f767`). Patch, `git am` ready — 440 KB, over the comment size limit, so as a file: [`git am < https://github.com/ggbdpq/magpie/commit/ee002237830e6ac7a2b9895a493d3d578297f767.patch`](https://github.com/ggbdpq/magpie/commit/ee002237830e6ac7a2b9895a493d3d578297f767.patch) — sha256[:16] `fbf5f5de915a9cc0`.

Attribution: the fix is qiqll's (yjqi, author kept on the commit, their `Co-authored-by: Claude Opus 5.5` line carried as they wrote it); AI-written (GLM-5.3-Flash (ZCode)) carried it onto the current main and re-ran the checks.
