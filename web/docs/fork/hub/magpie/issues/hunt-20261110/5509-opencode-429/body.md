Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `7682c105e`, branch [`fix/5509-opencode-429`](https://github.com/ggbdpq/magpie/tree/fix/5509-opencode-429). No upstream commits on `opencode_session.go` in this range.

Verification on the new base:

- `TestOpenCodeRefusalSaysWhatTheVendorSaid`, `TestOpenCodeRefusalSaysABareBodyAndNoWait`, `TestOpenCodeRefusalSaysADatedWaitAsHowLong` green.
- Ablation on the new base: the dated-wait wording out (`retryAfter` fork gated) → the wait/bare-body tests red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `bacf6871b596d011`. Asks 1 and 3 (from the take) remain as posted: the vendor's own refusal text and wait are said; the 429-rest semantics stay the vendor's.

Generated-by: GLM-5.3-Flash (ZCode)
