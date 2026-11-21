# 2685 交付评论（发布稿，英文）

Fix up on my branch, [hunt38-c-sess-libmcp-winpath](https://github.com/ggbdpq/magpie/tree/hunt38-c-sess-libmcp-winpath) (head `4e4191e1`, on top of `cb05dc2d`), attached below.

<details>
<summary>patch</summary>

```diff
[PATCH_BODY]
```

</details>

**Root cause.** Confirmed as reported, on `cb05dc2d`: `words()` (`internal/gui/assets/plugins/library/client.js:1914`) folds every `\x` into `x`, outside quotes and inside double quotes alike, so a typed Windows path loses every separator, and the server then starts with `C:Usersxxx...npx.cmd`. One correction to the report: a *single*-quoted path does survive — inside single quotes `words()` keeps every byte, so `quote()`'s `'C:\Users\me\npx.cmd'` round-trips whole (the node one-liner in the report drops its backslashes in the JS string literal, before `words()` ever sees them). The broken shapes are the unquoted path (the report's own), the double-quoted one (`"C:\Program Files\..."`), and a UNC path (`\\srv\share` loses its leading `\\`).

**Fix.** The line is split into argv for exec, not into a shell's words — nothing downstream ever folds `\U` into `U`, so the escape had no buyer. A backslash now takes only the next blank or quote with it: `my\ server` still means one word with a space, `it\'s` still means `it's`, and `C:\Users\me`, `"C:\Program Files\me"` and `\\srv\share` keep their separators. Two lines in `words()`, no platform sniffing; `quote()` needs no change, its single quotes were already word-true.

**Verification.**

| Check | Result |
| --- | --- |
| New `internal/gui/tests/library-mcp-windows-command.test.cjs` (Playwright, the real page, faked API): the reporter's line byte for byte, a saved path reopened and saved again, a double-quoted path with a blank, a UNC path, a POSIX-escaped blank | red on `cb05dc2d` — the save POST carries `command: "C:UsersxxxAppDataRoamingfnmaliasesdefaultnpx.cmd"`, exactly the report — green after the fix, chromium and webkit, en and zh |
| Ablation: client.js restored to `cb05dc2d`, test kept | both engines red again; fix back, green |
| Sibling GUI tests `library-mcp-copy-config` and `library-servers-bulk` | green on both engines |
| `node --check` on client.js | clean |

**Not run, and what turned up.** No Windows machine here; the assertions are on what the editor saves, which no OS switches. The report's point 4 — a bare `npx` that `mcp_check.go`'s `LookPath` can't find because fnm's node isn't in magpie's process PATH (`proc.FindTool` vs `path_windows.go`'s shims) — is a second bug and not in this patch. Not run: the full GUI suite. `mcp-editor-cancel`, one of the siblings, went red three times under parallel and load on this machine (a subtest at ~925s of per-step timeouts, the failing language/width drifting between runs: en 1100, zh-TW 390, then ja 1100) and passes in ~100s alone; the fix is branch-equivalent for any input without a backslash (only the `c === "\\"` arms changed), so it isn't this patch's, but it looks like the same busy-machine shape as #2673.

Merged with the reporter's credit kept, or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
