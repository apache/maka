# 2685 fnm 半边（发布稿，英文）——本地待发布，未获授权不发

The fnm half, on my branch [hunt38-c-libmcp-fnm-find](https://github.com/ggbdpq/magpie/tree/hunt38-c-libmcp-fnm-find) (head `ca89fd36`, on top of `717b69f7`), attached below.

<details>
<summary>patch</summary>

```diff
[PATCH_BODY]
```

</details>

**What changed.** The two halves of one lookup:

- The Library's health check started a stdio server with the command as typed, and exec finds a bare name on the PATH the process carries. A magpie started from a shortcut doesn't have a version manager's Node on it, so a server a terminal runs through fnm — the report's `npx -y chrome-devtools-mcp@latest`, its second error — failed the check as "notfound" while the agents ran it fine: they look their own CLIs up through `proc.FindTool`, PATH first, then the folders a user's tools are installed in (#839, #1482). `checkStdio` now looks a bare command up the same way before starting it; a command with a path in it, absolute or relative, still starts as typed, resolved where the command runs.
- fnm's folders were missing from that lookup on Windows: `UserBinDirs` had npm, bun, Volta, pnpm and mise, while fnm's folders were computed in a `//go:build !windows` file. The version enumeration and fnm's layout move into a shared `nodever.go` that takes where a version's programs sit — `installation/bin`, or on Windows the installation itself, `npx.cmd` with no bin folder — and `UserBinDirs` now walks `FNM_DIR`'s folder, else `%APPDATA%\fnm`, the default alias ahead of the versions by number.

**Verification.**

| Check | Result |
| --- | --- |
| New `TestCheckStdioVersionManagerNode` (internal/library): a fake MCP server copied to `~/.local/share/fnm/node-versions/v22.12.0/installation/bin/npx`, PATH without it | red on `717b69f7` — `notfound`, the report's 找不到 npx — green after; `-race -count=3` green |
| Ablation: `mcp_check.go` restored to `717b69f7`, test kept | red again (`notfound`); fix back, green |
| New `TestFnmBinsShapes` (internal/proc, both platforms): fnm's layout per platform, default alias hoisted, versions by number | green here for both the `installation/bin` and the Windows `installation` shape |
| New `TestUserBinDirsFnm` (`//go:build windows`): `%APPDATA%\fnm`'s versions highest first, `FNM_DIR`'s ahead of them, `FindTool("npx")` = v22's `npx.cmd` | compiles under `GOOS=windows`; no Windows machine here, not run |
| Existing nvm/fnm ordering tests after the move (`TestUserPathNvmDefault`, `TestFindToolNvmDefaultFirst`, `TestUserBinDirsFnmMise`) | green |
| `gofmt -l`; `go vet ./...`, `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...`; `go build`, `GOOS=linux go build -tags nogui`, `GOOS=windows go build` | clean |
| `go test -tags nogui ./...` | green except `internal/gui`'s `TestProxyCheckSaysAProxyPassedBy`, red on unmodified main too (a fake proxy answers 502 saying it was never asked; not this patch's) |

**Not verified**: a real Windows desktop; the Windows-tagged test's run.

---
**Source**: reported in #2685; the plan is the one laid out in yetone's review comment (fnm's folders on Windows, `checkStdio` through `proc.FindTool`, tests).

**Red without the fix** (base `717b69f7`): with `internal/library/mcp_check.go` reverted and the new test kept, `go test ./internal/library -run TestCheckStdioVersionManagerNode` fails:
```
mcp_check_test.go:318: got {State:error Tools:0 ToolList:[] Why:notfound Code:0 Detail:npx ...}, want ok with 3 tools: the server a terminal runs through fnm must start
```
With the fix: `ok`.

**Siblings**: `rg -n "LookPath|FindTool" internal/library` → the check (`checkStdio`, changed) and `rtk_upgrade.go`'s `have()` — left, it asks whether the standalone rtk binary is on PATH for a self-upgrade, not whether a version manager's server starts. The agents already resolve this way (`binAt`, internal/agent/agent.go). `proc.Command` itself is untouched: every other caller keeps exec's own lookup.

**When the read fails**: not applicable — no file reads added; a folder that can't be read contributes no directory, as before.

**Not verified**: a real Windows desktop; the Windows-tagged test's run; the GUI on Windows.

**AI**: written with GLM-5.3-Flash (ZCode); I've read the whole diff and can answer questions on it myself.
