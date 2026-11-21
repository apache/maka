Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `5241d3dba`, branch [`fix/5064-opencode-v2-providers`](https://github.com/ggbdpq/magpie/tree/fix/5064-opencode-v2-providers). No upstream commits on the OpenCode provider-sync path in this range.

Verification on the new base:

- `TestOpenCode2sConfigPutsNoV1ProviderBack` green.
- Ablation on the new base: the OpenCode 2 native-spelling check out (`openCodeNativeOn` false, the v1 provider gets re-added on every restart) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `1ed5a5c566e3a28c`. anhuiwangweiwei's OpenCode 2 install stays NOT-RUNNABLE here (the v2 config fixtures cover both spellings).

Generated-by: GLM-5.3-Flash (ZCode)
