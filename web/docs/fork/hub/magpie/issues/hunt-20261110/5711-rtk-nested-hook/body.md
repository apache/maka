@laweit-lxy both follow-ups land in the refreshed patch, on branch [`fix/5711-rtk-sandbox-toml-hooks`](https://github.com/ggbdpq/magpie/tree/fix/5711-rtk-sandbox-toml-hooks) (head `d4a45281c`, rebased onto current `upstream/main`, `7e5cebb86`).

**Half 1 stays confirmed on your machine** — your 11-09 run (banner lists `%LOCALAPPDATA%\rtk` among the sandbox's writable roots, `ls -la` rewritten to `rtk ls -la`, the first Codex-sandbox row in `history.db`) is the real-Windows leg this patch can't run itself; it's folded into the commit message as the confirmation.

**Half 2, the nested form, is in**: `codexTomlHookIn` now reads each group's nested `hooks` array too — a `[[hooks.PreToolUse]]` matcher group whose command lives in `[[hooks.PreToolUse.hooks]]` (`command`, and `commandWindows` on Windows) says on, matching the shape Codex trusted in your `hooks.state` (`config.toml:pre_tool_use:0:0`). New `TestRTKCodexTomlNestedHook` covers your exact TOML: the nested rtk command says on, another command's nested hook says off, and off Windows a nested hook only `commandWindows` sets stays off (Codex wouldn't run it there). One more thing since the rebase: the read now goes through `edit.TOMLWithout(raw, "projects")` (#2278), so a 1.5 MB `config.toml` costs a decode of the hooks tables alone, like the file's other readers.

Rebase note: zero conflicts; the one upstream commit in the area (#2278, 11-09) reroutes the file's readers away from whole-file decodes, and this reader follows it.

Verification on the new base (`7e5cebb86`, v0.1.3435), darwin:

- `TestRTKCodexTomlHooks`, `TestRTKCodexTomlNestedHook`, `TestRTKCodexGainWritable` green; whole `internal/library` ok (82s); GUI `library-rtk-gain.test.cjs` 6/6.
- Ablation, each on the new base: nested-array read out → `TestRTKCodexTomlNestedHook` red; `has` back to hooks.json alone → `TestRTKCodexTomlHooks` red ("the hook is in config.toml's [hooks.PreToolUse], yet Codex showed off"); the `writable_roots` write out → `TestRTKCodexGainWritable` red ("writable_roots = [], want rtk's folder alone"). All green again restored.
- Sibling scan: `codexTomlHookIn` is the only reader of Codex `config.toml`'s `[hooks]` for rtk (`hooks.go`'s event tables and `claude_subscription`'s hook notices are different paths); `3fc6ee411..7e5cebb86` touched this file once (#2278) — folded in as above.
- Fresh patch `git am`s clean onto a tree at `7e5cebb86`; sha256[:16] `9c8df54ac202e5cd`. NOT-RUNNABLE here: a real Windows elevated sandbox (your run is the live evidence for that half).

Generated-by: GLM-5.3-Flash (ZCode)
