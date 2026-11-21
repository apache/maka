Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `a9cb8649c`, branch [`fix/3096-rule-remove-flake`](https://github.com/ggbdpq/magpie/tree/fix/3096-rule-remove-flake). Test-only (`routing-rule-remove.test.cjs`).

Verification on the new base:

- Full file 20/20 pass.
- Ablation: the kept-still quiet-window gated off (proceed without scroll-free frames) — 20/20 still pass in this environment, noted honestly: the guard exists for scroll events the browser itself schedules after a click (the flake's trigger); with no such scroll arriving, both forms pass, and a deterministic red needs the real scroll timing the guard is built to absorb. Not staged.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `840bc6bfad70ae71`.

Generated-by: GLM-5.3-Flash (ZCode)
