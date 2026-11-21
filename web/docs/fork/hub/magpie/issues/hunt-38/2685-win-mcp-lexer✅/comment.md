<!-- Draft for a comment on yetone/magpie#2685. NOT posted this round. -->

Reproduced both halves on Windows 11 with fnm's Node, at bad4508c, and I have a local fix — happy to open a PR if the direction sounds right.

**What actually breaks.** Two details differ from the report, the conclusion doesn't:

- `:` survives. `words()` folds away only the `\` (`C:\Users\me\npx.cmd` comes back as `C:Usersmenpx.cmd`); the saved command is a broken drive-relative path either way.
- A **single-quoted** path round-trips fine: `quote()` wraps it in single quotes and `words()` reads a single-quoted word as it is. My guess is the probe in the report lost its backslashes to shell escaping — lifted verbatim from client.js, `words("'C:\Users\me\npx.cmd'")` keeps the path whole. The broken cases are the unquoted line and a double-quoted one (the `c === "\\" && q === '"'` branch folds `\` too).

**The fix, both halves:**

- `words()` (client.js): on Windows a backslash is a path separator and is kept, in a bare word and in double quotes; in double quotes a backslash now escapes only what the shell does there (`"`, `\`, `$`, `` ` ``) on both platforms — on POSIX this also stops `"a\nb"` folding into `anb`, which the old fold did. Single quotes and the POSIX bare-word escape are untouched, pinned by a test that stubs `navigator.platform` to a Mac and asserts the old POSIX behavior still holds.
- `quote()` (client.js): on Windows a backslash no longer asks for quotes, so a saved `C:\Users\me\npx.cmd` reopens in the field exactly as saved.
- `UserBinDirs()` (proc/path_windows.go): fnm's Node folders were unreachable (`fnmBins` lived behind `//go:build !windows`, and its `installation/bin` layout is the macOS/Linux one — fnm on Windows keeps `node-versions/<v>/installation` with no `bin` inside). fnm's and mise's version code moved to a shared nodever.go; on Windows the fnm folders (`FNM_DIR`, else `%APPDATA%\fnm`) and mise's `installs/node` join the list.
- `checkStdio` (library/mcp_check.go): a bare command is resolved the way `binAt` finds an agent's CLI (proc.LookPath, then proc.FindTool on Windows), so the check starts what an agent starts. The server's own command is not rewritten; a name nothing finds still reports `notfound` naming it.

**Red, at bad4508c:**

- `internal/gui/tests/mcp-command-lexer.test.cjs` (new, Chromium and WebKit): the reopened editor showed `'C:\Users\...\npx.cmd'` and the save came back with every `\` folded away. Green with the fix; the POSIX-stub part stays green on both sides of it.
- `TestUserBinDirsHasFnmsNode` (proc, new): `UserBinDirs = []` where fnm's two installation folders were built under `FNM_DIR`. Green after.
- `TestCheckStdio/bare tool off PATH` (library, new): `{Why:notfound Detail:npx}` for an npx.cmd under `FNM_DIR`, off PATH — the reporter's second error, as a test. Green after (`exited(3)`: the check ran the file).
- Ablations: reverting client.js, mcp_check.go or path_windows.go alone turns its test red again, each.
- On this machine: a probe against proc at bad4508c shows `UserBinDirs()` without any fnm folder and `exec.LookPath("npx")` failing on a registry-only PATH; after the fix `UserBinDirs()` lists the five fnm installations and `FindTool("npx")` reaches `Fnm\node-versions\v26.10.0\installation\npx.cmd`.

**Siblings checked:**

- `words()`/`quote()` have no other callers: the editor field, `serverLine()`'s four display uses, nothing else. The paste-JSON entry (`serversIn`) is `JSON.parse`, unaffected. The CLI splits argv and the TUI splits with `strings.Fields` — both keep a backslash, as the report says.
- routing/client.js has its own `words()`: it re-translates labels on a language change, not a lexer.
- `checkStdio` was the only place a server's bare command is started by magpie itself; rtk's `proc.Command` calls take already-resolved programs.

**Not verified / not tried:**

- This box is Windows only: the Go tests never ran on macOS/Linux (the POSIX fnm layout keeps its own tests in nodever_other_test.go, untouched), and the POSIX side of `words()` is pinned only by the navigator-platform stub in the Playwright test.
- The reporter's registry PATH (no node folder anywhere) wasn't reproduced machine-exactly — this box has a standalone NodeJS on the machine PATH, which `FindTool` reaches today; the notfound shape is reproduced with a bare PATH in the probe and in the sandboxed test.
- The hint text ("as you'd type them") is left as is: with the lexer fixed it is now true for `C:\…` too, so no string changed and no i18n keys moved.
- The library package's full run on this box has two pre-existing reds (`TestRemoveFoundSkill`, `TestGoneAgentListedToTakeOut`) that fail the same at bad4508c in a clean worktree (no symlink privilege on this account shows the first; the second is identical on the base). The new tests and every other TestCheckStdio subtest pass.
- GUI suite: 24 library-related files, 161 tests, all green in Chromium; WebKit ran the four files closest to the change (20 tests, green). The rest of the suite wasn't run — no string, selector or layout changed.

AI use: the analysis and patch were produced with GLM-5.3-Flash (ZCode) on a fork checkout; every run above was on this machine, commands and outputs recorded locally.
