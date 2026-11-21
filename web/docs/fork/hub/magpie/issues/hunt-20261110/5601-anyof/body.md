Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `fc853f8d4`, branch [`fix/5601-recursive-anyof-ref`](https://github.com/ggbdpq/magpie/tree/fix/5601-recursive-anyof-ref). No upstream commits on the tool-schema rewrite chain in this range.

Verification on the new base:

- `TestAliyunToolAnyRefs` green.
- Ablation on the new base: the recursive-ref collection out (`aliyunRecursiveRefs` results discarded, refs left in place) → the test's rewrite expectations red; restored → green. (First tried ablating the `forwardOnce` wiring line — the test reaches the transform directly, so that mutation isn't load-bearing; the in-function fork above is the real one and is what's recorded.)
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `925f86f9a662fbec`. Real Aliyun relay refusal stays NOT-RUNNABLE here, as posted (the recursive-`$ref` tool fixture covers the wire shape).

Generated-by: GLM-5.3-Flash (ZCode)
