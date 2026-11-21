Re-delivered as a single commit (this branch's parent carried an unrelated #5002 commit from the old working state — per the am-replay rule the #4782 commit alone is replayed onto current `upstream/main`, `0d99261dc`; the old two-commit branch is superseded by this one). Head `d300a7f41`, branch [`fix/4782-callback-stage-diagnostics`](https://github.com/ggbdpq/magpie/tree/fix/4782-callback-stage-diagnostics). Zero conflicts; upstream's #2440 work in the same file composes (the replay applied clean past it).

Verification on the new base:

- Whole `internal/claudebridge` package green.
- Ablation noted honestly: this is failure-path diagnostics hardening — the callback-stage timestamps and stderr capture surface in the failure message when the helper hangs; under a passing helper both the hardened and the old form pass (as with any diagnostics-only patch). The original red ("no answer from the helper" with nothing else) is reproducible only with a hanging helper, as posted.
- Fresh patch `git am`s clean onto a tree at `0d99261dc`; sha256[:16] `3603f7056485143d`.

Generated-by: GLM-5.3-Flash (ZCode)
