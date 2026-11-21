# 2685 词法 review 两点补充（发布稿，英文）——本地待发布，未获授权不发

Both points from the review are in, on top of `4e4191e1` (branch `hunt38-c-sess-libmcp-winpath`, now `fbf99f7c` + `ed2e053c`), attached below.

<details>
<summary>patch</summary>

```diff
[PATCH_BODY_1]

[PATCH_BODY_2]
```

</details>

**The trailing backslash.** `"C:\Program Files\"` — the trailing separator a folder leaves — kept the quote open: inside double quotes `\"` was read as an escaped quote, so the rest of the line folded into one word (`command: "C:\Program Files\" -y pkg` saved whole as one). The decision taken: inside quotes a backslash is a byte, the way cmd and PowerShell take it, and only a quote closes a quote — so a double-quoted path may end in a separator and still close, and nothing this field carries needs a literal `"` inside a double-quoted word. Outside quotes nothing moves: `my\ server` is still one word with a space, `it\'s` still means `it's`. Saved through the real editor, the new cases are red on `4e4191e1` under chromium, en and zh, and green after on chromium and webkit, en and zh, as are `library-mcp-copy-config` and `library-servers-bulk`, and `mcp-editor-cancel` alone (its busy-machine reds of the `4e4191e1` round didn't come back).

**The hint.** The command field now says the two things the field means: a Windows path goes in as it is, and a path with a blank in it goes in quotes — translated for zh, zh-TW, ja and de; i18n-keys stays green (the key lives in the plugin's four dictionaries, no kernel duplicate).

---
**Source**: the two points raised in yetone's review of `4e4191e1` on #2685.

**Red without the fix** (base `4e4191e1`): with `client.js` at the branch head and the new test cases kept — that is, the branch before this patch — `BROWSER=chromium node --test internal/gui/tests/library-mcp-windows-command.test.cjs` fails twice, `AssertionError [ERR_ASSERTION]: a double-quoted path ending in a backslash` (en and zh). With the fix: green, chromium and webkit, en and zh.

**Siblings**: the `\"` escape existed only in `words()`'s in-double-quotes branch; the unquoted branch escapes only a next blank or quote, and `quote()` wraps in single quotes, so a saved trailing-separator path round-trips through its own editor (asserted in the test). i18n: the old key had one use site; the new key went into all four plugin dictionaries, `i18n-keys` green (no kernel duplicate, every locale carries it).

**When the read fails**: not applicable — no file reads added.

**Not verified**: Windows GUI; the red run was taken on chromium (green covers webkit).

**AI**: written with GLM-5.3-Flash (ZCode); I've read the whole diff and can answer questions on it myself.
