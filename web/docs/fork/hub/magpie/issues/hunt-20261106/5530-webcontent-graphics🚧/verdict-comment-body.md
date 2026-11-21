A verdict on the data, with the page found — nothing here is gateway code, and no patch of mine to prove, so this is measurements and a location, not a fix.

**The setup** (Retina where the report was written): production build at `542ee03b4` (includes v0.1.3188's `54dc257f1`), Built-in Liquid Retina XDR 3024×1964 (2x), a temp HOME seeded with a real `providers.json` and the 6 MB `models.json` catalog (235 providers, 8938 models), the window at the report's 1470×820, on Providers.

- Shown, the two WebContent processes hold graphics **7.9 MB / 86 regions** (the window's) and **16 MB / 122** (the panel's) — two orders of magnitude under 1133 MB, because the page that holds the buffers was never open in my HOME.

**The page**: a Providers row of an aggregator, expanded. The catalog's only provider over 600 models is nano-gpt — 636 in today's snapshot, 608 in the report's, and the report's three counts agree all at once: 608 rows ≈ 608 SVGs (the logos), × ~7 divs ≈ 4315 divs, × ~2.4 ≈ 1445 buttons. 608 rows is ≈22,000 px of one column; at 2x a full-width tile is ~6 MB, so 335 buffers / 1133 MB is that one list painted whole, no virtual scrolling — which is also why pages without it hold ~10 buffers.

**Where the 699 standing KeyframeEffects live**: the expand animation. `sheet()` (app.js) animates **every child of the row it opens** — `for (const c of box.children) c.animate(…, { fill: "backwards" })` — so opening that one provider starts ~608 WAAPI animations at once. They finish and are garbage, but their effects stay recorded on layers the compositor keeps until a layer is let go, beside the 699 `BlendingKeyframe`s and 3322 `CubicBezierTimingFunction`s in the report's heap. Only 69 `CSSAnimation`s run because only the sheet's own height run is still going.

**The fill-mode suspicion is ruled out** at today's assets: no `animation-fill-mode` anywhere under `internal/gui/assets` — three shorthand keywords in all (one `both`, two `backwards`) — so the shape v0.1.1164 fixed is not back; its modern form is this per-child WAAPI sheet over an un-virtualized list.

What this settles, and what it leaves:

- The hidden-window half is v0.1.3188's. On this machine its effect is invisible in my numbers — 13–16 layers total, little for the 30 s sleep to release — and replaying the release on a real 608-row list needs the real provider expanded, which a temp HOME cannot grow. That replay is the one thing that would close this; @faithleysath, your page name ("a model or provider long list" — my answer is: nano-gpt or a similar aggregator, its row expanded) would let it be run where the data lives.
- The shown-state half is the un-virtualized 608-row list itself — the report's own suggestion 2, a product-sized change in the front page rather than gateway code, so I leave it to your call rather than hand in an unprovable patch.
