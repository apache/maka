Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `f9cc00bc9`, branch [`fix/5065-omp-remote-compaction2`](https://github.com/ggbdpq/magpie/tree/fix/5065-omp-remote-compaction2). No upstream commits on the omp/native-compaction path in this range.

Verification on the new base:

- `TestOmpRemoteCompaction`, `TestOmpTriggerUncarriedIsAnError` green.
- Ablation on the new base: omp's error text discarded at the write site (`writeError` told nothing of why the trigger can't be carried) → `TestOmpTriggerUncarriedIsAnError` red; restored → green. (Returning "" from `ompTriggerError` alone stays green — the test pins the explanation reaching omp, which is the fix's substance.)
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `fbffda7d3b943c54`. A real omp V2 setup stays NOT-RUNNABLE here, as posted (the fake omp turn covers the trigger shape).

Generated-by: GLM-5.3-Flash (ZCode)
