Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `e44dd15e8`, branch [`fix/4882-noisy-window-measure`](https://github.com/ggbdpq/magpie/tree/fix/4882-noisy-window-measure). Test-only; no product surface.

Verification on the new base:

- `TestLongTurnCopiedFewTimes` green (and `TestMarshalSizedIsJSONMarshal`, same file).
- Ablation: the helper reverted to the shared-window average it replaced — the run passed twice on this quiet box, as expected: the old form isn't wrong by construction, it *includes whatever else allocates during the window* (the reported 1.6 MB bump read as +400 KB a run, 3.2× against the 3× bound). A deterministic red needs concurrent allocation noise to inject, which this patch exists to stop reading; under injection-free conditions both forms pass. Noted honestly rather than staged.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `0764e6e81dea97f4`.

Generated-by: GLM-5.3-Flash (ZCode)
