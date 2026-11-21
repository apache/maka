Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `c03fe50e5`, branch [`fix/3208-go-xnet-bump`](https://github.com/ggbdpq/magpie/tree/fix/3208-go-xnet-bump). The bump carries: `go 1.26.8 → 1.26.10`, `golang.org/x/net v0.56.0 → v0.60.0`, `x/sys v0.46.0 → v0.48.0`, `x/term v0.44.0 → v0.46.0`, `x/text v0.39.0 → v0.42.0`.

Verification on the new base:

- Whole `internal/gateway` (825s) and `internal/provider` (130s) packages green on the bumped toolchain and libraries — for a dependency patch this is the load-bearing check, and it ran on the whole packages rather than a name list.
- Ablation: reverting `go.mod`/`go.sum` to the old pins builds and tests green too — as expected, the old pins are not broken, they are older; the patch's content is the bump itself plus the compatibility evidence above. Noted honestly rather than staged.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `47730ca5fd30e216`.

Generated-by: GLM-5.3-Flash (ZCode)
