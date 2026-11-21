Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `31a25b400`, branch [`fix/5668-escape-raw-control`](https://github.com/ggbdpq/magpie/tree/fix/5668-escape-raw-control). The patch contains literal escape sequences, so it's attached as a `.patch` URL rather than inlined: https://github.com/ggbdpq/magpie/commit/31a25b400cf997b799aeb362091d08445fe750af.patch

Verification on the new base:

- Tests re-run green: `TestRawControlByteInStringEscapedAndRouted`, `TestRawControlByteInStringEscapedOnResponses`, `TestRawControlByteOutsideStringStillRefused`, `TestParsedRequestEscapesNothing`, `TestEscapeRawControlBytes`, `TestDecodeRequestReturnsTheBodyItTook`.
- Ablation on the new base: the mended-body branch out (`n > 0` fork) → both escape-and-route tests red; restored → green.
- Sibling scan: `decodeRequest`'s call sites unchanged in kind on this base (the gateway gained 43 commits since the old base; the parse-entry contract this patch wraps is the same single `decodeJSON` choke point).
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `b2b66b333d4d54be`. Real 6.8 MB+0x00 relay reproduction stays NOT-RUNNABLE here, as posted (the httptest shape covers the wire bytes).

Generated-by: GLM-5.3-Flash (ZCode)
