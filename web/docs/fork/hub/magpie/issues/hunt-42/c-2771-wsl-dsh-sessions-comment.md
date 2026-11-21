# Comment draft for #2771 (takeover delivery, English, not posted)

Use: one comment on yetone/magpie#2771, with the patch attached or linked as the thread allows. The patch lives locally at `docs/issues/hunt42/c-2771-wsl-dsh-sessions.diff` (unified diff, no corresponding commit yet). If the patch is embedded in the comment, keep the `Generated-by` tail at the end as the one AI disclosure; if the comment only links the patch, replace the `AI:` line's first sentence with `written with GLM-5.3-Flash (ZCode).` so the model is named once. If the reporter's own local fix (mentioned in the issue body) is being submitted, please prefer theirs and drop this one; nothing here is a claim on the issue.

---

Confirmed on upstream main `5380114d`: the Sessions page and the native call reader never look at a distro's `~/.dsh`, and a dsh session there can't be deleted or restored either.

**Where it is**

- `internal/sessions/wsl.go`, `wslAgents`: the agents whose sessions are listed in a distro are claude, codex, pi, omp, kimi — no dsh, so `wslScan` never lists the distro's `~/.dsh`.
- `internal/sessions/sessions.go`, `allFiles`: asks `wslFiles("pi", "omp", "kimi")` — no dsh.
- `internal/sessions/calls_dsh.go`, `dshCallFiles`: `dshFiles()` only, which reads `$DSH_HOME` (else `~/.dsh`) on the Windows host.
- Deleting: `dshSessionDir` and `dshCacheRecord` are rooted at the host's `DshDir()`, so for a distro session they return "" and `sessionPaths` refuses (`no such session`) — a WSL dsh session would not have been deletable once listed.

**The patch**

- `wslAgents` gains `{"dsh", ".dsh"}`; `wslScan` lists it with the existing `dshFilesIn` scan rooted at the distro's `~/.dsh` (head reads only happen for a distro that is running, as the listing itself already does).
- The distro listing carries the session id (`wslEntry.Sid`) that `dshFiles` reads from each session's header, so delete and restore judge the distro's own folders and cached rows (`dshRootOf`), not the host store; a distro no longer listed refuses the delete rather than guessing.
- `allFiles` asks `wslFiles("dsh")` for the Sessions page; `dshCallFiles` appends `wslFiles("dsh")` for native calls, and the gateway-counted calls stay excluded as before (`dshGatewayProvider`).
- The cached session headers (`dshHeads`) are swept per folder, so the distro listing and this computer's read, which run apart, no longer make each other re-read every head.

dsh has no resume-by-id command, so a distro session's `Resume` stays empty, as this computer's do.

If this lands through my patch, please keep the original author's credit or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Verification**

Base `5380114d`, package `internal/sessions`, `go test -tags nogui -p 2`:

| Check | Result |
| --- | --- |
| New `TestWSLDshSessionsListed` (distro listing, title/cwd/tokens, subagent inside its parent, native calls counted, `Dirs()`, delete to trash with the distro's folders and cached rows, this computer's `.dsh` untouched, restore and relist) | RED on base (`no dsh session from the distro`), GREEN with the patch |
| Full `internal/sessions` package | ok (includes `TestWSLStoppedDistroKept` and `TestWSLStoppedSinceNotOpened`: a stopped distro's listing is kept and nothing in it is opened) |
| Ablation: product files (`dsh.go`, `wsl.go`, `sessions.go`, `calls_dsh.go`, `manage.go`, the design page) reverted to base, test kept | RED again at the same assert |
| `gofmt -l`, `go vet -tags nogui` (linux/windows/darwin), `go build -tags nogui` (linux/windows/darwin) | clean (darwin build prints the known `trayimage_darwin.go` cgo `-Wenum-conversion` warning) |

Not run: real Windows with a real WSL distro — this machine is macOS. The tests use the package's existing fake-distro fixture (`wslDistro`'s pattern), the same code path that real `\\wsl.localhost\<distro>` paths take. No real compressed WSL session was read, and no inference or API authentication was exercised (the change reads and moves session files only).

---
**Source**: reported in #2771 (li1how); I verified each named path on upstream main and wrote the patch from it.

**Red without the fix** (base `5380114d`): with the product files reverted and the new test kept, `go test ./internal/sessions -run TestWSLDshSessionsListed` fails:
```
--- FAIL: TestWSLDshSessionsListed: no dsh session from the distro in [...]
```
With the fix: `ok`.

**Siblings**: `rg -n "wslFiles\(|dshFiles\(\)|dshSessionDir|dshCacheRecord" internal/sessions/` → the sessions overview, the call readers, Codex's model/effort read, and the delete paths. Changed: `allFiles`, `dshCallFiles`, `sessionPaths` (via `dshRootOf`). Left: `codex.go` `wslFiles("codex")` (not dsh), `calls.go` claude/codex/kimi asks (covered readers, no dsh there).

**When the read fails**: a session whose header can't be read is not listed, as before; a distro no longer listed makes `dshRootOf` return "" and the delete is refused (`no such session`) instead of touching this computer's `.dsh` (asserted in the test).

**Not verified**: real Windows + real WSL distro, a real compressed WSL session file, `wsl.exe` resume paths (dsh has none).

**AI**: I've read the whole diff and can answer questions on it myself.

Generated-by: GLM-5.3-Flash (ZCode)
