Rebased onto current `upstream/main` (`803d7747e`), head `4162da568`, branch [`fix/2945-upstream-hammer`](https://github.com/ggbdpq/magpie/tree/fix/2945-upstream-hammer). Two conflicts against the new rate-limit-till-time work (hsjzg58958's `timedHeld`), resolved as composition, not choice:

- the held-answer chain now runs `timedHeld` (upstream's vendor-named 429 rest) → this patch's `outageHeld` (twice-failed unreachable) → the bare failure fall-through, in that order;
- the passing-wait gate takes upstream's new `!kept.outlives(wait)` term together with this patch's `!held` term (a held answer is never re-asked as a passing wait), keeping both additions.

Verification on the new base:

- `TestAllRestingOutageAnswersFromRest` green; upstream's `timedHeld` family green in the same tree (`TestTimedHeld*` runs pass).
- Ablation on the new base: the `outageHeld` branch out (resting keys asked one probe each again) → red; restored → green.
- Sibling scan: `rest_probe.go`'s background list-ask composes with `timedHeld`'s unchanged surface — no shared writes.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `04942236e0101b28`.

Generated-by: GLM-5.3-Flash (ZCode)
