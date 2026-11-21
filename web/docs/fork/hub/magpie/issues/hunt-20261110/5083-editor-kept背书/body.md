Verification refresh: @qiqll's fix (author unchanged, yjqi) rebased onto current `upstream/main` (`0d99261dc`) — zero conflicts. Branch: [`fix/5083-editor-kept-proxies-verify`](https://github.com/ggbdpq/magpie/tree/fix/5083-editor-kept-proxies-verify), head `cd1f19df0`.

On the new base:

- `TestProviderSaveKeepsWhatItLeavesOut` green; GUI `providers-last-edit.test.cjs` 50/50.
- Ablation on the new base: the kept-headers restoration out (`in.Headers == nil && old != nil` gated) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `0d99261dc`; sha256[:16] `60e23c6bb16d2058`.

Generated-by: GLM-5.3-Flash (ZCode)
