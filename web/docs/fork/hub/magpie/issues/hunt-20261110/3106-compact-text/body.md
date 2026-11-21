Rebased onto current `upstream/main` (`803d7747e`), head `596e88dba`, branch [`fix/3106-compaction-silent-assistant`](https://github.com/ggbdpq/magpie/tree/fix/3106-compaction-silent-assistant). One conflict in the compaction retry classifier, resolved as a union: upstream's `inputKindRefused` term (#5815's image-count family) and this patch's `refusesMessages` term both gate the ask-again-as-text fallback.

Verification on the new base:

- `TestCodexCompactMessagesRefusedAsksAgainAsText`, `TestMessagesRefusedOnlyMatchesBadRequestShapeErrors` green.
- Ablation on the new base: the `refusesMessages` term out (a messages-shape refusal ends the turn again) → red; restored → green.
- Sibling scan: both classifier terms are independent predicates over the same recorder — no shared state; the union keeps each family's retry semantics.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `2c7c028a7e1ce531`.

Generated-by: GLM-5.3-Flash (ZCode)
