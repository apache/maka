@yetone `magpie library sync` on Windows 11 with "Detect agents in WSL" on took 82.5 s and still ended "every agent already has it" (@Doeye1997). Their own goroutine dump sat in `os.Lstat` on `\\wsl.localhost\Ubuntu\home` under `syncSkills`, their CPU profile sat in `library.readView`, `statPart`, `lookPart`, `ours` and `linkTarget`, and their metadata table put one look on a `\\wsl.localhost` path at about 44x one on `C:\` — so the fix follows the reporter's own analysis: look at each WSL ancestor once per step instead of once per skill.

**Root cause**: `resolve` walks a path a part at a time through `lookPart`, and the Library page's read holds a memo of what each part turned out to be (`internal/library/linkmemo.go`, `readParts`, #1771), so a read looks at each folder once. Nothing in the sync held that memo. Every `realDir` in `syncSkills` (`internal/library/skills.go`) — the ownership checks, the sharer detection, the library side of each comparison — therefore re-walked the whole tree down to the skills folder, one look per part: the same few ancestors once per skill per agent, on `\\wsl.localhost` at 44x the price.

**The fix**: each agent's skill step now holds the read's memo while it runs and lets it go before LiveAgent's picks are read, so the ancestors are looked at once for the step and every later reader — a sharer of the same folder, the next step, the page's next read — still sees what the step wrote. The step holds `mu` as the read does, so nothing that writes can run under its memo; a caller without `mu` (a probe of a folder to add) gets what `linkmemo.go` already says it gets, at most as old as the step's last look. Steps outside the skill step (finding the targets, building the step list) walk each agent's tree once per sync, not once per skill, and are left as they are. On the test sandbox one agent's step on 32 skills went from 631 looks at its own folder's ancestors to 33 — what discovery and the step list make once per agent — and the whole test sync's looks fell from 56,909 to 6,802; the remainder is once per skill on cheap local paths (the library's own side, and the leaf looks), the `C:\` column of the reporter's table.

<details><summary>patch: library: an agent's skill step of a sync reads its tree the way a read of the page does (#5450) — git am applies it as is; SHA-256 first 16: 16e7ee4e866ec2d4</summary>

```text
{{PATCH}}
```

</details>

**Branch with the commit**: [`fix/5450-wsl-sync-skill-memo`](https://github.com/ggbdpq/magpie/tree/fix/5450-wsl-sync-skill-memo) (head `e375f4c8a8a817c69fffa24709ed24f36ed53a31`), rebased onto current `upstream/main` (`691a10446`); on a fresh checkout `git am` applies clean (the tree `f5ca67bb76e76787a6fd477ff169d1cb31eddd3d` reproduces byte for byte).

| Check | Result |
| --- | --- |
| `TestSyncSkillsLooksAtAncestorsOnce` (new) | red before the fix (631 and 567 ancestor looks per sync), green after (33 and 33, bound 56) |
| `go test ./internal/library/ -tags nogui -timeout 25m -count=1` | ok (264 s), zero failures |
| `go test -tags nogui ./...` | not run — the change is confined to internal/library, whose whole package passes |
| targeted `-race` (`TestSync*`, `TestRead*`, `TestGlance*`, `TestTake*`, `TestShared*`, `TestSkill*`, `-tags nogui -race`) | pass |
| `gofmt -l internal/library` | prints nothing |
| `go vet ./internal/library/` | clean |
| `go build` (darwin/arm64), `GOOS=windows go build ./...` | clean |
| `GOOS=linux go build ./...` | fails inside wails v3.0.0-beta.24 itself (`undefined: pointer`, `menu_linux.go`) on this toolchain; the commit is pure Go in `internal/library` and out of it — fails the same on origin/main, so it is not a baseline |
| Ablation | removing the `readParts` hold in `syncSkills` turns `TestSyncSkillsLooksAtAncestorsOnce` red (567 ancestor looks); restored, green |
| Re-verified on upstream/main | rebased from `eef99e4bb` to `691a10446` (three provider/native commits between, none touching internal/library); the targeted tests re-ran green after the rebase |

**Not verified**: the 82 s repro itself on real Windows 11 with a real WSL distro — NOT-RUNNABLE here (darwin). The ~44x per-look figure is the reporter's own measurement; the test asserts the same shape it multiplies (looks per sync) on plain local paths.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
