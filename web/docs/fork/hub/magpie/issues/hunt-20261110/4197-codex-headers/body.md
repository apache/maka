Rebased onto current `upstream/main` (`0d99261dc`), head `07808435f`, branch [`fix/4197-codex-headers`](https://github.com/ggbdpq/magpie/tree/fix/4197-codex-headers). One conflict in `provider.go`'s field block, resolved as a union: upstream's `ImageFilesOff` (#5407) and this patch's `CodexClient` both stand, adjacent.

Verification on the new base:

- `TestPluginCodexClientHeaders`, `TestPluginWithoutCodexClientFlagSendsNoCodexHeaders` green; whole-tree build clean with both fields present.
- Ablation on the new base: the header assembly gated out (`p.CodexClient` fork disabled — a plugin's provider gets no Codex identity headers) → `TestPluginCodexClientHeaders` red; restored → green.
- Sibling scan: `codexClientHeader`'s allowlist and the plugin header path unchanged on this range; the negative test still pins the off-by-default shape (Cursor's, Grok's).
- Fresh patch `git am`s clean onto a tree at `0d99261dc`; sha256[:16] `b6d4329b4206444d`.

Generated-by: GLM-5.3-Flash (ZCode)
