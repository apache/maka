Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `a78d86e40`, branch [`fix/5624-dsh-dsbot-datadir`](https://github.com/ggbdpq/magpie/tree/fix/5624-dsh-dsbot-datadir). No upstream commits on the dsh/appdir path in this range.

Verification on the new base:

- `TestDshLeavesDsBotsFolder` green (`internal/agent`).
- Ablation on the new base: the `DsbotOwns` fallback out (a `DSH_HOME` naming DS Bot's data folder is taken as-is again) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `e962b1f2d7f7864e`. Real DS Bot installation stays NOT-RUNNABLE here, as posted (the fake-home shapes cover the hijack paths).

Generated-by: GLM-5.3-Flash (ZCode)
